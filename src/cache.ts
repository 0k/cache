// types

export type CacheStore = {
    getValue(fn: Function, instance: any, args: any[]): any[]
}

type CacheOptions = {
    cacheOnSettled?: boolean
    noCacheOnReject?: boolean
    cacheStore?: new (...args: any[]) => CacheStore
    noClearCache?: boolean // wether to make this cache unclearable
    key?: (...args: any[]) => any
}


// exceptions

export class CacheError extends Error {
    constructor (message) {
        super(message)
        this.name = 'CacheError'
    }
}


// code

const KEY = Symbol.for('@0k/cache/config')

globalThis[KEY] = [] as Function[]

const allCaches = new WeakMap<any, Set<WeakMap<any, any>>>()

export function cacheFactory (defaultOpts?: CacheOptions) {
    const unwrapFns = globalThis[KEY] as Function[]
    defaultOpts = {
        key: (x: any) => x,
        ...defaultOpts,
    }
    function cache (...args: any[]) {
        if (
            args.length === 2 &&
            typeof args[0] === 'function' &&
            typeof args[1] === 'object' &&
            'kind' in args[1]
        ) {
            return cache()(...args)
        }
        if (args.length === 1 && typeof args[0] === 'object') {
            return cacheFactory({ ...defaultOpts, ...args[0] })
        }
        if (args.length > 2) {
            console.log(
                'These are the actual arguments of the cache decorator',
                args,
            )
            throw new Error('Unsupported use of cache decorator')
        }
        let opts: CacheOptions = args[0] || {}
        opts = { ...defaultOpts, ...opts }

        const DefaultCacheStore = opts.cacheStore || JsonKeyCacheStore

        if (opts.noCacheOnReject && opts.cacheOnSettled) {
            throw new CacheError(
                "Options 'noCacheOnReject' and 'cacheOnSettled' " +
                    'are mutually exclusive.',
            )
        }

        let CacheStore
        if (opts.noCacheOnReject || opts.cacheOnSettled) {
            class NewCacheStore extends DefaultCacheStore {}
            let gv = NewCacheStore.prototype.getValue as Function

            if (opts.noCacheOnReject) {
                gv = noCacheOnReject(gv)
            } else if (opts.cacheOnSettled) {
                gv = cacheOnSettled(gv)
            }

            NewCacheStore.prototype.getValue = function (...a: any[]) {
                return gv.apply(this, a)
            }
            CacheStore = NewCacheStore
        } else {
            CacheStore = DefaultCacheStore
        }
        return function (target: any, context: any) {
            if (arguments.length === 3) {
                throw new Error(
                    'Receiving OLD decorator prototype for' +
                        `${JSON.stringify(arguments[1])}`,
                )
            }

            // this is called per-method in a given class

            // we are currently executed once per class and per method. Each
            // method needs to make their own store for each instance.
            const instanceCacheMap = new WeakMap<any, CacheStore>()

            const wrapped: any = function (this: any, ...args: any[]) {
                let instanceCache
                let instance = this
                let changed = true
                while (changed) {
                    let unwrapped = instance
                    for (const unwrapFn of unwrapFns) {
                        unwrapped = unwrapFn(unwrapped)
                    }
                    changed = !Object.is(unwrapped, instance)
                    instance = unwrapped
                }
                instanceCache = instanceCacheMap.get(instance)
                if (!instanceCache) {
                    instanceCache = new CacheStore(opts)
                    instanceCacheMap.set(instance, instanceCache)
                }
                const [val, _argsKey, _isHit] = instanceCache.getValue(
                    target,
                    instance,
                    args,
                )
                return val
            }

            context.addInitializer(function () {
                const instance = this
                if (!opts.noClearCache) {
                    function clearCache () {
                        instanceCacheMap.delete(instance)
                    }

                    wrapped.clearCache = clearCache

                    const klass = Object.getPrototypeOf(instance)
                    let methodCaches = allCaches.get(klass)
                    if (!methodCaches) {
                        methodCaches = new Set()
                        allCaches.set(klass, methodCaches)
                    }
                    methodCaches.add(instanceCacheMap)

                    if (!Object.hasOwnProperty.call(instance, 'clearCaches')) {
                        instance.clearCaches = function () {
                            if (!methodCaches) return
                            for (const map of methodCaches) {
                                map.delete(this)
                            }
                        }
                    }
                }
            })
            if (context.kind === 'method') {
                return wrapped
            } else if (context.kind === 'getter') {
                return wrapped
            } else {
                throw new Error('Unsupported use of cache decorator')
            }
        }
    }

    return cache
}

export const cache = cacheFactory()



function noCacheOnReject (target: any) {
    return function (...args) {
        const [result, argsKey, isHit] = Reflect.apply(
            target,
            this,
            args,
        ) as any[]
        if (!isHit) return [result, argsKey, isHit]
        const self = this
        return [
            (async function () {
                let val
                try {
                    val = await result
                } catch (_err) {
                    self.delete(argsKey)
                    return Reflect.apply(target, self, args)
                }
                return val
            })(),
            argsKey,
            undefined,
        ]
    }
}

function cacheOnSettled (target: Function) {
    return function (this: Map<any, any>, ...args: any[]) {
        const [result, argsKey, isHit] = Reflect.apply(target, this, args)
        if (isHit || !(result instanceof Promise)) {
            return [result, argsKey, isHit]
        }
        // XXXvlab: yuck !
        this.delete(argsKey)
        return [
            (async () => {
                const v = await result // throws through on reject
                this.set(argsKey, v)
                return v
            })(),
            argsKey,
            false,
        ]
    }
}


// cache stores

export class JsonKeyCacheStore extends Map implements CacheStore {

    opts

    constructor (opts: { key: string }) {
        super()
        this.opts = {
            key: (x: any) => x,
            ...opts,
        }
    }

    getValue (fn, instance, args: any[]) {
        const argsKey = JSON.stringify(this.opts.key({ instance, args }))
        if (!this.has(argsKey)) {
            const result = fn.apply(instance, args)
            this.set(argsKey, result)
            return [result, argsKey, false]
        }
        return [this.get(argsKey), argsKey, true]
    }
}

export class JsonKeyTTLCacheStore extends Map implements CacheStore {
    opts: Record<string, any>
    constructor (opts: { key: string }) {
        super()
        this.opts = {
            key: (x: any) => x,
            ttl: 60, // in seconds
            ...opts,
        }
    }

    set (key, value) {
        return super.set(key, [value, Date.now()])
    }

    getValue (fn, instance, args) {
        const argsKey = JSON.stringify(this.opts.key({ instance, args }))
        const now = Date.now()
        const value = this.get(argsKey)
        if (value) {
            const [result, timestamp] = value
            const ttl =
                typeof this.opts.ttl === 'function'
                    ? this.opts.ttl({ instance, args })
                    : this.opts.ttl
            if (ttl === -1 || timestamp + ttl * 1000 > now) {
                return [result, argsKey, true]
            }
        }
        const result = fn.apply(instance, args)
        this.set(argsKey, result)
        return [result, argsKey, false]
    }
}

export function addUnwrapFn (unwrapFn: Function) {
    globalThis[KEY].push(unwrapFn)
}



// tests

/* @skip-prod-transpilation */
if (import.meta.vitest) {
    const { it, expect, describe, vi, beforeEach } = import.meta.vitest

    let warnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    describe('on getter', () => {
        it('should apply directly', () => {
            class A {
                @cache
                get value () {
                    console.warn('computing...')
                    return 2
                }
            }
            const a = new A()
            expect(a.value).toBe(2)
            expect(a.value).toBe(2)

            expect(warnSpy).toHaveBeenCalledTimes(1)
            expect(warnSpy).toHaveBeenNthCalledWith(1, 'computing...')
        })
        it('should NOT save value if exception', () => {
            class A {
                @cache
                get value () {
                    console.warn('computing...')
                    throw new Error('Argl')
                }
            }
            const a = new A()
            expect(() => a.value).toThrow('Argl')
            expect(() => a.value).toThrow('Argl')

            expect(warnSpy).toHaveBeenCalledTimes(2)
            expect(warnSpy).toHaveBeenNthCalledWith(1, 'computing...')
            expect(warnSpy).toHaveBeenNthCalledWith(2, 'computing...')
        })
        it('`this` should be accessible and tracked', () => {
            class A {
                value

                constructor (value) {
                    this.value = value
                }

                @cache
                get x () {
                    const result = this.value
                    console.warn(`computing x = this.value (${result})`)
                    return result
                }
            }

            const a = new A(5)

            expect(a.x).toBe(5) // compute
            expect(a.x).toBe(5) // cached

            expect(warnSpy).toHaveBeenCalledTimes(1)
            expect(warnSpy).toHaveBeenNthCalledWith(
                1,
                'computing x = this.value (5)',
            )

            a.value = 3

            expect(a.x).toBe(3) // compute

            expect(warnSpy).toHaveBeenCalledTimes(2)
            expect(warnSpy).toHaveBeenNthCalledWith(
                2,
                'computing x = this.value (3)',
            )
        })

        it('`this` should be accessible and tracked even if a function in class', () => {
            class A {
                value

                constructor (value) {
                    this.value = value
                }

                @cache
                get http () {
                    const self = this
                    class B {
                        value = self.value
                    }
                    return new B()
                }
            }

            const fn = function name () {}
            const a = new A(fn)

            const h1 = a.http
            const h2 = a.http

            expect(h1).toBe(h2)
            expect(h1.value).toBe(fn)
            expect(h2.value).toBe(fn)
            expect(h2.value).not.toBe(function name2 () {})
            // This one could be debatable
            //expect(h2.value).not.toBe(function name() {})
        })
    })
    describe('on method', () => {
        it('should apply directly', () => {
            class A {

                @cache
                compute (x: number) {
                    console.warn('computing...')
                    return 2 * x
                }
            }
            const a = new A()
            expect(a.compute(2)).toBe(4)
            expect(a.compute(2)).toBe(4)
            expect(a.compute(3)).toBe(6)
            expect(a.compute(3)).toBe(6)

            expect(warnSpy).toHaveBeenCalledTimes(2)
            expect(warnSpy).toHaveBeenNthCalledWith(1, 'computing...')
            expect(warnSpy).toHaveBeenNthCalledWith(2, 'computing...')
        })
        it('should NOT save upon exception', () => {
            class A {

                @cache
                compute (_x: number) {
                    console.warn('computing...')
                    throw new Error('Argl')
                }
            }
            const a = new A()
            expect(() => a.compute(2)).toThrow('Argl')
            expect(() => a.compute(2)).toThrow('Argl')

            expect(warnSpy).toHaveBeenCalledTimes(2)
            expect(warnSpy).toHaveBeenNthCalledWith(1, 'computing...')
            expect(warnSpy).toHaveBeenNthCalledWith(2, 'computing...')
        })
        it('should work when method is referring to "this"', () => {
            class A {
                value: any

                constructor (value) {
                    this.value = value
                }

                @cache
                compute (num: any) {
                    console.warn('computing... ')
                    return this.value + num
                }
            }
            const a = new A(3)
            expect(a.compute(2)).toBe(5)
            expect(a.compute(2)).toBe(5)

            expect(warnSpy).toHaveBeenCalledTimes(1)
        })
        it('should have `this` accessible and tracked', () => {
            class A {
                value

                constructor (value) {
                    this.value = value
                }

                @cache
                getValue () {
                    const result = this.value
                    console.warn(
                        `computing getValue() = this.value (${result})`,
                    )
                    return result
                }
            }

            const a = new A(5)

            expect(a.getValue()).toBe(5) // compute
            expect(a.getValue()).toBe(5) // cached

            expect(warnSpy).toHaveBeenCalledTimes(1)
            expect(warnSpy).toHaveBeenNthCalledWith(
                1,
                'computing getValue() = this.value (5)',
            )

            a.value = 3

            expect(a.getValue()).toBe(3) // compute

            expect(warnSpy).toHaveBeenCalledTimes(2)
            expect(warnSpy).toHaveBeenNthCalledWith(
                2,
                'computing getValue() = this.value (3)',
            )
        })
        it('should apply on method as a function', () => {
            class A {
                @cache()
                compute (x: number) {
                    console.warn('computing...')
                    return 2 * x
                }
            }
            const a = new A()
            expect(a.compute(2)).toBe(4)
            expect(a.compute(2)).toBe(4)
            expect(a.compute(3)).toBe(6)
            expect(a.compute(3)).toBe(6)

            expect(warnSpy).toHaveBeenCalledTimes(2)
            expect(warnSpy).toHaveBeenNthCalledWith(1, 'computing...')
            expect(warnSpy).toHaveBeenNthCalledWith(2, 'computing...')
        })
        it('should have distinct caches for method on same instances', () => {
            class A {

                @cache
                compute2x (x: number) {
                    console.warn(`computing... 2x${x}`)
                    return 2 * x
                }

                @cache
                compute3x (x: number) {
                    console.warn(`computing... 3x${x}`)
                    return 3 * x
                }
            }
            const a = new A()
            expect(a.compute2x(2)).toBe(4)
            expect(a.compute2x(2)).toBe(4)
            expect(a.compute2x(3)).toBe(6)
            expect(a.compute2x(3)).toBe(6)
            expect(a.compute3x(2)).toBe(6)
            expect(a.compute3x(2)).toBe(6)

            expect(warnSpy).toHaveBeenCalledTimes(3)
            expect(warnSpy).toHaveBeenNthCalledWith(1, 'computing... 2x2')
            expect(warnSpy).toHaveBeenNthCalledWith(2, 'computing... 2x3')
            expect(warnSpy).toHaveBeenNthCalledWith(3, 'computing... 3x2')
        })
        it('should have distinct caches for same method on diff instances', () => {
            class A {

                @cache
                compute2x (x: number) {
                    console.warn(`computing... 2x${x}`)
                    return 2 * x
                }
            }
            const a = new A()
            const b = new A()
            expect(a.compute2x(2)).toBe(4)
            expect(b.compute2x(2)).toBe(4)

            expect(warnSpy).toHaveBeenCalledTimes(2)
            expect(warnSpy).toHaveBeenNthCalledWith(1, 'computing... 2x2')
            expect(warnSpy).toHaveBeenNthCalledWith(2, 'computing... 2x2')
        })
        it('should re-run if run on same object with different values', () => {
            class A {

                @cache
                sum (nums: number[]) {
                    console.warn(`computing... sum([${nums.join(', ')}])`)
                    return nums.reduce((acc, n) => acc + n, 0)
                }
            }
            const a = new A()
            const nums = [1, 2]
            expect(a.sum(nums)).toBe(3)
            nums.push(3)
            expect(a.sum(nums)).toBe(6)
            nums[0] = 2
            expect(a.sum(nums)).toBe(7)
            expect(warnSpy).toHaveBeenCalledTimes(3)
            expect(warnSpy).toHaveBeenNthCalledWith(
                1,
                'computing... sum([1, 2])',
            )
            expect(warnSpy).toHaveBeenNthCalledWith(
                2,
                'computing... sum([1, 2, 3])',
            )
            expect(warnSpy).toHaveBeenNthCalledWith(
                3,
                'computing... sum([2, 2, 3])',
            )
        })
        it('should re-run if run on same object with different values 2', () => {
            // This aims to check the hashing method against using the
            // object itself as a default key (for instance in an
            // WeakMap)
            class A {

                @cache
                sum (nums: number[]) {
                    console.warn(`computing... sum([${nums.join(', ')}])`)
                    return nums.reduce((acc, n) => acc + n, 0)
                }
            }
            const a = new A()
            const nums = [1, 2]
            expect(a.sum(nums)).toBe(3)
            nums.push(3)
            expect(a.sum(nums)).toBe(6)
            nums[0] = 2
            expect(a.sum(nums)).toBe(7)
            expect(warnSpy).toHaveBeenCalledTimes(3)
            expect(warnSpy).toHaveBeenNthCalledWith(
                1,
                'computing... sum([1, 2])',
            )
            expect(warnSpy).toHaveBeenNthCalledWith(
                2,
                'computing... sum([1, 2, 3])',
            )
            expect(warnSpy).toHaveBeenNthCalledWith(
                3,
                'computing... sum([2, 2, 3])',
            )
        })
        describe('values', () => {
            it('should cache value like undefined', () => {
                class A {

                    @cache
                    getX (obj: any) {
                        console.warn(`computing... ${JSON.stringify(obj)}['x']`)
                        return obj.x
                    }
                }
                const a = new A()
                expect(a.getX(2)).toBe(undefined)
                expect(a.getX(2)).toBe(undefined)

                expect(warnSpy).toHaveBeenCalledTimes(1)

                expect(a.getX({})).toBe(undefined)
                expect(a.getX({})).toBe(undefined)

                expect(warnSpy).toHaveBeenCalledTimes(2)

                expect(warnSpy).toHaveBeenNthCalledWith(
                    1,
                    "computing... 2['x']",
                )
                expect(warnSpy).toHaveBeenNthCalledWith(
                    2,
                    "computing... {}['x']",
                )
            })
            it('should work when using basic plain old java object', () => {
                class A {

                    @cache
                    stringify (obj: any) {
                        console.warn(`computing... ${JSON.stringify(obj)}`)
                        return JSON.stringify(obj)
                    }
                }
                const a = new A()
                expect(a.stringify([null, true, {}, ['a'], undefined])).toBe(
                    '[null,true,{},["a"],null]',
                )
                expect(a.stringify([null, true, {}, ['a'], undefined])).toBe(
                    '[null,true,{},["a"],null]',
                )

                expect(warnSpy).toHaveBeenCalledTimes(1)
            })
            it('should work when method is referring to "this"', () => {
                class A {

                    value: any

                    constructor (value) {
                        this.value = value
                    }

                    @cache
                    compute (num: any) {
                        console.warn('computing... ')
                        return this.value + num
                    }
                }
                const a = new A(3)
                expect(a.compute(2)).toBe(5)
                expect(a.compute(2)).toBe(5)

                expect(warnSpy).toHaveBeenCalledTimes(1)
            })
            it('should work when method is referring to "this"', () => {
                class A {
                    value: any

                    constructor (value) {
                        this.value = value
                    }

                    @cache
                    compute (num: any) {
                        console.warn('computing... ')
                        return this.value + num
                    }
                }
                const a = new A(3)
                expect(a.compute(2)).toBe(5)
                a.value = 0
                expect(a.compute(2)).toBe(2)

                expect(warnSpy).toHaveBeenCalledTimes(2)
            })
        })
        describe('clearCache', () => {
            it('should clear cache and recompute', () => {
                class A {

                    @cache
                    compute (x: number) {
                        console.warn('computing...')
                        return 2 * x
                    }
                }

                const a = new A()
                expect(a.compute(5)).toBe(10) // compute
                expect(a.compute(5)).toBe(10) // cached

                expect(warnSpy).toHaveBeenCalledTimes(1)
                ;(a.compute as any).clearCache()

                expect(a.compute(5)).toBe(10) // recompute
                expect(warnSpy).toHaveBeenCalledTimes(2)
            })
            it('should clear cache of only current method', () => {
                class A {

                    @cache
                    compute2x (x: number) {
                        console.warn(`computing... 2x${x}`)
                        return 2 * x
                    }

                    @cache
                    compute3x (x: number) {
                        console.warn(`computing... 3x${x}`)
                        return 3 * x
                    }
                }

                const a = new A()

                expect(a.compute2x(5)).toBe(10) // compute
                expect(a.compute3x(5)).toBe(15) // compute

                expect(warnSpy).toHaveBeenCalledTimes(2)
                ;(a.compute2x as any).clearCache()

                expect(a.compute2x(5)).toBe(10) // compute
                expect(a.compute3x(5)).toBe(15) // cached

                expect(warnSpy).toHaveBeenCalledTimes(3)
            })
            it('should not allow clear cache when noClearCache is set', () => {
                class A {

                    @cache({ noClearCache: true })
                    compute (x: number) {
                        console.warn('computing...')
                        return 2 * x
                    }
                }

                const a = new A()
                expect((a.compute as any).clearCache).toBe(undefined)
            })
        })
        describe('clearCaches', () => {
            it('should clear all caches of instance', () => {
                class A {

                    @cache
                    compute2x (x: number) {
                        console.warn(`computing... 2x${x}`)
                        return 2 * x
                    }

                    @cache
                    compute3x (x: number) {
                        console.warn(`computing... 3x${x}`)
                        return 3 * x
                    }
                }

                const a = new A()
                const b = new A()

                expect(a.compute2x(5)).toBe(10) // compute
                expect(a.compute2x(4)).toBe(8) // compute
                expect(a.compute3x(5)).toBe(15) // compute

                expect(b.compute3x(5)).toBe(15) // compute

                expect(warnSpy).toHaveBeenCalledTimes(4)
                ;(a as any).clearCaches()

                expect(a.compute2x(5)).toBe(10) // compute
                expect(a.compute2x(4)).toBe(8) // compute
                expect(a.compute3x(5)).toBe(15) // compute

                expect(b.compute3x(5)).toBe(15) // cached

                expect(warnSpy).toHaveBeenCalledTimes(7)
            })
            it('should clear all caches of instance except noClearCached ones', () => {
                class A {

                    @cache
                    compute2x (x: number) {
                        console.warn(`computing... 2x${x}`)
                        return 2 * x
                    }

                    @cache({ noClearCache: true })
                    compute3x (x: number) {
                        console.warn(`computing... 3x${x}`)
                        return 3 * x
                    }
                }

                const a = new A()

                expect(a.compute2x(5)).toBe(10) // compute
                expect(a.compute2x(4)).toBe(8) // compute
                expect(a.compute3x(5)).toBe(15) // compute

                expect(warnSpy).toHaveBeenCalledTimes(3)
                ;(a as any).clearCaches()

                expect(a.compute2x(5)).toBe(10) // compute
                expect(a.compute2x(4)).toBe(8) // compute
                expect(a.compute3x(5)).toBe(15) // cached

                expect(warnSpy).toHaveBeenCalledTimes(5)
            })
            it('should clearCache on getter indirectly', () => {
                class A {

                    @cache
                    get value () {
                        console.warn('computing...')
                        return 2
                    }
                }
                const a = new A()
                expect(a.value).toBe(2)
                expect(a.value).toBe(2)
                ;(Object.getOwnPropertyDescriptor(
                    Object.getPrototypeOf(a),
                    'value',
                ).get as any).clearCache()
                expect(a.value).toBe(2)

                expect(warnSpy).toHaveBeenCalledTimes(2)
            })
        })
        describe('recursivity', () => {
            it('a cached function should be able to call another cached function', () => {
                class A {

                    @cache
                    compute2x (x: number) {
                        console.warn(`computing... 2x${x}`)
                        return 2 * x
                    }

                    @cache
                    compute6x (x: number) {
                        console.warn(`computing... 3x2x${x}`)
                        return 3 * this.compute2x(x)
                    }
                }

                const a = new A()

                expect(a.compute6x(3)).toBe(18) // compute
                expect(warnSpy).toHaveBeenCalledTimes(2)

                expect(warnSpy).toHaveBeenNthCalledWith(1, 'computing... 3x2x3')
                expect(warnSpy).toHaveBeenNthCalledWith(2, 'computing... 2x3')
                ;(a as any).clearCaches()

                expect(a.compute2x(3)).toBe(6) // compute
                expect(a.compute6x(3)).toBe(18) // compute

                expect(warnSpy).toHaveBeenCalledTimes(4)

                expect(warnSpy).toHaveBeenNthCalledWith(3, 'computing... 2x3')
                expect(warnSpy).toHaveBeenNthCalledWith(4, 'computing... 3x2x3')
            })
            it('a cached function should be able to call another cached function 2', () => {
                class A {
                    value

                    constructor (value) {
                        this.value = value
                    }

                    @cache
                    get x () {
                        const result = this.value
                        console.warn(`computing x = this.value (${result})`)
                        return result
                    }

                    @cache
                    get y () {
                        const result = this.x
                        console.warn(`computing y = this.x (${result})`)
                        return result
                    }
                }

                const a = new A(5)

                expect(a.x).toBe(5) // compute
                expect(a.y).toBe(5) // compute

                expect(warnSpy).toHaveBeenCalledTimes(2)

                expect(warnSpy).toHaveBeenNthCalledWith(
                    1,
                    'computing x = this.value (5)',
                )
                expect(warnSpy).toHaveBeenNthCalledWith(
                    2,
                    'computing y = this.x (5)',
                )

                a.value = 3

                expect(a.y).toBe(3) // compute

                expect(warnSpy).toHaveBeenCalledTimes(4)

                expect(warnSpy).toHaveBeenNthCalledWith(
                    3,
                    'computing x = this.value (3)',
                )
                expect(warnSpy).toHaveBeenNthCalledWith(
                    4,
                    'computing y = this.x (3)',
                )
            })
        })
    })
    describe('cache factory', () => {
        it('cache is its own factory', () => {
            const mycache = cache({ key: ({ _i, args }) => args[0] })

            class A {
                @mycache
                compute2x (x: number, y: number) {
                    console.warn(`computing... ${x}+${y}`)
                    return x + y
                }
            }

            const a = new A()
            expect(a.compute2x(3, 2)).toBe(5)
            expect(a.compute2x(3, 3)).toBe(5) // !!

            expect(warnSpy).toHaveBeenCalledTimes(1)
            expect(warnSpy).toHaveBeenNthCalledWith(1, 'computing... 3+2')

            // It should still work with new arguments

            class B {
                @mycache({ key: ({ _i, args }) => args[1] })
                compute2x (x: number, y: number) {
                    console.warn(`computing... ${x}+${y}`)
                    return x + y
                }
            }

            const b = new B()

            expect(b.compute2x(2, 5)).toBe(7)
            expect(b.compute2x(3, 5)).toBe(7) // !!

            expect(warnSpy).toHaveBeenCalledTimes(2)
            expect(warnSpy).toHaveBeenNthCalledWith(2, 'computing... 2+5')
        })
    })
    describe('promises', () => {
        it('promises are cached as-is', async () => {

            class A {
                @cache
                async compute2x (x: number, y: number) {
                    console.warn(`computing... ${x}+${y}`)
                    return x + y
                }
            }

            const a = new A()
            expect(await a.compute2x(3, 2)).toBe(5)
            expect(await a.compute2x(3, 2)).toBe(5)

            expect(warnSpy).toHaveBeenCalledTimes(1)
            expect(warnSpy).toHaveBeenNthCalledWith(1, 'computing... 3+2')
        })
        it('promises are cached as-is 2', async () => {

            const p = []
            class A {
                @cache
                compute2x (_x: number, _y: number) {
                    return new Promise((resolve, reject) => {
                        p.push({ resolve, reject })
                    })
                }
            }

            const a = new A()
            const promise1 = a.compute2x(3, 2)
            const promise2 = a.compute2x(3, 2)
            expect(Object.is(promise1, promise2)).toBe(true)

            expect(p.length).toBe(1)
        })
        it('promises are smart when noCacheOnReject is provided', async () => {

            const p = []
            class A {
                @cache({
                    noCacheOnReject: true,
                    key: ({ _i, args: [x, y, _callNb] }) => [x, y],
                })
                compute2x (x: number, y: number, callNb: number) {
                    return new Promise((resolve, reject) => {
                        console.warn(
                            `evaled with ${x}+${y} (callNb: ${callNb})`,
                        )
                        p.push({ resolve, reject })
                    })
                }
            }

            const a = new A()
            const promise1 = a.compute2x(3, 2, 1)
            const promise2 = a.compute2x(3, 2, 2)
            expect(Object.is(promise1, promise2)).toBe(false)
            expect(warnSpy).toHaveBeenCalledTimes(1)
            expect(warnSpy).toHaveBeenNthCalledWith(
                1,
                'evaled with 3+2 (callNb: 1)',
            )
            expect(
                await Promise.allSettled([
                    (async () => {
                        p[0].reject(new Error('Argl'))
                    })(),
                    promise1,
                ]),
            ).toStrictEqual([
                {
                    status: 'fulfilled',
                    value: undefined,
                },
                {
                    reason: new Error('Argl'),
                    status: 'rejected',
                },
            ])
            expect(warnSpy).toHaveBeenCalledTimes(2)
            expect(warnSpy).toHaveBeenNthCalledWith(
                2,
                'evaled with 3+2 (callNb: 2)',
            )

        })
        it('noCacheOnReject: second call waits for the first to settle', async () => {
            const p: Array<{ resolve: (v: number) => void }> = []

            class A {
                @cache({
                    noCacheOnReject: true,
                    key: ({ args: [x, y] }) => [x, y],
                })
                compute2x (x: number, y: number, callLabel: string) {
                    console.warn(
                        `evaled with ${x}+${y}, callLabel: ${callLabel}`,
                    )
                    return new Promise<number>((resolve) => {
                        p.push({ resolve })
                    })
                }
            }

            const a = new A()

            const p1 = (async () => {
                const res = await a.compute2x(3, 2, 'p1')
                console.warn(`resolved p1 with ${res}`)
                return res
            })()
            const p2 = (async () => {
                const res = await a.compute2x(3, 2, 'p2')
                console.warn(`resolved p2 with ${res}`)
                return res
            })()

            // One shared in-flight promise (second call reuses the first)
            expect(p.length).toBe(1)
            expect(warnSpy).toHaveBeenCalledTimes(1)
            expect(warnSpy).toHaveBeenNthCalledWith(
                1,
                'evaled with 3+2, callLabel: p1',
            )

            // When the underlying promise settles, both callers
            // resolve; p2 cannot beat p1
            p[0].resolve(5)
            await expect(Promise.all([p1, p2])).resolves.toEqual([5, 5])

            expect(warnSpy).toHaveBeenCalledTimes(3)
            expect(warnSpy).toHaveBeenNthCalledWith(2, 'resolved p1 with 5')
            expect(warnSpy).toHaveBeenNthCalledWith(3, 'resolved p2 with 5')
        })
        it('in-flight promises are NOT cached with cacheOnSettled', async () => {
            const p: Array<{ resolve: (v: number) => void }> = []

            class A {
                @cache({
                    cacheOnSettled: true,
                    key: ({ args: [x, y] }) => [x, y],
                })
                compute2x (x: number, y: number) {
                    console.warn(`evaled with ${x}+${y}`)
                    return new Promise<number>((resolve) => {
                        p.push({ resolve })
                    })
                }
            }

            const a = new A()
            const promise1 = a.compute2x(3, 2)
            const promise2 = a.compute2x(3, 2)

            expect(Object.is(promise1, promise2)).toBe(false)
            expect(warnSpy).toHaveBeenCalledTimes(2)
            expect(warnSpy).toHaveBeenNthCalledWith(1, 'evaled with 3+2')
            expect(warnSpy).toHaveBeenNthCalledWith(2, 'evaled with 3+2')

            p[0].resolve(5)
            p[1].resolve(5)

            expect(await promise1).toBe(5)
            expect(await promise2).toBe(5)
        })

        it('caches the fulfilled value after it settles', async () => {
            const p: Array<{ resolve: (v: number) => void }> = []

            class A {
                @cache({
                    cacheOnSettled: true,
                    key: ({ args: [x, y] }) => [x, y],
                })
                compute2x (x: number, y: number) {
                    console.warn(`evaled with ${x}+${y}`)
                    return new Promise<number>((resolve) => {
                        p.push({ resolve })
                    })
                }
            }

            const a = new A()

            const first = a.compute2x(3, 2)
            expect(warnSpy).toHaveBeenCalledTimes(1)
            expect(warnSpy).toHaveBeenNthCalledWith(1, 'evaled with 3+2')

            p[0].resolve(5)
            expect(await first).toBe(5)

            // After settle, value is cached (no new eval/log)
            expect(await a.compute2x(3, 2)).toBe(5)
            expect(warnSpy).toHaveBeenCalledTimes(1)
        })

        it('rejection is NOT cached; next call recomputes', async () => {
            const p: Array<{
                resolve: (v: number) => void
                reject: (e: any) => void
            }> = []

            class A {
                @cache({
                    cacheOnSettled: true,
                    key: ({ args: [x, y] }) => [x, y],
                })
                compute2x (x: number, y: number) {
                    console.warn(`evaled with ${x}+${y}`)
                    return new Promise<number>((resolve, reject) => {
                        p.push({ resolve, reject })
                    })
                }
            }

            const a = new A()

            const promise1 = a.compute2x(3, 2)
            expect(warnSpy).toHaveBeenCalledTimes(1)
            expect(warnSpy).toHaveBeenNthCalledWith(1, 'evaled with 3+2')

            const results = await Promise.allSettled([
                (async () => {
                    p[0].reject(new Error('boom'))
                })(),
                promise1,
            ])
            expect(results).toStrictEqual([
                { status: 'fulfilled', value: undefined },
                { status: 'rejected', reason: new Error('boom') },
            ])

            // Rejection wasn't cached → recompute happens
            const promise2 = a.compute2x(3, 2)
            expect(warnSpy).toHaveBeenCalledTimes(2)
            expect(warnSpy).toHaveBeenNthCalledWith(2, 'evaled with 3+2')

            // Fulfill second call
            p[1]?.resolve(5)
            expect(await promise2).toBe(5)

            // Now it should be cached
            expect(await a.compute2x(3, 2)).toBe(5)
            expect(warnSpy).toHaveBeenCalledTimes(2)
        })
        it('cacheOnSettled: second call can finish before the first', async () => {
            const p: Array<{ resolve: (v: number) => void }> = []

            class A {
                @cache({
                    cacheOnSettled: true,
                    key: ({ args: [x, y] }) => [x, y],
                })
                compute2x (x: number, y: number, callLabel: string) {
                    console.warn(
                        `evaled with ${x}+${y}, callLabel: ${callLabel}`,
                    )
                    return new Promise<number>((resolve) => {
                        p.push({ resolve })
                    })
                }
            }

            const a = new A()

            const p1 = (async () => {
                const res = await a.compute2x(3, 2, 'p1')
                console.warn(`resolved p1 with ${res}`)
                return res
            })()
            const p2 = (async () => {
                const res = await a.compute2x(3, 2, 'p2')
                console.warn(`resolved p2 with ${res}`)
                return res
            })()

            // Two independent in-flight promises (not deduped)
            expect(p.length).toBe(2)
            expect(warnSpy).toHaveBeenCalledTimes(2)
            expect(warnSpy).toHaveBeenNthCalledWith(
                1,
                'evaled with 3+2, callLabel: p1',
            )
            expect(warnSpy).toHaveBeenNthCalledWith(
                2,
                'evaled with 3+2, callLabel: p2',
            )

            // Resolve second before first
            p[1].resolve(5)
            await expect(p2).resolves.toBe(5)
            expect(warnSpy).toHaveBeenCalledTimes(3)
            expect(warnSpy).toHaveBeenNthCalledWith(3, 'resolved p2 with 5')

            p[0].resolve(5)
            await expect(p1).resolves.toBe(5)
            expect(warnSpy).toHaveBeenCalledTimes(4)
            expect(warnSpy).toHaveBeenNthCalledWith(4, 'resolved p1 with 5')
        })



    })

}
