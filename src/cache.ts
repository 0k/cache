import { track } from './track'
import { ImprintTreeMap, NoMatchingError } from './proxyTrackMap'

type Cached<F extends (...args: any[]) => any> = F & { clearCache(): void }

type CacheStore = {
    getValue(fn: Function, instance: any, args: any[]): any
}

type CacheOptions = {
    cacheStore?: new (...args: any[]) => CacheStore
    noClearCache?: boolean // wether to make this cache unclearable
    key?: (...args: any[]) => any
}

const allCaches = new WeakMap<any, Set<WeakMap<any, any>>>()

export function makeCacheDecorator (defaultOpts?: CacheOptions) {
    defaultOpts = defaultOpts || {}
    function cache (...args: any[]) {
        if (
            args.length === 3 &&
            typeof args[1] === 'string' &&
            'value' in args[2]
        ) {
            return cache()(...args)
        }
        let opts: CacheOptions = args[0] || {}
        opts = { ...defaultOpts, ...opts }

        const CacheStore = opts.cacheStore || ProxyCacheStore
        return function (
            target: any,
            propertyKey: string,
            descriptor: PropertyDescriptor,
        ) {
            // this is called per-method in a given class

            const originalMethod = descriptor.value
            delete descriptor.value
            delete descriptor.writable

            const instanceCacheMap = new WeakMap<any, CacheStore>()

            // Collect all caches
            let methodCaches = allCaches.get(target.constructor.prototype)
            if (!methodCaches) {
                methodCaches = new Set()
                allCaches.set(target.constructor.prototype, methodCaches)
            }
            if (!opts.noClearCache) methodCaches.add(instanceCacheMap)

            // clearCaches
            if (
                !opts.noClearCache &&
                !target.constructor.prototype.hasOwnProperty('clearCaches')
            ) {
                target.constructor.prototype.clearCaches = function () {
                    const caches = allCaches.get(Object.getPrototypeOf(this))
                    if (!caches) return
                    for (const map of caches) {
                        map.delete(this)
                    }
                }
            }

            descriptor.get = function () {
                const instance = this

                if (
                    Object.prototype.hasOwnProperty.call(instance, propertyKey)
                ) {
                    return instance[propertyKey]
                }

                let wrapped: any = function (this: any, ...args: any[]) {
                    let instanceCache = instanceCacheMap.get(instance)
                    if (!instanceCache) {
                        instanceCache = new CacheStore({ key: opts.key })
                        instanceCacheMap.set(instance, instanceCache)
                    }
                    return instanceCache.getValue(originalMethod, instance, args)
                }

                if (!opts.noClearCache) {
                    function clearCache () {
                        instanceCacheMap.delete(instance)
                    }

                    wrapped.clearCache = clearCache
                }
                Object.defineProperty(instance, propertyKey, {
                    value: wrapped,
                    writable: false,
                    configurable: false,
                })

                return wrapped
            }
        }
    }

    return cache
}

export const cache = makeCacheDecorator()


class JsonKeyCacheStore extends Map implements CacheStore {
    constructor (opts: { key: string }) {
        super()
    }

    getValue (fn, instance, args) {
        const argsKey = JSON.stringify(args)
        if (!this.has(argsKey)) {
            let result = fn.apply(instance, args)
            this.set(argsKey, result)
            return result
        }
        return this.get(argsKey)

    }
}

class ProxyCacheStore implements CacheStore {
    private imprintTreeMap: ImprintTreeMap
    constructor (opts: { key: string }) {
        this.imprintTreeMap = new ImprintTreeMap()
    }

    getValue (fn, instance, args) {
        let result
        let objectsToProxify = {instance, args}
        try {
            result = this.imprintTreeMap.get(objectsToProxify)
        } catch (e) {
            if (e instanceof NoMatchingError) {
                const { proxy: proxiedArgs, getTrackAndRevoke } = track(objectsToProxify)
                result = fn.apply(proxiedArgs.instance, proxiedArgs.args)
                this.imprintTreeMap.set(getTrackAndRevoke(), result)
            } else {
                throw e
            }
        }
        return result
    }
}



/* @skip-prod-transpilation */
if (import.meta.vitest) {
    const { it, expect, describe, vi, beforeEach } = import.meta.vitest

    let warnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    describe('on method', () => {
        it('should apply on method directly', () => {
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
        it('should re-run if run on same object with different values', () => {
            // This aims to check the hashing method against using the object itself
            // as a default key (for instance in an WeakMap)
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
                        return obj['x']
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
            it('should work whem using basic plain old java object', () => {
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
                    constructor(value) {
                        this.value = value
                    }
                    @cache
                    compute (num: any) {
                        console.warn(`computing... `)
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
                    constructor(value) {
                        this.value = value
                    }
                    @cache
                    compute (num: any) {
                        console.warn(`computing... `)
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
        })

    })
}
