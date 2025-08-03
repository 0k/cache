type Primitive = string | number | boolean | bigint | symbol | null | undefined

type Key = string | number | symbol
export type Ctor = Function | ObjectConstructor
type ReadOperation<T> = {
    [key: Key]: Primitive | T
}
type HasOperation = {
    [key: Key]: boolean
}

export interface TrackImprint {
    ctor?: WeakRef<Ctor>
    read?: ReadOperation<TrackImprint>
    has?: HasOperation
    ownKeys?: (string | symbol)[]
    descriptors?: { [key: Key]: TrackImprint }
}

export type Node<V> = {
    imprint: TrackImprint // the “pattern” represented by this branch
    value?: V // present only on leaf nodes
    children: Node<V>[]
}




function cleanNode (node) {
    if (node.has && Object.keys(node.has).length === 0) delete node.has
    if (node.read && Object.keys(node.read).length === 0) {
        delete node.read
    } else {
        for (const [key, val] of Object.entries(node.read)) {
            if (typeof val !== 'object' || val === null) continue
            cleanNode(val)
        }
    }
}


function trackWriteErrorMessage (name) {
    return `${JSON.stringify(
        name,
    )} is probably not a good idea in a cached function's arguments`
}

function trackNotSupported (name) {
    return `${JSON.stringify(
        name,
    )} is not supported (yet?) on a cached function's arguments`
}


export function track<T extends object> (target: T) {
    if (!target || typeof target !== 'object') {
        throw new TypeError('Cannot track a non-object')
    }
    const nodeToProxy = new WeakMap<object, any>() // reuse proxy per *node*

    const makeNode = (obj: any): TrackImprint => ({
        ctor: new WeakRef(obj?.constructor ?? Object),
        read: {},
        has: {},
    })
    const allRevokes = []

    const makeProxy = (obj: any, node: TrackImprint): any => {
        // reuse the proxy bound to this node (not to the object)
        const cached = nodeToProxy.get(node as any)
        if (cached) return cached

        const { proxy, revoke } = Proxy.revocable(obj, {
            get (o, prop, r) {
                const val = Reflect.get(o, prop, r)

                if (val !== null && typeof val === 'object') {
                    // one *child node per path segment* (prop)
                    let child
                    if (!node.read.hasOwnProperty(prop)) {
                        child = makeNode(val)
                        node.read[prop] = child
                    } else {
                        child = node.read[prop] as TrackImprint
                    }
                    return makeProxy(val, child)
                } else {
                    node.read[prop] = val
                    return val
                }
            },
            has (o, prop) {
                node.has[prop] = Reflect.has(o, prop)
                return node.has[prop] as boolean
            },
            ownKeys (o) {
                node.ownKeys = Reflect.ownKeys(o)
                return node.ownKeys
            },

            /** explicit descriptor request */
            // XXXvlab: Should support that !
            // getOwnPropertyDescriptor(o, prop) {
            //     throw new Error(trackNotSupported('getOwnPropertyDescriptor'));
            // },

            /** seldom used but cheap to track */
            getPrototypeOf (o) {
                throw new Error(trackNotSupported('getPrototypeOf'))
            },

            isExtensible (o) {
                throw new Error(trackNotSupported('isExtensible'))
            },

            /* Dubious write operation on arguments */

            set () {
                throw new Error(trackWriteErrorMessage('set'))
            },
            defineProperty () {
                throw new Error(trackWriteErrorMessage('defineProperty'))
            },
            deleteProperty () {
                throw new Error(trackWriteErrorMessage('deleteProperty'))
            },
            setPrototypeOf () {
                throw new Error(trackWriteErrorMessage('setPrototypeOf'))
            },
            preventExtensions () {
                throw new Error(trackWriteErrorMessage('preventExtensions'))
            },

            /* less common but still side-effecting */
            apply () {
                throw new Error(trackNotSupported('apply'))
            },
            construct () {
                throw new Error(trackNotSupported('construct'))
            },


        })

        nodeToProxy.set(node, proxy)
        allRevokes.push(revoke)
        return proxy
    }

    const rootNode = makeNode(target)
    const proxy = makeProxy(target, rootNode)


    return {
        proxy,
        getTrackAndRevoke (): TrackImprint {
            // remove empty read or empty has
            cleanNode(rootNode)
            for (const revoke of allRevokes) revoke()
            return rootNode
        },
    }
}


/* @skip-prod-transpilation */
if (import.meta.vitest) {
    const { it, expect, describe, vi, beforeEach } = import.meta.vitest


    describe('track', () => {
        it('should track plain old javascript objects', () => {
            expect(() => track(null)).toThrowError(TypeError)
            expect(() => track(undefined)).toThrowError(TypeError)
        })
        it('should track get in imprint', () => {
            let a = {
                b: 1,
                c: {
                    d: 1,
                    e: 2,
                },
            }
            let tracker = track(a)
            a = tracker.proxy

            expect(a.b + a.c.d).toBe(2)

            expect(tracker.getTrackAndRevoke()).toStrictEqual({
                ctor: new WeakRef(Object.constructor),
                read: {
                    b: 1,
                    c: {
                        ctor: new WeakRef(Object.constructor),
                        read: {
                            d: 1,
                        },
                    },
                },
            })
        })
        it('should track has in imprint', () => {
            let a = {
                b: 1,
                c: {
                    d: 1,
                    e: 2,
                },
            }
            let tracker = track(a)
            a = tracker.proxy

            expect('b' in a).toBe(true)
            expect('x' in a.c).toBe(false)

            expect(tracker.getTrackAndRevoke()).toStrictEqual({
                ctor: new WeakRef(Object.constructor),
                has: { b: true },
                read: {
                    c: {
                        ctor: new WeakRef(Object.constructor),
                        has: {
                            x: false,
                        },
                    },
                },
            })
        })
        it('should track ownKey in imprint', () => {
            let a = {
                b: 1,
                c: {
                    d: 1,
                    e: 2,
                },
            }
            let tracker = track(a)
            a = tracker.proxy

            expect(new Set(Object.keys(a))).toStrictEqual(new Set(['b', 'c']))

            expect(tracker.getTrackAndRevoke()).toStrictEqual({
                ctor: new WeakRef(Object.constructor),
                ownKeys: ['b', 'c'],
            })
        })
        it('should track paths even if using same ref object', () => {
            // The logic here is that we don't want to do any assumptions
            // on how the current tracked structure is, but only how we
            // are actually querying it.

            let a = {
                x: 1,
                y: 2,
            }
            let b = {
                p: a,
                q: a,
            }
            let tracker = track(b)
            b = tracker.proxy

            expect(b.p.x + b.q.y).toBe(3)

            let t = tracker.getTrackAndRevoke()
            expect(t).toStrictEqual({
                ctor: new WeakRef(Object.constructor),
                read: {
                    p: {
                        ctor: new WeakRef(Object.constructor),
                        read: {
                            x: 1,
                        },
                    },
                    q: {
                        ctor: new WeakRef(Object.constructor),
                        read: {
                            y: 2,
                        },
                    },
                },
            })
        })
        it('should track paths even if using same ref object', () => {
            let a = {
                x: 1,
                y: 2,
            }
            let b = {
                p: a,
                q: a,
            }
            let tracker = track(b)
            b = tracker.proxy

            expect(b.p.x + b.q.y).toBe(3)
            expect(b.p.x + b.p.y).toBe(3)

            let t = tracker.getTrackAndRevoke()
            expect(t).toStrictEqual({
                ctor: new WeakRef(Object.constructor),
                read: {
                    p: {
                        ctor: new WeakRef(Object.constructor),
                        read: {
                            x: 1,
                            y: 2,
                        },
                    },
                    q: {
                        ctor: new WeakRef(Object.constructor),
                        read: {
                            y: 2,
                        },
                    },
                },
            })
        })

        it('returns same proxy for repeated access of the same path', () => {
            const shared = { x: 1 }
            const obj = { p: shared, q: shared }

            const t1 = track(obj) // whichever tracker we are testing
            const proxy = t1.proxy

            // access the *same* path twice
            const first = proxy.p
            const second = proxy.p

            expect(first === second).toBe(true)
        })

        it('allows the same primitive to be read twice without throwing', () => {
            const root = { a: 1 }
            const t = track(root)
            const p = t.proxy

            // two identical reads
            void p.a // first read = 1
            ;(root as any).a = 2
            void p.a // second read = 2

            expect(() => t.getTrackAndRevoke()).not.toThrow()
        })

    })

}
