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
export type SessionRead = { branch?: unknown; cwd?: unknown; project?: unknown; remote?: unknown;
  repositoryRoot?: unknown; title?: unknown }

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

/**
 * The first `:` outside square brackets ahead of the first `/`, or -1, and whether a `[` ahead of that `/` is still
 * open where the walk stopped.
 */
function headOf(value: string): { colon: number; open: boolean } {
  let open = false
  for (let at = 0; at < value.length && value[at] !== '/'; at += 1) {
    const char = value[at]
    if (char === '[') open = true
    else if (char === ']') open = false
    else if (char === ':' && !open) return { colon: at, open }
  }
  return { colon: -1, open }
}

/** Whether a result reads as `host/path` itself, the form the router keeps as it is given. */
function readsReduced(value: string): boolean {
  if (/[@?#\\ ]/.test(value) || value.includes('://') || /^[/.~]/.test(value)) return false
  const { colon, open } = headOf(value)
  // An opening bracket that never closes would hide each colon behind it from the colon test.
  return colon < 0 && !open
}

/**
 * The remote as `host/path`, or no value for a remote the rule cannot read. Git's own value is a URL, the `scp` form
 * or a local path, so a value in neither of the first two forms is a local path and sends nothing.
 */
function reduced(remote: string): string | undefined {
  // A `file` URL names a path on some machine, also behind an authority such as `localhost`.
  if (/^file:\/\//i.test(remote)) return undefined
  let host: string
  let path: string
  const scheme = remote.indexOf('://')
  if (scheme >= 0) {
    const after = remote.slice(scheme + 3)
    const end = after.search(/[/?#]/)
    const authority = end < 0 ? after : after.slice(0, end)
    path = end < 0 ? '' : after.slice(end)
    // A raw `/`, `?` or `#` in a credential ends the authority early, and the cuts below can then remove each sign of
    // it, so an `@` behind the authority's end leaves the user information unreadable.
    if (path.includes('@')) return undefined
    host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '')
  } else {
    const { colon } = headOf(remote)
    if (colon < 0) return undefined
    const left = remote.slice(0, colon)
    // One letter ahead of the colon is a Windows drive.
    if (/^[A-Za-z]$/.test(left)) return undefined
    path = remote.slice(colon + 1)
    if (path.includes('@')) return undefined
    host = left.slice(left.lastIndexOf('@') + 1)
  }
  const cut = path.search(/[?#]/)
  path = (cut < 0 ? path : path.slice(0, cut)).replace(/^\/+/, '').replace(/\/+$/, '')
  // One `.git` alone goes, so a repository named `tools.git` keeps its name.
  if (path.endsWith('.git')) path = path.slice(0, -4).replace(/\/+$/, '')
  // The router folds the ASCII letters of a raw remote's host and keeps the case of a reduced one, so a fold of each
  // script, as `toLowerCase` makes, would name one repository in two ways.
  host = host.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  if (host === '' || path === '') return undefined
  const result = `${host}/${path}`
  return readsReduced(result) ? result : undefined
}

/** The value where it is within `cap` bytes. A cut path, remote or branch would name another one, so none is cut. */
function within(value: string | undefined, cap: number): string | undefined {
  return value !== undefined && bytesOf(value) <= cap ? value : undefined
}

/** The session's set: each member cleaned and capped, and a member with no value left out. */
export function sessionFactSet(read: SessionRead): SessionFactSet {
  const set: SessionFactSet = {}
  const branch = within(cleaned(read.branch), SHORT_CAP)
  if (branch !== undefined) set.branch = branch
  const cwd = within(cleaned(read.cwd), LONG_CAP)
  if (cwd !== undefined) set.cwd = cwd
  const project = within(cleaned(read.project), LONG_CAP)
  if (project !== undefined) set.project = project
  const remote = cleaned(read.remote)
  // The cap counts the reduced value, so a long remote with a short result is kept.
  const repository = within(remote === undefined ? undefined : reduced(remote), LONG_CAP)
  if (repository !== undefined) set.repository = repository
  const root = within(cleaned(read.repositoryRoot), LONG_CAP)
  if (root !== undefined) set.repository_root = root
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
