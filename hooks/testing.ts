import type {
  AgentInfo,
  AgentStatus,
  ConfigSetResult,
  ConfigValue,
  HttpResponse,
  On,
  PromptEditResult,
  PromptSubmitResult,
  RegisteredToolSpec,
} from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import type { Identity } from '../types'
import type { Body } from './rules'

// The recorded host beneath every mod test: the router behind `$.http.fetch` (the posted reports and the allowance
// GETs), the session's id and place, the environment writes, the state the host holds for the plugin, the plugin's own
// store, the commands that read the client process and the branch, the log, the toasts, the tools the mod registers,
// the agent list, and the engine's own answers to the events a replay or a settings change raises, so no bottom hook
// throws for an event the mod passes on.

type Ack = {
  session_id: string
  instance_id: string
  sequence: number
  lease_expires_ms: number
  agent_id?: string
  request_generation?: number
  agents?: { agent_id: string; state: string; request_generation: number }[]
}

type Refusal = { code: string; instance_id?: string; request_generation?: number }

/**
 * What the router answers one request with: a status and a body, or a transport failure. A body that is a string is
 * sent as it is, for a page that is no JSON, such as the console page the admin listener serves for an unknown path.
 */
export type Reply = { status: number; body?: unknown } | { fail: string }

/** A scripted answer, handed the request's body and the acknowledgment the router would send by default. */
export type Answer = (body: Body, ack: Ack) => Reply | Promise<Reply>

/** A scripted answer to a GET, handed its URL and its headers with lower-cased names. */
export type GetAnswer = (url: string, headers: Record<string, string>) => Reply | Promise<Reply>

/** Where the fake host says the session stands. A member left out answers undefined. */
export type FakePlace = {
  cwd?: string
  /** `null` outside a repository, and `'rejects'` for a call that fails. */
  repo?: { remote: string | null; root: string } | null | 'rejects'
  root?: string
}

/** One answer of git: what it printed with its exit code, or the reason the host ran no process. */
export type GitAnswer = { exitCode: number; stdout: string } | { reject: string }

export type FakeOptions = {
  /** What `$.session.id()` answers until `setId` changes it. */
  id?: string
  /** The identity the host already holds for the plugin, as it does across a hot reload of the module. */
  state?: Identity
  /** The other values the host already holds for the plugin, by key, as it does across a hot reload of the module. */
  values?: Record<string, unknown>
  /**
   * What `$.process.run` prints for the client process's identity. Absent, the host runs no command, as a surface
   * without process access answers.
   */
  process?: string
  /** What the plugin's own store holds at the start, by key, as the file it keeps across processes does. */
  store?: Record<string, unknown>
  /** Where the session stands until `setPlace` moves it. */
  place?: FakePlace
}

export type LogLine = { text: string; to: string }

export type EnvWrite = { name: string; value: string | undefined }

export type ConfigWrite = { key: string; value: ConfigValue }

export type ConfigChange = { key: string; value: ConfigValue; previous: ConfigValue }

export type FakeRouter = {
  /** Every body the mod posted, in order. */
  requests: Body[]
  /** Every answer other than a 2xx, with its status. */
  refusals: (Refusal & { status: number })[]
  /** Every `$.ui.log` line with its sink. */
  logs: LogLine[]
  /** The headers of every posted report, in order. */
  headers: Record<string, string>[]
  /** The method and URL of every posted report, in order. */
  targets: { method: string; url: string }[]
  /** The clock's time as each posted report arrived, in order. */
  times: number[]
  /** The op stubs the mod reached, by event name, in order. */
  reached: string[]
  /**
   * Every GET with its URL and its headers, the names lower-cased as a server reads them, apart from the posted
   * reports the lists above record.
   */
  gets: { url: string; headers: Record<string, string> }[]
  /** Every spec the mod registered through `$.tool.register`, in order. */
  tools: RegisteredToolSpec[]
  /** The text of every `$.ui.toast`, in order. */
  toasts: string[]
  /** Every `$.env.set` with its name and value, in order. */
  envWrites: EnvWrite[]
  /** The identity the mod wrote through `$.state.set`, absent until it writes one. */
  state?: Identity
  /** The other values the mod wrote through `$.state.set`, by key, each the last write. */
  values: Map<string, unknown>
  /** The plugin's store as the mod left it, by key: the start's contents and every `$.store.set` over them. */
  store: Map<string, unknown>
  /** The argument vector of every `$.process.run`, in order. */
  commands: (readonly string[])[]
  /** Every `config.set` that reached the writer beneath the hooks, with the value the last `next` carried, in order. */
  configWrites: ConfigWrite[]
  /**
   * Changes one of the plugin's rows as the person does in the `/config` menu: the `config.set` event runs through
   * the hooks, and the fake writes what reaches the bottom, as the engine's writer does.
   */
  setConfig: ($: Engine, change: ConfigChange) => Promise<ConfigSetResult>
  setId: (id: string) => void
  setAgents: (list: readonly {
    id: string
    status: string
    type?: string
    description?: string
    name?: string
    parentId?: string
  }[]) => void
  /** Moves the session's place for the reads that follow. */
  setPlace: (place: FakePlace) => void
  /** Replaces the default answer for the next request, and several calls answer the next requests in turn. */
  answer: (fn: Answer) => void
  /** Replaces the default answer, a `200` with `SAMPLE_ALLOWANCE`, for the next GET, and several calls queue up. */
  answerGet: (fn: GetAnswer) => void
  /**
   * Scripts the result of the next hand-built `tool.call`, and several calls answer the next calls in turn. A
   * function that answers a promise holds the call until it settles, as a tool that runs for a while does.
   */
  answerTool: (fn: (e: { tool: string }) => unknown) => void
  /** Scripts the next `agent.spawn`'s answer the same way, with the id the client gives the agent. */
  answerSpawn: (fn: () => { agentId: string } | Promise<{ agentId: string }>) => void
  /**
   * Scripts the next `$.process.run` whose vector starts with `git`, and several calls answer the next ones in turn.
   * A function that answers a promise holds the call open until it settles. Without a script git answers exit code 1
   * with no output, as it does on a detached HEAD.
   */
  answerGit: (fn: () => GitAnswer | Promise<GitAnswer>) => void
  /**
   * Scripts what the next `prompt.edit` resolves to beneath the mod, and several calls answer the next edits in turn.
   * A function that throws stands for a lower hook that rejects the edit.
   */
  answerEdit: (fn: () => PromptEditResult) => void
  /**
   * Scripts what the next `prompt.submit` resolves to beneath the mod, and several calls answer the next prompts in
   * turn. A `{ drop }` stands for a lower hook that stops the prompt, and a function that answers a promise holds the
   * prompt until it settles, as a settings hook that runs for a while does.
   */
  answerSubmit: (fn: () => PromptSubmitResult | Promise<PromptSubmitResult>) => void
  /**
   * Holds the next `$.env.set` of the owner header (`ANTHROPIC_CUSTOM_HEADERS`) for this long on the clock before the
   * write lands, as a host whose hook on the write runs for a while does.
   */
  delayEnvSet: (ms: number) => void
  /** Holds the next `$.session.id()` for this long on the clock before it answers. */
  delayId: (ms: number) => void
  /** Holds the next `$.agent.list()` for this long on the clock before it answers. */
  delayList: (ms: number) => void
  /** Holds the next `$.state.get` of the plugin's tracked work for this long on the clock before it answers. */
  delayModel: (ms: number) => void
  /** Holds the fence's next read of the stored pairs (`$.store.get`) for this long on the clock before it answers. */
  delayStore: (ms: number) => void
  /**
   * Denies the next `$.env.set` of the owner header (`ANTHROPIC_CUSTOM_HEADERS`) with the reason, as another plugin's
   * hook on the variable does, which rejects the call.
   */
  denyEnvSet: (reason: string) => void
  /** Denies the next `$.tool.register` with the reason, as an engine that refuses the spec does. */
  denyRegister: (reason: string) => void
}

type Replayed = { tool?: unknown; spawn?: { model?: string; agentId?: string } }

const replayed = new WeakMap<FakeRouter, Replayed>()

export const LEASE_MS = 90000

/** The allowance route's answer with one account, one window and one pin, as the router's fixture shapes it. */
export const SAMPLE_ALLOWANCE = {
  protocol: 1,
  now: '2026-11-08T12:00:00Z',
  pool: { pinning: 'always', strategy: 'priority' },
  accounts: [{
    id: 'bbbbbbbb',
    funding: 'plan',
    tier: 'default_claude_max_20x',
    obstacle: null,
    slow_down: null,
    windows: {
      five_hour: {
        utilization: 0.25,
        horizon_at: '2026-11-08T14:00:00Z',
        burn_per_hour: 0.1,
        demand_per_hour: 0.1,
        projected_at_horizon: 0.45,
        ceiling: 0.95,
        fit: 'fits',
        runway_minutes: 420,
      },
    },
    spend: [],
  }],
  pins: [{
    agent: 'main',
    model: 'claude-sonnet-4-5',
    account: 'bbbbbbbb',
    placed_at: '2026-11-08T11:50:00Z',
    last_used_at: '2026-11-08T12:00:00Z',
    warm: true,
    warm_until: '2026-11-08T12:05:00Z',
    runway_minutes: 420,
    binding_window: 'five_hour',
    slow_down: null,
  }],
}

function response(reply: { status: number; body?: unknown }): HttpResponse {
  const { status, body } = reply
  return {
    status,
    ok: status >= 200 && status <= 299,
    headers: { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json' },
    text: typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body),
  }
}

const EVENT_FIELDS: Record<string, { required: string[]; optional: string[] }> = {
  activity: { required: ['agent_id', 'kind'], optional: ['request_generation'] },
  agent_facts: { required: ['agent_id'], optional: ['agent_type', 'description', 'name', 'request_generation'] },
  agent_start: { required: ['agent_id'], optional: ['request_generation'] },
  heartbeat: { required: [], optional: [] },
  session_end: { required: [], optional: [] },
  session_facts: { required: [], optional: ['branch', 'cwd', 'project', 'repository', 'repository_root', 'title'] },
  session_start: { required: [], optional: ['owner_id', 'previous_instance_id'] },
  state: { required: ['agent_id', 'state'], optional: ['deadline', 'park_kind', 'request_generation', 'wake_at'] },
}

const COMMON_FIELDS = ['event', 'instance_id', 'protocol', 'sequence', 'session_id']

// The router's decoder, so a body the router would refuse is refused here with the same code.
function invalid(body: Record<string, unknown>): string | undefined {
  if (body.protocol !== 1) return body.protocol === undefined ? 'invalid_event' : 'unsupported_protocol'
  const fields = EVENT_FIELDS[String(body.event)]
  if (fields === undefined) return typeof body.event === 'string' ? 'unknown_event' : 'invalid_event'
  const allowed = new Set([...COMMON_FIELDS, ...fields.required, ...fields.optional])
  if (Object.keys(body).some((key) => !allowed.has(key))) return 'invalid_event'
  if ([...COMMON_FIELDS, ...fields.required].some((key) => body[key] === undefined)) return 'invalid_event'
  const ids = [body.session_id, body.instance_id, body.agent_id ?? 'main']
  if (ids.some((id) => typeof id !== 'string' || id === '')) return 'invalid_identity'
  if (!Number.isInteger(body.sequence) || (body.sequence as number) < 1) return 'invalid_identity'
  // The router reads the two times as whole milliseconds, so a fraction fails its decoder.
  if ([body.wake_at, body.deadline].some((at) => at !== undefined && !Number.isInteger(at))) return 'invalid_event'
  if (body.kind !== undefined && body.kind !== 'prompt' && body.kind !== 'presence') return 'invalid_state'
  if (body.event === 'state') {
    if (!['busy', 'idle', 'parked', 'released', 'unknown'].includes(String(body.state))) return 'invalid_state'
    const parked = body.state === 'parked'
    if (!parked && (body.park_kind !== undefined || body.wake_at !== undefined || body.deadline !== undefined)) {
      return 'invalid_event'
    }
    if (parked && !['background', 'scheduled', 'both'].includes(String(body.park_kind))) return 'invalid_state'
    if (parked && body.park_kind !== 'background' && body.wake_at === undefined) return 'invalid_event'
    // A background park holds no wake time and a scheduled park no deadline, and the router refuses the spare one.
    if (parked && body.park_kind === 'background' && body.wake_at !== undefined) return 'invalid_event'
    if (parked && body.park_kind === 'scheduled' && body.deadline !== undefined) return 'invalid_event'
  }
  return undefined
}

export function fakeRouter(on: On, clock: MockClock, options: FakeOptions = {}): FakeRouter {
  // The engine answers these classic events itself, the two stops, the session's start and the prompt's submit. Under
  // test the fake host stands in, so the mod's hooks can pass each on.
  on('classic.Stop', async () => ({}))
  on('classic.SubagentStop', async () => ({}))
  on('classic.SessionStart', async () => ({}))
  on('classic.UserPromptSubmit', async () => ({}))
  let id = options.id ?? 'session-a'
  // The fields the fake builds for an agent, which cover what a hook reads. The client's AgentInfo gains required
  // fields between releases, so the list is cast once, where the fake answers agent.list.
  let agents: Pick<AgentInfo, 'description' | 'id' | 'name' | 'parentId' | 'status' | 'type'>[] = []
  const answers: Answer[] = []
  const getAnswers: GetAnswer[] = []
  const tools: ((e: { tool: string }) => unknown)[] = []
  const spawns: (() => { agentId: string } | Promise<{ agentId: string }>)[] = []
  const gits: (() => GitAnswer | Promise<GitAnswer>)[] = []
  let place: FakePlace = options.place ?? {}
  const edits: (() => PromptEditResult)[] = []
  const submits: (() => PromptSubmitResult | Promise<PromptSubmitResult>)[] = []
  const envSetDenials: string[] = []
  const registerDenials: string[] = []
  let envSetDelayMs = 0
  let idDelayMs = 0
  let listDelayMs = 0
  let modelDelayMs = 0
  let storeDelayMs = 0
  // The agents the router holds per session, each with its generation.
  const held = new Map<string, Map<string, number>>()
  // The last sequence the router took per session and instance, so a report at or below it is refused as the router
  // refuses it.
  const sequences = new Map<string, number>()
  let identity = options.state
  let stateVersion = identity === undefined ? 0 : 1
  const values = new Map(Object.entries(options.values ?? {}))
  let spawned = 0

  const router: FakeRouter = {
    requests: [],
    refusals: [],
    logs: [],
    headers: [],
    targets: [],
    times: [],
    reached: [],
    gets: [],
    tools: [],
    toasts: [],
    envWrites: [],
    values: new Map(),
    store: new Map(Object.entries(options.store ?? {})),
    commands: [],
    configWrites: [],
    setConfig: ($, change) => $.config.set({
      ...change,
      provider: { plugin: 'phoebis-companion', tier: 'user' },
      origin: { kind: 'composer' },
    }),
    setId: (next) => {
      id = next
    },
    setAgents: (list) => {
      agents = list.map((agent) => ({
        id: agent.id,
        status: agent.status as AgentStatus,
        type: agent.type ?? 'general-purpose',
        description: agent.description ?? '',
        ...(agent.name === undefined ? {} : { name: agent.name }),
        ...(agent.parentId === undefined ? {} : { parentId: agent.parentId }),
      }))
    },
    setPlace: (next) => {
      place = next
    },
    answer: (fn) => {
      answers.push(fn)
    },
    answerGet: (fn) => {
      getAnswers.push(fn)
    },
    answerTool: (fn) => {
      tools.push(fn)
    },
    answerSpawn: (fn) => {
      spawns.push(fn)
    },
    answerGit: (fn) => {
      gits.push(fn)
    },
    answerEdit: (fn) => {
      edits.push(fn)
    },
    answerSubmit: (fn) => {
      submits.push(fn)
    },
    delayEnvSet: (ms) => {
      envSetDelayMs = ms
    },
    delayId: (ms) => {
      idDelayMs = ms
    },
    delayList: (ms) => {
      listDelayMs = ms
    },
    delayModel: (ms) => {
      modelDelayMs = ms
    },
    delayStore: (ms) => {
      storeDelayMs = ms
    },
    denyEnvSet: (reason) => {
      envSetDenials.push(reason)
    },
    denyRegister: (reason) => {
      registerDenials.push(reason)
    },
  }
  const slots: Replayed = {}
  replayed.set(router, slots)

  function agentsOf(session: string): Map<string, number> {
    let map = held.get(session)
    if (map === undefined) {
      map = new Map([['main', 1]])
      held.set(session, map)
    }
    return map
  }

  function acknowledgment(body: Body): Ack {
    const known = agentsOf(body.session_id)
    const agent = 'agent_id' in body ? body.agent_id : 'main'
    // A report the router takes carries the agent's current generation, so the default answer agrees with it.
    const ack: Ack = {
      session_id: body.session_id,
      instance_id: body.instance_id,
      sequence: body.sequence,
      lease_expires_ms: clock.now() + LEASE_MS,
      agent_id: agent,
      request_generation: body.request_generation ?? known.get(agent) ?? 1,
    }
    if (body.event === 'session_start') {
      ack.agents = [...known].map(([agentId, generation]) => ({
        agent_id: agentId,
        state: 'busy',
        request_generation: generation,
      }))
    }
    return ack
  }

  on('http.fetch', async (_$, e) => {
    router.reached.push('http.fetch')
    const init = e.init ?? {}
    if (init.body === undefined) {
      const headers = Object.fromEntries(
        Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
      )
      router.gets.push({ url: e.url, headers })
      const scripted = getAnswers.shift()
      const reply = scripted === undefined ? { status: 200, body: SAMPLE_ALLOWANCE } : await scripted(e.url, headers)
      return 'fail' in reply ? { deny: reply.fail } : { value: response(reply) }
    }
    router.targets.push({ method: init.method ?? 'GET', url: e.url })
    router.times.push(clock.now())
    router.headers.push({ ...(init.headers ?? {}) })
    let decoded: Record<string, unknown>
    try {
      decoded = JSON.parse(typeof init.body === 'string' ? init.body : '') as Record<string, unknown>
    } catch {
      decoded = { unparsed: init.body ?? '' }
    }
    const body = decoded as Body
    router.requests.push(body)
    const ack = acknowledgment(body)
    const stream = `${body.session_id} ${body.instance_id}`
    const scripted = answers.shift()
    let reply: Reply
    if (scripted !== undefined) {
      reply = await scripted(body, ack)
    } else {
      const code = invalid(decoded)
      if (code !== undefined) {
        reply = { status: 400, body: { code } }
      } else if (body.sequence <= (sequences.get(stream) ?? 0)) {
        reply = { status: 409, body: { code: 'stale_sequence' } }
      } else {
        agentsOf(body.session_id).set(ack.agent_id ?? 'main', ack.request_generation ?? 1)
        reply = { status: 200, body: ack }
      }
    }
    if ('fail' in reply) return { deny: reply.fail }
    if (reply.status >= 200 && reply.status <= 299 && typeof body.sequence === 'number') {
      sequences.set(stream, Math.max(sequences.get(stream) ?? 0, body.sequence))
    }
    if (reply.status < 200 || reply.status > 299) {
      router.refusals.push({ status: reply.status, ...(reply.body as Refusal) })
    }
    return { value: response(reply) }
  })
  on('session.id', async () => {
    router.reached.push('session.id')
    if (idDelayMs > 0) {
      const ms = idDelayMs
      idDelayMs = 0
      await clock.sleep(ms)
    }
    return { value: id }
  })
  on('session.cwd', () => {
    router.reached.push('session.cwd')
    return { value: place.cwd as string }
  })
  on('session.root', () => {
    router.reached.push('session.root')
    return { value: place.root as string }
  })
  on('session.repo', () => {
    router.reached.push('session.repo')
    const repo = place.repo
    if (repo === 'rejects') return { deny: 'no repository read' }
    return { value: repo === undefined || repo === null ? repo as null : { ...repo, internal: false, name: null } }
  })
  on('env.set', async (_$, e) => {
    router.reached.push('env.set')
    if (e.name === 'ANTHROPIC_CUSTOM_HEADERS') {
      const denial = envSetDenials.shift()
      if (denial !== undefined) return { deny: denial }
    }
    if (e.name === 'ANTHROPIC_CUSTOM_HEADERS' && envSetDelayMs > 0) {
      const ms = envSetDelayMs
      envSetDelayMs = 0
      await clock.sleep(ms)
    }
    router.envWrites.push({ name: e.name, value: e.value })
    // The op answers an object whose deny field is absent when the write was made.
    return { value: {} }
  })
  on('state.get', async (_$, e) => {
    router.reached.push('state.get')
    if (e.key === 'model' && modelDelayMs > 0) {
      const ms = modelDelayMs
      modelDelayMs = 0
      await clock.sleep(ms)
    }
    if (e.key !== 'identity') return { value: { value: values.get(e.key), version: values.has(e.key) ? 1 : 0 } }
    return { value: { value: identity, version: stateVersion } }
  })
  on('state.set', (_$, e) => {
    router.reached.push('state.set')
    if (e.key !== 'identity') {
      values.set(e.key, e.value)
      router.values.set(e.key, e.value)
      return { value: { isSet: true, version: 1 } }
    }
    identity = e.value as Identity
    stateVersion += 1
    router.state = e.value as Identity
    return { value: { isSet: true, version: stateVersion } }
  })
  on('store.get', async (_$, e) => {
    router.reached.push('store.get')
    if (e.key === 'identities' && storeDelayMs > 0) {
      const ms = storeDelayMs
      storeDelayMs = 0
      await clock.sleep(ms)
    }
    return { value: router.store.get(e.key) }
  })
  on('store.set', (_$, e) => {
    router.reached.push('store.set')
    // The host keeps JSON text, so a read gives back the value's JSON form.
    router.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    router.reached.push('process.run')
    router.commands.push([...e.argv])
    if (e.argv[0] === 'git') {
      const scripted = gits.shift()
      const answer = scripted === undefined ? { exitCode: 1, stdout: '' } : await scripted()
      if ('reject' in answer) return { deny: answer.reject }
      return {
        value: {
          exitCode: answer.exitCode,
          stdout: answer.stdout,
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }
    if (options.process === undefined) return { deny: 'this host runs no command' }
    return {
      value: {
        exitCode: 0,
        stdout: `${options.process}\n`,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.log', (_$, e) => {
    router.reached.push('ui.log')
    router.logs.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    router.reached.push('ui.toast')
    router.toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.register', (_$, e) => {
    router.reached.push('tool.register')
    const denial = registerDenials.shift()
    if (denial !== undefined) return { deny: denial }
    router.tools.push(e)
    return { value: { tool: `mcp__phoebis-companion__${e.name}` } }
  })
  on('agent.list', async () => {
    router.reached.push('agent.list')
    if (listDelayMs > 0) {
      const ms = listDelayMs
      listDelayMs = 0
      await clock.sleep(ms)
    }
    return { value: agents as AgentInfo[] }
  })

  // The engine's own answers: what each event's bottom resolves to when nothing beneath the plugins rewrites it.
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$, e) => {
    const scripted = submits.shift()
    return scripted === undefined ? { text: e.text, context: e.context } : scripted()
  })
  on('prompt.edit', (_$, e) => {
    const scripted = edits.shift()
    return scripted === undefined ? { text: e.text, cursor: e.cursor } : scripted()
  })
  on('turn.step', async function* (_$, e) {
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('config.set', (_$, e) => {
    router.configWrites.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('tool.call', async (_$, e) => {
    const scripted = tools.shift()
    if (scripted !== undefined) return { result: await scripted(e) }
    const result = slots.tool ?? {}
    slots.tool = undefined
    return { result }
  })
  on('agent.spawn', async (_$, e) => {
    const scripted = spawns.shift()
    const recorded: Replayed['spawn'] = scripted === undefined ? slots.spawn : await scripted()
    slots.spawn = undefined
    spawned += 1
    return {
      model: recorded?.model ?? e.parentModel ?? 'claude-haiku-4-5',
      agentId: recorded?.agentId ?? `agent-${spawned}`,
    }
  })
  return router
}

type Line = Record<string, unknown> & { t: number; kind: string }

// Lines the mod never hooks, or that the engine raises around the events it does.
const DROPPED = new Set(['session.append', 'session.receive', 'tick', 'tool.result', 'turn.start'])

// The classic events the mod hooks, for the task registry they carry.
const STOPS = new Set(['Stop', 'SubagentStop'])

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Replays a recorded event log through the test's `$`: the clock moves to each line's time, the session id follows
 * every line that names one, and each event the mod can hook fires in the shape the engine raises it.
 */
export async function replay($: Engine, _on: On, log: string, clock: MockClock, router: FakeRouter): Promise<void> {
  const slots = replayed.get(router) as Replayed
  const lines = log.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Line)
  const answered = new Set<number>()
  for (const [index, line] of lines.entries()) {
    await clock.set(Math.max(line.t, clock.now()))
    if (typeof line.id === 'string') router.setId(line.id)
    if (DROPPED.has(line.kind)) continue
    switch (line.kind) {
      case 'session.start':
        await $.session.start({
          cwd: text(line.cwd),
          surface: line.surface === 'terminal' ? 'terminal' : null,
          isInteractive: line.isInteractive === true,
        })
        break
      case 'prompt.submit':
        await $.prompt.submit({
          text: text(line.text),
          origin: line.origin as { kind: 'composer' },
          wait: false,
        })
        break
      case 'tool.call': {
        const result = lines.findIndex((later, at) =>
          at > index && !answered.has(at) && later.kind === 'tool.result' && later.tool === line.tool)
        if (result >= 0) {
          answered.add(result)
          const recorded = lines[result] as Line
          slots.tool = {
            ...(recorded.backgroundTaskId === undefined ? {} : { backgroundTaskId: recorded.backgroundTaskId }),
            ...(recorded.resultAgentId === undefined ? {} : { agentId: recorded.resultAgentId }),
          }
        }
        await $.tool.call({
          tool: text(line.tool),
          tool_use_id: text(line.toolUseId),
          run_in_background: line.bg === true,
          command: '',
        } as Parameters<Engine['tool']['call']>[0])
        break
      }
      case 'agent.spawn':
        slots.spawn = line.result as Replayed['spawn']
        // The engine fills the spawn's identity (its tool use, provider, parent model and fork) as a session does.
        await $.agent.spawn(
          { prompt: '', description: '', subagentType: text(line.type) } as Parameters<Engine['agent']['spawn']>[0],
        )
        break
      case 'turn.step': {
        const stream = $.turn.step({
          turnId: text(line.turnId),
          index: typeof line.index === 'number' ? line.index : 0,
          model: text(line.model),
          messageCount: 1,
          ...(typeof line.agentId === 'string' ? { agentId: line.agentId } : {}),
        })
        for await (const _chunk of stream) {
          // Read to the end, as the engine reads a step.
        }
        break
      }
      case 'turn.complete':
        router.setAgents(Array.isArray(line.agents) ? (line.agents as { id: string; status: string }[]) : [])
        await $.turn.complete({
          turnId: text(line.turnId),
          ...(typeof line.agentId === 'string' ? { agentId: line.agentId } : {}),
          reason: (line.reason ?? 'answer') as 'answer',
          answer: '',
          durationMs: 0,
          isAborted: line.reason === 'aborted',
        })
        break
      case 'classic': {
        const name = text(line.name)
        if (!STOPS.has(name)) break
        const classic = ($ as unknown as { classic: Record<string, (input: unknown) => Promise<unknown>> }).classic
        await classic[name]?.({
          ...(typeof line.agentId === 'string' ? { agent_id: line.agentId } : {}),
          background_tasks: Array.isArray(line.backgroundTasks) ? line.backgroundTasks : [],
          session_crons: [],
        })
        break
      }
      case 'session.end':
        await $.session.end({
          reason: line.reason as 'other',
          sessionId: text(line.sessionId),
          resume: line.resume as { id: string },
        })
        break
    }
  }
  await clock.settle()
}
