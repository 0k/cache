import { match } from './match'
import { TrackImprint, Ctor, Node } from './track'

export class NoMatchingError extends Error {
    constructor (message) {
        super(message)
        this.name = 'NoMatchingError'
    }
}


/** helper: true ⇢ both WeakRefs still live and target the same object */
const sameCtor = (a: WeakRef<Ctor>, b: WeakRef<Ctor>): boolean => {
    const ca = a.deref()
    return ca !== undefined && ca === b.deref()
}

const build = (
    ctor: WeakRef<Ctor> | undefined,
    read?: TrackImprint['read'],
    has?: TrackImprint['has'],
    ownKeys?: (string | symbol)[],
): TrackImprint | null => ({
    ...(ctor && { ctor }),
    ...(read && Object.keys(read).length !== 0 && { read }),
    ...(has && Object.keys(has).length !== 0 && { has }),
    ...(ownKeys && ownKeys.length && { ownKeys }),
})


function trackImprintSplit (
    A: TrackImprint,
    B: TrackImprint,
): [TrackImprint | null, TrackImprint | null, TrackImprint | null] {

    // ── ctor handling

    let ctorInt: WeakRef<Ctor> | undefined
    let ctorOnlyA: WeakRef<Ctor> | undefined = A.ctor
    let ctorOnlyB: WeakRef<Ctor> | undefined = B.ctor

    if (sameCtor(A.ctor, B.ctor)) {
        ctorInt = A.ctor
        ctorOnlyA = undefined
        ctorOnlyB = undefined
    } else {
        // if only one side has ctor, keep it on that side
        if (!A.ctor) ctorOnlyA = undefined
        if (!B.ctor) ctorOnlyB = undefined
    }

    // -- ownKeys

    let ownKeysInt: (string | symbol)[] | undefined
    let ownKeysOnlyA: (string | symbol)[] | undefined = A.ownKeys
    let ownKeysOnlyB: (string | symbol)[] | undefined = B.ownKeys

    if (
        ownKeysOnlyA &&
        ownKeysOnlyB &&
        ownKeysOnlyA.length === ownKeysOnlyB.length &&
        ownKeysOnlyA.every((v, i) => v === ownKeysOnlyB[i])
    ) {
        ownKeysInt = ownKeysOnlyA
        ownKeysOnlyA = undefined
        ownKeysOnlyB = undefined
    }

    // -- has keys

    const commonHas: TrackImprint['has'] = {}
    const onlyAHas: TrackImprint['has'] = {}
    const onlyBHas: TrackImprint['has'] = {}
    const aHas = A.has || {}
    const bHas = B.has || {}
    const hasKeys = new Set([
        ...Reflect.ownKeys(aHas),
        ...Reflect.ownKeys(bHas),
    ])

    for (const k of hasKeys) {
        const aVal = aHas[k]
        const bVal = bHas[k]

        // key exists only on one side
        if (!(k in bHas)) {
            onlyAHas[k] = aVal
            continue
        }
        if (!(k in aHas)) {
            onlyBHas[k] = bVal
            continue
        }

        // both sides have the key
        if (aVal === bVal) {
            commonHas[k] = aVal // identical primitive
        } else {
            onlyAHas[k] = aVal
            onlyBHas[k] = bVal
        }
    }

    // ── read keys

    const commonRead: TrackImprint['read'] = {}
    const onlyARead: TrackImprint['read'] = {}
    const onlyBRead: TrackImprint['read'] = {}
    const aRead = A.read || {}
    const bRead = B.read || {}

    const keys = new Set([...Reflect.ownKeys(aRead), ...Reflect.ownKeys(bRead)])
    for (const k of keys) {
        const aVal = aRead[k]
        const bVal = bRead[k]

        // key exists only on one side
        if (!(k in bRead)) {
            onlyARead[k] = aVal
            continue
        }
        if (!(k in aRead)) {
            onlyBRead[k] = bVal
            continue
        }

        // both sides have the key
        const bothObj =
            aVal &&
            bVal &&
            typeof aVal === 'object' &&
            typeof bVal === 'object' &&
            'read' in aVal &&
            'read' in bVal

        if (bothObj) {
            const [i, oa, ob] = trackImprintSplit(
                aVal as TrackImprint,
                bVal as TrackImprint,
            )
            if (i) commonRead[k] = i
            if (oa) onlyARead[k] = oa
            if (ob) onlyBRead[k] = ob
        } else if (aVal === bVal) {
            commonRead[k] = aVal // identical primitive
        } else {
            onlyARead[k] = aVal
            onlyBRead[k] = bVal
        }
    }

    return [
        build(ctorInt, commonRead, commonHas, ownKeysInt),
        build(ctorOnlyA, onlyARead, onlyAHas, ownKeysOnlyA),
        build(ctorOnlyB, onlyBRead, onlyBHas, ownKeysOnlyB),
    ]
}


export class ImprintTreeMap<V = unknown> {
    private roots: Node<V>[] = []

    set (imprint: TrackImprint, value: V): void {
        this.roots = this.insertIntoList(this.roots, imprint, value)
    }

    get (obj: unknown): V | undefined {
        return this.lookupInList(this.roots, obj)
    }

    private insertIntoList (
        list: Node<V>[],
        imprint: TrackImprint,
        value: V,
    ): Node<V>[] {
        for (let i = 0; i < list.length; ++i) {
            const node = list[i]
            const [inter, onlyA, onlyB] = trackImprintSplit(
                node.imprint,
                imprint,
            )

            if (!inter) continue // no overlap → keep scanning

            // 1. replace current node by the *intersection* node
            const interNode: Node<V> = {
                imprint: inter,
                children: [],
            }

            // 2. existing branch (onlyA) becomes a child
            if (onlyA) {
                node.imprint = onlyA
                interNode.children.push(node)
            } else if (node.value !== undefined || node.children.length) {
                // no onlyA: keep node as child to preserve its subtree
                interNode.children.push(node)
            }

            // 3. new branch (onlyB) becomes a child or this node itself
            if (onlyB) {
                interNode.children.push({ imprint: onlyB, value, children: [] })
            } else {
                interNode.value = value // perfect overlap → store value here
            }

            // 4. replace in the list and done
            list[i] = interNode
            return list
        }

        // no intersection with any existing root → push as new root
        list.push({ imprint, value, children: [] })
        return list
    }

    private lookupInList (list: Node<V>[], obj: unknown): V | undefined {
        for (const node of list) {
            if (!match(node.imprint, obj)) {
                continue
            }
            if (node.hasOwnProperty("value")) {
                return node.value
            }
            try {
                return this.lookupInList(node.children, obj)
            } catch(e) {
                if (e instanceof NoMatchingError) {
                    continue
                }
            }
        }
        throw new NoMatchingError("No match found")
    }
}


/* @skip-prod-transpilation */
if (import.meta.vitest) {
    const { it, expect, describe, vi, beforeEach } = import.meta.vitest

    describe("trackImprintSplit", () => {
        it("returns intersection, onlyB, onlyA as expected", () => {
            const weak = (ctor: Function) => new WeakRef(ctor as any);

            const A: TrackImprint = {
                ctor: weak(Object),
                has: {z1: true, z2: false},
                read: {
                    x: 1,
                    y: { ctor: weak(Object), read: { a: 10, c: 4 }, ownKeys: ["a", "c"] },
                },
            };

            const B: TrackImprint = {
                ctor: weak(Object),
                has: {z1: true},
                read: {
                    x: 1,
                    y: { ctor: weak(Object), read: { a: 20, c: 4 }, ownKeys: ["a", "c"] },
                },
            };

            const [intersection, onlyA, onlyB] = trackImprintSplit(A, B);

            expect(intersection).toStrictEqual(
                {
                    ctor: weak(Object),
                    has: {z1: true},
                    read: {
                        x: 1,
                        y: { ctor: weak(Object), read: { c: 4 }, ownKeys: ["a", "c"] },
                    }
                }
            )

            expect(onlyA).toStrictEqual(
                {
                    has: {z2: false},
                    read: {
                        y: { read: { a: 10 } },
                    }
                }
            )

            expect(onlyB).toStrictEqual(
                {
                    read: {
                        y: { read: { a: 20 } },
                    }
                }
            )

        });
    });
    describe("ImprintTreeMap.set / get", () => {
        it("stores and retrieves via splitting", () => {
            const weak = (c: Function) => new WeakRef(c as any);

            const A = { ctor: weak(Object), has: {y: false}, read: { x: 1 } };
            const B = { ctor: weak(Object), read: { x: 1, y: 2 } };
            const C = { ctor: weak(Object), read: { x: 1, y: 3 }, ownKeys: ["x", "y"]};
            const tree = new ImprintTreeMap<number>();

            tree.set(A, 10);
            tree.set(B, 20);
            tree.set(C, 30);

            expect(tree.get({ x: 1 })).toBe(10);
            expect(tree.get({ x: 1, y: 2 })).toBe(20);
            expect(tree.get({ x: 1, y: 3 })).toBe(30);
            expect(() => tree.get({ x: 2 })).toThrowError();
        });
    });

}
