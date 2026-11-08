import type { Register } from 'claude-code'
import { answerCall, errorAnswer, retireStarts, startCheck, TOOL_CALL } from './allowance.ts'
import { clearSettings, emptyQueue, installKeepalive, MINIMUM_VERSION, startKeepalive } from './keepalive.ts'
import { errorText, optionsOf, PREFIX, redactSecrets, resolveSettings, urlProblem, versionAtLeast } from './settings.ts'
import type { Resolution, Settings } from './settings.ts'

const MISSING: Record<Extract<Resolution, { missing: unknown }>['missing'], string> = {
  invalid_url: `${PREFIX}the management URL from the option or ANTHROPIC_BASE_URL is not usable`,
  no_token: `${PREFIX}no router key from the option or the environment`,
  no_url: `${PREFIX}no management URL from the option or ANTHROPIC_BASE_URL`,
  token_without_url: `${PREFIX}the token setting needs the Management URL, so this session reports nothing`,
}

const UNCONFIGURED = 'the allowance is unknown: this session\'s last start left no usable router configuration ' +
  '(settings missing or unusable, key refused or start failed)'

// Counts the session starts, so a start that throws clears the configuration only while no later start has begun.
let starts = 0

export const register: Register = (on, options) => {
  // The URL and key the last session.start resolved, which the tool reads under. A registered tool outlives a start
  // that leaves no configuration, so a call after one answers an error rather than the earlier configuration's router.
  let current: Settings | undefined
  // The options hold for the activation: a change reloads the plugin and runs register again.
  const config = optionsOf(options)

  // An earlier start's settings would otherwise keep the lifecycle reporting, the next session registering and the
  // tool reading under a URL and key this start no longer resolves, a report queued under that key would go out under
  // a later start's, and an earlier start whose GET is still out would act on its answer once it lands. The heartbeat
  // timer stays, its ticks doing nothing until a later start resolves settings.
  function deactivate(): void {
    current = undefined
    clearSettings()
    emptyQueue()
    retireStarts()
  }

  if (config.keepalive) installKeepalive(on)

  on('tool.call', { tool: TOOL_CALL }, async ($) => {
    const sessionId = await $.session.id()
    const now = await $.clock.now()
    // current is read in the same synchronous step as answerCall's generation, so a start that lands during the two
    // reads above cannot pair its generation with the settings it replaced.
    if (current === undefined) return errorAnswer(UNCONFIGURED)
    return answerCall($, current, sessionId, now)
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
    starts += 1
    const start = starts
    // Each `return next(e)` below hands back its promise unawaited, so a rejection beneath never reaches this catch.
    try {
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
      // No await falls between setting current and startCheck's generation step, so the start that set current last
      // is the one whose check is not stale.
      current = resolution.settings
      const outcome = await startCheck($, resolution.settings, sessionId, client, config.notifications)
      // A later start that set or cleared current during the check owns the configuration, so this one leaves it.
      if (outcome === 'stale' || current !== resolution.settings) return next(e)
      if (outcome === 'refused') {
        deactivate()
      } else if (config.keepalive) {
        await startKeepalive($, resolution.settings, () => current === resolution.settings)
      }
      return next(e)
    } catch (error) {
      // A later start may already hold the configuration, and an earlier start's failure must not clear it.
      if (start === starts) {
        const key = current?.key ?? ''
        deactivate()
        const line = `${PREFIX}the session start hook failed (${errorText(error)}), so this session reports nothing`
        $.ui.log(redactSecrets(line, key), { to: 'debug' })
      }
      return next(e)
    }
  }).catch(($, e, next) => next(e)) // A failure inside the mod never changes the event.
}
