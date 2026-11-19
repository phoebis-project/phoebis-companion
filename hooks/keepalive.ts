import type { AgentInfo, EngineInterface, HttpResponse, On, Timer } from 'claude-code'
import type { Identity, SavedAgent, SavedModel, SavedTask } from '../types'
import {
  agentOf,
  collapse,
  commandDeadline,
  earliest,
  heartbeatInterval,
  isParkKind,
  isRealPrompt,
  isRelease,
  isRun,
  nextFireAt,
  nextSequence,
  ownerHeaderLines,
  ownerOf,
  parkOf,
  restore,
  reusable,
  sameAgent,
  samePark,
} from './rules'
import type { AgentRecord, Body, Cron, Park, Report } from './rules'
import { bearer, errorText, parsed, redactSecrets, say } from './settings'
import type { Settings } from './settings'

// The oldest client whose hook events this module was checked against.
export const MINIMUM_VERSION: readonly [number, number, number] = [2, 1, 287]

const MAIN = 'main'
// The router's codes are snake_case words, so anything else an answer carries stays out of the log.
const CODE = /^[a-z_]{1,64}$/
const EVENTS_PATH = '/v0/keepalive/events'
// The loader lists what a $.state call names only from a reference no importer can change.
const IDENTITY_REF = { plugin: 'phoebis-companion', key: 'identity' } as const
const MODEL_REF = { plugin: 'phoebis-companion', key: 'model' } as const
// The plugin's store outlives the session the host's state belongs to, so it keeps each client process's pair for a
// reload under a later session id of that process. An ended process's entry is never read again, so the store keeps
// the newest alone.
const IDENTITIES = 'identities'
const KEPT_IDENTITIES = 8
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000]

type SessionRecord = {
  id: string
  instance: string
  owner: string
  sequence: number
  generations: Map<string, number>
  announced: Set<string>
  // The ids the router last named released for a subagent this mod still holds: a later answer that omits one does
  // not announce it again, since the router's record left and the agent's next report starts it anew.
  routerReleased: Set<string>
  stopped: boolean
  // A start refused for a live holder told the person it waits, so the takeover that ends the wait is told once too.
  conflicted?: boolean
  heartbeatAt?: number
}

type Queue = {
  reports: Report[]
  inFlight?: { report: Report }
  attempt: number
  retryAt?: number
  // The agents whose start the router refused for its agent limit, each with its own retry time and attempt count:
  // their reports wait in order while the heartbeats and the other agents' reports go on.
  deferred: Map<string, { retryAt: number; attempt: number }>
}

const PRESENCE_THROTTLE_MS = 60000
// The client removes a recurring cron after the fire at which it is this old. A one-shot has no age limit.
const CRON_LIFETIME_MS = 604800000

type Model = {
  agents: Map<string, AgentRecord>
  crons: Map<string, Cron>
  // Loops the client's list never names (a workflow's agents, the engine's forks), by the agent their events count for.
  unlisted: Map<string, string>
  // The agents whose own turn runs, so an unlisted loop's turn end does not rest one in the middle of it.
  turning: Set<string>
  // The background commands main started in its running turn, which a prompt typed into that turn leaves open.
  current: Set<string>
  // The subagents this run released, until the client spawns one again or gives it a turn: a registration's answer
  // that still names one of them describes the run the release ends, so the client's list does not re-adopt it.
  released: Set<string>
}

const ENDED = new Set(['completed', 'failed', 'killed'])
const LIVE = new Set(['idle', 'pending', 'running', 'waiting'])
const WAKEUP = 'wakeup:'
// The statuses under which the client's task registry still runs a task.
const LIVE_TASK = new Set(['pending', 'running'])
// A trigger reaches the mod a moment after the client fired, and the mod's reading of a cron's creation trails the
// client's by as much, so a fire due this soon counts as the one that happened.
const TRIGGER_DELAY_MS = 5000

// Minted or re-adopted at session start, before the settings are in place, so every report names it.
let identity: Identity | undefined
// Read at the load's first fence: every session id of the process shares it, and a reload reads it again.
let hostProcess: { id: string | undefined } | undefined
// A call on `$` runs the host's hook chain, which states no order across calls, so each fence's writes settle before
// the next fence's begin, or a superseded start's header write that the host completes late could land after the
// current start's and name the wrong owner. The reads stay outside the chain, so a start that waits on a slow read
// holds no later start.
let fenceWrites: Promise<unknown> = Promise.resolve()
let settings: Settings | undefined
let bashBounds: { defaultMs?: number; maxMs?: number } = {}
// The code of the registration's last refusal, while nothing else has been answered since.
let startRefusal: unknown
let session: SessionRecord | undefined
const queue: Queue = { reports: [], attempt: 0, deferred: new Map() }
let timer: Timer | undefined
type RefusalHandler = (status: number, under: Settings) => void

// The start hook holds the settings the allowance tool reads under, so it decides what a refusal does to them.
let onRefused: RefusalHandler = () => undefined
// The tracked work as the host last took it, so a pump writes it only when it changed.
let savedModel: string | undefined
// The reports already sent again under a generation the router named, so a second refusal drops them.
const resent = new WeakSet<Report>()
const model: Model = freshModel()

// A start or a state of the agent's still queued carries a run the router takes after any answer that named the
// agent released, so that answer no longer says the router ended what the mod holds.
function holdsRun(agent: string): boolean {
  return queue.reports.some((queued) => isRun(queued, agent))
}

function releaseQueued(agent: string): boolean {
  return queue.reports.some((queued) => isRelease(queued, agent))
}

function backoff(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] as number
}

function buildBody(session: SessionRecord, report: Report, nowMs: number): Body {
  session.sequence = nextSequence(session.sequence, nowMs)
  // The router fences the session's requests by the owner its registration names, so every registration names it.
  const fenced: Report = report.event === 'session_start' ? { ...report, owner_id: session.owner } : report
  const body: Body = {
    ...fenced,
    protocol: 1,
    session_id: session.id,
    instance_id: session.instance,
    sequence: session.sequence,
  }
  const agent = agentOf(report)
  const generation = agent === undefined ? undefined : session.generations.get(agent)
  if (generation !== undefined) body.request_generation = generation
  return body
}

function active(): boolean {
  return settings !== undefined && identity !== undefined
}

// The pair itself, so a caller sends with the values this checked rather than reading the module's variables again.
function reporting(): { config: Settings; record: SessionRecord } | undefined {
  if (!active() || settings === undefined || session === undefined || session.stopped) return undefined
  return { config: settings, record: session }
}

function live(): boolean {
  return reporting() !== undefined
}

function freshRecord(id: string, state: AgentRecord['state'], parent?: string): AgentRecord {
  const record: AgentRecord = { id, state, open: new Map(), lastPresence: 0 }
  if (parent !== undefined) record.parent = parent
  return record
}

// The router creates main busy with the registration, so the mod starts it the same way.
function freshAgents(): Map<string, AgentRecord> {
  return new Map([[MAIN, freshRecord(MAIN, 'busy')]])
}

function freshModel(): Model {
  return {
    agents: freshAgents(),
    crons: new Map(),
    unlisted: new Map(),
    turning: new Set(),
    current: new Set(),
    released: new Set(),
  }
}

function mainAgent(): AgentRecord {
  let main = model.agents.get(MAIN)
  if (main === undefined) {
    main = freshRecord(MAIN, 'busy')
    model.agents.set(MAIN, main)
  }
  return main
}

// The crons belong to the session, and the session's loop is main's.
function parkNow(agent: AgentRecord): Park {
  return parkOf(agent, agent.id === MAIN ? model.crons.values() : [])
}

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined
}

function milliseconds(text: string | undefined): number | undefined {
  const value = text === undefined ? Number.NaN : Number.parseInt(text, 10)
  // The client ignores a value that is not a positive number, so the deadline does as well.
  return Number.isFinite(value) && value > 0 ? value : undefined
}

// The router must know an agent before any report names it. One announced or on its way is not announced again,
// since a second start answers agent_exists and costs a registration.
function announce(agentId: string): void {
  if (agentId === MAIN || session === undefined || session.announced.has(agentId)) return
  const flying = queue.inFlight?.report
  // A start in flight announces the run a queued release ends, so the next run needs a start of its own.
  const releasing = releaseQueued(agentId)
  if (flying !== undefined && sameAgent(flying, 'agent_start', agentId) && !releasing) return
  queue.reports = collapse(queue.reports, { event: 'agent_start', agent_id: agentId })
  session.routerReleased.delete(agentId)
}

function report(agentId: string, state: AgentRecord['state'], park?: Park): void {
  const agent = model.agents.get(agentId)
  if (agent !== undefined) agent.state = state
  if (!live()) return
  announce(agentId)
  const body: Extract<Report, { event: 'state' }> = { event: 'state', agent_id: agentId, ...park, state }
  queue.reports = collapse(queue.reports, body)
}

// A subagent rests parked on its own open work or not at all: with nothing open, its work went back to its parent.
function rest(agent: AgentRecord): void {
  const park = parkNow(agent)
  if (agent.id !== MAIN && park.state === 'idle') release(agent.id)
  else report(agent.id, park.state, park)
}

function busy(agentId: string): void {
  const agent = model.agents.get(agentId)
  if (agent !== undefined && agent.state !== 'busy') report(agentId, 'busy')
}

// Changes what an agent waits on. A busy agent's park is read at the end of its turn and a released one is gone, so
// only a resting agent is reported here, and only when the park the router holds moved.
function change(agent: AgentRecord, edit: () => void): void {
  const before = parkNow(agent)
  edit()
  if (model.agents.get(agent.id) !== agent || agent.state === 'busy') return
  const after = parkNow(agent)
  if (!samePark(before, after)) rest(agent)
}

// Inside one park change, so a subagent whose last commands end together goes straight to its release. A park
// reported between two removals would announce anew an agent the router already released.
function dropCommands(owner: AgentRecord, drop: (task: SavedTask) => boolean): void {
  const ended = [...owner.open.values()].filter((task) => task.kind === 'command' && drop(task))
  if (ended.length === 0) return
  change(owner, () => {
    for (const task of ended) owner.open.delete(task.id)
  })
}

function release(agentId: string): void {
  if (agentId === MAIN) return
  const known = model.agents.delete(agentId)
  model.turning.delete(agentId)
  model.released.add(agentId)
  // The router named this run released already, so a report would only announce the agent anew and hold its slot
  // for one more cache TTL. A start or a state still queued gives the router a run again, so the release follows it.
  const releasedByRouter = session?.routerReleased.delete(agentId) === true && !holdsRun(agentId)
  if (!releasedByRouter && (known || session?.announced.has(agentId) === true)) report(agentId, 'released')
  // A released agent that resumes under its id is announced again, which restarts it on the router.
  session?.announced.delete(agentId)
  for (const owner of [...model.agents.values()]) {
    if (owner.open.has(agentId)) change(owner, () => owner.open.delete(agentId))
  }
}

// A live agent the mod meets first in the client's list or the router's answer (one that ran before this load, or one
// resumed after its release) joins its parent's open set, so the parent stays parked on it until it ends.
function adopt(agentId: string, parentId: string | undefined, state: AgentRecord['state']): void {
  const parent = parentId ?? MAIN
  const agent = freshRecord(agentId, state, parent)
  model.released.delete(agentId)
  session?.routerReleased.delete(agentId)
  model.agents.set(agentId, agent)
  const owner = model.agents.get(parent)
  if (owner !== undefined) change(owner, () => owner.open.set(agentId, { id: agentId, kind: 'subagent' }))
}

// The agent an event of this loop counts for, once the mod has judged the loop.
function holder(agentId: string | undefined): string | undefined {
  if (agentId === undefined) return MAIN
  if (model.agents.has(agentId)) return agentId
  const host = model.unlisted.get(agentId)
  if (host === undefined) return undefined
  return model.agents.has(host) ? host : MAIN
}

// Judges a loop the mod meets first. An agent the client lists is adopted, and a loop it never names (a workflow's
// agent, one of the engine's forks) counts for main and never becomes a router agent, so no tick releases it.
async function attribute($: EngineInterface, agentId: string | undefined): Promise<string> {
  const held = holder(agentId)
  if (held !== undefined || agentId === undefined) return held ?? MAIN
  const listed = await agentList($)
  const info = listed?.find((agent) => agent.id === agentId)
  if (info !== undefined) {
    adopt(agentId, info.parentId, 'idle')
    return agentId
  }
  // An unreadable list judges nothing, so the loop's next event asks again.
  if (listed !== undefined) model.unlisted.set(agentId, MAIN)
  return MAIN
}

// The task registry the client attaches to a stop event. An open command the registry no longer runs has ended,
// whatever ended it, and one the registry never held cannot wake its loop, so both leave their owner's open set. A
// subagent's life is the agent list's to tell, so the registry's subagent rows are left to it.
function tasksStopped($: EngineInterface, e: unknown): void {
  if (!live()) return
  const listed = field(e, 'background_tasks')
  if (Array.isArray(listed)) {
    const running = new Set<string>()
    for (const entry of listed) {
      const id = field(entry, 'id')
      const status = field(entry, 'status')
      if (typeof id === 'string' && typeof status === 'string' && LIVE_TASK.has(status)) running.add(id)
    }
    for (const owner of [...model.agents.values()]) dropCommands(owner, (task) => !running.has(task.id))
  }
  void pump($)
}

function fired(now: number): void {
  change(mainAgent(), () => {
    for (const cron of [...model.crons.values()]) {
      if (earliest(cron) > now + TRIGGER_DELAY_MS) continue
      // The client counts the next fire from the time it fired, which is never before the time it computed, and
      // removes a recurring cron after the fire at which it is seven days old.
      const from = Math.max(now, cron.wakeAt)
      const aged = now - cron.createdAt >= CRON_LIFETIME_MS
      const next = cron.recurring && cron.expression !== undefined && !aged
        ? nextFireAt(cron.expression, from, cron.id, true)
        : undefined
      if (next === undefined) model.crons.delete(cron.id)
      else cron.wakeAt = next
    }
  })
}

async function toolRan($: EngineInterface, agentId: string, e: { tool: string; tool_use_id: string },
  result: unknown): Promise<void> {
  switch (e.tool) {
    case 'Bash': {
      const task = field(result, 'backgroundTaskId')
      if (typeof task !== 'string') return
      const now = await $.clock.now()
      const owner = model.agents.get(agentId)
      if (owner === undefined) return
      const timeout = field(e, 'timeout')
      const deadline = commandDeadline(now, typeof timeout === 'number' ? timeout : undefined, bashBounds)
      change(owner, () => owner.open.set(task, { id: task, kind: 'command', deadline }))
      if (owner.id === MAIN && model.turning.has(MAIN)) model.current.add(task)
      return
    }
    case 'CronCreate': {
      const id = field(result, 'id')
      const expression = field(e, 'cron')
      const recurring = field(e, 'recurring')
      if (typeof id !== 'string' || typeof expression !== 'string') return
      const repeats = typeof recurring === 'boolean' ? recurring : true
      const now = await $.clock.now()
      const wakeAt = nextFireAt(expression, now, id, repeats)
      if (wakeAt === undefined) return
      const cron: Cron = { id, wakeAt, recurring: repeats, expression, createdAt: now }
      change(mainAgent(), () => model.crons.set(id, cron))
      return
    }
    case 'ScheduleWakeup': {
      const stop = field(e, 'stop') === true
      const wakeAt = field(result, 'scheduledFor')
      const delay = field(result, 'clampedDelaySeconds')
      if (!stop && typeof wakeAt !== 'number') return
      const now = await $.clock.now()
      change(mainAgent(), () => {
        // The client cancels every pending wakeup when the model reschedules the loop or stops it.
        for (const id of [...model.crons.keys()]) if (id.startsWith(WAKEUP)) model.crons.delete(id)
        // An answer with no time is a loop that aged out, which the client ends with its pending wakeups.
        if (stop || typeof wakeAt !== 'number' || wakeAt <= 0) return
        const id = WAKEUP + e.tool_use_id
        // The client records the wakeup as created at the asked time, or just before the minute it rounded to.
        const createdAt = typeof delay === 'number' ? Math.min(now + delay * 1000, wakeAt - 1) : now
        model.crons.set(id, { id, wakeAt, recurring: false, createdAt })
      })
      return
    }
    case 'CronDelete': {
      const id = field(e, 'id')
      if (typeof id === 'string') change(mainAgent(), () => model.crons.delete(id))
      return
    }
  }
}

function spawned(agentId: string, parentId: string): void {
  // A step that reached the mod before the client's list named the agent counted it for main until now.
  model.unlisted.delete(agentId)
  model.released.delete(agentId)
  const known = model.agents.get(agentId)
  if (known === undefined) {
    model.agents.set(agentId, freshRecord(agentId, 'busy', parentId))
    announce(agentId)
  } else {
    // A step of the subagent's own loop reached the mod before its spawn answered, and announced it then.
    known.parent = parentId
  }
  const parent = model.agents.get(parentId)
  if (parent !== undefined) change(parent, () => parent.open.set(agentId, { id: agentId, kind: 'subagent' }))
}

// An unlisted loop's turn end rests the agent it counts for, unless that agent's own turn still runs.
function restHost(agentId: string): void {
  const agent = model.agents.get(agentId)
  if (agent !== undefined && !model.turning.has(agentId)) rest(agent)
}

async function turnEnded($: EngineInterface, agentId: string): Promise<void> {
  if (model.unlisted.has(agentId)) {
    restHost(holder(agentId) ?? MAIN)
    return
  }
  // An unreadable list leaves the turn end to the tick.
  const listed = await agentList($)
  if (listed === undefined) return
  const info = listed.find((agent) => agent.id === agentId)
  const agent = model.agents.get(agentId)
  if (info === undefined && agent === undefined) {
    model.unlisted.set(agentId, MAIN)
    restHost(MAIN)
    return
  }
  if (info === undefined || ENDED.has(info.status)) {
    release(agentId)
    return
  }
  // An agent the mod never held has nothing open of its own and was never announced, so there is nothing to report.
  if (agent === undefined) return
  model.turning.delete(agentId)
  // A subagent with work of its own still open has a turn to come, so it parks on that work as main does.
  rest(agent)
}

async function reconcile($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  // The list describes the agents the mod held when it asked: one spawned or resumed while the answer was out is
  // not in it, and a session replaced meanwhile is not the one it describes.
  const record = session
  const candidates = [...model.agents.values()].filter((agent) => agent.id !== MAIN)
  const listed = new Map((await $.agent.list()).map((agent) => [agent.id, agent.status]))
  if (session !== record) return
  // A loop judged unlisted that the list names now is an agent, so its next event is judged again.
  for (const id of [...model.unlisted.keys()]) if (listed.has(id)) model.unlisted.delete(id)
  for (const agent of candidates) {
    if (model.agents.get(agent.id) !== agent) continue
    const status = listed.get(agent.id)
    if (status === undefined || ENDED.has(status)) release(agent.id)
  }
  // A command is stopped at its deadline, so the first tick past it closes the task when no notification did.
  for (const owner of [...model.agents.values()]) {
    dropCommands(owner, (task) => task.deadline !== undefined && task.deadline <= now)
  }
}

function restate(agent: AgentRecord): void {
  if (agent.state === 'busy') report(agent.id, 'busy')
  else rest(agent)
}

// The registration's answer names every agent the router holds. Each side learns what the other lacks: an agent
// only the router holds is rebuilt from the client's list or released, a state or a park the router holds wrongly
// is sent again, and an agent only the mod holds is announced with its state.
function reconcileAck(entries: AnsweredAgent[], listed: AgentInfo[] | undefined): void {
  const held = new Map(entries.map((entry) => [entry.agent_id, entry]))
  const client = listed === undefined ? undefined : new Map(listed.map((agent) => [agent.id, agent]))
  const live: AgentInfo[] = []
  for (const [id, { state, park }] of held) {
    if (state === 'released') continue
    const agent = model.agents.get(id)
    if (agent !== undefined) {
      // The router lists a parked agent with no park kind once it no longer holds its park.
      const differs = state === 'parked' && agent.state === 'parked'
        ? park === undefined || !samePark(parkNow(agent), park)
        : state !== agent.state
      if (differs) restate(agent)
      continue
    }
    // The answer names the run this mod released. The release ends it on the router, so the agent is not adopted
    // again until a spawn or a turn starts a new run, and a router restored from a save older than the release
    // learns of it here, when no release of it is still queued.
    if (model.released.has(id)) {
      if (!releaseQueued(id)) {
        report(id, 'released')
        session?.announced.delete(id)
      }
      continue
    }
    // Without the client's list a live agent cannot be told from an ended one, so the router's stays as it is.
    if (id === MAIN || client === undefined) continue
    const info = client.get(id)
    if (info !== undefined && LIVE.has(info.status)) {
      live.push(info)
    } else {
      report(id, 'released')
      session?.announced.delete(id)
    }
  }
  // Parents first, so a child the answer lists before its parent still joins the parent's open set.
  while (live.length > 0) {
    const at = live.findIndex((info) => !live.some((other) => other.id === (info.parentId ?? MAIN)))
    const [info] = live.splice(at < 0 ? 0 : at, 1)
    if (info === undefined) break
    adopt(info.id, info.parentId, 'busy')
    report(info.id, 'busy')
  }
  for (const agent of [...model.agents.values()]) {
    if (held.has(agent.id)) continue
    // The router released this run and its record left the engine, so announcing the agent again would hold a slot
    // for a run the router already ended. Its next report starts it anew.
    if (session?.routerReleased.has(agent.id) === true) continue
    // The router creates main with the registration, so an answer without it only needs main's state.
    if (agent.id !== MAIN) {
      session?.announced.delete(agent.id)
      queue.reports = collapse(queue.reports, { event: 'agent_start', agent_id: agent.id })
    }
    restate(agent)
  }
}

async function agentList($: EngineInterface): Promise<AgentInfo[] | undefined> {
  try {
    return await $.agent.list()
  } catch {
    return undefined
  }
}

function startReport(previousInstance?: string): Report {
  return previousInstance === undefined
    ? { event: 'session_start' }
    : { event: 'session_start', previous_instance_id: previousInstance }
}

function reregister(): void {
  if (!queue.reports.some((queued) => queued.event === 'session_start')) {
    queue.reports = collapse(queue.reports, startReport())
  }
}

function post($: EngineInterface, config: Settings, body: Body): Promise<HttpResponse> {
  return $.http.fetch(config.url + EVENTS_PATH, {
    method: 'POST',
    headers: { ...bearer(config.key), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// The tracked work as the host holds it: a reload of the module in the same session reads it back before the
// registration's answer is reconciled, so the park the router holds is not overwritten with a fresh busy main.
function snapshotModel(record: SessionRecord): SavedModel {
  const agents: SavedAgent[] = [...model.agents.values()].map((agent) => ({
    id: agent.id,
    ...(agent.parent === undefined ? {} : { parent: agent.parent }),
    state: agent.state,
    open: [...agent.open.values()].map((task) => ({ ...task })),
    lastPresence: agent.lastPresence,
  }))
  return {
    id: record.id,
    agents,
    crons: [...model.crons.values()].map((cron) => ({ ...cron })),
    released: [...model.released],
    routerReleased: [...record.routerReleased],
  }
}

function restoreModel(saved: SavedModel, sessionRecord: SessionRecord): void {
  model.agents = new Map(saved.agents.map((agent) => {
    const record = freshRecord(agent.id, agent.state, agent.parent)
    record.open = new Map(agent.open.map((task) => [task.id, { ...task }]))
    record.lastPresence = agent.lastPresence
    return [agent.id, record]
  }))
  model.crons = new Map(saved.crons.map((cron) => [cron.id, { ...cron }]))
  model.released = new Set(saved.released)
  sessionRecord.routerReleased = new Set(saved.routerReleased)
  mainAgent()
}

function heldModelFor(held: unknown, id: string): SavedModel | undefined {
  if (field(held, 'id') !== id || !Array.isArray(field(held, 'agents')) || !Array.isArray(field(held, 'crons')) ||
    !Array.isArray(field(held, 'released')) || !Array.isArray(field(held, 'routerReleased'))) {
    return undefined
  }
  return held as SavedModel
}

async function persistModel($: EngineInterface): Promise<void> {
  if (session === undefined) return
  const value = snapshotModel(session)
  const text = JSON.stringify(value)
  if (text === savedModel) return
  savedModel = text
  await $.state.set(MODEL_REF, value)
}

async function ensureSession($: EngineInterface, isCurrent: () => boolean): Promise<void> {
  const id = await $.session.id()
  // The record moves only for a prompt or a start that is still current at each decision, since a start can lose its
  // currency while it waits. A stopped record under the current id is a conversation resumed after the session_end
  // closed it, so a current caller revives it.
  const kept = (): boolean => !isCurrent() || (session?.id === id && !session.stopped)
  if (kept() || identity === undefined) return
  // The same id in the same process is a reload of the module or a resume after its end, and the host still holds
  // its tracked work. A new id is a new conversation, so nothing the old one had open or scheduled carries over. Read
  // before the session moves, so a pump during the read never writes the old session's work under the new id.
  const held = heldModelFor((await $.state.get(MODEL_REF)).value, id)
  if (kept()) return
  session = {
    id,
    instance: identity.instance,
    owner: identity.owner,
    sequence: 0,
    generations: new Map(),
    announced: new Set(),
    routerReleased: new Set(),
    stopped: false,
  }
  queue.reports = collapse([], startReport())
  queue.deferred = new Map()
  savedModel = undefined
  Object.assign(model, freshModel())
  if (held !== undefined) restoreModel(held, session)
}

// The first queued report that may go out now: one of an agent whose start the router refused for its limit waits
// for that agent's retry time, so the agent's reports keep their order while everything else proceeds.
function nextReport(now: number): number {
  return queue.reports.findIndex((report) => {
    const agent = agentOf(report)
    if (agent === undefined) return true
    const held = queue.deferred.get(agent)
    return held === undefined || held.retryAt <= now
  })
}

function ready(): { config: Settings; record: SessionRecord } | undefined {
  return queue.inFlight === undefined && queue.reports.length > 0 ? reporting() : undefined
}

async function pump($: EngineInterface): Promise<void> {
  try {
    await persistModel($)
    if (ready() === undefined) return
    const sentAt = await $.clock.now()
    if (queue.retryAt !== undefined && sentAt < queue.retryAt) return
    const held = ready()
    if (held === undefined) return
    const at = nextReport(sentAt)
    if (at < 0) return
    // A session.start can replace or clear the settings while the request is out, so the catch reads the key this
    // request carried from here and cannot throw on a cleared one.
    const { config, record } = held
    const [report] = queue.reports.splice(at, 1) as [Report]
    queue.inFlight = { report }
    const body = buildBody(record, report, sentAt)
    let response: HttpResponse | undefined
    try {
      response = await post($, config, body)
    } catch (error) {
      // The client refuses a plugin's fetch inside the process when its policy check failed, and a refused host
      // throws the same way, so the one sign of either is this line: the backoff below retries all the same. The
      // message is the host's and may quote the request, so the key and any URL credentials leave it first.
      response = undefined
      try {
        const reason = redactSecrets(errorText(error), config.key)
        say($, `the ${report.event} report could not be sent (${reason}), so the mod retries under its backoff ` +
          'unless the session ends first', { to: 'debug' })
      } catch {
        // A host that refuses the log call, or an error value that cannot become a string, must not stop the pump,
        // since a throw here would leave queue.inFlight set for the process.
      }
    }
    let now: number
    let listed: AgentInfo[] | undefined
    try {
      now = await $.clock.now()
      // The registration's answer is reconciled against the client's agents, read while nothing else can be sent.
      if (report.event === 'session_start' && response?.ok === true) listed = await agentList($)
    } finally {
      queue.inFlight = undefined
    }
    // A /clear or a /resume replaced the session while the request was out, so the answer speaks for a session
    // the mod no longer reports. A start that cleared the settings or set other values meanwhile abandoned the report
    // with them, so its answer restores, schedules or refuses nothing, while a start with the same values, such as a
    // reload, keeps it. A 401 or 403 under such a start answers a request sent under the settings the start replaced,
    // so the refusal drops and the registration the start queued asks again. The registration a later start queues
    // with its own settings schedules the heartbeat again.
    const still = reporting()
    const kept = still?.record === record && still.config.url === config.url && still.config.key === config.key
    const stale = still?.config !== config && response !== undefined &&
      (response.status === 401 || response.status === 403)
    if (kept && !stale) settle($, config, record, report, response, now, listed)
  } catch {
    return
  }
  await pump($)
}

/** Drops every queued report, as a refused key leaves nothing to send. */
export function emptyQueue(): void {
  queue.reports = []
}

type AnsweredAgent = { agent_id: string; state: unknown; request_generation?: number; park?: Park }

type Answer = {
  code?: string
  lease_expires_ms?: number
  request_generation?: number
  agent_id?: string
  instance_id?: string
  agents?: AnsweredAgent[]
}

function answeredPark(entry: unknown): Park | undefined {
  const kind = field(entry, 'park_kind')
  if (!isParkKind(kind)) return undefined
  const park: Park = { state: 'parked', park_kind: kind }
  const wakeAt = field(entry, 'wake_at')
  if (typeof wakeAt === 'number') park.wake_at = wakeAt
  const deadline = field(entry, 'deadline')
  if (typeof deadline === 'number') park.deadline = deadline
  return park
}

// An agents entry is kept with a string agent_id alone: the generations skip one without a number, but the
// registration's reconcile still reads its state.
function answerOf(text: string): Answer {
  const value = parsed(text)
  const answer: Answer = {}
  if (typeof value.code === 'string') answer.code = value.code
  if (typeof value.lease_expires_ms === 'number') answer.lease_expires_ms = value.lease_expires_ms
  if (typeof value.request_generation === 'number') answer.request_generation = value.request_generation
  if (typeof value.agent_id === 'string') answer.agent_id = value.agent_id
  if (typeof value.instance_id === 'string') answer.instance_id = value.instance_id
  if (Array.isArray(value.agents)) {
    answer.agents = []
    for (const entry of value.agents) {
      const id = field(entry, 'agent_id')
      if (typeof id !== 'string') continue
      const agent: AnsweredAgent = { agent_id: id, state: field(entry, 'state') }
      const generation = field(entry, 'request_generation')
      if (typeof generation === 'number') agent.request_generation = generation
      const park = answeredPark(entry)
      if (park !== undefined) agent.park = park
      answer.agents.push(agent)
    }
  }
  return answer
}

function settle($: EngineInterface, config: Settings, record: SessionRecord, report: Report,
  response: HttpResponse | undefined, now: number, listed: AgentInfo[] | undefined): void {
  const repeated = startRefusal
  startRefusal = undefined
  // The router's agent limit refuses one agent's start, not the session: that agent waits under its own retry time
  // while the lease is renewed and the other agents report.
  if (response !== undefined && response.status === 429 && report.event === 'agent_start' &&
    answerOf(response.text).code === 'agent_limit') {
    queue.reports = restore(queue.reports, report)
    deferAgent($, report.agent_id, now)
    return
  }
  if (response === undefined || response.status === 429 || response.status >= 500) {
    queue.reports = restore(queue.reports, report)
    delay($, now)
    return
  }
  if (response.ok) {
    acknowledged($, record, report, answerOf(response.text), now, listed)
    return
  }
  if (response.status === 401 || response.status === 403) {
    // A refused report stops every session of the process until a later start's check no longer refuses the key,
    // since a retry would only fill the router's log.
    clearSettings()
    emptyQueue()
    timer?.cancel()
    say($, `a report was refused with status ${response.status}, so this process reports nothing until a ` +
      'start\'s check no longer refuses the key', { to: 'debug' })
    onRefused(response.status, config)
    return
  }
  if (response.status === 409) {
    refusedReport($, record, report, answerOf(response.text), now, repeated)
    return
  }
  // Any other answer names a report the router never takes, so the mod drops it rather than retrying. The router
  // keeps no trace of it, which leaves this line as the one sign of a body the mod built wrong.
  const code = answerOf(response.text).code
  const named = code !== undefined && CODE.test(code) ? `with code ${code}` : 'with no code'
  say($, `the router answered status ${response.status} ${named} to the ${report.event} report, so the mod drops it`,
    { to: 'debug' })
}

function delay($: EngineInterface, now: number): void {
  queue.retryAt = now + backoff(queue.attempt)
  queue.attempt += 1
  $.clock.after(queue.retryAt - now, () => void pump($))
}

function deferAgent($: EngineInterface, agent: string, now: number): void {
  const attempt = queue.deferred.get(agent)?.attempt ?? 0
  const retryAt = now + backoff(attempt)
  queue.deferred.set(agent, { retryAt, attempt: attempt + 1 })
  $.clock.after(retryAt - now, () => void pump($))
}

function acknowledged($: EngineInterface, record: SessionRecord, report: Report, ack: Answer,
  now: number, listed: AgentInfo[] | undefined): void {
  // Only these two reports renew the router's lease, so only their answers move the heartbeat.
  if ((report.event === 'session_start' || report.event === 'heartbeat') && ack.lease_expires_ms !== undefined) {
    const at = now + heartbeatInterval(ack.lease_expires_ms, now)
    record.heartbeatAt = at
    timer?.cancel()
    timer = $.clock.after(at - now, () => tick($))
  }
  if (ack.request_generation !== undefined) record.generations.set(ack.agent_id ?? MAIN, ack.request_generation)
  for (const { agent_id: id, request_generation: generation, state } of ack.agents ?? []) {
    if (generation === undefined) continue
    record.generations.set(id, generation)
    if (state === 'released') {
      record.announced.delete(id)
      // announce skips main, and an answer that omits main restates it, so only a subagent the mod holds joins. A
      // queued start or state means the mod holds a run that the answer's release predates, so the id stays out and
      // its release takes the ordinary path, behind that report.
      if (id !== MAIN && model.agents.has(id) && !holdsRun(id)) record.routerReleased.add(id)
    } else {
      record.routerReleased.delete(id)
      // The answer names the run a queued release ends, so the next run needs a start of its own, as for a start's
      // answer below.
      if (!releaseQueued(id)) record.announced.add(id)
    }
  }
  // A start answered after its run ended leaves the agent unannounced, so the next run starts it again once the
  // queued release went out.
  if (report.event === 'agent_start') {
    queue.deferred.delete(report.agent_id)
    // An accepted start means the router holds the run live again, whatever answer named it released after the start
    // was queued.
    record.routerReleased.delete(report.agent_id)
    if (!releaseQueued(report.agent_id)) record.announced.add(report.agent_id)
  }
  if (report.event === 'session_start') {
    if (record.conflicted === true && report.previous_instance_id !== undefined) {
      say($, `took over session ${record.id} from a silent instance`)
    }
    record.conflicted = undefined
  }
  queue.attempt = 0
  queue.retryAt = undefined
  // An answer without the member says nothing about the router's agents, so nothing is reconciled against it.
  if (report.event === 'session_start' && ack.agents !== undefined) reconcileAck(ack.agents, listed)
}

function refusedReport($: EngineInterface, record: SessionRecord, report: Report, refusal: Answer, now: number,
  repeated: unknown): void {
  const agent = agentOf(report)
  const generation = refusal.request_generation
  switch (refusal.code) {
    case 'unknown_instance':
    case 'instance_ended':
    case 'stale_sequence':
      queue.reports = restore(queue.reports, report)
      reregister()
      if (report.event === 'session_start') {
        // A registration the router refuses again for the same reason would otherwise go out at once, round after
        // round, so the repeat waits the backoff.
        if (repeated === refusal.code) delay($, now)
        startRefusal = refusal.code
      }
      return
    case 'instance_conflict':
      // The router names a holder that ended or went silent, the one a takeover start replaces, so a holder named
      // after a takeover start already went out is the newer one to take over from.
      if (refusal.instance_id !== undefined) {
        queue.reports = collapse(queue.reports, startReport(refusal.instance_id))
        return
      }
      // A live holder's lease lapses unless it reports, and the router names it from then on, so the start waits
      // under the backoff rather than ending the session.
      queue.reports = restore(queue.reports, report)
      delay($, now)
      if (record.conflicted !== true) {
        record.conflicted = true
        say($, `another instance reports session ${record.id}, so the start is retried once its lease lapses`)
      }
      return
    case 'unknown_previous_instance':
      queue.reports = collapse(queue.reports, startReport())
      return
    case 'agent_exists':
      if (agent !== undefined) {
        record.announced.add(agent)
        queue.deferred.delete(agent)
      }
      reregister()
      return
    case 'unknown_agent':
      if (agent === undefined) return
      record.announced.delete(agent)
      // The recovery start gives the router a run again, as announce's start does.
      record.routerReleased.delete(agent)
      queue.reports = ahead(restore(queue.reports, report), agent)
      return
    case 'stale_request_generation':
      if (agent === undefined || generation === undefined) {
        reregister()
        return
      }
      record.generations.set(agent, generation)
      if (!resent.has(report)) {
        resent.add(report)
        queue.reports = restore(queue.reports, report)
      }
      return
    case 'agent_released':
      if (agent === undefined || generation === undefined) {
        reregister()
        return
      }
      record.generations.set(agent, generation)
      record.announced.delete(agent)
      return
  }
}

// The router must know an agent before its first queued report, so the announcement goes right before that one.
function ahead(reports: Report[], agent: string): Report[] {
  const rest = reports.filter((queued) => !sameAgent(queued, 'agent_start', agent))
  const start: Report = { event: 'agent_start', agent_id: agent }
  const at = rest.findIndex((queued) => agentOf(queued) === agent)
  return at < 0 ? [...rest, start] : [...rest.slice(0, at), start, ...rest.slice(at)]
}

function tick($: EngineInterface): void {
  void (async () => {
    try {
      if (!active()) return
      // A tick serves the record the host still holds. An id that is not the record's was read across a clear or a
      // resume, and neither raises a start, so the tick leaves the new conversation to its first prompt.
      const id = await $.session.id()
      if (session?.id !== id) return
      // A failed reconcile must not cost the lease, so the heartbeat goes out either way.
      if (live()) await reconcile($).catch(() => undefined)
      // A heartbeat renews a lease the router granted, so a session still waiting for its registration sends none.
      if (session !== undefined && !session.stopped && session.heartbeatAt !== undefined) {
        queue.reports = collapse(queue.reports, { event: 'heartbeat' })
      }
    } catch {
      return
    }
    await pump($)
  })()
}

/** The host process's identity, read once per load, or `undefined` where the host cannot run the command. */
async function processIdentity($: EngineInterface): Promise<string | undefined> {
  if (hostProcess !== undefined) return hostProcess.id
  let id: string | undefined
  try {
    // The API leaves nothing scoped to the process, so the shell's parent, the client process, names it.
    const { exitCode, stdout } = await $.process.run(['sh', '-c', 'echo $PPID'])
    const text = stdout.trim()
    id = exitCode === 0 && /^\d+$/.test(text) ? text : undefined
  } catch {
    id = undefined
  }
  hostProcess = { id }
  // Whether that parent is the client process rests on how the host spawns the shell, so the read shows in the log.
  if (id !== undefined) {
    say($, `the client process reads as ${id}, which keys the pair the mod reuses across a clear`, { to: 'debug' })
  }
  return id
}

type StoredPair = [string, Identity]

// A list, newest last, rather than an object keyed by process: an object orders integer-like keys by value. Any
// process of the user's can write the store, so an entry of another shape is dropped.
async function storedPairs($: EngineInterface): Promise<StoredPair[]> {
  let value: unknown
  try {
    value = await $.store.get(IDENTITIES)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const pairs: StoredPair[] = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue
    const [instance, owner] = [field(entry[1], 'instance'), field(entry[1], 'owner')]
    if (typeof instance === 'string' && typeof owner === 'string') pairs.push([entry[0], { instance, owner }])
  }
  return pairs
}

async function keepPair($: EngineInterface, pairs: StoredPair[], processId: string, pair: Identity): Promise<void> {
  const added: StoredPair = [processId, { instance: pair.instance, owner: pair.owner }]
  const kept: StoredPair[] = [...pairs.filter(([id]) => id !== processId), added].slice(-KEPT_IDENTITIES)
  if (JSON.stringify(kept) === JSON.stringify(pairs)) return
  try {
    await $.store.set(IDENTITIES, kept)
  } catch {
    // A store the host refuses to write costs the reuse after a clear alone, never the fence.
  }
}

// A later start owns the identity the relay must read, so each write goes out only while this start is current,
// checked in the step that issues it.
async function writeIdentity($: EngineInterface, isCurrent: () => boolean, pair: Identity, held: Identity | undefined,
  existing: string | undefined, pairs: StoredPair[], processId: string | undefined): Promise<void> {
  // A pair the fence reused from the host's state is there already.
  if (pair !== held && isCurrent()) await $.state.set(IDENTITY_REF, pair)
  if (processId !== undefined && isCurrent()) await keepPair($, pairs, processId, pair)
  // The owner line replaces any line before it, so the relay reads one owner whatever the variable inherited.
  if (isCurrent()) await $.env.set('ANTHROPIC_CUSTOM_HEADERS', ownerHeaderLines(existing, pair.owner))
  if (isCurrent()) await $.env.set('PHOEBIS_KEEPALIVE_INSTANCE', pair.instance)
}

// The owner the router fences this process's requests by. A reload of the module, an enable or a worker respawn in
// the same process keeps the pair under any session id of the process, so the router's session keeps its owner, and
// any other process mints its own.
async function fence($: EngineInterface, isCurrent: () => boolean): Promise<Identity> {
  const [existing, variable, { value: held }] = await Promise.all([
    $.env.get('ANTHROPIC_CUSTOM_HEADERS'),
    $.env.get('PHOEBIS_KEEPALIVE_INSTANCE'),
    $.state.get(IDENTITY_REF),
  ])
  const owner = ownerOf(existing)
  const processId = await processIdentity($)
  const pairs = processId === undefined ? [] : await storedPairs($)
  let pair: Identity
  if (held !== undefined && reusable(held, variable, owner)) {
    pair = held
  } else {
    // The host's state belongs to the session, so after a clear it holds nothing under the new id, and the store's
    // entry for this process is what still shows the pair was minted here.
    const stored = pairs.find(([id]) => id === processId)?.[1]
    pair = stored !== undefined && reusable(stored, variable, owner)
      ? stored
      : { instance: crypto.randomUUID(), owner: crypto.randomUUID() }
  }
  const run = fenceWrites.then(() => writeIdentity($, isCurrent, pair, held, existing, pairs, processId))
  // A fence whose writes reject must not stall the ones after it.
  fenceWrites = run.catch(() => undefined)
  await run
  return pair
}

/**
 * Starts the lifecycle: the fence, the registration, the pump. Idempotent per session start. `isCurrent` answers
 * whether the start that resolved these settings still holds the configuration.
 */
export async function startKeepalive($: EngineInterface, resolved: Settings, isCurrent: () => boolean):
  Promise<void> {
  // The earlier settings hold through every await here. Replaced sooner, they would let a pump register the record of
  // an older id that ensureSession is about to replace.
  const [pair, defaultMs, maxMs] = await Promise.all([
    fence($, isCurrent),
    $.env.get('BASH_DEFAULT_TIMEOUT_MS'),
    $.env.get('BASH_MAX_TIMEOUT_MS'),
  ])
  // A later start that landed during the fence owns the identity, the bounds and the session it moves.
  if (!isCurrent()) return
  identity = pair
  bashBounds = { defaultMs: milliseconds(defaultMs), maxMs: milliseconds(maxMs) }
  await ensureSession($, isCurrent)
  // A later session start can land during these awaits, and the settings it set or cleared must stand.
  if (!isCurrent()) return
  // One step with no await, so no report goes out under these settings ahead of the registration. Its acknowledgment
  // is what schedules the heartbeat, so the session registers again whatever ended the previous settings, and a
  // registered session's repeat is idempotent on the router.
  settings = resolved
  reregister()
  void pump($)
}

/** Drops the held settings, so the lifecycle reports nothing until a later start resolves them again. */
export function clearSettings(): void {
  settings = undefined
}

export function installKeepalive(on: On, refused: RefusalHandler): void {
  onRefused = refused
  on('prompt.submit', async ($, e, next) => {
    if (!active()) return next(e)
    await ensureSession($, () => true)
    // The client fired the cron whatever a hook beneath does with the prompt the fire raised.
    if (live() && e.origin.kind === 'scheduled-trigger') fired(await $.clock.now())
    void pump($)
    // A prompt a hook beneath drops never starts a turn, and one whose chain finishes after a clear or a resume
    // replaced the session belongs to the session it was typed into.
    const record = session
    const r = await next(e)
    if (r.drop === undefined && live() && session === record && isRealPrompt(e.origin)) {
      // The router marks main busy on the prompt itself, so no state report goes with it.
      queue.reports = collapse(queue.reports, { event: 'activity', agent_id: MAIN, kind: 'prompt' })
      const main = mainAgent()
      main.state = 'busy'
      model.turning.add(MAIN)
      // The person's return ends main's wait on every command its earlier turns started, still running or not, so a
      // long-running one such as a dev server parks main only until then. A prompt typed into the running turn keeps
      // the commands that turn started, since they are seconds old.
      const keep = e.turnId === undefined ? new Set<string>() : model.current
      dropCommands(main, (task) => !keep.has(task.id))
      void pump($)
    }
    return r
  }).catch(($, e, next) => next(e))

  // Presence resets the router's idle clock and nothing else. The hook's budget is short, so it only queues.
  on('prompt.edit', async ($, e, next) => {
    if (!live()) return next(e)
    const main = mainAgent()
    // The edit runs beneath while the clock is read. The handler only keeps a rejection from going unhandled meanwhile:
    // the returned promise still carries it, and the presence is queued either way.
    const pending = next(e)
    pending.catch(() => undefined)
    const now = await $.clock.now()
    if (now - main.lastPresence >= PRESENCE_THROTTLE_MS) {
      main.lastPresence = now
      queue.reports = collapse(queue.reports, { event: 'activity', agent_id: MAIN, kind: 'presence' })
    }
    void pump($)
    return pending
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (live()) {
      const agentId = await attribute($, e.agentId)
      // Only a loop's own step starts its agent's turn: a fork working for main neither starts nor ends main's.
      if (agentId === (e.agentId ?? MAIN)) model.turning.add(agentId)
      busy(agentId)
      void pump($)
    }
    return yield* next(e)
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    // A call another plugin raised is not the model's work, though what it starts belongs to the session.
    const raised = next.origin.plugin !== 'engine'
    let agentId = MAIN
    if (live()) {
      agentId = await attribute($, e.agentId)
      if (!raised) busy(agentId)
      void pump($)
    }
    // A clear or a resume while the tool runs replaces the session, and the result then belongs to the one that
    // started it, not to the session reporting now.
    const record = session
    const r = await next(e)
    if (live() && session === record && r.deny === undefined) {
      await toolRan($, agentId, e, r.result)
      void pump($)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const record = session
    const r = await next(e)
    const agentId = field(r, 'agentId')
    if (live() && session === record && typeof agentId === 'string') {
      const parent = holder(e.parentAgentId) ?? MAIN
      // A workflow's agent is a loop the client's list never names, so it works for its parent. The marker is read
      // loosely, since the oldest supported client's declarations lack it.
      if (field(e, 'workflow') !== undefined) model.unlisted.set(agentId, parent)
      else spawned(agentId, parent)
      void pump($)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (live()) {
      if (e.agentId === undefined) {
        model.turning.delete(MAIN)
        model.current.clear()
        rest(mainAgent())
      } else {
        await turnEnded($, e.agentId)
      }
      void pump($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The client's task registry rides every stop event, of main and of each subagent, so a command's end is read
  // there and never from the text of the notification that reported it.
  on('classic.Stop', async ($, e, next) => {
    tasksStopped($, e)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    tasksStopped($, e)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The end goes out past a request in flight: every session.end hook shares one short budget, and the lease
  // covers whatever this one request does not reach.
  on('session.end', async ($, e, next) => {
    // No tick follows the end: the conversation that resumes or replaces this one registers at its first prompt or
    // start, and that registration's acknowledgment schedules the timer again.
    timer?.cancel()
    const held = reporting()
    if (held !== undefined) {
      const { config, record } = held
      record.stopped = true
      queue.reports = []
      const body = buildBody(record, { event: 'session_end' }, await $.clock.now())
      void post($, config, body).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
