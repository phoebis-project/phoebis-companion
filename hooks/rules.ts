import type { AgentFactSet, Identity, SavedAgent, SavedCron, SavedTask, SessionFactSet } from '../types'

// The rules the lifecycle computes with. Nothing here holds state: the session, the queue and the tracked work
// belong to keepalive.ts.

/** A kind of reported fact, by the option that switches it. */
export type FactKind = 'agents' | 'project' | 'title'

export type Report =
  | { event: 'session_start'; reported_facts: FactKind[]; owner_id?: string; previous_instance_id?: string }
  | { event: 'heartbeat' }
  | { event: 'session_end' }
  | { event: 'agent_start'; agent_id: string }
  | { event: 'activity'; agent_id: string; kind: 'prompt' | 'presence' }
  | ({ event: 'state'; agent_id: string; state: SavedAgent['state'] } & Partial<ParkFields>)
  | ({ event: 'session_facts' } & SessionFactSet)
  | ({ event: 'agent_facts'; agent_id: string } & AgentFactSet)

/** A report of display state. Each other report is a lifecycle report and goes out ahead of it. */
export function isFacts(report: Report): boolean {
  return report.event === 'session_facts' || report.event === 'agent_facts'
}

export type Body = Report & {
  protocol: 1
  session_id: string
  instance_id: string
  sequence: number
  request_generation?: number
}

const OWNER_HEADER = 'X-Keepalive-Owner-Id'
const HEARTBEAT_MIN_MS = 1000
const HEARTBEAT_MAX_MS = 25000

export type Cron = SavedCron

export type AgentRecord = {
  id: string
  parent?: string
  state: SavedAgent['state']
  open: Map<string, SavedTask>
  lastPresence: number
  /** What the client last said of the agent, cleaned. Empty with the option off. */
  facts: AgentFactSet
  /** The set last queued for the agent, undefined while none was or once the router refused it as unknown. */
  factsQueued: AgentFactSet | undefined
  /** The router has not answered the last set queued for good. */
  factsOwed: boolean
}

const PARK_KINDS = ['background', 'both', 'scheduled'] as const

type ParkFields = { park_kind: (typeof PARK_KINDS)[number]; wake_at?: number; deadline?: number }

export type Park = { state: 'idle' } | ({ state: 'parked' } & ParkFields)

const DEFAULT_COMMAND_TIMEOUT_MS = 1800000
const MAX_COMMAND_TIMEOUT_MS = 7200000

// The person's own prompts: typed at the terminal, sent through Remote Control or Slack, or handed over by the SDK
// host.
const REAL_PROMPTS = new Set(['bridge', 'composer', 'sdk', 'slack-ping'])
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
// The client's Bash bounds a background command's limit derives from: its default and foreground maximum, and the
// longest timer it can arm.
const BASH_DEFAULT_MS = 120000
const BASH_MAX_MS = 600000
const TIMER_MAX_MS = 2147483647
// The client's own bound on its walk to the next match: as many steps as a leap year has minutes.
const CRON_STEPS = 527040
// The bounds of minute, hour, day of month, month and day of week.
const CRON_FIELDS: readonly CronBounds[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  // The day of week also takes 7 for Sunday.
  { min: 0, max: 7, wrap: 7 },
]

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
export function reusable(held: Identity, variable: string | undefined, headerOwner: string | undefined): boolean {
  return variable !== undefined && headerOwner !== undefined && held.instance === variable && held.owner === headerOwner
}

// From the clock, so a record that starts over after a reload or a return to an earlier id is never behind the
// sequence the router took last.
export function nextSequence(previous: number, nowMs: number): number {
  return Math.max(previous + 1, nowMs)
}

export function agentOf(report: Report): string | undefined {
  return 'agent_id' in report ? report.agent_id : undefined
}

export function sameAgent(report: Report, event: Report['event'], agent: string): boolean {
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
        return queue.filter((queued, at) => at <= released || !isRun(queued, report.agent_id))
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
    case 'session_facts':
    case 'agent_facts':
      // The newest set stands for the session or the agent. It goes to the end, so it stays behind what was queued
      // ahead of it, an agent's start among them.
      return [...queue.filter((queued) => !supersedes(queued, report)), report]
  }
}

export function isRelease(report: Report, agent: string): boolean {
  return report.event === 'state' && report.agent_id === agent && report.state === 'released'
}

export function isRun(report: Report, agent: string): boolean {
  return sameAgent(report, 'agent_start', agent) || sameAgent(report, 'state', agent)
}

function supersedes(queued: Report, report: Report): boolean {
  switch (report.event) {
    case 'session_start':
    case 'heartbeat':
    case 'session_facts':
      return queued.event === report.event
    case 'session_end':
      return false
    case 'agent_start':
    case 'agent_facts':
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

export function isRealPrompt(origin: { kind: string }): boolean {
  return REAL_PROMPTS.has(origin.kind)
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined
}

// The client's own arithmetic for a background command, so the variables raise its bounds and never lower them. The
// router reads whole milliseconds, so a fractional timeout rounds up, as the cron times do.
export function commandDeadline(startedAt: number, timeoutMs: number | undefined,
  env: { defaultMs?: number; maxMs?: number }): number {
  const base = env.defaultMs ?? BASH_DEFAULT_MS
  const limit = Math.max(DEFAULT_COMMAND_TIMEOUT_MS, base)
  const ceiling = Math.max(env.maxMs ?? BASH_MAX_MS, base)
  const cap = Math.min(Math.max(MAX_COMMAND_TIMEOUT_MS, ceiling), TIMER_MAX_MS)
  return Math.ceil(startedAt + Math.min(positive(timeoutMs) ?? limit, cap))
}

type CronBounds = { min: number; max: number; wrap?: number }

// One field of a cron expression as the client's own parser reads it, or nothing when the client would refuse it.
function cronField(text: string, bounds: CronBounds): Set<number> | undefined {
  const { min, max, wrap } = bounds
  const values = new Set<number>()
  const add = (value: number): void => {
    values.add(wrap === undefined ? value : value % wrap)
  }
  for (const part of text.split(',')) {
    const every = /^\*(?:\/(\d+))?$/.exec(part)
    if (every !== null) {
      const step = every[1] === undefined ? 1 : Number(every[1])
      if (step < 1) return undefined
      for (let value = min; value <= max; value += step) add(value)
      continue
    }
    const range = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part)
    if (range !== null) {
      const [from, to] = [Number(range[1]), Number(range[2])]
      const step = range[3] === undefined ? 1 : Number(range[3])
      if (from > to || step < 1 || from < min || to > max) return undefined
      for (let value = from; value <= to; value += step) add(value)
      continue
    }
    if (!/^\d+$/.test(part)) return undefined
    const value = Number(part)
    if (value < min || value > max) return undefined
    add(value)
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

function onHalfHour(ms: number): boolean {
  return new Date(ms).getMinutes() % ONE_SHOT_MINUTE_MOD === 0
}

// When the client fires a cron next, counted from its creation or its last fire, as its scheduler computes it.
export function nextFireAt(expression: string, baseMs: number, id: string, recurring: boolean): number | undefined {
  const sets = cronSets(expression)
  if (sets === undefined) return undefined
  const grid = matchAfter(sets, baseMs)
  if (grid === undefined) return undefined
  if (!recurring) {
    if (!onHalfHour(grid)) return grid
    return Math.ceil(Math.max(grid - idShare(id) * ONE_SHOT_MAX_MS, baseMs))
  }
  const after = matchAfter(sets, grid)
  if (after === undefined) return grid
  const period = after - grid
  if (LOOP_EXPRESSION.test(expression) && CACHE_LEAD_MS < period && period >= LOOP_PERIOD_MS &&
    period - CACHE_LEAD_MS < LOOP_PERIOD_MS) return baseMs + period - CACHE_LEAD_MS
  return Math.ceil(grid + Math.min(idShare(id) * RECURRING_SHARE * period, RECURRING_CAP_MS))
}

export function isParkKind(value: unknown): value is ParkFields['park_kind'] {
  return PARK_KINDS.some((kind) => kind === value)
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

export function samePark(a: Park, b: Park): boolean {
  if (a.state === 'idle' || b.state === 'idle') return a.state === b.state
  return a.park_kind === b.park_kind && a.wake_at === b.wake_at && a.deadline === b.deadline
}

// The first time the client may fire a wake. A cron's is computed exactly. A wakeup's task id never reaches the mod,
// so on :00 or :30 it may fire anywhere the one-shot rule allows, up to 90 s early and never before its creation.
export function earliest(cron: Cron): number {
  if (cron.expression !== undefined || !onHalfHour(cron.wakeAt)) return cron.wakeAt
  return Math.max(cron.wakeAt - ONE_SHOT_MAX_MS, cron.createdAt)
}
