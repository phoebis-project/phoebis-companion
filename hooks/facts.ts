import type { AgentInfo, ClassicEventOf, EngineInterface, Frozen, On } from 'claude-code'
import type { AgentFactSet, SavedAgentFacts, SavedFacts, SavedSlot, SessionFactSet } from '../types'
import { agentFactSet, sameFacts, sessionFactSet } from './fact-rules'
import type { SessionRead } from './fact-rules'
import type { FactKind, Report } from './rules'
import { guarded } from './settings'
import type { FactOptions } from './settings'

// The facts the mod reports for display: the options, each agent's sets, the session's set, the closing sets, the
// titles seen and the reads. The module queues nothing, sends nothing and writes no host state. Where a set goes out it
// answers a report, which the reporting module queues in the same step, so each order of the queue and each state call
// has one owner.

export type SessionFactsRead = { number: number; set: SessionFactSet }

type FactsSlot<T> = {
  /** The set last queued, undefined while none was. */
  factsQueued: T | undefined
  /** The router has not answered the last set queued for good. */
  factsOwed: boolean
}
// An agent's queued set is undefined also once the router refused it as unknown.
type AgentSlot = FactsSlot<AgentFactSet> & {
  /** What the client last said of the agent, cleaned. */
  facts: AgentFactSet
}

let factOptions: FactOptions = { agents: false, project: false, title: false }
const agents = new Map<string, AgentSlot>()
const session: FactsSlot<SessionFactSet> & { due: boolean } = {
  // The session's set as last queued, whatever the router answered, so a set the router refused goes out again only
  // once it changes or a registration is acknowledged.
  factsQueued: undefined,
  // A set queued that the router has not answered for good, so a registration sends it again, an empty one too.
  factsOwed: false,
  // An acknowledged registration leaves the duty to send the session's facts whole, since the router's record may be
  // a new one. It stands until a session read that counts takes it.
  due: false,
}
// The set of a run that ended before the router acknowledged its start, by the queued release that ends the run, so
// that acknowledgment puts it right ahead of that release. A later run of the agent ends under a release of its own.
const closingSets = new WeakMap<Report, AgentFactSet>()
// The title the client last named for each session, by that session's id: a title counts only for its own session. An
// entry without a title is an event that saw the session and carried none.
const seenTitles = new Map<string, string | undefined>()
// Counts the session reads, so a read that finishes behind a later one changes nothing.
let factReads = 0
let factReadsDone = 0

export function installFacts(on: On, options: FactOptions): void {
  factOptions = options
  if (factOptions.title) {
    // The title rides these two events and no other. Nothing but the title and the session id is read, so a prompt's
    // text stays unread, and each event is passed on unchanged.
    on('classic.SessionStart', async (_$, e, next) => {
      noteTitle(e)
      return next(e)
    }).catch((_$, e, next) => next(e))
    on('classic.UserPromptSubmit', async (_$, e, next) => {
      noteTitle(e)
      return next(e)
    }).catch((_$, e, next) => next(e))
  }
}

// Keeps the title an event names with its session's id. An event of the session without a string title leaves the
// title empty, so the next read sends the set without it.
function noteTitle(e: Frozen<ClassicEventOf['classic.SessionStart'] |
  ClassicEventOf['classic.UserPromptSubmit']>): void {
  const id = e.session_id
  if (typeof id !== 'string') return
  const title = e.session_title
  seenTitles.set(id, typeof title === 'string' ? title : undefined)
}

// The kinds whose option is on, in alphabetical order, so two registrations of one option set carry one body.
export function reportedKinds(): FactKind[] {
  return (Object.keys(factOptions) as FactKind[]).filter((kind) => factOptions[kind]).sort()
}

/** Empties each slot and drops the title seen of each session other than the one installed. */
export function resetFacts(sessionId: string): void {
  agents.clear()
  session.factsQueued = undefined
  session.factsOwed = false
  session.due = false
  for (const id of [...seenTitles.keys()]) if (id !== sessionId) seenTitles.delete(id)
}

// The table's order is the member order of a restored set, and so of its saved text.
const MEMBER_KINDS = {
  title: 'title',
  branch: 'project', cwd: 'project', project: 'project', repository: 'project', repository_root: 'project',
} as const satisfies Record<keyof SessionFactSet, FactKind>

// The members of a saved set whose kind is on. The registration's list states a kind that is off, so its members
// do not come back.
function keptFacts(saved: SessionFactSet): SessionFactSet {
  const kept: SessionFactSet = {}
  for (const member of Object.keys(MEMBER_KINDS) as (keyof SessionFactSet)[]) {
    if (factOptions[MEMBER_KINDS[member]] && saved[member] !== undefined) kept[member] = saved[member]
  }
  return kept
}

function restoreSlot<T>(slot: FactsSlot<T>, saved: SavedSlot<T>): void {
  slot.factsQueued = saved.facts
  slot.factsOwed = saved.factsOwed === true
}

// The saved sets back in their slots, under the options. An entry of an agent the restored work does not hold is
// left out, so the slots and the records stay in step.
export function restoreFacts(saved: SavedFacts): void {
  for (const entry of saved.agents) {
    const record = agents.get(entry.id)
    if (record === undefined) continue
    restoreSlot(record, entry)
    // No spawn fires again at a reload, so the saved set stands until the list's next read.
    if (entry.facts !== undefined) record.facts = entry.facts
  }
  // The saved set does not say which members owed the mark, so the mark comes back while either kind is on. The
  // one report that it costs carries the present set.
  if (factOptions.project || factOptions.title) {
    session.factsQueued = saved.facts === undefined ? undefined : keptFacts(saved.facts)
    session.factsOwed = saved.factsOwed === true
  }
  // No title event fires again at a reload, so the saved title stands until the next one. An event that saw the
  // session in this activation is newer than the save, also where it carried no title.
  if (factOptions.title && saved.facts?.title !== undefined && !seenTitles.has(saved.id)) {
    seenTitles.set(saved.id, saved.facts.title)
  }
}

function savedSlot<T>(slot: FactsSlot<T>): SavedSlot<T> {
  return {
    ...(slot.factsQueued === undefined ? {} : { facts: { ...slot.factsQueued } }),
    ...(slot.factsOwed ? { factsOwed: true as const } : {}),
  }
}

export function savedFacts(id: string): SavedFacts {
  const entries: SavedAgentFacts[] = []
  for (const [agentId, agent] of agents) {
    const saved = savedSlot(agent)
    if (saved.facts !== undefined || saved.factsOwed === true) entries.push({ id: agentId, ...saved })
  }
  return { id, agents: entries, ...savedSlot(session) }
}

// An agent gets a slot with the option on alone, and each read, send and restore of its set needs one, so a default
// install reads none of a row's members. The registration's list states a kind that is off, so no report of that kind
// goes out.
export function agentJoined(id: string): void {
  if (!factOptions.agents) return
  agents.set(id, { facts: {}, factsQueued: undefined, factsOwed: false })
}

function listedFacts(info: AgentInfo): AgentFactSet {
  return agentFactSet({ description: info.description, name: info.name, type: info.type })
}

export function agentListed(id: string, info: AgentInfo): void {
  const agent = agents.get(id)
  if (agent !== undefined) agent.facts = listedFacts(info)
}

export function agentSpawned(id: string,
  call: { description?: unknown; name?: unknown; subagentType?: unknown }): void {
  const agent = agents.get(id)
  if (agent !== undefined) {
    agent.facts = agentFactSet({ description: call.description, name: call.name, type: call.subagentType })
  }
}

// Answers the agent's report where its set goes out. `whole` is the send behind an acknowledged start or registration,
// where the router's record may be a new one.
export function agentReport(id: string, whole: boolean): Report | undefined {
  const agent = agents.get(id)
  if (agent === undefined) return undefined
  return queueFacts(agent, agent.facts, whole, { event: 'agent_facts', agent_id: id, ...agent.facts })
}

/** Marks the set queued and owed where it goes out, and answers its report. */
function queueFacts<T extends AgentFactSet | SessionFactSet>(slot: FactsSlot<T>, set: T, whole: boolean,
  report: Report): Report | undefined {
  const holds = Object.keys(set).length > 0 || Object.keys(slot.factsQueued ?? {}).length > 0 || slot.factsOwed
  if (whole ? !holds : sameFacts(set, slot.factsQueued)) return undefined
  slot.factsQueued = set
  slot.factsOwed = true
  return report
}

export function agentLeft(id: string, release: Report | undefined): void {
  const facts = agents.get(id)?.facts
  if (release !== undefined && facts !== undefined && Object.keys(facts).length > 0) {
    closingSets.set(release, facts)
  }
  agents.delete(id)
}

export function closingReport(release: Report): Report | undefined {
  const facts = closingSets.get(release)
  if (facts === undefined || release.event !== 'state') return undefined
  return { event: 'agent_facts', agent_id: release.agent_id, ...facts }
}

export function agentRefused(id: string): void {
  const held = agents.get(id)
  if (held !== undefined) {
    held.factsQueued = undefined
    held.factsOwed = false
  }
}

// The router answered a facts report for good, with an acknowledgment or with a refusal that drops it. Where the
// report is the last set queued, nothing is owed any more. The answer to an older report leaves the newer one owed.
export function settled(report: Report): void {
  if (report.event === 'session_facts') {
    const { event: _event, ...set } = report
    settleFacts(session, set)
    return
  }
  if (report.event !== 'agent_facts') return
  const { event: _event, agent_id: id, ...set } = report
  // The record is gone for the set a run left behind, and that set owes nothing.
  settleFacts(agents.get(id), set)
}

function settleFacts<T extends AgentFactSet | SessionFactSet>(slot: FactsSlot<T> | undefined, set: T): void {
  if (slot !== undefined && sameFacts(set, slot.factsQueued)) slot.factsOwed = false
}

export function registrationAcknowledged(): void {
  session.due = true
}

// The branch of the directory the read took, so a move while git is out pairs no place with another place's branch.
// Where that read answered nothing, git runs in the session's present directory. A detached HEAD, a host that runs no
// process, a missing git and the timeout all answer none, since any other word would read as a branch's name.
async function branchOf($: EngineInterface, cwd: string | undefined): Promise<string | undefined> {
  return guarded(async () => {
    const { exitCode, stdout } = await $.process.run(['git', 'symbolic-ref', '--short', '-q', 'HEAD'],
      { timeoutMs: 2000, ...(cwd === undefined ? {} : { cwd }) })
    return exitCode === 0 ? stdout.split('\n')[0] : undefined
  })
}

async function readPlace($: EngineInterface): Promise<SessionRead> {
  const read: SessionRead = {}
  // Each call is guarded on its own: a client that lacks one, or a call that rejects, costs that call's facts alone.
  const [cwd, project, repo] = await Promise.all([
    guarded(() => $.session.cwd()),
    guarded(() => $.session.root()),
    guarded(() => $.session.repo()),
  ])
  read.project = project
  read.cwd = cwd
  if (repo !== undefined && repo !== null) {
    read.repositoryRoot = repo.root
    read.remote = repo.remote
    read.branch = await branchOf($, cwd)
  }
  return read
}

export function readSession($: EngineInterface, sessionId: string): SessionFactsRead | Promise<SessionFactsRead> {
  const number = ++factReads
  const finish = (read: SessionRead): SessionFactsRead => {
    if (seenTitles.has(sessionId)) read.title = seenTitles.get(sessionId)
    return { number, set: sessionFactSet(read) }
  }
  // A read of a title alone awaits nothing, so its set enters the queue in the caller's own step.
  return factOptions.project ? readPlace($).then(finish) : finish({})
}

export function sessionReport(read: SessionFactsRead): Report | undefined {
  // A later read that finished first holds the newer set.
  if (read.number < factReadsDone) return undefined
  factReadsDone = read.number
  // An acknowledged registration leaves the duty to send the set whole, since the router's record may be a new
  // one. The first read that counts takes it, and a read that finds nothing to send has done it.
  const whole = session.due
  session.due = false
  return queueFacts(session, read.set, whole, { event: 'session_facts', ...read.set })
}
