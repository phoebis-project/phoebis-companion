import type { Register } from 'claude-code'
import { answerCall, errorAnswer, startCheck, TOOL_CALL } from './allowance.ts'
import { clearSettings, emptyQueue, installKeepalive, MINIMUM_VERSION, startKeepalive } from './keepalive.ts'
import { optionsOf, PREFIX, redactSecrets, resolveSettings, urlProblem, versionAtLeast } from './settings.ts'
import type { Resolution, Settings } from './settings.ts'

const MISSING: Record<Extract<Resolution, { missing: unknown }>['missing'], string> = {
  invalid_url: `${PREFIX}the management URL from the option or ANTHROPIC_BASE_URL is not usable`,
  no_token: `${PREFIX}no router key from the option or the environment`,
  no_url: `${PREFIX}no management URL from the option or ANTHROPIC_BASE_URL`,
  token_without_url: `${PREFIX}the token setting needs the Management URL, so this session reports nothing`,
}

const UNCONFIGURED = 'the allowance is unknown: this session\'s last start left no usable router configuration ' +
  '(settings missing or unusable, key refused or start failed)'

export const register: Register = (on, options) => {
  // The URL and key the last session.start resolved, which the tool reads under. A registered tool outlives a start
  // that leaves no configuration, so a call after one answers an error rather than the earlier configuration's router.
  let current: Settings | undefined
  // The options hold for the activation: a change reloads the plugin and runs register again.
  const config = optionsOf(options)

  // An earlier start's settings would otherwise keep the lifecycle reporting, the next session registering and the
  // tool reading under a URL and key this start no longer resolves, and a report queued under that key would go out
  // under a later start's. The heartbeat timer stays, its ticks doing nothing until a later start resolves settings.
  function deactivate(): void {
    current = undefined
    clearSettings()
    emptyQueue()
  }

  if (config.keepalive) installKeepalive(on)

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

  on('session.start', async ($, e, next) => {
    const { version, base } = await $.session.version()
    const client = base ?? version
    if (!versionAtLeast(client, MINIMUM_VERSION)) return next(e)
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
      const line = 'problem' in resolution
        ? `${MISSING[resolution.missing]} (${resolution.problem})`
        : MISSING[resolution.missing]
      deactivate()
      $.ui.log(line)
      if (config.notifications) $.ui.toast(line)
      return next(e)
    }
    const sessionId = await $.session.id()
    // A later start that began while this one's GET was out owns the configuration, so a stale check leaves it alone.
    // No await falls between setting current and startCheck's generation step, so the start that set current last is
    // the one whose check is not stale.
    current = resolution.settings
    const outcome = await startCheck($, resolution.settings, sessionId, client, config.notifications)
    if (outcome === 'stale') return next(e)
    if (outcome === 'refused') {
      deactivate()
    } else if (config.keepalive) {
      await startKeepalive($, resolution.settings)
    }
    return next(e)
  }).catch(($, e, next) => {
    const key = current?.key ?? ''
    deactivate()
    const reason = next.error.message ?? next.error.kind
    $.ui.log(redactSecrets(`${PREFIX}the session start hook failed (${reason}), so this session reports nothing`, key),
      { to: 'debug' })
    // A failure inside the mod never changes the event.
    return next(e)
  })
}
