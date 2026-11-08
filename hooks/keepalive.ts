import type { AgentInfo, EngineInterface, HttpResponse, On, Timer } from 'claude-code'
import type { Identity, SavedAgent, SavedModel } from '../types/index.d.ts'
import { bearer, errorText, parsed, redactSecrets } from './settings.ts'
import type { Settings } from './settings.ts'

// The oldest client whose hook events this module was checked against.
export const MINIMUM_VERSION: readonly [number, number, number] = [2, 1, 287]

export type Report =
  | { event: 'session_start'; owner_id?: string; previous_instance_id?: string }
  | { event: 'heartbeat' }
  | { event: 'session_end' }
  | { event: 'agent_start'; agent_id: string }
  | { event: 'activity'; agent_id: string; kind: 'prompt' | 'presence' }
  | {
      event: 'state'
      agent_id: string
      state: 'busy' | 'idle' | 'parked' | 'released'
      park_kind?: 'background' | 'scheduled' | 'both'
      wake_at?: number
      deadline?: number
    }

export type Body = Report & {
  protocol: 1
  session_id: string
  instance_id: string
  sequence: number
  request_generation?: number
}

export const MAIN = 'main'
// The router's codes are snake_case words, so anything else an answer carries stays out of the log.
const CODE = /^[a-z_]{1,64}$/
export const EVENTS_PATH = '/v0/keepalive/events'
export const OWNER_HEADER = 'X-Keepalive-Owner-Id'
// The loader lists what a $.state call names only from a reference no importer can change.
const IDENTITY_REF = { plugin: 'phoebis-companion', key: 'identity' } as const
const MODEL_REF = { plugin: 'phoebis-companion', key: 'model' } as const
// The plugin's store outlives the session the host's state belongs to, so it keeps each client process's pair for a
// reload under a later session id of that process. An ended process's entry is never read again, so the store keeps
// the newest alone.
const IDENTITIES = 'identities'
const KEPT_IDENTITIES = 8
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000]
export const HEARTBEAT_MIN_MS = 1000
export const HEARTBEAT_MAX_MS = 25000

export type SessionRecord = {
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

export type Queue = {
  reports: Report[]
  inFlight?: { report: Report }
  attempt: number
  retryAt?: number
  // The agents whose start the router refused for its agent limit, each with its own retry time and attempt count:
  // their reports wait in order while the heartbeats and the other agents' reports go on.
  deferred: Map<string, { retryAt: number; attempt: number }>
}

export type OpenTask = { id: string; kind: 'command' | 'subagent'; deadline?: number }

export type Cron = { id: string; wakeAt: number; recurring: boolean; expression?: string; createdAt: number }

export type AgentRecord = {
  id: string
  parent?: string
  state: 'busy' | 'idle' | 'parked' | 'released'
  open: Map<string, OpenTask>
  lastPresence: number
}

export type Park =
  | { state: 'idle' }
  | { state: 'parked'; park_kind: 'background' | 'scheduled' | 'both'; wake_at?: number; deadline?: number }

export const PRESENCE_THROTTLE_MS = 60000
export const DEFAULT_COMMAND_TIMEOUT_MS = 1800000
export const MAX_COMMAND_TIMEOUT_MS = 7200000
// The client removes a recurring cron after the fire at which it is this old. A one-shot has no age limit.
export const CRON_LIFETIME_MS = 604800000

type Model = {
  agents: Map<string, AgentRecord>
  crons: Map<string, Cron>
  env: { defaultMs?: number; maxMs?: number }
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

// The person's own prompts: typed at the terminal, sent through Remote Control or Slack, or handed over by the SDK
// host.
const REAL_PROMPTS = new Set(['bridge', 'composer', 'sdk', 'slack-ping'])
const ENDED = new Set(['completed', 'failed', 'killed'])
const LIVE = new Set(['idle', 'pending', 'running', 'waiting'])
const WAKEUP = 'wakeup:'
// The statuses under which the client's task registry still runs a task.
const LIVE_TASK = new Set(['pending', 'running'])
// The client's scheduler: a recurring cron fires after its grid time by its id's share of half the period, at most
// thirty minutes, a five-minute loop a cache lead before its period ends, and a one-shot on :00 or :30 up to 90 s
// early by its id's share.
const RECURRING_SHARE = 0.5
const RECURRING_CAP_MS = 1800000
const ONE_SHOT_MAX_MS = 90000
const ONE_SHOT_MINUTE_MOD = 30
const CACHE_LEAD_MS = 15000
const LOOP_PERIOD_MS = 300000
const LOOP_EXPRESSION = /^\*\/\d+ \* \* \* \*$/
// A trigger reaches the mod a moment after the client fired, and the mod's reading of a cron's creation trails the
// client's by as much, so a fire due this soon counts as the one that happened.
const TRIGGER_DELAY_MS = 5000
// The client's Bash bounds a background command's limit derives from: its default and foreground maximum, and the
// longest timer it can arm.
const BASH_DEFAULT_MS = 120000
const BASH_MAX_MS = 600000
const TIMER_MAX_MS = 2147483647
// The client's own bound on its walk to the next match: as many steps as a leap year has minutes.
const CRON_STEPS = 527040
// The bounds of minute, hour, day of month, month and day of week.
const CRON_FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
] as const

// Minted or re-adopted at session start, before the settings are in place, so every report names it.
let identity: Identity | undefined
// Read at the load's first fence: every session id of the process shares it, and a reload reads it again.
let hostProcess: { id: string | undefined } | undefined
let settings: Settings | undefined
// The code of the registration's last refusal, while nothing else has been answered since.
let startRefusal: unknown
let session: SessionRecord | undefined
const queue: Queue = { reports: [], attempt: 0, deferred: new Map() }
let timer: Timer | undefined
// The tracked work as the host last took it, so a pump writes it only when it changed.
let savedModel: string | undefined
// A key the router refused is refused for every session of the process, and retrying it would only fill the
// router's log.
let refused = false
// The reports already sent again under a generation the router named, so a second refusal drops them.
const resent = new WeakSet<Report>()
const model: Model = {
  agents: freshAgents(),
  crons: new Map(),
  env: {},
  unlisted: new Map(),
  turning: new Set(),
  current: new Set(),
  released: new Set(),
}

// A line of ANTHROPIC_CUSTOM_HEADERS as the client reads it: the name before the first colon, the value after it.
function headerLine(line: string): { name: string; value: string } | undefined {
  const at = line.indexOf(':')
  return at < 0 ? undefined : { name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() }
}

// Header names are case-insensitive, so a line in any case is one the relay reads as the owner.
function isOwnerLine(line: string): boolean {
  return headerLine(line)?.name.toLowerCase() === OWNER_HEADER.toLowerCase()
}

export function ownerOf(existing: string | undefined): string | undefined {
  const owners = (existing ?? '').split(/\r?\n/).filter(isOwnerLine)
  // Two owner lines leave which one a request carries to the client, so neither proves who wrote them.
  if (owners.length !== 1) return undefined
  const value = headerLine(owners[0] as string)?.value
  return value === undefined || value === '' ? undefined : value
}

export function ownerHeaderLines(existing: string | undefined, uuid: string): string {
  const kept = (existing ?? '').split(/\r?\n/).filter((line) => line.trim() !== '' && !isOwnerLine(line))
  return [...kept, `${OWNER_HEADER}: ${uuid}`].join('\n')
}

// The variables alone are inherited by every process this one starts, so only a record kept for this process, the
// host's state for the session or the store's entry under the process's identity, shows that this load runs where the
// pair was minted.
export function reusable(held: Identity | undefined, variable: string | undefined,
  headerOwner: string | undefined): boolean {
  return held !== undefined && variable !== undefined && headerOwner !== undefined &&
    held.instance === variable && held.owner === headerOwner
}

// From the clock, so a record that starts over after a reload or a return to an earlier id is never behind the
// sequence the router took last.
export function nextSequence(previous: number, nowMs: number): number {
  return Math.max(previous + 1, nowMs)
}

function agentOf(report: Report): string | undefined {
  return 'agent_id' in report ? report.agent_id : undefined
}

function sameAgent(report: Report, event: Report['event'], agent: string): boolean {
  return report.event === event && agentOf(report) === agent
}

export function collapse(queue: Report[], report: Report): Report[] {
  switch (report.event) {
    case 'session_end':
      return [report]
    case 'session_start':
      return [report, ...queue.filter((queued) => queued.event !== 'session_start')]
    case 'heartbeat':
      return queue.some((queued) => queued.event === 'heartbeat') ? queue : [...queue, report]
    case 'agent_start': {
      // A start queued before a release of the agent announced the run that release ends, so a new run needs its own.
      const released = queue.findLastIndex((queued) => isRelease(queued, report.agent_id))
      return queue.some((queued, at) => at > released && sameAgent(queued, 'agent_start', report.agent_id))
        ? queue
        : [...queue, report]
    }
    case 'state': {
      const released = queue.findLastIndex((queued) => isRelease(queued, report.agent_id))
      // A run queued after a release never reached the router, so a second release drops that run and keeps the
      // first release, which ends what the router holds.
      if (report.state === 'released' && released >= 0) {
        return queue.filter((queued, at) => at <= released ||
          !(sameAgent(queued, 'state', report.agent_id) || sameAgent(queued, 'agent_start', report.agent_id)))
      }
      // A queued release stays ahead of the agent's next state, since without it the router would be asked to start
      // an agent it still holds.
      return [
        ...queue.filter((queued) => !sameAgent(queued, 'state', report.agent_id) || isRelease(queued, report.agent_id)),
        report,
      ]
    }
    case 'activity': {
      // Appended rather than replaced in place, so a prompt stays behind a state the agent reported before it.
      const queued = queue.find((candidate) => sameAgent(candidate, 'activity', report.agent_id))
      if (queued !== undefined && report.kind === 'presence') return queue
      return [...queue.filter((candidate) => candidate !== queued), report]
    }
  }
}

function isRelease(report: Report, agent: string): boolean {
  return report.event === 'state' && report.agent_id === agent && report.state === 'released'
}

function isRun(report: Report, agent: string): boolean {
  return sameAgent(report, 'agent_start', agent) || sameAgent(report, 'state', agent)
}

// A start or a state of the agent's still queued carries a run the router takes after any answer that named the
// agent released, so that answer no longer says the router ended what the mod holds.
function holdsRun(agent: string): boolean {
  return queue.reports.some((queued) => isRun(queued, agent))
}

function supersedes(queued: Report, report: Report): boolean {
  switch (report.event) {
    case 'session_start':
    case 'heartbeat':
      return queued.event === report.event
    case 'session_end':
      return false
    case 'agent_start':
      return sameAgent(queued, report.event, report.agent_id)
    case 'state':
      // A release refused once goes out again even behind the agent's next state.
      return sameAgent(queued, report.event, report.agent_id) && report.state !== 'released'
    case 'activity':
      return queued.event === 'activity' && queued.agent_id === report.agent_id &&
        (queued.kind === 'prompt' || report.kind === 'presence')
  }
}

export function restore(queue: Report[], report: Report): Report[] {
  const agent = agentOf(report)
  const released = agent === undefined ? -1 : queue.findIndex((queued) => isRelease(queued, agent))
  let rest = queue
  if (agent !== undefined && isRelease(report, agent) && released >= 0) {
    // The router still holds the run this release ends, and the run queued up to the later release never reached
    // it, so the first release goes out in place of that run, as collapse keeps the first of two.
    rest = queue.filter((queued, at) => at > released || !isRun(queued, agent))
  } else {
    // A start queued behind a release of the agent announces the next run, so it never stands in for this one.
    const current = report.event === 'agent_start' && released >= 0 ? queue.slice(0, released) : queue
    if (current.some((queued) => supersedes(queued, report))) return queue
    // A prompt resets everything a presence does, so the agent keeps one activity as collapse keeps it.
    if (report.event === 'activity' && report.kind === 'prompt') {
      rest = queue.filter((queued) => !sameAgent(queued, 'activity', report.agent_id))
    }
  }
  // A registration stays first, since every other report needs the session it opens.
  const at = rest[0]?.event === 'session_start' ? 1 : 0
  return [...rest.slice(0, at), report, ...rest.slice(at)]
}

export function heartbeatInterval(leaseExpiresMs: number, nowMs: number): number {
  return Math.min(HEARTBEAT_MAX_MS, Math.max(HEARTBEAT_MIN_MS, Math.floor((leaseExpiresMs - nowMs) / 3)))
}

export function backoff(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] as number
}

export function buildBody(session: SessionRecord, report: Report, nowMs: number): Body {
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

export function isRealPrompt(origin: { kind: string } | undefined): boolean {
  return origin !== undefined && REAL_PROMPTS.has(origin.kind)
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined
}

// The client's own arithmetic for a background command, so the variables raise its bounds and never lower them. The
// router reads whole milliseconds, so a fractional timeout rounds up, as the cron times do.
export function commandDeadline(startedAt: number, timeoutMs: number | undefined,
  env: { defaultMs?: number; maxMs?: number }): number {
  const base = positive(env.defaultMs) ?? BASH_DEFAULT_MS
  const limit = Math.max(DEFAULT_COMMAND_TIMEOUT_MS, base)
  const ceiling = Math.max(positive(env.maxMs) ?? BASH_MAX_MS, base)
  const cap = Math.min(Math.max(MAX_COMMAND_TIMEOUT_MS, ceiling), TIMER_MAX_MS)
  return Math.ceil(startedAt + Math.min(positive(timeoutMs) ?? limit, cap))
}

// One field of a cron expression as the client's own parser reads it, or nothing when the client would refuse it.
function cronField(text: string, bounds: { min: number; max: number }): Set<number> | undefined {
  const { min, max } = bounds
  // The day of week also takes 7 for Sunday.
  const weekday = min === 0 && max === 6
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const every = /^\*(?:\/(\d+))?$/.exec(part)
    if (every !== null) {
      const step = every[1] === undefined ? 1 : Number(every[1])
      if (step < 1) return undefined
      for (let value = min; value <= max; value += step) values.add(value)
      continue
    }
    const range = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part)
    if (range !== null) {
      const [from, to] = [Number(range[1]), Number(range[2])]
      const step = range[3] === undefined ? 1 : Number(range[3])
      if (from > to || step < 1 || from < min || to > (weekday ? 7 : max)) return undefined
      for (let value = from; value <= to; value += step) values.add(weekday && value === 7 ? 0 : value)
      continue
    }
    if (!/^\d+$/.test(part)) return undefined
    const value = weekday && Number(part) === 7 ? 0 : Number(part)
    if (value < min || value > max) return undefined
    values.add(value)
  }
  return values.size === 0 ? undefined : values
}

type CronSets = { minutes: Set<number>; hours: Set<number>; days: Set<number>; months: Set<number>;
  weekdays: Set<number> }

function cronSets(expression: string): CronSets | undefined {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== CRON_FIELDS.length) return undefined
  const fields = CRON_FIELDS.map((bounds, index) => cronField(parts[index] ?? '', bounds))
  const [minutes, hours, days, months, weekdays] = fields
  if (minutes === undefined || hours === undefined || days === undefined || months === undefined ||
    weekdays === undefined) return undefined
  return { minutes, hours, days, months, weekdays }
}

// The client's own walk to the first match after a time: from the next whole minute in local time, a month, a day or
// an hour that cannot match is skipped whole, and the walk ends where the client's does.
function matchAfter(sets: CronSets, fromMs: number): number | undefined {
  const { minutes, hours, days, months, weekdays } = sets
  // A restricted day of month and a restricted day of week match either one, as cron and the client read them.
  const anyDay = days.size === 31
  const anyWeekday = weekdays.size === 7
  const at = new Date(fromMs)
  at.setSeconds(0, 0)
  at.setMinutes(at.getMinutes() + 1)
  for (let step = 0; step < CRON_STEPS; step += 1) {
    if (!months.has(at.getMonth() + 1)) {
      at.setMonth(at.getMonth() + 1, 1)
      at.setHours(0, 0, 0, 0)
      continue
    }
    const day = days.has(at.getDate())
    const weekday = weekdays.has(at.getDay())
    if (!(anyDay ? anyWeekday || weekday : anyWeekday ? day : day || weekday)) {
      at.setDate(at.getDate() + 1)
      at.setHours(0, 0, 0, 0)
      continue
    }
    if (!hours.has(at.getHours())) {
      at.setHours(at.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!minutes.has(at.getMinutes())) {
      at.setMinutes(at.getMinutes() + 1)
      continue
    }
    return at.getTime()
  }
  return undefined
}

// The share of the spread the client gives a cron, from the first eight hexadecimal digits of its id.
function idShare(id: string): number {
  const share = Number.parseInt(id.slice(0, 8), 16) / 4294967296
  return Number.isFinite(share) ? share : 0
}

// When the client fires a cron next, counted from its creation or its last fire, as its scheduler computes it.
export function nextFireAt(expression: string, baseMs: number, id: string, recurring: boolean): number | undefined {
  const sets = cronSets(expression)
  if (sets === undefined) return undefined
  const grid = matchAfter(sets, baseMs)
  if (grid === undefined) return undefined
  if (!recurring) {
    if (new Date(grid).getMinutes() % ONE_SHOT_MINUTE_MOD !== 0) return grid
    return Math.ceil(Math.max(grid - idShare(id) * ONE_SHOT_MAX_MS, baseMs))
  }
  const after = matchAfter(sets, grid)
  if (after === undefined) return grid
  const period = after - grid
  if (LOOP_EXPRESSION.test(expression) && CACHE_LEAD_MS < period && period >= LOOP_PERIOD_MS &&
    period - CACHE_LEAD_MS < LOOP_PERIOD_MS) return baseMs + period - CACHE_LEAD_MS
  return Math.ceil(grid + Math.min(idShare(id) * RECURRING_SHARE * period, RECURRING_CAP_MS))
}

export function parkOf(agent: AgentRecord, crons: Iterable<Cron>): Park {
  let wakeAt: number | undefined
  for (const cron of crons) wakeAt = wakeAt === undefined ? cron.wakeAt : Math.min(wakeAt, cron.wakeAt)
  const background = agent.open.size > 0
  if (!background && wakeAt === undefined) return { state: 'idle' }
  const park: Park = {
    state: 'parked',
    park_kind: background && wakeAt !== undefined ? 'both' : background ? 'background' : 'scheduled',
  }
  if (wakeAt !== undefined) park.wake_at = wakeAt
  // A subagent has no deadline, so the park has one only while every open task is a command.
  let deadline: number | undefined
  for (const task of agent.open.values()) {
    if (task.kind !== 'command' || task.deadline === undefined) {
      deadline = undefined
      break
    }
    deadline = deadline === undefined ? task.deadline : Math.max(deadline, task.deadline)
  }
  if (deadline !== undefined) park.deadline = deadline
  return park
}

function active(): boolean {
  return settings !== undefined && identity !== undefined && !refused
}

function live(): boolean {
  return active() && session !== undefined && !session.stopped
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

function mainAgent(): AgentRecord {
  let main = model.agents.get(MAIN)
  if (main === undefined) {
    main = freshRecord(MAIN, 'busy')
    model.agents.set(MAIN, main)
  }
  return main
}

// The crons belong to the session, and the session's loop is main's.
function cronsOf(agent: AgentRecord): Iterable<Cron> {
  return agent.id === MAIN ? model.crons.values() : []
}

function samePark(a: Park, b: Park): boolean {
  if (a.state === 'idle' || b.state === 'idle') return a.state === b.state
  return a.park_kind === b.park_kind && a.wake_at === b.wake_at && a.deadline === b.deadline
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
  const releasing = queue.reports.some((queued) => isRelease(queued, agentId))
  if (flying !== undefined && sameAgent(flying, 'agent_start', agentId) && !releasing) return
  queue.reports = collapse(queue.reports, { event: 'agent_start', agent_id: agentId })
  session.routerReleased.delete(agentId)
}

function report(agentId: string, state: AgentRecord['state'], park?: Park): void {
  const agent = model.agents.get(agentId)
  if (agent !== undefined) agent.state = state
  if (!live()) return
  announce(agentId)
  const body: Extract<Report, { event: 'state' }> = { event: 'state', agent_id: agentId, state }
  if (park !== undefined && park.state === 'parked') {
    body.park_kind = park.park_kind
    if (park.wake_at !== undefined) body.wake_at = park.wake_at
    if (park.deadline !== undefined) body.deadline = park.deadline
  }
  queue.reports = collapse(queue.reports, body)
}

// A subagent rests parked on its own open work or not at all: with nothing open, its work went back to its parent.
function rest(agent: AgentRecord): void {
  const park = parkOf(agent, cronsOf(agent))
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
  const before = parkOf(agent, cronsOf(agent))
  edit()
  if (model.agents.get(agent.id) !== agent || agent.state === 'busy') return
  const after = parkOf(agent, cronsOf(agent))
  if (!samePark(before, after)) rest(agent)
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
function tasksStopped(listed: unknown): void {
  if (!Array.isArray(listed)) return
  const running = new Set<string>()
  for (const entry of listed) {
    const id = field(entry, 'id')
    const status = field(entry, 'status')
    if (typeof id === 'string' && typeof status === 'string' && LIVE_TASK.has(status)) running.add(id)
  }
  for (const owner of [...model.agents.values()]) {
    for (const task of [...owner.open.values()]) {
      if (task.kind === 'command' && !running.has(task.id)) change(owner, () => owner.open.delete(task.id))
    }
  }
}

// The first time the client may fire a wake. A cron's is computed exactly. A wakeup's task id never reaches the mod,
// so on :00 or :30 it may fire anywhere the one-shot rule allows, up to 90 s early and never before its creation.
function earliest(cron: Cron): number {
  const onHalfHour = new Date(cron.wakeAt).getMinutes() % ONE_SHOT_MINUTE_MOD === 0
  if (cron.expression !== undefined || !onHalfHour) return cron.wakeAt
  return Math.max(cron.wakeAt - ONE_SHOT_MAX_MS, cron.createdAt)
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
      const deadline = commandDeadline(now, typeof timeout === 'number' ? timeout : undefined, model.env)
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
    change(owner, () => {
      for (const task of [...owner.open.values()]) {
        if (task.kind === 'command' && task.deadline !== undefined && task.deadline <= now) owner.open.delete(task.id)
      }
    })
  }
}

function restate(agent: AgentRecord): void {
  if (agent.state === 'busy') report(agent.id, 'busy')
  else rest(agent)
}

// The registration's answer names every agent the router holds. Each side learns what the other lacks: an agent
// only the router holds is rebuilt from the client's list or released, a state the router holds wrongly is sent
// again, and an agent only the mod holds is announced with its state.
function reconcileAck(entries: unknown[], listed: AgentInfo[] | undefined): void {
  const held = new Map<string, unknown>()
  for (const entry of entries) {
    const id = field(entry, 'agent_id')
    if (typeof id === 'string') held.set(id, field(entry, 'state'))
  }
  const client = listed === undefined ? undefined : new Map(listed.map((agent) => [agent.id, agent]))
  const live: AgentInfo[] = []
  for (const [id, state] of held) {
    if (state === 'released') continue
    const agent = model.agents.get(id)
    if (agent !== undefined) {
      if (state !== agent.state) restate(agent)
      continue
    }
    // The answer names the run this mod released. The release ends it on the router, so the agent is not adopted
    // again until a spawn or a turn starts a new run, and a router restored from a save older than the release
    // learns of it here, when no release of it is still queued.
    if (model.released.has(id)) {
      if (!queue.reports.some((queued) => isRelease(queued, id))) {
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

function request(config: Settings, body: Body): { method: string; headers: Record<string, string>; body: string } {
  return {
    method: 'POST',
    headers: { ...bearer(config.key), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

// The tracked work as the host holds it: a reload of the module in the same session reads it back before the
// registration's answer is reconciled, so the park the router holds is not overwritten with a fresh busy main.
function snapshotModel(record: SessionRecord): SavedModel {
  const agents: SavedAgent[] = [...model.agents.values()].map((agent) => ({
    id: agent.id,
    ...(agent.parent === undefined ? {} : { parent: agent.parent }),
    state: agent.state,
    open: [...agent.open.values()].map((task) => ({
      id: task.id,
      kind: task.kind,
      ...(task.deadline === undefined ? {} : { deadline: task.deadline }),
    })),
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

async function ensureSession($: EngineInterface): Promise<void> {
  const id = await $.session.id()
  if (session?.id === id || identity === undefined) return
  // The same id in the same process is a reload of the module, whose tracked work the host still holds. A new id
  // is a new conversation, so nothing the old one had open or scheduled carries over. Read before the session
  // moves, so a pump during the read never writes the old session's work under the new id.
  const held = heldModelFor((await $.state.get(MODEL_REF)).value, id)
  if (session?.id === id) return
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
  model.unlisted = new Map()
  model.turning = new Set()
  model.current = new Set()
  model.released = new Set()
  if (held !== undefined) {
    restoreModel(held, session)
    return
  }
  model.agents = freshAgents()
  model.crons = new Map()
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

function ready(): boolean {
  return active() && session !== undefined && !session.stopped && queue.inFlight === undefined &&
    queue.reports.length > 0
}

async function pump($: EngineInterface): Promise<void> {
  try {
    await persistModel($)
    if (!ready()) return
    const sentAt = await $.clock.now()
    if (queue.retryAt !== undefined && sentAt < queue.retryAt) return
    if (!ready() || session === undefined || settings === undefined) return
    const at = nextReport(sentAt)
    if (at < 0) return
    const record = session
    // A session.start can replace or clear the settings while the request is out, so the catch reads the key this
    // request carried from here and cannot throw on a cleared one.
    const config = settings
    const [report] = queue.reports.splice(at, 1) as [Report]
    queue.inFlight = { report }
    const init = request(settings, buildBody(record, report, sentAt))
    let response: HttpResponse | undefined
    try {
      response = await $.http.fetch(settings.url + EVENTS_PATH, init)
    } catch (error) {
      // The client refuses a plugin's fetch inside the process when its policy check failed, and a refused host
      // throws the same way, so the one sign of either is this line: the backoff below retries all the same. The
      // message is the host's and may quote the request, so the key and any URL credentials leave it first.
      response = undefined
      try {
        const reason = redactSecrets(errorText(error), config.key)
        $.ui.log(`the ${report.event} report could not be sent (${reason}), so the mod retries under its backoff ` +
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
    // the mod no longer reports.
    if (record === session && !record.stopped && !refused) settle($, record, report, response, now, listed)
  } catch {
    return
  }
  await pump($)
}

/** Drops every queued report, as a refused key leaves nothing to send. */
export function emptyQueue(): void {
  queue.reports = []
}

function settle($: EngineInterface, record: SessionRecord, report: Report, response: HttpResponse | undefined,
  now: number, listed: AgentInfo[] | undefined): void {
  const repeated = startRefusal
  startRefusal = undefined
  // The router's agent limit refuses one agent's start, not the session: that agent waits under its own retry time
  // while the lease is renewed and the other agents report.
  if (response !== undefined && response.status === 429 && report.event === 'agent_start' &&
    parsed(response.text).code === 'agent_limit') {
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
    acknowledged($, record, report, parsed(response.text), now, listed)
    return
  }
  if (response.status === 401 || response.status === 403) {
    refused = true
    emptyQueue()
    timer?.cancel()
    $.ui.log(`the router refused the key with status ${response.status}, so this process reports nothing more`,
      { to: 'debug' })
    return
  }
  if (response.status === 409) {
    refusedReport($, record, report, parsed(response.text), now, repeated)
    return
  }
  // Any other answer names a report the router never takes, so the mod drops it rather than retrying. The router
  // keeps no trace of it, which leaves this line as the one sign of a body the mod built wrong.
  const code = parsed(response.text).code
  const named = typeof code === 'string' && CODE.test(code) ? `with code ${code}` : 'with no code'
  $.ui.log(`the router answered status ${response.status} ${named} to the ${report.event} report, so the mod drops it`,
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

function acknowledged($: EngineInterface, record: SessionRecord, report: Report, ack: Record<string, unknown>,
  now: number, listed: AgentInfo[] | undefined): void {
  // Only these two reports renew the router's lease, so only their answers move the heartbeat.
  if ((report.event === 'session_start' || report.event === 'heartbeat') && typeof ack.lease_expires_ms === 'number') {
    const at = now + heartbeatInterval(ack.lease_expires_ms, now)
    record.heartbeatAt = at
    timer?.cancel()
    timer = $.clock.after(at - now, () => tick($))
  }
  if (typeof ack.request_generation === 'number') {
    record.generations.set(typeof ack.agent_id === 'string' ? ack.agent_id : MAIN, ack.request_generation)
  }
  const agents: unknown[] = Array.isArray(ack.agents) ? ack.agents : []
  for (const agent of agents) {
    if (typeof agent !== 'object' || agent === null) continue
    const { agent_id: id, request_generation: generation, state } = agent as Record<string, unknown>
    if (typeof id !== 'string' || typeof generation !== 'number') continue
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
      if (!queue.reports.some((queued) => isRelease(queued, id))) record.announced.add(id)
    }
  }
  // A start answered after its run ended leaves the agent unannounced, so the next run starts it again once the
  // queued release went out.
  if (report.event === 'agent_start') {
    queue.deferred.delete(report.agent_id)
    // An accepted start means the router holds the run live again, whatever answer named it released after the start
    // was queued.
    record.routerReleased.delete(report.agent_id)
    if (!queue.reports.some((queued) => isRelease(queued, report.agent_id))) record.announced.add(report.agent_id)
  }
  if (report.event === 'session_start') {
    if (record.conflicted === true && report.previous_instance_id !== undefined) {
      $.ui.log(`took over session ${record.id} from a silent instance`)
    }
    record.conflicted = undefined
  }
  queue.attempt = 0
  queue.retryAt = undefined
  // An answer without the member says nothing about the router's agents, so nothing is reconciled against it.
  if (report.event === 'session_start' && Array.isArray(ack.agents)) reconcileAck(agents, listed)
}

function refusedReport($: EngineInterface, record: SessionRecord, report: Report,
  refusal: Record<string, unknown>, now: number, repeated: unknown): void {
  const agent = agentOf(report)
  const generation = typeof refusal.request_generation === 'number' ? refusal.request_generation : undefined
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
      if (typeof refusal.instance_id === 'string') {
        queue.reports = collapse(queue.reports, startReport(refusal.instance_id))
        return
      }
      // A live holder's lease lapses unless it reports, and the router names it from then on, so the start waits
      // under the backoff rather than ending the session. The host prefixes the plugin's name to the line.
      queue.reports = restore(queue.reports, report)
      delay($, now)
      if (record.conflicted !== true) {
        record.conflicted = true
        $.ui.log(`another instance reports session ${record.id}, so the start is retried once its lease lapses`)
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
      await ensureSession($)
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
    $.ui.log(`the client process reads as ${id}, which keys the pair the mod reuses across a clear`, { to: 'debug' })
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

// The owner the router fences this process's requests by. A reload of the module, an enable or a worker respawn in
// the same process keeps the pair under any session id of the process, so the router's session keeps its owner, and
// any other process mints its own.
async function fence($: EngineInterface): Promise<Identity> {
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
    await $.state.set(IDENTITY_REF, pair)
  }
  if (processId !== undefined) await keepPair($, pairs, processId, pair)
  // The owner line replaces any line before it, so the relay reads one owner whatever the variable inherited.
  await $.env.set('ANTHROPIC_CUSTOM_HEADERS', ownerHeaderLines(existing, pair.owner))
  await $.env.set('PHOEBIS_KEEPALIVE_INSTANCE', pair.instance)
  return pair
}

/** Starts the lifecycle: the fence, the registration, the pump. Idempotent per session start. */
export async function startKeepalive($: EngineInterface, resolved: Settings): Promise<void> {
  if (!refused) identity = await fence($)
  settings = resolved
  if (active()) {
    const [defaultMs, maxMs] = await Promise.all([
      $.env.get('BASH_DEFAULT_TIMEOUT_MS'),
      $.env.get('BASH_MAX_TIMEOUT_MS'),
    ])
    model.env = { defaultMs: milliseconds(defaultMs), maxMs: milliseconds(maxMs) }
    await ensureSession($)
    void pump($)
  }
}

/** Drops the held settings, so the lifecycle reports nothing until a later start resolves them again. */
export function clearSettings(): void {
  settings = undefined
}

export function installKeepalive(on: On): void {
  on('prompt.submit', async ($, e, next) => {
    if (active()) {
      await ensureSession($)
      if (live()) {
        if (e.origin.kind === 'scheduled-trigger') {
          fired(await $.clock.now())
        } else if (isRealPrompt(e.origin)) {
          // The router marks main busy on the prompt itself, so no state report goes with it.
          queue.reports = collapse(queue.reports, { event: 'activity', agent_id: MAIN, kind: 'prompt' })
          const main = mainAgent()
          main.state = 'busy'
          model.turning.add(MAIN)
          // The person's return ends main's wait on every command its earlier turns started, still running or
          // not, so a long-running one such as a dev server parks main only until then. A prompt typed into the
          // running turn keeps the commands that turn started, since they are seconds old.
          const keep = e.turnId === undefined ? new Set<string>() : model.current
          for (const task of [...main.open.values()]) {
            if (task.kind === 'command' && !keep.has(task.id)) main.open.delete(task.id)
          }
        }
      }
      void pump($)
    }
    return next(e)
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
    if (live()) {
      tasksStopped(field(e, 'background_tasks'))
      void pump($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    if (live()) {
      tasksStopped(field(e, 'background_tasks'))
      void pump($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The end goes out past a request in flight: every session.end hook shares one short budget, and the lease
  // covers whatever this one request does not reach.
  on('session.end', async ($, e, next) => {
    if (active() && settings !== undefined && session !== undefined && !session.stopped) {
      const config = settings
      const record = session
      record.stopped = true
      queue.reports = []
      const body = buildBody(record, { event: 'session_end' }, await $.clock.now())
      void $.http.fetch(config.url + EVENTS_PATH, request(config, body)).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
