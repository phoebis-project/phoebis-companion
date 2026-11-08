import type { Register } from 'claude-code'
import { installKeepalive, MINIMUM_VERSION, resolveSettings, startKeepalive, versionAtLeast } from './keepalive.ts'
import type { Resolution } from './keepalive.ts'

const MISSING: Record<Extract<Resolution, { missing: unknown }>['missing'], string> = {
  no_token: 'phoebis-companion: no router key from the option or the environment',
  no_url: 'phoebis-companion: no management URL from the option or ANTHROPIC_BASE_URL',
  token_without_url: 'phoebis-companion: the token setting needs the Management URL, so this session reports nothing',
}

export const register: Register = (on, options) => {
  installKeepalive(on, () => true)
  on('session.start', async ($, e, next) => {
    const { version, base } = await $.session.version()
    if (!versionAtLeast(base ?? version, MINIMUM_VERSION)) return next(e)
    const resolution = resolveSettings({
      managementUrl: options.management_url,
      token: options.token,
      baseUrl: await $.env.get('ANTHROPIC_BASE_URL'),
      authToken: await $.env.get('ANTHROPIC_AUTH_TOKEN'),
      apiKey: await $.env.get('ANTHROPIC_API_KEY'),
      oauthToken: await $.env.get('CLAUDE_CODE_OAUTH_TOKEN'),
    })
    if ('missing' in resolution) $.ui.log(MISSING[resolution.missing])
    else await startKeepalive($, resolution.settings)
    return next(e)
  }).catch(($, e, next) => next(e)) // A failure inside the mod never changes the event.
}
