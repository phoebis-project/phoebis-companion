import type { Register } from 'claude-code'
import { answerCall, errorAnswer, startCheck, TOOL_CALL } from './allowance.ts'
import {
  clearSettings,
  emptyQueue,
  installKeepalive,
  MINIMUM_VERSION,
  redactSecrets,
  resolveSettings,
  startKeepalive,
  versionAtLeast,
} from './keepalive.ts'
import type { Resolution, Settings } from './keepalive.ts'
import { optionsOf, urlProblem } from './settings.ts'

const MISSING: Record<Extract<Resolution, { missing: unknown }>['missing'], string> = {
  no_token: 'phoebis-companion: no router key from the option or the environment',
  no_url: 'phoebis-companion: no management URL from the option or ANTHROPIC_BASE_URL',
  token_without_url: 'phoebis-companion: the token setting needs the Management URL, so this session reports nothing',
}

const UNCONFIGURED = 'no router URL or key resolved at this session start, so the allowance is unknown'

export const register: Register = (on, options) => {
  // The URL and key the last session.start resolved, which the tool reads under. A registered tool outlives a start
  // that resolves nothing, so a call after one answers an error rather than the earlier configuration's router.
  let current: Settings | undefined

  installKeepalive(on, () => optionsOf(options).keepalive)

  on('tool.call', { tool: TOOL_CALL }, async ($) => {
    if (current === undefined) return errorAnswer(UNCONFIGURED)
    return answerCall($, current, await $.session.id(), await $.clock.now())
  }).catch((_$, _e, next) => {
    // A thrown error would fail the model's call, so the failure becomes the answer's text.
    const reason = next.error.message ?? next.error.kind
    return errorAnswer(redactSecrets(`the allowance could not be read (${reason})`, current?.key ?? ''))
  })

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
    const client = base ?? version
    if (!versionAtLeast(client, MINIMUM_VERSION)) return next(e)
    const config = optionsOf(options)
    const [baseUrl, authToken, apiKey, oauthToken] = await Promise.all([
      $.env.get('ANTHROPIC_BASE_URL'),
      $.env.get('ANTHROPIC_AUTH_TOKEN'),
      $.env.get('ANTHROPIC_API_KEY'),
      $.env.get('CLAUDE_CODE_OAUTH_TOKEN'),
    ])
    const resolution = resolveSettings({
      managementUrl: config.managementUrl,
      token: config.token,
      baseUrl,
      authToken,
      apiKey,
      oauthToken,
    })
    if ('missing' in resolution) {
      // An earlier start's settings would otherwise keep the lifecycle reporting, and the next session registering,
      // under a URL and key this start no longer resolves.
      clearSettings()
      current = undefined
      $.ui.log(MISSING[resolution.missing])
      if (config.notifications) $.ui.toast(MISSING[resolution.missing])
      return next(e)
    }
    current = resolution.settings
    const outcome = await startCheck($, resolution.settings, await $.session.id(), client, config.notifications)
    if (outcome === 'refused') {
      // The keepalive route's own 401 empties the queue and cancels the heartbeat timer. Here the held settings go
      // instead, so an earlier start's key sends nothing more and the timer's ticks do nothing until a later start
      // resolves settings again.
      emptyQueue()
      clearSettings()
    } else if (config.keepalive) {
      await startKeepalive($, resolution.settings)
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // A failure inside the mod never changes the event.
}
