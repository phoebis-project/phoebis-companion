import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { fakeRouter } from './testing'
import type { Answer, FakeOptions, FakePlace, FakeRouter, GitAnswer, Reply } from './testing'

const ROUTER_URL = 'http://127.0.0.1:1'
const CONFIGURED = { options: { management_url: ROUTER_URL } }
const TITLED = { options: { management_url: ROUTER_URL, report_title: true } }
const PLACED = { options: { management_url: ROUTER_URL, report_project: true } }
const AGENTS = { options: { management_url: ROUTER_URL, report_agents: true } }
// A spawn call's members, the list's row with the same three values, and the set they report.
const REVIEWER = { description: 'Review the retry loop', name: 'reviewer', subagentType: 'code-reviewer' }
const REVIEWER_ROW = { description: 'Review the retry loop', name: 'reviewer', type: 'code-reviewer' }
const REVIEWER_FACTS = {
  agent_id: 'worker-1', agent_type: 'code-reviewer', description: 'Review the retry loop', name: 'reviewer',
}
const STOREFRONT: FakePlace = {
  cwd: '/home/dev/work/storefront',
  repo: { remote: 'git@git.example:acme/storefront.git', root: '/home/dev/work/storefront' },
  root: '/home/dev/work/storefront',
}
// Three paths, as a worktree has them, so a case tells the three path members apart.
const BILLING: FakePlace = {
  cwd: '/home/dev/work/billing-service.worktrees/tax/api',
  repo: { remote: 'git@git.example:acme/billing-service.git', root: '/home/dev/work/billing-service' },
  root: '/home/dev/work/billing-service.worktrees/tax',
}
const GIT = ['git', 'symbolic-ref', '--short', '-q', 'HEAD']
// What STOREFRONT reports without a branch.
const STOREFRONT_FACTS = {
  cwd: '/home/dev/work/storefront',
  project: '/home/dev/work/storefront',
  repository: 'git.example/acme/storefront',
  repository_root: '/home/dev/work/storefront',
}
const KEY = 'k-test'
const T0 = 1_790_000_000_000

// What a load that reported the title left in the host's state, and the pair it minted, as a reload finds them.
const IDENTITY = { instance: 'i-1', owner: 'u-1' }
const TITLED_MODEL = {
  id: 'session-a',
  agents: [{ id: 'main', state: 'busy', open: [], lastPresence: 0 }],
  crons: [],
  released: [],
  routerReleased: [],
  facts: { title: 'Checkout retry' },
}
// What a load left whose clear of the title the router had not acknowledged.
const OWED_MODEL = {
  id: 'session-a',
  agents: [{ id: 'main', state: 'busy', open: [], lastPresence: 0 }],
  crons: [],
  released: [],
  routerReleased: [],
  facts: {},
  factsOwed: true,
}
// What a load left that reported a subagent's name, and one whose clear of the agent's set the router had not
// acknowledged.
const AGENT_MODEL = {
  id: 'session-a',
  agents: [
    { id: 'main', state: 'busy', open: [{ id: 'worker-1', kind: 'subagent' }], lastPresence: 0 },
    { id: 'worker-1', parent: 'main', state: 'busy', open: [], lastPresence: 0, facts: { name: 'reviewer' } },
  ],
  crons: [],
  released: [],
  routerReleased: [],
}
const AGENT_OWED_MODEL = {
  ...AGENT_MODEL,
  agents: [
    { id: 'main', state: 'busy', open: [{ id: 'worker-1', kind: 'subagent' }], lastPresence: 0 },
    { id: 'worker-1', parent: 'main', state: 'busy', open: [], lastPresence: 0, facts: {}, factsOwed: true },
  ],
}
// The agents a router answers the reload's registration with, as it still holds the subagent the earlier load ran.
const WORKER_HELD = [
  { agent_id: 'main', state: 'busy', request_generation: 1 },
  { agent_id: 'worker-1', state: 'busy', request_generation: 1 },
]
// What a load left that released a subagent whose set reached the router, and the router's answer that still holds
// the released record with its facts.
const RELEASED_MODEL = {
  id: 'session-a',
  agents: [{ id: 'main', state: 'busy', open: [], lastPresence: 0 }],
  crons: [],
  released: ['worker-1'],
  routerReleased: [],
  factsLeft: ['worker-1'],
}
const WORKER_RELEASED = [
  { agent_id: 'main', state: 'busy', request_generation: 1 },
  { agent_id: 'worker-1', state: 'released', request_generation: 2 },
]

const ok = (body: unknown): Reply => ({ status: 200, body })
const refusal = (code: string, extra: Record<string, unknown> = {}): Reply =>
  ({ status: 409, body: { code, ...extra } })

function host(on: On, options: FakeOptions = {}): { clock: MockClock; router: FakeRouter } {
  mock.env(on, { ANTHROPIC_AUTH_TOKEN: KEY })
  const clock = mock.clock(on, { now: T0 })
  return { clock, router: fakeRouter(on, clock, { id: 'session-a', ...options }) }
}

async function start($: Engine, clock: MockClock): Promise<void> {
  await $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
  await clock.settle()
}

async function prompt($: Engine, clock: MockClock, kind: 'composer' | 'sdk' = 'composer'): Promise<void> {
  await $.prompt.submit({ text: 'hi', origin: { kind }, wait: false })
  await clock.settle()
}

async function end($: Engine, clock: MockClock, reason: 'clear' | 'resume' | 'other', id: string): Promise<void> {
  await $.session.end({ reason, sessionId: id, resume: { id } })
  await clock.settle()
}

function events(router: FakeRouter): string[] {
  return router.requests.map((body) => body.event)
}

// The bodies posted under one session id, a state with its agent and its state.
function under(router: FakeRouter, id: string): string[] {
  return router.requests.filter((body) => body.session_id === id)
    .map((body) => body.event === 'state' ? `state ${body.agent_id} ${body.state}` : body.event)
}

async function spawn($: Engine, clock: MockClock, members: Record<string, unknown>): Promise<void> {
  await $.agent.spawn({ prompt: '', ...members } as Parameters<Engine['agent']['spawn']>[0])
  await clock.settle()
}

async function step($: Engine, clock: MockClock, agentId?: string): Promise<void> {
  const stream = $.turn.step({
    turnId: 'turn-1',
    index: 0,
    model: 'claude-haiku-4-5',
    messageCount: 1,
    ...(agentId === undefined ? {} : { agentId }),
  })
  for await (const _chunk of stream) {
    // Read to the end, as the engine reads a step.
  }
  await clock.settle()
}

async function complete($: Engine, clock: MockClock, agentId?: string): Promise<void> {
  await $.turn.complete({
    turnId: 'turn-1',
    reason: 'answer',
    answer: '',
    durationMs: 0,
    isAborted: false,
    ...(agentId === undefined ? {} : { agentId }),
  })
  await clock.settle()
}

// The members of each agent_facts body, in the order sent.
function agentFacts(router: FakeRouter): Record<string, unknown>[] {
  return router.requests.filter((body) => body.event === 'agent_facts')
    .map(({ event: _e, instance_id: _i, protocol: _p, request_generation: _g, sequence: _q, session_id: _s,
      ...members }) => members)
}

// The entry the saved model holds for one agent.
function savedAgent(router: FakeRouter, id: string): unknown {
  return (router.values.get('model') as { agents: { id: string }[] }).agents.find((agent) => agent.id === id)
}

// Holds the next spawn's answer open, and answers the function that ends it with the id the client gives the agent.
function heldSpawn(router: FakeRouter): (agentId: string) => void {
  let give: ((answer: { agentId: string }) => void) | undefined
  router.answerSpawn(() => new Promise((resolve) => {
    give = resolve
  }))
  return (agentId) => {
    // A case whose spawn never reached the client would otherwise wait for an answer that never comes.
    if (give === undefined) throw new Error('the held spawn never started')
    give({ agentId })
  }
}

// One of the two events a title rides, as the client raises it for the session.
async function titled($: Engine, clock: MockClock, name: 'SessionStart' | 'UserPromptSubmit', id: string,
  title?: string): Promise<void> {
  const classic = ($ as unknown as { classic: Record<string, (input: unknown) => Promise<unknown>> }).classic
  const raise = classic[name]
  // A kit that lacks the event would otherwise pass each case that raises it as a silent no-op.
  if (raise === undefined) throw new Error(`the test kit raises no classic.${name}`)
  await raise({ session_id: id, ...(title === undefined ? {} : { session_title: title }) })
  await clock.settle()
}

// The fact members of each session_facts body, in the order sent.
function facts(router: FakeRouter): Record<string, unknown>[] {
  return router.requests.filter((body) => body.event === 'session_facts')
    .map(({ event: _e, instance_id: _i, protocol: _p, sequence: _q, session_id: _s, ...members }) => members)
}

// What git prints on a branch.
function onBranch(name: string): GitAnswer {
  return { exitCode: 0, stdout: `${name}\n` }
}

function gitRuns(router: FakeRouter): (readonly string[])[] {
  return router.commands.filter((argv) => argv[0] === 'git')
}

// Holds the next git call open, and answers the function that ends it with git's answer.
function heldGit(router: FakeRouter): (answer: GitAnswer) => void {
  let give: ((answer: GitAnswer) => void) | undefined
  router.answerGit(() => new Promise((resolve) => {
    give = resolve
  }))
  return (answer) => {
    // A case whose read never reached git would otherwise answer nothing and pass in silence.
    if (give === undefined) throw new Error('the held git call never started')
    give(answer)
  }
}

test('the session\'s facts follow each acknowledged registration', TITLED, async ($, on) => {
  const { clock, router } = host(on)
  await titled($, clock, 'SessionStart', 'session-a', 'Checkout retry')
  await start($, clock)
  router.answer(() => refusal('unknown_instance'))
  await prompt($, clock)
  expect(events(router)).toEqual([
    'session_start', 'session_facts', 'activity', 'session_start', 'activity', 'session_facts',
  ])
  // The title has no source but the classic event, so these bodies show that the event reached the mod's hook.
  expect(facts(router)).toEqual([{ title: 'Checkout retry' }, { title: 'Checkout retry' }])
})

test('a title seen under a cleared session does not go out under the new id', TITLED, async ($, on) => {
  const { clock, router } = host(on)
  await titled($, clock, 'UserPromptSubmit', 'session-a', 'Old work')
  await start($, clock)
  await end($, clock, 'clear', 'session-a')
  router.setId('session-b')
  await prompt($, clock)
  // The title went out for its own session, so the prompt's classic event reached the mod's hook.
  expect(facts(router)).toEqual([{ title: 'Old work' }])
  expect(router.requests.filter((body) => body.session_id === 'session-b').map((body) => body.event))
    .toEqual(['session_start', 'activity'])
})

test('a title seen behind the prompt\'s read leaves at the end of main\'s turn', TITLED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  await prompt($, clock)
  await titled($, clock, 'UserPromptSubmit', 'session-a', 'Checkout retry')
  await $.turn.complete({ turnId: 'turn-1', reason: 'answer', answer: '', durationMs: 0, isAborted: false })
  await clock.settle()
  expect(facts(router)).toEqual([{ title: 'Checkout retry' }])
})

test('a facts report a router without the two events refuses is dropped and not sent again at the next prompt',
  TITLED, async ($, on) => {
    const { clock, router } = host(on)
    router.answer((_body, ack) => ok(ack))
    router.answer(() => ({ status: 400, body: { code: 'invalid_event' } }))
    await titled($, clock, 'SessionStart', 'session-a', 'Checkout retry')
    await start($, clock)
    await prompt($, clock)
    await prompt($, clock)
    expect(events(router)).toEqual(['session_start', 'session_facts', 'activity', 'activity'])
    expect(router.logs).toEqual([{
      text: 'the router answered status 400 with code invalid_event to the session_facts ' +
        'report, so the mod drops it',
      to: 'debug',
    }])
  })

test('a due heartbeat passes a facts report that waits for its retry', TITLED, async ($, on) => {
  const { clock, router } = host(on)
  // A lease of twelve seconds puts the heartbeat four seconds behind the registration.
  router.answer((_body, ack) => ok({ ...ack, lease_expires_ms: clock.now() + 12000 }))
  router.answer(() => ({ status: 503 }))
  router.answer(() => ({ status: 503 }))
  router.answer(() => ({ status: 503 }))
  await titled($, clock, 'SessionStart', 'session-a', 'Checkout retry')
  await start($, clock)
  await clock.advance(4000)
  // The third failure puts the next try at T0 + 7000, and the heartbeat does not wait for it.
  expect(events(router)).toEqual(['session_start', 'session_facts', 'session_facts', 'session_facts', 'heartbeat'])
  expect(router.times).toEqual([T0, T0, T0 + 1000, T0 + 3000, T0 + 4000])
})

test('a title is cut on a whole character within 256 bytes', TITLED, async ($, on) => {
  const { clock, router } = host(on)
  // 254 bytes of ASCII and one character of four bytes make 258.
  await titled($, clock, 'SessionStart', 'session-a', `${'a'.repeat(254)}😀`)
  await start($, clock)
  expect(facts(router)).toEqual([{ title: 'a'.repeat(254) }])
})

test('a title loses an unpaired surrogate and still leaves', TITLED, async ($, on) => {
  const { clock, router } = host(on)
  await titled($, clock, 'SessionStart', 'session-a', 'fix\uD83D cart')
  await start($, clock)
  expect(facts(router)).toEqual([{ title: 'fix cart' }])
})

test('an option turned off clears the title at the reload\'s registration', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on, { state: IDENTITY, values: { model: TITLED_MODEL } })
  await start($, clock)
  await prompt($, clock)
  expect(events(router)).toEqual(['session_start', 'session_facts', 'activity'])
  expect(facts(router)).toEqual([{}])
})

test('a clear the router did not acknowledge is saved as owed, without the title it withdraws', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on, { state: IDENTITY, values: { model: TITLED_MODEL } })
    router.answer((_body, ack) => ok(ack))
    router.answer(() => ({ status: 503 }))
    await start($, clock)
    expect(router.values.get('model')).toEqual({
      id: 'session-a',
      agents: [{ id: 'main', state: 'busy', open: [], lastPresence: 0 }],
      crons: [],
      released: [],
      routerReleased: [],
      facts: {},
      factsOwed: true,
    })
    await clock.advance(1000)
    expect(facts(router)).toEqual([{}, {}])
    expect(router.values.get('model')).toEqual({
      id: 'session-a',
      agents: [{ id: 'main', state: 'busy', open: [], lastPresence: 0 }],
      crons: [],
      released: [],
      routerReleased: [],
      facts: {},
    })
  })

test('a write of the tracked work that the host lands last holds no withdrawn title', TITLED, async ($, on) => {
  const { clock, router } = host(on)
  await titled($, clock, 'SessionStart', 'session-a', 'Checkout retry')
  await start($, clock)
  // Main's turn end writes the work with the title, and the host lands that write two seconds late, behind the
  // writes of the withdrawal that follows.
  router.delayModelWrite(2000)
  await complete($, clock)
  await titled($, clock, 'UserPromptSubmit', 'session-a')
  await prompt($, clock)
  await clock.advance(2000)
  expect((router.values.get('model') as { facts?: unknown }).facts).toEqual({})
})

test('a write of the tracked work the host refuses is written again by the next pump, which sends what waits',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    // Main's turn end changes the work, and the host refuses its write, so the pump that issued it sends nothing.
    router.denyModelWrite('the host refuses the write')
    await complete($, clock)
    expect(events(router)).toEqual(['session_start'])
    // The heartbeat's pump finds the work unchanged since the refused write.
    await clock.advance(25000)
    expect(events(router)).toEqual(['session_start', 'state', 'heartbeat'])
    expect(router.values.get('model')).toEqual({
      id: 'session-a',
      agents: [{ id: 'main', state: 'idle', open: [], lastPresence: 0 }],
      crons: [],
      released: [],
      routerReleased: [],
    })
  })

test('a clear owed at a reload goes out at the registration', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on, { state: IDENTITY, values: { model: OWED_MODEL } })
  await start($, clock)
  expect(facts(router)).toEqual([{}])
})

test('a title event ahead of the start outranks the saved title', TITLED, async ($, on) => {
  const { clock, router } = host(on, { state: IDENTITY, values: { model: TITLED_MODEL } })
  await titled($, clock, 'SessionStart', 'session-a')
  await start($, clock)
  expect(facts(router)).toEqual([{}])
})

test('a page that answers a clear with 200 leaves the clear to go out again under the facts backoff', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on, { state: IDENTITY, values: { model: TITLED_MODEL } })
    router.answer((_body, ack) => ok(ack))
    // Something in front of the router answers the clear with a page of its own.
    router.answer(() => ({ status: 200, body: '<!doctype html>' }))
    await start($, clock)
    await clock.advance(1000)
    expect(facts(router)).toEqual([{}, {}])
  })

test('a clear the router refuses is not sent again at the next registration', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on, { state: IDENTITY, values: { model: TITLED_MODEL } })
  router.answer((_body, ack) => ok(ack))
  router.answer(() => ({ status: 400, body: { code: 'unknown_event' } }))
  await start($, clock)
  await start($, clock)
  expect(events(router)).toEqual(['session_start', 'session_facts', 'session_start'])
})

test('a default install sends no facts report and runs no git command', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on, { place: STOREFRONT })
  await titled($, clock, 'UserPromptSubmit', 'session-a', 'Checkout retry')
  await start($, clock)
  await prompt($, clock)
  router.answerSpawn(() => ({ agentId: 'worker-1' }))
  await $.agent.spawn({ prompt: '', description: 'Review the cart', subagentType: 'Explore' } as
    Parameters<Engine['agent']['spawn']>[0])
  await clock.settle()
  await clock.advance(25000)
  expect(events(router)).toContain('heartbeat')
  expect(events(router)).not.toContain('session_facts')
  expect(events(router)).not.toContain('agent_facts')
  expect(gitRuns(router)).toEqual([])
})

test('a set that stays the same is sent once, and a changed branch sends it again', PLACED, async ($, on) => {
  const { clock, router } = host(on, { place: STOREFRONT })
  router.answerGit(() => onBranch('main'))
  router.answerGit(() => onBranch('main'))
  router.answerGit(() => onBranch('feature/x'))
  await start($, clock)
  await prompt($, clock)
  await prompt($, clock)
  expect(facts(router)).toEqual([
    { ...STOREFRONT_FACTS, branch: 'main' },
    { ...STOREFRONT_FACTS, branch: 'feature/x' },
  ])
})

test('a remote leaves as host and path, and one the rule cannot read does not leave', PLACED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  // Each row stands in its own directory, so each set differs and each prompt sends one.
  const rows: [string, string | undefined][] = [
    ['https://user:token@Git.Example/acme/storefront.git?x=1#f', 'git.example/acme/storefront'],
    ['git@git.example:acme/storefront.git', 'git.example/acme/storefront'],
    ['ssh://git@git.example:2222/acme/storefront/', 'git.example/acme/storefront'],
    ['file:///srv/git/storefront.git', undefined],
    ['/srv/git/storefront.git', undefined],
    ['C:\\work\\storefront', undefined],
    ['https://user:pa/ss@git.example/acme/storefront.git', undefined],
    ['ssh://git@[2001:db8::1]:2222/acme/storefront.git', '[2001:db8::1]/acme/storefront'],
    ['https://to/ken?x@git.example/acme/storefront.git', undefined],
    ['https://user:8080/pa#ss@git.example/acme/storefront.git', undefined],
    ['user:pa/ss?x@git.example:acme/storefront.git', undefined],
    ['file://localhost/srv/git/notes.git', undefined],
    ['https://git.example/acme/tools.git.git', 'git.example/acme/tools.git'],
    [`https://git.example/acme/storefront.git?${'x'.repeat(1000)}`, 'git.example/acme/storefront'],
    ['https://git.example:abc/acme/storefront.git', undefined],
    ['C:/work/storefront', undefined],
    ['ssh://git@[2001:db8::1:2222/acme/storefront.git', undefined],
    ['https://Git.\u00C9xample/acme/storefront.git', 'git.\u00C9xample/acme/storefront'],
    ['https://git.example/acme/storefront.git#f', 'git.example/acme/storefront'],
    ['git@git.example:Acme/Storefront.git', 'git.example/Acme/Storefront'],
    ['https://git.example/acme/store front.git', undefined],
    ['https://git.example/acme\\storefront.git', undefined],
    ['git@git.example:acme/storefront.git?next=https://git.example/acme/notes', undefined],
    ['C://work/storefront.git', undefined],
    ['gcrypt::/srv/git/storefront.git', undefined],
    ['https://git.example/acme/storefront\u00A0.git', undefined],
    ['https://\u00A0git.example/acme/storefront.git', undefined],
    ['mirrors/storefront.git', undefined],
  ]
  for (const [at, [remote]] of rows.entries()) {
    const root = `/home/dev/work/r${at}`
    router.setPlace({ cwd: root, repo: { remote, root }, root })
    await prompt($, clock)
  }
  expect(facts(router).map((body) => body.repository)).toEqual(rows.map(([, repository]) => repository))
})

test('a session outside a repository runs no git command', PLACED, async ($, on) => {
  const { clock, router } = host(on, { place: { cwd: '/home/dev/notes', repo: null, root: '/home/dev/notes' } })
  await start($, clock)
  await prompt($, clock)
  expect(facts(router)).toEqual([{ cwd: '/home/dev/notes', project: '/home/dev/notes' }])
  expect(gitRuns(router)).toEqual([])
})

test('a repository read that rejects sends the project and the working directory and runs no git command', PLACED,
  async ($, on) => {
    const { clock, router } = host(on, { place: { ...STOREFRONT, repo: 'rejects' } })
    await start($, clock)
    expect(facts(router)).toEqual([{ cwd: '/home/dev/work/storefront', project: '/home/dev/work/storefront' }])
    expect(gitRuns(router)).toEqual([])
  })

test('a detached HEAD and a failed call send no branch, and a branch leaves without its line break', PLACED,
  async ($, on) => {
    const { clock, router } = host(on, { place: STOREFRONT })
    // The first answer prints under its nonzero exit, so the exit code alone keeps `HEAD` off the wire.
    router.answerGit(() => ({ exitCode: 1, stdout: 'HEAD\n' }))
    router.answerGit(() => onBranch('feature/x'))
    router.answerGit(() => ({ reject: 'no git' }))
    await start($, clock)
    await prompt($, clock)
    await prompt($, clock)
    expect(facts(router)).toEqual([STOREFRONT_FACTS, { ...STOREFRONT_FACTS, branch: 'feature/x' }, STOREFRONT_FACTS])
    expect(gitRuns(router)).toEqual([GIT, GIT, GIT])
  })

test('a prompt passes down its chain while git has not answered', PLACED, async ($, on) => {
  const { clock, router } = host(on, { place: STOREFRONT })
  router.answerGit(() => new Promise<GitAnswer>(() => undefined))
  router.answerGit(() => new Promise<GitAnswer>(() => undefined))
  await start($, clock)
  await prompt($, clock)
  expect(events(router)).toEqual(['session_start', 'activity'])
})

test('a read that answers after a clear queues nothing', PLACED, async ($, on) => {
  const { clock, router } = host(on, { place: STOREFRONT })
  const first = heldGit(router)
  const second = heldGit(router)
  const third = heldGit(router)
  await start($, clock)
  await end($, clock, 'clear', 'session-a')
  router.setId('session-b')
  await prompt($, clock)
  first(onBranch('old'))
  await clock.settle()
  // No read of session-b has finished, so the record's check alone keeps the old result out.
  expect(facts(router)).toEqual([])
  second(onBranch('main'))
  third(onBranch('main'))
  await clock.settle()
  expect(facts(router)).toEqual([{ ...STOREFRONT_FACTS, branch: 'main' }])
  expect(router.requests.filter((body) => body.event === 'session_facts').map((body) => body.session_id))
    .toEqual(['session-b'])
})

test('a read that answers after a newer read finished queues nothing', PLACED, async ($, on) => {
  const { clock, router } = host(on, { place: STOREFRONT })
  const first = heldGit(router)
  router.answerGit(() => onBranch('feature/b'))
  await start($, clock)
  await prompt($, clock)
  first(onBranch('feature/a'))
  await clock.settle()
  expect(facts(router)).toEqual([{ ...STOREFRONT_FACTS, branch: 'feature/b' }])
})

test('a read that ends after a refused key queues nothing for the next start', PLACED, async ($, on) => {
  const { clock, router } = host(on, { place: STOREFRONT })
  const first = heldGit(router)
  const second = heldGit(router)
  // A lease of three seconds puts the heartbeat one second behind the registration.
  router.answer((_body, ack) => ok({ ...ack, lease_expires_ms: clock.now() + 3000 }))
  router.answer(() => ({ status: 401 }))
  await start($, clock)
  await clock.advance(1000)
  first(onBranch('feature/a'))
  await clock.settle()
  await start($, clock)
  expect(events(router)).toEqual(['session_start', 'heartbeat', 'session_start'])
  second(onBranch('feature/b'))
  await clock.settle()
  expect(facts(router)).toEqual([{ ...STOREFRONT_FACTS, branch: 'feature/b' }])
})

test('a prompt\'s read that ends first carries the registration\'s duty', PLACED, async ($, on) => {
  const { clock, router } = host(on, { place: STOREFRONT })
  router.answerGit(() => onBranch('main'))
  const registered = heldGit(router)
  router.answerGit(() => onBranch('main'))
  // A lease of three seconds puts the heartbeat one second behind the registration.
  router.answer((_body, ack) => ok({ ...ack, lease_expires_ms: clock.now() + 3000 }))
  router.answer((_body, ack) => ok(ack))
  router.answer(() => refusal('unknown_instance'))
  await start($, clock)
  await clock.advance(1000)
  await prompt($, clock)
  registered(onBranch('main'))
  await clock.settle()
  // The router that lost its record gets the set again, though it equals the last one queued.
  expect(facts(router)).toEqual([{ ...STOREFRONT_FACTS, branch: 'main' }, { ...STOREFRONT_FACTS, branch: 'main' }])
  expect(events(router).filter((event) => event === 'session_start' || event === 'session_facts'))
    .toEqual(['session_start', 'session_facts', 'session_start', 'session_facts'])
})

test('a read whose working directory moved under git counts for nothing', PLACED, async ($, on) => {
  const { clock, router } = host(on, { place: STOREFRONT })
  const first = heldGit(router)
  router.answerGit(() => onBranch('feature/tax'))
  await start($, clock)
  router.setPlace(BILLING)
  first(onBranch('main'))
  await clock.settle()
  expect(facts(router)).toEqual([])
  await prompt($, clock)
  expect(facts(router)).toEqual([{
    branch: 'feature/tax',
    cwd: '/home/dev/work/billing-service.worktrees/tax/api',
    project: '/home/dev/work/billing-service.worktrees/tax',
    repository: 'git.example/acme/billing-service',
    repository_root: '/home/dev/work/billing-service',
  }])
})

test('a set queued under one key does not go to the router a later start names with another', PLACED,
  async ($, on) => {
    const variables = new Map([['ANTHROPIC_AUTH_TOKEN', 'K1']])
    on('env.get', (_$, e) => ({ value: variables.get(e.name) }))
    const clock = mock.clock(on, { now: T0 })
    const router = fakeRouter(on, clock, { id: 'session-a', place: STOREFRONT })
    router.answerGit(() => onBranch('main'))
    router.answer((_body, ack) => ok(ack))
    router.answer(() => ({ status: 503 }))
    await start($, clock)
    // The set waits for its retry while the session moves, and the start under K2 reads the new place behind a git
    // call that answers past that retry.
    variables.set('ANTHROPIC_AUTH_TOKEN', 'K2')
    router.setPlace(BILLING)
    const registered = heldGit(router)
    await start($, clock)
    await clock.advance(1000)
    registered(onBranch('feature/tax'))
    await clock.settle()
    expect(facts(router)).toEqual([{ ...STOREFRONT_FACTS, branch: 'main' }, {
      branch: 'feature/tax',
      cwd: '/home/dev/work/billing-service.worktrees/tax/api',
      project: '/home/dev/work/billing-service.worktrees/tax',
      repository: 'git.example/acme/billing-service',
      repository_root: '/home/dev/work/billing-service',
    }])
  })

test('a set queued for one router URL does not go to the URL a later start names',
  { options: { report_project: true } }, async ($, on) => {
    // With no Management URL, the router's URL comes from ANTHROPIC_BASE_URL, which the second start reads anew.
    const variables = new Map([['ANTHROPIC_AUTH_TOKEN', KEY], ['ANTHROPIC_BASE_URL', ROUTER_URL]])
    on('env.get', (_$, e) => ({ value: variables.get(e.name) }))
    const clock = mock.clock(on, { now: T0 })
    const router = fakeRouter(on, clock, { id: 'session-a', place: STOREFRONT })
    router.answerGit(() => onBranch('main'))
    router.answer((_body, ack) => ok(ack))
    router.answer(() => ({ status: 503 }))
    await start($, clock)
    variables.set('ANTHROPIC_BASE_URL', 'http://127.0.0.1:2')
    router.setPlace(BILLING)
    const registered = heldGit(router)
    await start($, clock)
    await clock.advance(1000)
    registered(onBranch('feature/tax'))
    await clock.settle()
    expect(facts(router)).toEqual([{ ...STOREFRONT_FACTS, branch: 'main' }, {
      branch: 'feature/tax',
      cwd: '/home/dev/work/billing-service.worktrees/tax/api',
      project: '/home/dev/work/billing-service.worktrees/tax',
      repository: 'git.example/acme/billing-service',
      repository_root: '/home/dev/work/billing-service',
    }])
  })

test('a move ahead of the directory\'s answer leaves the read with the new place whole', PLACED, async ($, on) => {
  const { clock, router } = host(on, { place: STOREFRONT })
  // The registration's read asks for the directory first, and the host answers it a second late, after a move.
  router.delayCwd(1000)
  router.answerGit(() => onBranch('feature/tax'))
  await start($, clock)
  router.setPlace(BILLING)
  await clock.advance(1000)
  expect(facts(router)).toEqual([{
    branch: 'feature/tax',
    cwd: '/home/dev/work/billing-service.worktrees/tax/api',
    project: '/home/dev/work/billing-service.worktrees/tax',
    repository: 'git.example/acme/billing-service',
    repository_root: '/home/dev/work/billing-service',
  }])
})

test('a spawn\'s facts follow its acknowledged start, and a workflow\'s agent sends none', AGENTS, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  router.answerSpawn(() => ({ agentId: 'worker-1' }))
  await spawn($, clock, REVIEWER)
  expect(events(router)).toEqual(['session_start', 'agent_start', 'agent_facts'])
  expect(agentFacts(router)).toEqual([{
    agent_id: 'worker-1', agent_type: 'code-reviewer', description: 'Review the retry loop', name: 'reviewer',
  }])
  router.answerSpawn(() => ({ agentId: 'flow-1' }))
  await spawn($, clock, { ...REVIEWER, workflow: { runId: 'wf_1', agentIndex: 1 } })
  expect(events(router)).toEqual(['session_start', 'agent_start', 'agent_facts'])
})

test('an agent\'s facts follow its start again where the router lost its record', AGENTS, async ($, on) => {
  const { clock, router } = host(on)
  router.setAgents([{ id: 'worker-1', status: 'running', ...REVIEWER_ROW }])
  // The registration, the start and the facts, then a heartbeat the router no longer places, and a new registration
  // that holds main alone, so the agent starts again.
  router.answer((_body, ack) => ok(ack))
  router.answer((_body, ack) => ok(ack))
  router.answer((_body, ack) => ok(ack))
  router.answer(() => refusal('unknown_instance'))
  router.answer((_body, ack) => ok({ ...ack, agents: [{ agent_id: 'main', state: 'busy', request_generation: 1 }] }))
  await start($, clock)
  router.answerSpawn(() => ({ agentId: 'worker-1' }))
  await spawn($, clock, REVIEWER)
  await clock.advance(25000)
  expect(agentFacts(router)).toEqual([
    { agent_id: 'worker-1', agent_type: 'code-reviewer', description: 'Review the retry loop', name: 'reviewer' },
    { agent_id: 'worker-1', agent_type: 'code-reviewer', description: 'Review the retry loop', name: 'reviewer' },
  ])
})

test('facts the router refuses for an unknown agent are dropped and start no agent', AGENTS, async ($, on) => {
  const { clock, router } = host(on)
  router.answer((_body, ack) => ok(ack))
  router.answer((_body, ack) => ok(ack))
  router.answer(() => refusal('unknown_agent'))
  router.setAgents([{ id: 'worker-1', status: 'running', ...REVIEWER_ROW }])
  await start($, clock)
  router.answerSpawn(() => ({ agentId: 'worker-1' }))
  await spawn($, clock, REVIEWER)
  // The heartbeat's tick at the end reads the list, whose row holds the set the router refused.
  await clock.advance(25000)
  expect(events(router)).toEqual(['session_start', 'agent_start', 'agent_facts', 'heartbeat'])
})

test('a tick sends an agent\'s facts where the client\'s list changed them, and none where it did not', AGENTS,
  async ($, on) => {
    const { clock, router } = host(on)
    router.setAgents([{ id: 'worker-1', status: 'running', ...REVIEWER_ROW }])
    await start($, clock)
    router.answerSpawn(() => ({ agentId: 'worker-1' }))
    await spawn($, clock, REVIEWER)
    await clock.advance(25000)
    expect(agentFacts(router)).toEqual([REVIEWER_FACTS])
    router.setAgents([{ id: 'worker-1', status: 'running', ...REVIEWER_ROW, description: 'Review the export job' }])
    await clock.advance(25000)
    const changed = {
      agent_id: 'worker-1', agent_type: 'code-reviewer', description: 'Review the export job', name: 'reviewer',
    }
    expect(agentFacts(router)).toEqual([REVIEWER_FACTS, changed])
    await clock.advance(25000)
    expect(agentFacts(router)).toEqual([REVIEWER_FACTS, changed])
  })

test('an option turned off clears each announced agent\'s facts at the reload\'s registration', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on, { state: IDENTITY, values: { model: AGENT_MODEL } })
    // The list still runs the agent, so the tick reads its row.
    router.setAgents([{ id: 'worker-1', status: 'running' }])
    router.answer((_body, ack) => ok({ ...ack, agents: WORKER_HELD }))
    await start($, clock)
    expect(agentFacts(router)).toEqual([{ agent_id: 'worker-1' }])
    await clock.advance(25000)
    expect(agentFacts(router)).toEqual([{ agent_id: 'worker-1' }])
  })

test('an agent\'s clear the router did not acknowledge is saved as owed', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on, { state: IDENTITY, values: { model: AGENT_MODEL } })
  router.answer((_body, ack) => ok({ ...ack, agents: WORKER_HELD }))
  router.answer(() => ({ status: 503 }))
  await start($, clock)
  expect(savedAgent(router, 'worker-1')).toEqual({
    id: 'worker-1', parent: 'main', state: 'busy', open: [], lastPresence: 0, facts: {}, factsOwed: true,
  })
  await clock.advance(1000)
  expect(agentFacts(router)).toEqual([{ agent_id: 'worker-1' }, { agent_id: 'worker-1' }])
  expect(savedAgent(router, 'worker-1')).toEqual({
    id: 'worker-1', parent: 'main', state: 'busy', open: [], lastPresence: 0, facts: {},
  })
})

test('an agent\'s clear owed at a reload goes out at the registration', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on, { state: IDENTITY, values: { model: AGENT_OWED_MODEL } })
  router.answer((_body, ack) => ok({ ...ack, agents: WORKER_HELD }))
  await start($, clock)
  expect(agentFacts(router)).toEqual([{ agent_id: 'worker-1' }])
})

test('a released agent whose set reached the router is saved as one whose facts the router can still hold', AGENTS,
  async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    router.answerSpawn(() => ({ agentId: 'worker-1' }))
    await spawn($, clock, REVIEWER)
    // A spawn with no members leaves the agent no set, so the router holds none for it.
    router.answerSpawn(() => ({ agentId: 'worker-2' }))
    await spawn($, clock, { description: '', subagentType: '' })
    router.setAgents([])
    await complete($, clock, 'worker-1')
    await complete($, clock, 'worker-2')
    expect((router.values.get('model') as { factsLeft?: unknown }).factsLeft).toEqual(['worker-1'])
  })

test('a released agent whose closing set left is saved as one whose facts the router can still hold', AGENTS,
  async ($, on) => {
    const { clock, router } = host(on)
    router.answer((_body, ack) => ok(ack))
    router.answer(async (_body, ack) => {
      await clock.sleep(2000)
      return ok(ack)
    })
    await start($, clock)
    router.answerSpawn(() => ({ agentId: 'worker-1' }))
    await spawn($, clock, REVIEWER)
    router.setAgents([])
    await complete($, clock, 'worker-1')
    await clock.advance(2000)
    // The set left ahead of the release, and a reload with the option off starts from this saved model, as the case
    // below does.
    expect(agentFacts(router)).toEqual([REVIEWER_FACTS])
    expect((router.values.get('model') as { factsLeft?: unknown }).factsLeft).toEqual(['worker-1'])
  })

test('an option turned off clears the facts of a released agent that a step runs again', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on, { state: IDENTITY, values: { model: RELEASED_MODEL } })
    router.answer((_body, ack) => ok({ ...ack, agents: WORKER_RELEASED }))
    await start($, clock)
    router.setAgents([{ id: 'worker-1', status: 'running' }])
    await step($, clock, 'worker-1')
    expect(agentFacts(router)).toEqual([{ agent_id: 'worker-1' }])
  })

test('an option turned off clears the facts of a released agent that a spawn runs again', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on, { state: IDENTITY, values: { model: RELEASED_MODEL } })
    router.answer((_body, ack) => ok({ ...ack, agents: WORKER_RELEASED }))
    await start($, clock)
    router.answerSpawn(() => ({ agentId: 'worker-1' }))
    await spawn($, clock, { description: '', subagentType: 'Explore' })
    expect(agentFacts(router)).toEqual([{ agent_id: 'worker-1' }])
  })

test('an agent type past its cap leaves without the type', AGENTS, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  router.answerSpawn(() => ({ agentId: 'worker-1' }))
  await spawn($, clock, { description: 'Review the retry loop', subagentType: 'a'.repeat(257) })
  expect(agentFacts(router)).toEqual([{ agent_id: 'worker-1', description: 'Review the retry loop' }])
})

test('a branch, a path or a remote past its cap leaves without that member',
  { options: { management_url: ROUTER_URL, report_project: true, report_title: true } }, async ($, on) => {
    const path = 'a'.repeat(1025)
    // Reduced to `git.example/` and the 1,013 letters, 1,025 bytes.
    const remote = `https://git.example/${'p'.repeat(1013)}`
    const { clock, router } = host(on, { place: { cwd: path, repo: { remote, root: path }, root: path } })
    router.answerGit(() => onBranch('b'.repeat(257)))
    await titled($, clock, 'SessionStart', 'session-a', 'Checkout retry')
    await start($, clock)
    // The title shows that the read ran, so each missing member was dropped at its cap.
    expect(facts(router)).toEqual([{ title: 'Checkout retry' }])
  })

test('an agent list that answers behind a clear adopts no agent', AGENTS, async ($, on) => {
  const { clock, router } = host(on)
  router.setAgents([{ id: 'worker-1', status: 'running', description: 'Review the retry loop', name: 'reviewer' }])
  await start($, clock)
  router.delayList(1000)
  const stepping = step($, clock, 'worker-1')
  await clock.settle()
  await end($, clock, 'clear', 'session-a')
  router.setId('session-b')
  await start($, clock)
  // The new session starts with main busy, so its turn end rests main, and a step that counted for main would
  // report it busy again.
  await complete($, clock)
  await clock.advance(1000)
  await stepping
  expect(under(router, 'session-b')).toEqual(['session_start', 'state main idle'])
})

test('a tool call whose list read a clear overtakes files nothing under the new session', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    router.setAgents([{ id: 'worker-1', status: 'running' }])
    await start($, clock)
    router.delayList(1000)
    router.answerTool(() => ({ stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg-1' }))
    const calling = $.tool.call({
      tool: 'Bash', tool_use_id: 'toolu_1', command: 'sleep 600', run_in_background: true, agentId: 'worker-1',
    } as Parameters<Engine['tool']['call']>[0])
    await clock.settle()
    await end($, clock, 'clear', 'session-a')
    router.setId('session-b')
    await start($, clock)
    await clock.advance(1000)
    await calling
    await complete($, clock)
    // A command filed under main would park main on it.
    expect(under(router, 'session-b')).toEqual(['session_start', 'state main idle'])
  })

test('a due heartbeat passes a backlog of facts reports', AGENTS, async ($, on) => {
  const { clock, router } = host(on)
  // A lease of nine seconds puts the heartbeat three seconds behind the registration.
  router.answer((_body, ack) => ok({ ...ack, lease_expires_ms: clock.now() + 9000 }))
  const late: Answer = async (body, ack) => {
    if (body.event === 'agent_facts') await clock.sleep(2000)
    return ok(ack)
  }
  // Each of the seven requests behind the registration: three starts, three facts reports and the heartbeat.
  for (let request = 0; request < 7; request += 1) router.answer(late)
  // The list holds what the spawns said, so the tick finds no set changed.
  router.setAgents([
    { id: 'worker-1', status: 'running', description: 'one', type: 'Explore' },
    { id: 'worker-2', status: 'running', description: 'two', type: 'Explore' },
    { id: 'worker-3', status: 'running', description: 'three', type: 'Explore' },
  ])
  await start($, clock)
  router.answerSpawn(() => ({ agentId: 'worker-1' }))
  router.answerSpawn(() => ({ agentId: 'worker-2' }))
  router.answerSpawn(() => ({ agentId: 'worker-3' }))
  await spawn($, clock, { description: 'one', subagentType: 'Explore' })
  await spawn($, clock, { description: 'two', subagentType: 'Explore' })
  await spawn($, clock, { description: 'three', subagentType: 'Explore' })
  await clock.advance(4000)
  // The heartbeat, queued behind the third agent's facts at the tick, leaves ahead of them.
  expect(events(router)).toEqual([
    'session_start', 'agent_start', 'agent_facts', 'agent_start', 'agent_start', 'agent_facts', 'heartbeat',
    'agent_facts',
  ])
})

test('restored facts of an agent the new registration does not acknowledge stay unsent', AGENTS, async ($, on) => {
  const { clock, router } = host(on)
  router.setAgents([{ id: 'worker-1', status: 'running', ...REVIEWER_ROW }])
  // The registration, the start, the first facts and the heartbeat.
  router.answer((_body, ack) => ok(ack))
  router.answer((_body, ack) => ok(ack))
  router.answer((_body, ack) => ok(ack))
  router.answer((_body, ack) => ok(ack))
  router.answer(() => refusal('unknown_instance'))
  router.answer((_body, ack) => ok({
    ...ack,
    agents: [
      { agent_id: 'main', state: 'busy', request_generation: 1 },
      { agent_id: 'worker-1', state: 'released', request_generation: 2 },
    ],
  }))
  await start($, clock)
  router.answerSpawn(() => ({ agentId: 'worker-1' }))
  await spawn($, clock, REVIEWER)
  router.setAgents([{ id: 'worker-1', status: 'running', ...REVIEWER_ROW, description: 'Review the export job' }])
  await clock.advance(25000)
  expect(events(router)).toEqual([
    'session_start', 'agent_start', 'agent_facts', 'heartbeat', 'agent_facts', 'session_start',
  ])
})

test('an agent that ends while its start is out sends its facts ahead of its release', AGENTS, async ($, on) => {
  const { clock, router } = host(on)
  router.answer((_body, ack) => ok(ack))
  router.answer(async (_body, ack) => {
    await clock.sleep(2000)
    return ok(ack)
  })
  await start($, clock)
  router.answerSpawn(() => ({ agentId: 'worker-1' }))
  await spawn($, clock, REVIEWER)
  router.setAgents([])
  await complete($, clock, 'worker-1')
  await clock.advance(2000)
  expect(events(router)).toEqual(['session_start', 'agent_start', 'agent_facts', 'state'])
  expect(agentFacts(router)).toEqual([REVIEWER_FACTS])
  expect(router.requests[3]).toMatchObject({ agent_id: 'worker-1', state: 'released' })
})

test('a second run that ends while the first run\'s start is out leaves the first run its own set', AGENTS,
  async ($, on) => {
    const { clock, router } = host(on)
    router.answer((_body, ack) => ok(ack))
    router.answer(async (_body, ack) => {
      await clock.sleep(2000)
      return ok(ack)
    })
    await start($, clock)
    router.setAgents([])
    router.answerSpawn(() => ({ agentId: 'worker-1' }))
    await spawn($, clock, REVIEWER)
    await complete($, clock, 'worker-1')
    router.answerSpawn(() => ({ agentId: 'worker-1' }))
    await spawn($, clock, { ...REVIEWER, description: 'Review the export job' })
    await complete($, clock, 'worker-1')
    await clock.advance(2000)
    // The router holds the first run alone, since the second run's start never left behind the first release.
    expect(agentFacts(router)).toEqual([REVIEWER_FACTS])
  })

test('a run that ends while the earlier run\'s release is out sends its set ahead of its own release', AGENTS,
  async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    router.answerSpawn(() => ({ agentId: 'worker-1' }))
    await spawn($, clock, REVIEWER)
    router.answer(async (_body, ack) => {
      await clock.sleep(2000)
      return ok(ack)
    })
    router.setAgents([])
    await complete($, clock, 'worker-1')
    // The agent runs again under its id while its release is out, and ends before that release is answered.
    router.setAgents([{ id: 'worker-1', status: 'running', ...REVIEWER_ROW, description: 'Review the export job' }])
    await step($, clock, 'worker-1')
    router.setAgents([{ id: 'worker-1', status: 'completed' }])
    await complete($, clock, 'worker-1')
    await clock.advance(2000)
    expect(under(router, 'session-a')).toEqual([
      'session_start', 'agent_start', 'agent_facts', 'state worker-1 released', 'agent_start', 'agent_facts',
      'state worker-1 released',
    ])
    expect(agentFacts(router)).toEqual([REVIEWER_FACTS, {
      agent_id: 'worker-1', agent_type: 'code-reviewer', description: 'Review the export job', name: 'reviewer',
    }])
  })

test('a run that ends while its start is out sends its set while another facts report waits for its retry',
  { options: { management_url: ROUTER_URL, report_agents: true, report_title: true } }, async ($, on) => {
    const { clock, router } = host(on)
    router.answer((_body, ack) => ok(ack))
    router.answer(() => ({ status: 503 }))
    // The start's answer lands half a second in, while the title waits for its retry a second behind its failure.
    router.answer(async (_body, ack) => {
      await clock.sleep(500)
      return ok(ack)
    })
    await titled($, clock, 'SessionStart', 'session-a', 'Checkout retry')
    await start($, clock)
    router.answerSpawn(() => ({ agentId: 'worker-1' }))
    await spawn($, clock, REVIEWER)
    router.setAgents([])
    await complete($, clock, 'worker-1')
    await clock.advance(500)
    // The set's acknowledgment resets the facts backoff, so the title goes again behind the release.
    expect(events(router)).toEqual([
      'session_start', 'session_facts', 'agent_start', 'agent_facts', 'state', 'session_facts',
    ])
  })

test('a failed facts report of a run that ended early is passed by its release', AGENTS, async ($, on) => {
  const { clock, router } = host(on)
  router.answer((_body, ack) => ok(ack))
  router.answer(async (_body, ack) => {
    await clock.sleep(2000)
    return ok(ack)
  })
  router.answer(() => ({ status: 503 }))
  await start($, clock)
  router.answerSpawn(() => ({ agentId: 'worker-1' }))
  await spawn($, clock, REVIEWER)
  router.setAgents([])
  await complete($, clock, 'worker-1')
  await clock.advance(2000)
  // Past the facts' backoff of one second.
  await clock.advance(2000)
  expect(events(router)).toEqual(['session_start', 'agent_start', 'agent_facts', 'state'])
})

test('a changed set of an announced agent that failed waits out its retry time while its release passes it', AGENTS,
  async ($, on) => {
    const { clock, router } = host(on)
    // The registration, the start, the spawn's set and the heartbeat, then the changed set the tick sends.
    for (let request = 0; request < 4; request += 1) router.answer((_body, ack) => ok(ack))
    router.answer(() => ({ status: 503 }))
    await start($, clock)
    router.answerSpawn(() => ({ agentId: 'worker-1' }))
    await spawn($, clock, REVIEWER)
    router.setAgents([{ id: 'worker-1', status: 'running', ...REVIEWER_ROW, description: 'Review the export job' }])
    await clock.advance(25000)
    // The failed set stands at the queue's head, and the agent's release queues right behind it, a second ahead of
    // the set's retry time.
    router.setAgents([])
    await complete($, clock, 'worker-1')
    expect(events(router)).toEqual(['session_start', 'agent_start', 'agent_facts', 'heartbeat', 'agent_facts', 'state'])
  })

test('spawn facts for an agent its own step announced first go out as a changed set', AGENTS, async ($, on) => {
  const { clock, router } = host(on)
  router.setAgents([{ id: 'worker-1', status: 'running', type: 'code-reviewer' }])
  await start($, clock)
  const answer = heldSpawn(router)
  const spawning = spawn($, clock, REVIEWER)
  await clock.settle()
  // The agent's own step adopts it from the list's row and announces it.
  await step($, clock, 'worker-1')
  answer('worker-1')
  await spawning
  expect(agentFacts(router)).toEqual([{ agent_id: 'worker-1', agent_type: 'code-reviewer' }, REVIEWER_FACTS])
})
