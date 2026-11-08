import type { Register } from 'claude-code'
import {
  clearSettings,
  installKeepalive,
  MINIMUM_VERSION,
  resolveSettings,
  startKeepalive,
  versionAtLeast,
} from './keepalive.ts'
import type { Resolution } from './keepalive.ts'
import { optionsOf, urlProblem } from './settings.ts'

const MISSING: Record<Extract<Resolution, { missing: unknown }>['missing'], string> = {
  no_token: 'phoebis-companion: no router key from the option or the environment',
  no_url: 'phoebis-companion: no management URL from the option or ANTHROPIC_BASE_URL',
  token_without_url: 'phoebis-companion: the token setting needs the Management URL, so this session reports nothing',
}

export const register: Register = (on, options) => {
  installKeepalive(on, () => optionsOf(options).keepalive)

  on('config.set', { key: 'phoebis-companion.management_url' }, (_$, e, next) => {
    const problem = urlProblem(e.value)
    return problem === undefined ? next(e) : { deny: problem }
  })

  // The engine writes the row beneath next, so an answer of { value } without it would leave the stored token as it
  // was while the menu shows the trimmed one.
  on('config.set', { key: 'phoebis-companion.token' }, (_$, e, next) =>
    next(typeof e.value === 'string' ? { ...e, value: e.value.trim() } : e))

  // Every row shows as the manifest declares it, and this is the seat for a row a later version describes.
  on('config.describe', (_$, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const { version, base } = await $.session.version()
    if (!versionAtLeast(base ?? version, MINIMUM_VERSION)) return next(e)
    const config = optionsOf(options)
    const resolution = resolveSettings({
      managementUrl: config.managementUrl,
      token: config.token,
      baseUrl: await $.env.get('ANTHROPIC_BASE_URL'),
      authToken: await $.env.get('ANTHROPIC_AUTH_TOKEN'),
      apiKey: await $.env.get('ANTHROPIC_API_KEY'),
      oauthToken: await $.env.get('CLAUDE_CODE_OAUTH_TOKEN'),
    })
    if ('missing' in resolution) {
      // An earlier start's settings would otherwise keep the lifecycle reporting, and the next session registering,
      // under a URL and key this start no longer resolves.
      clearSettings()
      $.ui.log(MISSING[resolution.missing])
      if (config.notifications) $.ui.toast(MISSING[resolution.missing])
      return next(e)
    }
    if (config.keepalive) await startKeepalive($, resolution.settings)
    return next(e)
  }).catch(($, e, next) => next(e)) // A failure inside the mod never changes the event.
}
