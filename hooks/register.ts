import type { Register } from 'claude-code'
import { answerCall, errorAnswer, retireStarts, startCheck, TOOL_CALL } from './allowance'
import { clearSettings, emptyQueue, installKeepalive, startKeepalive } from './keepalive'
import { errorText, optionsOf, redactSecrets, resolveSettings, say, urlProblem } from './settings'
import type { Resolution, Settings } from './settings'

const MISSING: Record<Extract<Resolution, { missing: unknown }>['missing'], string> = {
  invalid_url: 'the management URL from the option or ANTHROPIC_BASE_URL is not usable',
  no_token: 'no router key from the option or the environment',
  no_url: 'no management URL from the option or ANTHROPIC_BASE_URL',
  token_without_url: 'the token setting needs the Management URL, so this session reports nothing',
}

const UNCONFIGURED = 'the allowance is unknown: this session has no usable router configuration ' +
  '(settings missing or unusable, key refused or start failed)'

// Counts the session starts, so a start that throws can tell whether a later start has begun since.
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

  if (config.keepalive) {
    // Only a 401 says the router refused the key, which both routes share. A 403 refuses one request, from something in
    // front of the router, and says nothing about whether the key may read the allowance, which the tool's own route
    // answers. A start that has not yet installed its settings holds settings of its own, so a refusal of the settings
    // it replaced leaves that start current.
    installKeepalive(on, (status, under) => {
      if (status === 401 && current === under) current = undefined
    }, { title: config.reportTitle })
  }

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
    let resolved: Settings | undefined
    const tell = (text: string): void => {
      const line = say($, text)
      if (config.notifications) $.ui.toast(line)
    }
    // Each `return next(e)` below hands back its promise unawaited, so a rejection beneath never reaches this catch.
    try {
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
        // A later start that began during the reads above owns the configuration, so this one leaves it.
        if (start !== starts) return next(e)
        const line = 'problem' in resolution
          ? `${MISSING[resolution.missing]} (${resolution.problem})`
          : MISSING[resolution.missing]
        deactivate()
        tell(line)
        return next(e)
      }
      resolved = resolution.settings
      const sessionId = await $.session.id()
      // No await falls between setting current and startCheck's generation step, so the start that set current last
      // is the one whose check is not stale.
      current = resolution.settings
      const outcome = await startCheck($, resolution.settings, sessionId, tell)
      // A later start that set or cleared current during the check owns the configuration, so this one leaves it.
      if (outcome === 'stale' || current !== resolution.settings) return next(e)
      if (outcome === 'refused') {
        deactivate()
      } else if (config.keepalive) {
        await startKeepalive($, resolution.settings, () => current === resolution.settings)
      }
      return next(e)
    } catch (error) {
      // A later start may already hold the configuration, and an earlier start's failure must not clear it. A start
      // whose settings are still current owns the configuration even when a later start began after it.
      if (start === starts || (resolved !== undefined && current === resolved)) {
        const key = current?.key ?? ''
        deactivate()
        const line = `the session start hook failed (${errorText(error)}), so this session reports nothing`
        say($, redactSecrets(line, key), { to: 'debug' })
      }
      return next(e)
    }
  }).catch(($, e, next) => next(e)) // A failure inside the mod never changes the event.
}
