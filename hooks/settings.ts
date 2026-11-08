import type { PluginOptions } from 'claude-code'

const CREDENTIAL = 'a URL with a username or password'
const QUERY = 'a URL with a query'
const NOT_HTTP = 'an http or https URL with a host'

export type Options = { managementUrl: string; token: string; keepalive: boolean; notifications: boolean }

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
