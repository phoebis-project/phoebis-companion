import type { EngineInterface } from 'claude-code'
import { bearer, errorText, parsed, redactSecrets, say } from './settings'
import type { Settings } from './settings'

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

const DESCRIPTION = [
  'Reads what this session\'s router key has left in its Phoebis Router pool: the pool\'s pinning mode and strategy, ' +
  'the active accounts under pseudonyms with their plan windows and spend, and this session\'s pins. Takes no input ' +
  'and answers the router\'s JSON body as text, from a cache of ten seconds or a fresh read.',
  'The body: `protocol` (1), `now` (the router\'s clock, RFC 3339), `pool` with `pinning` and `strategy`, then ' +
  '`accounts` and `pins`. Each account: `id` (an eight-character pseudonym, the same across sessions on one router ' +
  'and naming no real account), `funding` (plan, usage_based or api_key), `tier`, `obstacle` (budget, ' +
  'budget_unknown, cooldown, overage or spent for a hold on the whole account, else null), `slow_down` (the ' +
  'slow-down in force on it, or null), `windows` keyed by window id (five_hour, seven_day or a model\'s own week, ' +
  'and empty for an API-key account) and `spend`, one row per spend budget with `period`, `spent_usd`, ' +
  '`budget_usd` and `period_end`.',
  'Each window: `utilization`, the share used now, from 0 to 1 of the window. `burn_per_hour`, the share the ' +
  'account\'s sessions burn in an hour, and `demand_per_hour`, what they would burn with no slow-down holding them. ' +
  '`horizon_at`, the window\'s reset or the subscription\'s end, whichever comes first. `projected_at_horizon`, the ' +
  'predicted share at the earlier of horizon_at and five hours from now. `ceiling`, the share of the window the ' +
  'pool fills an account to: its 5-hour ceiling on five_hour and its weekly ceiling on the others. `fit`, the word ' +
  'a fresh placement reads on the window: fits (a fresh session at the pool\'s usual burn stays under the ceiling ' +
  'until the earlier of horizon_at and five hours from now), rewrite_only (a request still lands under the ceiling, ' +
  'and the usual burn after it reaches the ceiling before then), least_bad (at or over the ceiling), ending ' +
  '(allowance left, with the account inside its wind-down) or spent (the share at 1 or more, so nothing is left ' +
  'until horizon_at). `runway_minutes`, the whole minutes until the share reaches `ceiling` at the current burn: 0 ' +
  'at or above it, and null means unbounded.',
  'Each pin of this session: `agent` (main or a subagent id), `model`, `account` (a pseudonym), `placed_at`, ' +
  '`last_used_at`, `warm` and `warm_until` for its cache entry, `runway_minutes` on the window that binds it ' +
  '(`binding_window`) and `slow_down`.',
  'Read it for pace alone. A window whose fit is fits and whose runway is long or null has room for a long run or a ' +
  'fan-out. A short runway on the account a pin names means the pool is close to its ceiling on that window at the ' +
  'current burn: finish the work before then, wait for the reset horizon_at names, or spread the work out. The ' +
  'accounts are pseudonymous, and the router keeps the final say on placement: this tool steers no placement, no ' +
  'pin and no shedding round.',
  'A call pays before a long autonomous run, before a fan-out of subagents, and after a turn that felt slow. Calls ' +
  'inside ten seconds read one cached answer. While the router cannot be reached, the answer is an error text ' +
  'naming the failure.',
].join('\n\n')

type Fetched = { status: number; text: string } | { failure: string }

/**
 * What the start check does with the answer, or `stale` when a later start began while its GET or its registration was
 * out.
 */
type StartOutcome = 'register' | 'not_permitted' | 'refused' | 'stale' | 'unreachable'

// The engine refuses a registered tool's result that is neither a string nor a list of content blocks, so an MCP
// envelope never reaches the model. A failure goes out as a deny, which the model reads as an error result.
type ToolAnswer = { result: string } | { deny: string }

const NOT_PERMITTED = 'this key may not read the allowance'
// The tail of the unreachable line behind a registration that the engine refused. The transcript line and the toast
// both take it through `tell`. It claims what this start knows, since a tool that an earlier start registered outlives
// a later start.
const TOOL_REFUSED = 'and the engine refused the allowance tool, so this start registered none'

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
  return { result: text }
}

export function errorAnswer(text: string): ToolAnswer {
  return { deny: text }
}

/**
 * The tool's answer: this session's cached body inside CACHE_MS, else one bounded GET, a failure as a deny.
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

/** Registers the tool and answers whether the engine took it. A refusal goes to the debug log with its reason. */
async function registerTool($: EngineInterface): Promise<boolean> {
  try {
    await $.tool.register({
      name: TOOL_NAME,
      description: DESCRIPTION,
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    return true
  } catch (error) {
    // A registration the engine refuses costs the tool alone, never the keepalive start that follows it.
    say($, `the allowance tool could not be registered (${errorText(error)})`, { to: 'debug' })
    return false
  }
}

/**
 * Makes every start check whose GET or registration is still out stale, and keeps a pending call's answer out of the
 * cache.
 */
export function retireStarts(): void {
  generation += 1
}

/**
 * The start check: the cache cleared, one GET bounded by WAIT_MS, the transcript or debug line with its toast, and the
 * tool's registration on every outcome but a refused key and a withheld permission. A check whose GET a later start
 * overtook answers `stale` and does nothing after the GET. A refused key calls `clear` ahead of its line, so no earlier
 * start installs its settings between the two. The line of an unreachable router goes out behind the registration,
 * whose answer picks its tail, and a check that a later start overtook during the registration answers `stale` and
 * tells no line.
 */
export async function startCheck($: EngineInterface, settings: Settings, sessionId: string,
  tell: (line: string) => void, clear: () => void): Promise<StartOutcome> {
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
  if (outcome === 'not_permitted') say($, NOT_PERMITTED, { to: 'debug' })
  if (outcome === 'refused') {
    // A refused key clears the configuration in this step, which accepts the 401, and ahead of its line. An earlier
    // start whose id read lands behind the line would otherwise find no clear and install its settings after the
    // user read that the session reports nothing. No await falls between the generation test above, the clear and
    // the line.
    clear()
    tell(redactSecrets(`the router at ${settings.url} refused the key (401), so this session reports nothing`,
      settings.key))
  }
  // The tool list sits at the front of the prompt's cached prefix, so the tool is registered while the router is
  // unreachable rather than appearing later and rewriting the whole prefix once.
  if (outcome === 'register' || outcome === 'unreachable') {
    const registered = await registerTool($)
    // A later start can begin while the registration is out, and a check that it retired tells no line.
    if (sent !== generation) return 'stale'
    if (outcome === 'unreachable') {
      const tail = registered ? 'the allowance tool answers once it is back' : TOOL_REFUSED
      tell(`${unreachable(fetched, settings)}, ${tail}`)
    }
  }
  return outcome
}
