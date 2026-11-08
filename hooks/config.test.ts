import { expect, test } from 'claude-code/testing'
import { MINIMUM_VERSION, resolveSettings, versionAtLeast } from './keepalive.ts'
import type { SettingSources } from './keepalive.ts'

const ROUTER = 'http://127.0.0.1:8317'

const UNSET: SettingSources = {
  managementUrl: '',
  token: '',
  baseUrl: undefined,
  authToken: undefined,
  apiKey: undefined,
  oauthToken: undefined,
}

test('the option wins over the variable and a trailing slash leaves', () => {
  expect(
    resolveSettings({ ...UNSET, managementUrl: 'http://router.example:9000/', baseUrl: ROUTER, authToken: 'auth-key' }),
  ).toStrictEqual({ settings: { url: 'http://router.example:9000', key: 'auth-key' } })
  expect(resolveSettings({ ...UNSET, baseUrl: `${ROUTER}/`, authToken: 'auth-key' })).toStrictEqual({
    settings: { url: ROUTER, key: 'auth-key' },
  })
})

test('a path prefix in the url stays', () => {
  expect(
    resolveSettings({ ...UNSET, managementUrl: 'https://gateway.example/phoebis/', authToken: 'auth-key' }),
  ).toStrictEqual({ settings: { url: 'https://gateway.example/phoebis', key: 'auth-key' } })
  expect(resolveSettings({ ...UNSET, baseUrl: `${ROUTER}/team/a`, oauthToken: 'oauth-key' })).toStrictEqual({
    settings: { url: `${ROUTER}/team/a`, key: 'oauth-key' },
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
  expect(resolveSettings(option)).toStrictEqual({ missing: 'token_without_url' })
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

test('no url or no key names the missing source', () => {
  const both = { ...UNSET, baseUrl: ROUTER, authToken: 'auth-key' }
  expect(resolveSettings(both)).toStrictEqual({ settings: { url: ROUTER, key: 'auth-key' } })
  expect(resolveSettings({ ...both, baseUrl: undefined })).toStrictEqual({ missing: 'no_url' })
  expect(resolveSettings({ ...both, authToken: undefined })).toStrictEqual({ missing: 'no_token' })
  expect(resolveSettings(UNSET)).toStrictEqual({ missing: 'no_url' })
})

test('a blank token is no token, so the environment\'s token serves', () => {
  expect(resolveSettings({ ...UNSET, baseUrl: ROUTER, token: ' \n', authToken: 'auth-key' }))
    .toStrictEqual({ settings: { url: ROUTER, key: 'auth-key' } })
  expect(resolveSettings({ ...UNSET, managementUrl: ROUTER, token: '', authToken: 'auth-key' }))
    .toStrictEqual({ settings: { url: ROUTER, key: 'auth-key' } })
})

test('the minimum version admits 2.1.287, 2.1.290-dev and 3.0.0 and refuses 2.1.286', () => {
  expect(MINIMUM_VERSION).toEqual([2, 1, 287])
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
