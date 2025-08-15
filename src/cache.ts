// types

export type CacheStore = {
    getValue(fn: Function, instance: any, args: any[]): any
}

type CacheOptions = {
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

        const CacheStore = opts.cacheStore || JsonKeyCacheStore
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
                return instanceCache.getValue(target, instance, args)
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

    getValue (fn, instance, args) {
        const argsKey = JSON.stringify(this.opts.key({ instance, args }))
        if (!this.has(argsKey)) {
            const result = fn.apply(instance, args)
            this.set(argsKey, result)
            return result
        }
        return this.get(argsKey)
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
                return result
            }
        }
        const result = fn.apply(instance, args)
        this.set(argsKey, result)
        return result
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
}
