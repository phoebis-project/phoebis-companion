import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { MINIMUM_VERSION } from './keepalive.ts'
import { resolveSettings, urlProblem, versionAtLeast } from './settings.ts'
import { fakeRouter } from './testing.ts'
import type { FakeRouter } from './testing.ts'

const ROUTER = 'http://127.0.0.1:8317'
const KEY = 'k-test'
const CONFIGURED = { options: { management_url: ROUTER } }
const CONFIGURED_OFF = { options: { management_url: ROUTER, keepalive: false } }

const UNSET: Parameters<typeof resolveSettings>[0] = {
  managementUrl: '',
  token: '',
  baseUrl: undefined,
  authToken: undefined,
  apiKey: undefined,
  oauthToken: undefined,
}

function host(on: On): { clock: MockClock; router: FakeRouter } {
  mock.env(on, { ANTHROPIC_AUTH_TOKEN: KEY })
  const clock = mock.clock(on)
  return { clock, router: fakeRouter(on, clock) }
}

async function start($: Engine, clock: MockClock): Promise<void> {
  await $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
  await clock.settle()
}

test('the option wins over the variable and a trailing slash leaves', () => {
  expect(
    resolveSettings({ ...UNSET, managementUrl: 'http://router.example:9000/', baseUrl: ROUTER, authToken: 'auth-key' }),
  ).toStrictEqual({ settings: { url: 'http://router.example:9000', key: 'auth-key' } })
  expect(resolveSettings({ ...UNSET, baseUrl: `${ROUTER}/`, authToken: 'auth-key' })).toStrictEqual({
    settings: { url: ROUTER, key: 'auth-key' },
  })
})

test('the token option wins, then ANTHROPIC_AUTH_TOKEN, then ANTHROPIC_API_KEY, then CLAUDE_CODE_OAUTH_TOKEN', () => {
  const all = {
    ...UNSET,
    managementUrl: ROUTER,
    token: 'option-key',
    authToken: 'auth-key',
    apiKey: 'api-key',
    oauthToken: 'oauth-key',
  }
  expect(resolveSettings(all)).toStrictEqual({ settings: { url: ROUTER, key: 'option-key' } })
  expect(resolveSettings({ ...all, token: '' })).toStrictEqual({ settings: { url: ROUTER, key: 'auth-key' } })
  expect(resolveSettings({ ...all, token: '', authToken: undefined }))
    .toStrictEqual({ settings: { url: ROUTER, key: 'api-key' } })
  expect(resolveSettings({ ...all, token: '', authToken: undefined, apiKey: undefined }))
    .toStrictEqual({ settings: { url: ROUTER, key: 'oauth-key' } })
})

test('a token from the option goes to management_url alone and never to ANTHROPIC_BASE_URL', () => {
  const option = { ...UNSET, baseUrl: ROUTER, token: 'option-key', authToken: 'auth-key' }
  expect(resolveSettings({ ...option, managementUrl: ' ' })).toStrictEqual({ missing: 'token_without_url' })
  expect(resolveSettings({ ...option, managementUrl: 'http://router.example:9000' }))
    .toStrictEqual({ settings: { url: 'http://router.example:9000', key: 'option-key' } })
})

test('an empty or blank source counts as unset', () => {
  expect(
    resolveSettings({ ...UNSET, managementUrl: '  ', token: '\n', baseUrl: ROUTER, authToken: '',
      oauthToken: 'oauth-key' }),
  ).toStrictEqual({ settings: { url: ROUTER, key: 'oauth-key' } })
  expect(resolveSettings({ ...UNSET, managementUrl: ' ', baseUrl: ' \t', token: ' ', authToken: 'auth-key' }))
    .toStrictEqual({ missing: 'no_url' })
})

test('the minimum version admits 2.1.287, 2.1.290-dev and 3.0.0 and refuses 2.1.286', () => {
  expect(versionAtLeast('2.1.287', MINIMUM_VERSION)).toBe(true)
  expect(versionAtLeast('2.1.290-dev', MINIMUM_VERSION)).toBe(true)
  expect(versionAtLeast('3.0.0', MINIMUM_VERSION)).toBe(true)
  expect(versionAtLeast('2.1.286', MINIMUM_VERSION)).toBe(false)
})

test('the minimum version admits 2.2.0 and refuses 1.9.999 and a string that names no version', () => {
  expect(versionAtLeast('2.2.0', MINIMUM_VERSION)).toBe(true)
  expect(versionAtLeast('1.9.999', MINIMUM_VERSION)).toBe(false)
  expect(versionAtLeast('not a version', MINIMUM_VERSION)).toBe(false)
})

test('config.set denies a URL with a credential or a query and takes a path prefix', async () => {
  expect(urlProblem('https://user:pw@router.example/')).toBe('a URL with a username or password')
  expect(urlProblem('http://router.example/?x=1')).toBe('a URL with a query')
  expect(urlProblem('router.example:8317')).toBe('an http or https URL with a host')
  expect(urlProblem('http://127.0.0.1:8317/phoebis')).toBeUndefined()
  expect(urlProblem('')).toBeUndefined()
})

test('a URL with a fragment is refused, as the route paths appended to it would land in the fragment', () => {
  expect(urlProblem('http://127.0.0.1:8317/#/sessions')).toBe('an http or https URL with a host')
})

test('the management_url hook keeps a URL with a credential out of the settings and writes a path prefix',
  async ($, on) => {
    const { router } = host(on)
    const key = 'phoebis-companion.management_url'
    expect(await router.setConfig($, { key, value: 'https://user:pw@router.example/', previous: '' }))
      .toStrictEqual({ deny: 'a URL with a username or password' })
    expect(await router.setConfig($, { key, value: `${ROUTER}/phoebis`, previous: '' }))
      .toStrictEqual({ value: `${ROUTER}/phoebis` })
    expect(router.configWrites).toStrictEqual([{ key, value: `${ROUTER}/phoebis` }])
  })

test('the token hook forwards the trimmed value to the writer', CONFIGURED, async ($, on) => {
  const { router } = host(on)
  const result = await router.setConfig($, { key: 'phoebis-companion.token', value: ' k-new ', previous: '' })
  expect(result).toStrictEqual({ value: 'k-new' })
  expect(router.configWrites).toStrictEqual([{ key: 'phoebis-companion.token', value: 'k-new' }])
})

describe('a missing setting raises a toast beside its transcript line only while notifications is on', () => {
  const line = 'phoebis-companion: no management URL from the option or ANTHROPIC_BASE_URL'
  const cases = [['on by default', {}, [line]], ['off', { notifications: false }, []]] as const
  for (const [name, options, toasts] of cases) {
    test(name, { options }, async ($, on) => {
      const { clock, router } = host(on)
      await start($, clock)
      expect(router.logs).toEqual([{ text: line, to: 'transcript' }])
      expect(router.toasts).toEqual(toasts)
    })
  }
})

test('a start that finds no router key leaves nothing reported under the settings an earlier start resolved',
  CONFIGURED, async ($, on) => {
    const variables = new Map([['ANTHROPIC_AUTH_TOKEN', KEY]])
    on('env.get', (_$, e) => ({ value: variables.get(e.name) }))
    const clock = mock.clock(on)
    const router = fakeRouter(on, clock)
    await start($, clock)
    await $.session.end({ reason: 'clear', sessionId: 'session-a', resume: { id: 'session-a' } })
    variables.delete('ANTHROPIC_AUTH_TOKEN')
    router.setId('session-b')
    await start($, clock)
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
    await clock.advance(60000)
    expect(router.requests.map((body) => body.event)).toEqual(['session_start', 'session_end'])
    expect(router.logs).toEqual([
      { text: 'phoebis-companion: no router key from the option or the environment', to: 'transcript' },
    ])
  })

test('keepalive off sends no session_start while the allowance GET still goes out', CONFIGURED_OFF,
  async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    expect(router.gets.map((get) => get.url)).toStrictEqual([`${ROUTER}/v0/companion/allowance?session_id=session-a`])
    expect(router.requests).toStrictEqual([])
  })
