import type { SessionFactSet } from '../types'

// The facts the mod reports for display. Nothing here holds state. Each rule is the router's, applied here before a
// value leaves the machine, so the set the mod compares for a change is the set the router keeps.

/** The cap of a title, a description, a name, a branch and an agent's type, in bytes of UTF-8. */
const SHORT_CAP = 256
/** The cap of a path and of a reduced remote, in bytes of UTF-8. */
const LONG_CAP = 1024

// Each character is written as its escape, since a raw U+2028 or U+2029 ends the line inside the literal and the
// module would not parse.
const FOLDED = /[\u0009-\u000D\u0085\u{2028}\u{2029}]+/gu
// Under the `u` flag `\p{Cs}` matches an unpaired surrogate alone. The router's decoder refuses a whole body for one.
const REMOVED = /[\p{Cc}\p{Cf}\p{Cs}]/gu

/** What the session read gathered, each member as its source gave it. */
export type SessionRead = { title?: unknown }

/**
 * The value with each run of line breaks and tabs folded to one space, each other control and format character and
 * each unpaired surrogate removed, and the ends trimmed. No value for an empty result or for a value that is no string.
 */
function cleaned(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(FOLDED, ' ').replace(REMOVED, '').trim()
  return text === '' ? undefined : text
}

/** The value's length in bytes of UTF-8, each code point counted as 1, 2, 3 or 4 by its value. */
function bytesOf(value: string): number {
  let bytes = 0
  for (const point of value) {
    const code = point.codePointAt(0) as number
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/**
 * The longest prefix of whole code points within `cap` bytes, trimmed at its end again, so a cut never leaves half of
 * a surrogate pair.
 */
function cutTo(value: string, cap: number): string {
  let bytes = 0
  let end = 0
  for (const point of value) {
    bytes += bytesOf(point)
    if (bytes > cap) return value.slice(0, end).trimEnd()
    end += point.length
  }
  return value
}

/** The session's set: each member cleaned and capped, and a member with no value left out. */
export function sessionFactSet(read: SessionRead): SessionFactSet {
  const set: SessionFactSet = {}
  const title = cleaned(read.title)
  if (title !== undefined) set.title = cutTo(title, SHORT_CAP)
  return set
}

/** Whether two sets hold the same members with the same values. No set counts as the empty set. */
export function sameFacts(a: Readonly<Record<string, string | undefined>> | undefined,
  b: Readonly<Record<string, string | undefined>> | undefined): boolean {
  const left = Object.entries(a ?? {}).filter(([, value]) => value !== undefined)
  const right = b ?? {}
  return left.length === Object.values(right).filter((value) => value !== undefined).length &&
    left.every(([key, value]) => right[key] === value)
}
