import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { fakeRouter } from './testing'
import type { FakeOptions, FakeRouter, Reply } from './testing'

const ROUTER_URL = 'http://127.0.0.1:1'
const CONFIGURED = { options: { management_url: ROUTER_URL } }
const TITLED = { options: { management_url: ROUTER_URL, report_title: true } }
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
  const { clock, router } = host(on)
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
