import type { PluginOptions } from 'claude-code'

// The settings layer and the helpers the two hooks modules share. keepalive.ts and allowance.ts both import it, so the
// allowance tool, which runs with the keepalive switch off, depends on nothing in the lifecycle.

const CREDENTIAL = 'a URL with a username or password'
const QUERY = 'a URL with a query'
const NOT_HTTP = 'an http or https URL with a host'
export const PREFIX = 'phoebis-companion: '

type Options = { managementUrl: string; token: string; keepalive: boolean; notifications: boolean }

export type Settings = { url: string; key: string }

type SettingSources = {
  managementUrl: string
  token: string
  baseUrl: string | undefined
  authToken: string | undefined
  apiKey: string | undefined
  oauthToken: string | undefined
}

export type Resolution =
  | { settings: Settings }
  | { missing: 'no_url' | 'no_token' | 'token_without_url' }

/** `undefined` when the URL is acceptable, else the reason the `config.set` hook denies it. */
export function urlProblem(value: unknown): string | undefined {
  if (typeof value !== 'string') return NOT_HTTP
  // A blank URL leaves the router's address to ANTHROPIC_BASE_URL, as resolveSettings reads it.
  if (value.trim() === '') return undefined
  if (!URL.canParse(value)) return NOT_HTTP
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return NOT_HTTP
  // The URL is stored in plain settings, unlike the sensitive token, so a credential in it would sit there in clear.
  if (url.username !== '' || url.password !== '') return CREDENTIAL
  // The route paths are appended to the URL, so anything after the path, a query or a fragment, would swallow them.
  const prefix = url.origin + url.pathname
  if (url.href === prefix) return undefined
  return url.href.startsWith(`${prefix}?`) ? QUERY : NOT_HTTP
}

/** The four options as the manifest types them, a wrong type read as the default. */
export function optionsOf(options: PluginOptions): Options {
  return {
    managementUrl: typeof options.management_url === 'string' ? options.management_url : '',
    token: typeof options.token === 'string' ? options.token : '',
    keepalive: typeof options.keepalive === 'boolean' ? options.keepalive : true,
    notifications: typeof options.notifications === 'boolean' ? options.notifications : true,
  }
}

export function versionAtLeast(version: string, minimum: readonly [number, number, number]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (match === null) return false
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const [leastMajor, leastMinor, leastPatch] = minimum
  if (major !== leastMajor) return major > leastMajor
  if (minor !== leastMinor) return minor > leastMinor
  return patch >= leastPatch
}

function given(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

// A repository's settings can set ANTHROPIC_BASE_URL, so that URL carries the environment's own token alone, and the
// token setting goes to management_url or nowhere.
function tokenWithoutUrl(sources: SettingSources): boolean {
  return given(sources.token) !== undefined && given(sources.managementUrl) === undefined
}

/** The URL and the key the mod reports under, or which source is missing. A token from the setting needs the URL. */
export function resolveSettings(sources: SettingSources): Resolution {
  if (tokenWithoutUrl(sources)) return { missing: 'token_without_url' }
  const url = given(sources.managementUrl) ?? given(sources.baseUrl)
  if (url === undefined) return { missing: 'no_url' }
  // The variables rank as the client ranks them, so the key the mod reports under is the key the client sends.
  const key =
    given(sources.token) ?? given(sources.authToken) ?? given(sources.apiKey) ?? given(sources.oauthToken)
  if (key === undefined) return { missing: 'no_token' }
  // Route paths are appended to the URL, so a trailing slash would double.
  return { settings: { url: url.endsWith('/') ? url.slice(0, -1) : url, key } }
}

/**
 * An error's message with the configured key and any URL userinfo taken out, so a host error that quotes the request
 * leaves no credential in the debug log, whatever the host put in the message. The key goes first, so a key inside
 * a URL's userinfo is covered twice over. The userinfo runs from the scheme's `://` to the last `@` before the first
 * `/` after it, whitespace included, since a password may carry a raw `@` or a space and a raw `/` ends the authority.
 * Text after a `://` that is no userinfo but holds an `@` before the next `/` is taken out too, the safe direction.
 */
export function redactSecrets(message: string, key: string): string {
  const withoutKey = key === '' ? message : message.split(key).join('<key>')
  return withoutKey.replace(/:\/\/[^/]+@/g, '://<redacted>@')
}

export function bearer(key: string): Record<string, string> {
  return { Authorization: 'Bearer ' + key }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function parsed(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    const object = typeof value === 'object' && value !== null && !Array.isArray(value)
    return object ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
