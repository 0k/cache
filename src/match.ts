import { track, TrackImprint } from './track'


export function match (imprint: TrackImprint, obj: unknown): boolean {
    if (obj === null || typeof obj !== 'object') return false

    //  optional ctor check
    if (imprint.ctor) {
        const expected = imprint.ctor.deref() // may be undefined if GC-ed
        if (expected && (obj as any).constructor !== expected) return false
    }

    // optional has check
    for (const key of Reflect.ownKeys(imprint.has || {})) {
        const expected = (imprint.has as any)[key]
        const actual = key in (obj as any)

        if (actual !== expected) return false
    }

    // optional ownKeys
    if (imprint.ownKeys) {
        const expected = imprint.ownKeys
        const actual = Object.keys(obj)
        if (actual.length !== expected.length) return false
        if (!actual.every((v, i) => v === expected[i])) return false
    }

    // option property check
    for (const key of Reflect.ownKeys(imprint.read || {})) {
        const expected = imprint.read[key]
        const actual = obj[key]

        if (expected !== null && typeof expected === 'object') {
            if (!match(expected as TrackImprint, actual)) return false
        } else {
            if (actual !== expected) return false
        }
    }
    return true
}

/* @skip-prod-transpilation */
if (import.meta.vitest) {
    const { it, expect, describe, vi, beforeEach } = import.meta.vitest

    describe('track and match', () => {
        it('should track imprint with get', () => {
            let a = {
                b: 1,
                c: {
                    d: 1,
                    e: 2,
                },
            }
            let tracker = track(a)
            a = tracker.proxy

            a.b + a.c.d

            let t = tracker.getTrackAndRevoke()
            expect(match(t, { b: 1, d: 2, c: { d: 1 } })).toBe(true)
            expect(match(t, { b: 1, d: 3, c: { d: 1 } })).toBe(true)
            expect(match(t, { b: 1, d: 3, c: { d: 2 } })).toBe(false)
        })
        it('should track imprint with has', () => {
            let a = {
                b: 1,
                c: {
                    d: 1,
                    e: 2,
                },
            }
            let tracker = track(a)
            a = tracker.proxy

            'b' in a

            let t = tracker.getTrackAndRevoke()
            expect(match(t, { b: 1 })).toBe(true)
            expect(match(t, { b: false })).toBe(true)
            expect(match(t, { c: null })).toBe(false)
        })
        it('should track imprint with ownKey', () => {
            let a = {
                b: 1,
                c: {
                    d: 1,
                    e: 2,
                },
            }
            let tracker = track(a)
            a = tracker.proxy

            Object.keys(a.c)

            let t = tracker.getTrackAndRevoke()
            expect(match(t, { b: 1 })).toBe(false)
            expect(match(t, { c: { d: false, e: undefined } })).toBe(true)
            expect(match(t, { c: { d: false, e: undefined, f: true } })).toBe(
                false,
            )
        })
    })
}
