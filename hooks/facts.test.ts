import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { fakeRouter } from './testing'
import type { FakeOptions, FakePlace, FakeRouter, GitAnswer, Reply } from './testing'

const ROUTER_URL = 'http://127.0.0.1:1'
const CONFIGURED = { options: { management_url: ROUTER_URL } }
const TITLED = { options: { management_url: ROUTER_URL, report_title: true } }
const PLACED = { options: { management_url: ROUTER_URL, report_project: true } }
const STOREFRONT: FakePlace = {
  cwd: '/home/dev/work/storefront',
  repo: { remote: 'git@git.example:acme/storefront.git', root: '/home/dev/work/storefront' },
  root: '/home/dev/work/storefront',
}
const BILLING: FakePlace = {
  cwd: '/home/dev/work/billing-service',
  repo: { remote: 'git@git.example:acme/billing-service.git', root: '/home/dev/work/billing-service' },
  root: '/home/dev/work/billing-service',
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
      text: 'phoebis-companion: the router answered status 400 with code invalid_event to the session_facts ' +
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
  expect(router.commands.filter((argv) => argv[0] === 'git')).toEqual([])
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
  const rows: [number, string][] = [
    [1, 'https://user:token@Git.Example/acme/storefront.git?x=1#f'],
    [2, 'git@git.example:acme/storefront.git'],
    [3, 'ssh://git@git.example:2222/acme/storefront/'],
    [5, 'file:///srv/git/storefront.git'],
    [6, '/srv/git/storefront.git'],
    [7, 'C:\\work\\storefront'],
    [8, 'https://user:pa/ss@git.example/acme/storefront.git'],
    [9, 'ssh://git@[2001:db8::1]:2222/acme/storefront.git'],
    [10, 'https://to/ken?x@git.example/acme/storefront.git'],
    [11, 'https://user:8080/pa#ss@git.example/acme/storefront.git'],
    [12, 'user:pa/ss?x@git.example:acme/storefront.git'],
    [13, 'file://localhost/srv/git/notes.git'],
    [14, 'https://git.example/acme/tools.git.git'],
    [16, `https://git.example/acme/storefront.git?${'x'.repeat(1000)}`],
    [17, 'https://git.example:abc/acme/storefront.git'],
    [20, 'C:/work/storefront'],
    [21, 'ssh://git@[2001:db8::1:2222/acme/storefront.git'],
    [22, 'https://Git.\u00C9xample/acme/storefront.git'],
  ]
  for (const [row, remote] of rows) {
    const root = `/home/dev/work/r${row}`
    router.setPlace({ cwd: root, repo: { remote, root }, root })
    await prompt($, clock)
  }
  expect(facts(router).map((body) => body.repository)).toEqual([
    'git.example/acme/storefront',
    'git.example/acme/storefront',
    'git.example/acme/storefront',
    undefined,
    undefined,
    undefined,
    undefined,
    '[2001:db8::1]/acme/storefront',
    undefined,
    undefined,
    undefined,
    undefined,
    'git.example/acme/tools.git',
    'git.example/acme/storefront',
    undefined,
    undefined,
    undefined,
    'git.\u00C9xample/acme/storefront',
  ])
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
    cwd: '/home/dev/work/billing-service',
    project: '/home/dev/work/billing-service',
    repository: 'git.example/acme/billing-service',
    repository_root: '/home/dev/work/billing-service',
  }])
})
