import type { EngineInterface } from 'claude-code'
import { bearer, errorText, parsed, PREFIX, redactSecrets, versionAtLeast } from './settings.ts'
import type { Settings } from './settings.ts'

// The start check and the allowance tool: one GET of the allowance route at session start settles whether a router
// answers at the URL, whether the key is valid and whether the key may read the allowance, and the tool answers the
// route's body to the model from a short cache.

const ALLOWANCE_PATH = '/v0/companion/allowance'
const TOOL_NAME = 'allowance'
export const TOOL_CALL = `mcp__phoebis-companion__${TOOL_NAME}` as const
const CACHE_MS = 10_000
// The start check and a call both wait this long for the router, inside the 10 s a hook has per dispatch: a router
// that accepts the connection and never answers would otherwise hold the session start or the model's call with it.
const WAIT_MS = 3_000
const TOOL_MINIMUM_VERSION: readonly [number, number, number] = [2, 1, 293]

const DESCRIPTION = [
  'Reads what this session\'s router key has left in its Phoebis Router pool: the pool\'s ceiling, pinning mode and ' +
  'strategy, the active accounts under pseudonyms with their plan windows and spend, and this session\'s pins. Takes ' +
  'no input and answers the router\'s JSON body as text, from a cache of ten seconds or a fresh read.',
  'The body: `protocol` (1), `now` (the router\'s clock, RFC 3339), `pool` with `ceiling` (the share of a window the ' +
  'pool fills an account to), `pinning` and `strategy`, then `accounts` and `pins`. Each account: `id` (an ' +
  'eight-character pseudonym, the same across sessions on one router and naming no real account), `funding` (plan, ' +
  'usage_based or api_key), `tier`, `obstacle` (why the router would not place on it right now, or null), ' +
  '`pace_score`, `slow_down` (the slow-down in force on it, or null), `windows` keyed by window id (five_hour, ' +
  'seven_day or a model\'s own week, and empty for an API-key account) and `spend`, one row per spend budget with ' +
  '`period`, `spent_usd`, `budget_usd` and `period_end`.',
  'Each window: `utilization`, the share used now, from 0 to 1 of the window. `burn_per_hour`, the share the ' +
  'account\'s sessions burn in an hour, and `demand_per_hour`, what they would burn with no slow-down holding them. ' +
  '`horizon_at`, the window\'s reset or the subscription\'s end, whichever comes first. `projected_at_horizon`, the ' +
  'predicted share at the earlier of horizon_at and five hours from now. `runway_minutes`, the whole minutes until ' +
  'the share reaches the pool\'s ceiling at the current burn: 0 at or above the ceiling, and null means unbounded.',
  'Each pin of this session: `agent` (main or a subagent id), `model`, `account` (a pseudonym), `placed_at`, ' +
  '`last_used_at`, `warm` and `warm_until` for its cache entry, `runway_minutes` on the window that binds it ' +
  '(`binding_window`) and `slow_down`.',
  'Read it for pace alone. A long runway, or null on every window, means room for a long run or a fan-out. A short ' +
  'runway on the account a pin names means the pool is close to its ceiling on that window at the current burn: ' +
  'finish the work before then, wait for the reset horizon_at names, or spread the work out. The accounts are ' +
  'pseudonymous, and the router keeps the final say on placement: this tool steers no placement, no pin and no ' +
  'shedding round.',
  'A call pays before a long autonomous run, before a fan-out of subagents, and after a turn that felt slow. Calls ' +
  'inside ten seconds read one cached answer. While the router cannot be reached, the answer is an error text ' +
  'naming the failure.',
].join('\n\n')

type Fetched = { status: number; text: string } | { failure: string }

/** What the start check does with the answer, or `stale` when a later start began while its GET was out. */
type StartOutcome = 'register' | 'not_permitted' | 'refused' | 'stale' | 'unreachable'

type ToolAnswer = { result: { content: { type: 'text'; text: string }[]; isError?: true } }

const NOT_PERMITTED = `${PREFIX}this key may not read the allowance`

// The entry names its session, since a /clear starts a new session id with no session.start to clear the cache.
let cache: { at: number; sessionId: string; text: string } | undefined
// An earlier start's GET can land after a later start refilled the cache or left no configuration, so a GET's answer
// counts only while no later start has retired it.
let generation = 0

/** True for a text that parses as a JSON object with `protocol: 1`, which is what the allowance route answers. */
function isAllowance(text: string): boolean {
  return parsed(text).protocol === 1
}

/** One GET of the allowance, the failure text for a transport error. */
async function fetchAllowance($: EngineInterface, settings: Settings, sessionId: string): Promise<Fetched> {
  const url = `${settings.url}${ALLOWANCE_PATH}?session_id=${encodeURIComponent(sessionId)}`
  try {
    const response = await $.http.fetch(url, { headers: bearer(settings.key) })
    return { status: response.status, text: response.text }
  } catch (error) {
    // The host's message may quote the request, bearer included.
    return { failure: redactSecrets(errorText(error), settings.key) }
  }
}

/** The GET bounded by WAIT_MS: its answer, or a failure when the wait ends first and the answer is dropped. */
function fetchWithin($: EngineInterface, settings: Settings, sessionId: string): Promise<Fetched> {
  return Promise.race([
    fetchAllowance($, settings, sessionId),
    $.clock.sleep(WAIT_MS).then((): Fetched => ({ failure: `no answer within ${WAIT_MS / 1000} seconds` })),
  ])
}

/** The body of a `200` that is the allowance, which is the one answer the cache may hold. */
function allowanceOf(fetched: Fetched): string | undefined {
  if ('failure' in fetched) return undefined
  return fetched.status === 200 && isAllowance(fetched.text) ? fetched.text : undefined
}

function outcomeOf(fetched: Fetched, body: string | undefined): StartOutcome {
  if (body !== undefined) return 'register'
  if ('failure' in fetched) return 'unreachable'
  if (fetched.status === 401) return 'refused'
  if (fetched.status === 403 && parsed(fetched.text).code === 'companion_not_permitted') return 'not_permitted'
  return 'unreachable'
}

/** The parenthesis of the unreachable line and of the tool's error text. */
function reasonOf(fetched: Fetched): string {
  if ('failure' in fetched) return fetched.failure
  return fetched.status === 200 ? 'not the allowance' : String(fetched.status)
}

function unreachable(fetched: Fetched, settings: Settings): string {
  return redactSecrets(`no answer from the router at ${settings.url} (${reasonOf(fetched)})`, settings.key)
}

function answer(text: string): ToolAnswer {
  return { result: { content: [{ type: 'text', text }] } }
}

export function errorAnswer(text: string): ToolAnswer {
  return { result: { content: [{ type: 'text', text }], isError: true } }
}

/**
 * The tool's answer: this session's cached body inside CACHE_MS, else one bounded GET, a failure as text with isError.
 */
export async function answerCall($: EngineInterface, settings: Settings, sessionId: string, now: number):
  Promise<ToolAnswer> {
  if (cache !== undefined && cache.sessionId === sessionId && now - cache.at < CACHE_MS) return answer(cache.text)
  const sent = generation
  const fetched = await fetchWithin($, settings, sessionId)
  const body = allowanceOf(fetched)
  if (body === undefined) return errorAnswer(unreachable(fetched, settings))
  if (sent === generation) cache = { at: now, sessionId, text: body }
  return answer(body)
}

async function registerTool($: EngineInterface, client: string): Promise<void> {
  if (!versionAtLeast(client, TOOL_MINIMUM_VERSION)) {
    $.ui.log(`${PREFIX}Claude Code ${client} is older than ${TOOL_MINIMUM_VERSION.join('.')}, so the allowance tool ` +
      'is not registered', { to: 'debug' })
    return
  }
  try {
    await $.tool.register({
      name: TOOL_NAME,
      description: DESCRIPTION,
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
  } catch (error) {
    // A registration the engine refuses costs the tool alone, never the keepalive start that follows it.
    $.ui.log(`${PREFIX}the allowance tool could not be registered (${errorText(error)})`, { to: 'debug' })
  }
}

/** Makes every start check and call whose GET is still out stale: its answer is neither cached nor acted on. */
export function retireStarts(): void {
  generation += 1
}

/**
 * The start check: the cache cleared, one GET bounded by WAIT_MS, the transcript or debug line with its toast, and the
 * tool's registration on every outcome but a refused key and a withheld permission. A check whose GET a later start
 * overtook answers `stale` and does nothing after the GET.
 */
export async function startCheck($: EngineInterface, settings: Settings, sessionId: string, client: string,
  notifications: boolean): Promise<StartOutcome> {
  // A reload under a changed URL or key must never answer the earlier configuration's body.
  retireStarts()
  const sent = generation
  cache = undefined
  const now = await $.clock.now()
  const fetched = await fetchWithin($, settings, sessionId)
  if (sent !== generation) return 'stale'
  const body = allowanceOf(fetched)
  const outcome = outcomeOf(fetched, body)
  if (body !== undefined) cache = { at: now, sessionId, text: body }
  if (outcome === 'not_permitted') $.ui.log(NOT_PERMITTED, { to: 'debug' })
  if (outcome === 'refused' || outcome === 'unreachable') {
    const line = outcome === 'refused'
      ? redactSecrets(`${PREFIX}the router at ${settings.url} refused the key (401), so this session reports nothing`,
        settings.key)
      : `${PREFIX}${unreachable(fetched, settings)}, the allowance tool answers once it is back`
    $.ui.log(line)
    if (notifications) $.ui.toast(line)
  }
  // The tool list sits at the front of the prompt's cached prefix, so the tool is registered while the router is
  // unreachable rather than appearing later and rewriting the whole prefix once.
  if (outcome === 'register' || outcome === 'unreachable') await registerTool($, client)
  return outcome
}
