import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import runA from './fixtures/run-a.ts'
import runB from './fixtures/run-b.ts'
import runC from './fixtures/run-c.ts'
import runE from './fixtures/run-e.ts'
import runH from './fixtures/run-h.ts'
import { collapse, heartbeatInterval, restore } from './keepalive.ts'
import type { Body, Report } from './keepalive.ts'
import { redactSecrets } from './settings.ts'
import { fakeRouter, LEASE_MS, replay } from './testing.ts'
import type { FakeOptions, FakeRouter, Reply } from './testing.ts'

const ROUTER_URL = 'http://127.0.0.1:1'
const CONFIGURED = { options: { management_url: ROUTER_URL } }
const KEY = 'k-test'
const T0 = 1_790_000_000_000
const LOGS = { 'run-a': runA, 'run-b': runB, 'run-c': runC, 'run-e': runE, 'run-h': runH }

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

function nth<T>(list: readonly T[], index: number): T {
  const found = list[index]
  if (found === undefined) throw new Error(`nothing at ${index} of ${list.length}`)
  return found
}

function previousInstance(body: Body): string | undefined {
  return body.event === 'session_start' ? body.previous_instance_id : undefined
}

function events(router: FakeRouter): string[] {
  return router.requests.map((body) => body.event)
}

function lines(log: string, from: number, to?: number): string {
  return log.split('\n').slice(from, to).join('\n')
}

describe('the five recorded logs replay through the fake host with no skipped hook', () => {
  for (const [name, log] of Object.entries(LOGS)) {
    test(name, CONFIGURED, async ($, on) => {
      mock.env(on, { ANTHROPIC_AUTH_TOKEN: KEY })
      const clock = mock.clock(on)
      const router = fakeRouter(on, clock)
      await replay($, on, log, clock, router)
      expect(router.requests.length).toBeGreaterThan(0)
    })
  }
})

test('a configured mod registers at session start and holds the next report until the acknowledgment lands',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    router.answer(async (_body, ack) => {
      await clock.sleep(2000)
      return ok({ ...ack, lease_expires_ms: clock.now() + 3000 })
    })
    router.answer(async (_body, ack) => {
      await clock.sleep(2000)
      return ok(ack)
    })
    await start($, clock)
    expect(router.requests).toHaveLength(1)
    // A first body counts from the clock, so a later load in the same process never repeats a sequence.
    expect(router.requests[0]).toMatchObject({
      event: 'session_start',
      protocol: 1,
      session_id: 'session-a',
      sequence: T0,
    })
    expect(nth(router.requests, 0).instance_id).toMatch(/^[0-9a-f-]{36}$/)
    await clock.advance(500)
    await prompt($, clock)
    await clock.advance(1499)
    expect(events(router)).toEqual(['session_start'])
    await clock.advance(1)
    expect(events(router)).toEqual(['session_start', 'activity'])
    // The registration's three-second lease puts the heartbeat a second after it, while the activity is out.
    await clock.advance(1999)
    expect(events(router)).toEqual(['session_start', 'activity'])
    await clock.advance(1)
    expect(events(router)).toEqual(['session_start', 'activity', 'heartbeat'])
    expect(router.times).toEqual([T0, T0 + 2000, T0 + 4000])
  })

test('a newer report queued during the flight is sent after the late acknowledgment and the report in flight is ' +
  'never collapsed away', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  router.answer(async (_body, ack) => {
    await clock.sleep(2000)
    return ok(ack)
  })
  await prompt($, clock)
  await clock.advance(500)
  await prompt($, clock)
  await clock.advance(1499)
  expect(events(router)).toEqual(['session_start', 'activity'])
  await clock.advance(1)
  expect(events(router)).toEqual(['session_start', 'activity', 'activity'])
  expect(router.requests.map((body) => body.sequence)).toEqual([T0, T0 + 1, T0 + 2000])
  expect(router.times).toEqual([T0, T0, T0 + 2000])
})

test('an acknowledgment from a replaced session is ignored', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  // The heartbeat's late answer names a short lease and a generation the next session must never adopt.
  router.answer(async (_body, ack) => {
    await clock.sleep(2000)
    return ok({ ...ack, lease_expires_ms: clock.now() + 3000, request_generation: 9 })
  })
  // The next registration's answer names no generation, so a generation the activity carries can only be stale.
  router.answer(async (body) => {
    await clock.sleep(3000)
    return ok({
      session_id: body.session_id,
      instance_id: body.instance_id,
      sequence: body.sequence,
      lease_expires_ms: clock.now() + LEASE_MS,
    })
  })
  await clock.advance(25000)
  expect(events(router)).toEqual(['session_start', 'heartbeat'])
  await clock.advance(500)
  router.setId('session-b')
  await prompt($, clock)
  await clock.advance(1500)
  expect(router.requests.map((body) => [body.event, body.session_id])).toEqual([
    ['session_start', 'session-a'],
    ['heartbeat', 'session-a'],
    ['session_start', 'session-b'],
  ])
  await clock.advance(3000)
  await clock.advance(10000)
  expect(router.requests.map((body) => [body.event, body.session_id])).toEqual([
    ['session_start', 'session-a'],
    ['heartbeat', 'session-a'],
    ['session_start', 'session-b'],
    ['activity', 'session-b'],
  ])
  expect(nth(router.requests, 3).request_generation).toBeUndefined()
  expect(nth(router.requests, 2).instance_id).toBe(nth(router.requests, 0).instance_id)
  expect(nth(router.requests, 2).sequence, 'a fresh record takes the clock as its first sequence')
    .toBe(nth(router.times, 2))
})

test('the heartbeat runs at a third of the lease between one and twenty five seconds', CONFIGURED, async ($, on) => {
  expect(heartbeatInterval(T0 + 90000, T0)).toBe(25000)
  expect(heartbeatInterval(T0 + 6000, T0)).toBe(2000)
  expect(heartbeatInterval(T0 + 1500, T0)).toBe(1000)
  const { clock, router } = host(on)
  router.answer((_body, ack) => ok(ack))
  router.answer((_body, ack) => ok({ ...ack, lease_expires_ms: clock.now() + 6000 }))
  router.answer((_body, ack) => ok({ ...ack, lease_expires_ms: clock.now() + 1500 }))
  router.answer((_body, ack) => ok({ ...ack, lease_expires_ms: clock.now() + 1500 }))
  await start($, clock)
  await clock.advance(28500)
  expect(events(router)).toEqual(['session_start', 'heartbeat', 'heartbeat', 'heartbeat'])
  expect(router.times).toEqual([T0, T0 + 25000, T0 + 27000, T0 + 28000])
})

test('the heartbeat deadline is moved by a registration or a heartbeat acknowledgment alone', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    for (let at = 500; at <= 120000; at += 500) {
      await clock.advance(500)
      await prompt($, clock)
    }
    const renewals = router.requests
      .map((body, index) => ({ event: body.event, at: nth(router.times, index) }))
      .filter((request) => request.event === 'session_start' || request.event === 'heartbeat')
    expect(renewals.map((request) => request.at)).toEqual([T0, T0 + 25000, T0 + 50000, T0 + 75000, T0 + 100000])
    for (const [index, renewal] of renewals.slice(1).entries()) {
      expect(renewal.at).toBeLessThan(nth(renewals, index).at + LEASE_MS)
    }
    expect(events(router).filter((event) => event === 'activity')).toHaveLength(240)
  })

test('a transport failure and a 5xx restore the report and back off one two four eight sixteen and thirty seconds',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    const failures: Reply[] = [
      { fail: 'connection refused' },
      { status: 503, body: { code: 'quiesced' } },
      { status: 500 },
      { fail: 'connection reset' },
      { status: 502 },
      { status: 504 },
      { status: 429, body: { code: 'session_limit' } },
    ]
    for (const failure of failures) router.answer(() => failure)
    await start($, clock)
    await clock.advance(91000)
    expect(events(router)).toEqual(Array(8).fill('session_start'))
    expect(router.requests.map((body) => body.sequence)).toEqual(router.times)
    const delays = router.times.slice(1).map((at, index) => at - nth(router.times, index))
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
    // The success resets the attempts, so the next failure waits one second again.
    router.answer(() => ({ status: 503, body: { code: 'quiesced' } }))
    await prompt($, clock)
    await clock.advance(999)
    expect(events(router).slice(8)).toEqual(['activity'])
    await clock.advance(1)
    expect(events(router).slice(8)).toEqual(['activity', 'activity'])
  })

test('a fetch that throws writes one debug line naming the report and the error, and a 5xx writes none',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    router.answer(() => ({ fail: 'connection refused' }))
    router.answer(() => ({ status: 503, body: { code: 'quiesced' } }))
    await start($, clock)
    await clock.advance(3001)
    expect(events(router)).toEqual(['session_start', 'session_start', 'session_start'])
    const debug = router.logs.filter((line) => line.to === 'debug')
    expect(debug).toHaveLength(1)
    expect(debug[0]?.text).toContain('session_start')
    expect(debug[0]?.text).toContain('connection refused')
    expect(debug[0]?.text).toContain('so the mod retries under its backoff')
    expect(debug[0]?.text).toContain('unless the session ends first')
    expect(debug[0]?.text).not.toContain(KEY)
  })

test('a fetch that throws with the request in its message logs the line without the key or the URL credentials',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    const fail = `fetch to http://user:${KEY} two@127.0.0.1:1/v0/keepalive/events failed with bearer ${KEY}`
    router.answer(() => ({ fail }))
    await start($, clock)
    await clock.advance(1001)
    expect(events(router)).toEqual(['session_start', 'session_start'])
    const debug = router.logs.filter((line) => line.to === 'debug')
    expect(debug).toHaveLength(1)
    expect(debug[0]?.text).toContain('the session_start report could not be sent (')
    expect(debug[0]?.text).toContain('unless the session ends first')
    expect(debug[0]?.text).toContain('http://<redacted>@127.0.0.1:1/v0/keepalive/events')
    expect(debug[0]?.text).toContain('bearer <key>')
    expect(debug[0]?.text).not.toContain(KEY)
    expect(debug[0]?.text).not.toContain('user:')
  })

test('a hook event before the retry deadline enqueues and sends nothing', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  router.answer(() => ({ status: 503, body: { code: 'quiesced' } }))
  await start($, clock)
  await clock.advance(200)
  await prompt($, clock)
  await clock.advance(300)
  await prompt($, clock)
  await clock.advance(499)
  expect(events(router)).toEqual(['session_start'])
  await clock.advance(1)
  expect(events(router)).toEqual(['session_start', 'session_start', 'activity'])
  expect(router.times).toEqual([T0, T0 + 1000, T0 + 1000])
})

test('redactSecrets takes the configured key and a URL\'s userinfo out of a message and leaves the rest', () => {
  expect(redactSecrets(`fetch to http://user:${KEY}@127.0.0.1:1/v0/keepalive/events failed with bearer ${KEY}`, KEY))
    .toBe('fetch to http://<redacted>@127.0.0.1:1/v0/keepalive/events failed with bearer <key>')
  expect(redactSecrets('https://alice:hunter2@router.example/v0 refused', KEY))
    .toBe('https://<redacted>@router.example/v0 refused')
  expect(redactSecrets('connection refused', KEY)).toBe('connection refused')
  expect(redactSecrets(`bearer ${KEY}`, '')).toBe(`bearer ${KEY}`)
  expect(redactSecrets('https://u:p@ss@h.example/v0', KEY)).toBe('https://<redacted>@h.example/v0')
  expect(redactSecrets('fetch https://alice:two words@router.example/v0/keepalive/events failed', KEY))
    .toBe('fetch https://<redacted>@router.example/v0/keepalive/events failed')
})

test('queued reports collapse into one heartbeat, the newest state per agent and a prompt over a presence', () => {
  const reports: Report[] = [
    { event: 'heartbeat' },
    { event: 'state', agent_id: 'main', state: 'busy' },
    { event: 'activity', agent_id: 'main', kind: 'presence' },
    { event: 'agent_start', agent_id: 'worker' },
    { event: 'heartbeat' },
    { event: 'state', agent_id: 'worker', state: 'busy' },
    { event: 'state', agent_id: 'main', state: 'parked', park_kind: 'background', deadline: T0 },
    { event: 'activity', agent_id: 'main', kind: 'prompt' },
    { event: 'activity', agent_id: 'main', kind: 'presence' },
    { event: 'agent_start', agent_id: 'worker' },
    { event: 'session_start' },
    { event: 'session_start', previous_instance_id: 'instance-old' },
  ]
  const queue = reports.reduce(collapse, [] as Report[])
  expect(queue).toEqual([
    { event: 'session_start', previous_instance_id: 'instance-old' },
    { event: 'heartbeat' },
    { event: 'agent_start', agent_id: 'worker' },
    { event: 'state', agent_id: 'worker', state: 'busy' },
    { event: 'state', agent_id: 'main', state: 'parked', park_kind: 'background', deadline: T0 },
    { event: 'activity', agent_id: 'main', kind: 'prompt' },
  ])
  expect(collapse(queue, { event: 'session_end' })).toEqual([{ event: 'session_end' }])
})

test('restore puts a report back at the head unless a queued one supersedes it, and a restored prompt drops a ' +
  'queued presence', () => {
  const busy: Report = { event: 'state', agent_id: 'main', state: 'busy' }
  const parked: Report = { event: 'state', agent_id: 'main', state: 'parked', park_kind: 'background' }
  const worker: Report = { event: 'state', agent_id: 'worker', state: 'idle' }
  const prompted: Report = { event: 'activity', agent_id: 'main', kind: 'prompt' }
  const present: Report = { event: 'activity', agent_id: 'main', kind: 'presence' }
  const beat: Report = { event: 'heartbeat' }
  const registration: Report = { event: 'session_start' }
  expect(restore([beat, worker], busy)).toEqual([busy, beat, worker])
  expect(restore([registration, beat], busy)).toEqual([registration, busy, beat])
  expect(restore([parked], busy)).toEqual([parked])
  expect(restore([worker, beat], { event: 'heartbeat' })).toEqual([worker, beat])
  expect(restore([prompted], present)).toEqual([prompted])
  expect(restore([present], prompted)).toEqual([prompted])
  expect(restore([registration, present, beat], prompted)).toEqual([registration, prompted, beat])
  expect(restore([], registration)).toEqual([registration])
})

test('unknown_instance, instance_ended and stale_sequence re-register with the same instance and the restored ' +
  'report follows', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  for (const code of ['unknown_instance', 'instance_ended', 'stale_sequence']) {
    router.answer(() => refusal(code))
    await prompt($, clock)
  }
  expect(events(router)).toEqual([
    'session_start',
    'activity', 'session_start', 'activity',
    'activity', 'session_start', 'activity',
    'activity', 'session_start', 'activity',
  ])
  expect(router.refusals.map((answer) => answer.code)).toEqual(['unknown_instance', 'instance_ended', 'stale_sequence'])
  const starts = router.requests.filter((body) => body.event === 'session_start')
  for (const registration of starts) {
    expect(registration.instance_id).toBe(nth(starts, 0).instance_id)
    expect(registration).not.toHaveProperty('previous_instance_id')
  }
  expect(router.requests.map((body) => body.sequence)).toEqual(Array.from({ length: 10 }, (_, at) => T0 + at))
})

test('instance_conflict with an instance id retries with previous_instance_id, and a second named holder is taken ' +
  'over in turn', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  router.answer(() => refusal('instance_conflict', { instance_id: 'instance-old' }))
  await start($, clock)
  await prompt($, clock)
  expect(router.requests.map((body) => [body.event, body.session_id, previousInstance(body)])).toEqual([
    ['session_start', 'session-a', undefined],
    ['session_start', 'session-a', 'instance-old'],
    ['activity', 'session-a', undefined],
  ])
  router.setId('session-b')
  router.answer(() => refusal('instance_conflict', { instance_id: 'instance-old' }))
  router.answer(() => refusal('instance_conflict', { instance_id: 'instance-new' }))
  await prompt($, clock)
  await prompt($, clock)
  expect(router.requests.slice(3).map((body) => [body.event, body.session_id, previousInstance(body)])).toEqual([
    ['session_start', 'session-b', undefined],
    ['session_start', 'session-b', 'instance-old'],
    ['session_start', 'session-b', 'instance-new'],
    ['activity', 'session-b', undefined],
    ['activity', 'session-b', undefined],
  ])
  // A takeover the router names at once is the mod's own business, so the person reads nothing of it.
  expect(router.logs).toEqual([])
})

test('a bare instance_conflict keeps the session live and retries the start under the backoff, at its ceiling, ' +
  'until a named conflict takes over, with one transcript line at the first refusal and one at the takeover',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    // A live holder for the first 90 seconds, the lease, then the silent one the router names.
    for (let refusals = 0; refusals < 7; refusals += 1) router.answer(() => refusal('instance_conflict'))
    router.answer(() => refusal('instance_conflict', { instance_id: 'instance-old' }))
    await start($, clock)
    await prompt($, clock)
    // Short of the first heartbeat the takeover's lease schedules.
    await clock.advance(100000)
    expect(router.requests.map((body) => [body.event, previousInstance(body)])).toEqual([
      ...Array(8).fill(['session_start', undefined]),
      ['session_start', 'instance-old'],
      ['activity', undefined],
    ])
    // One, two, four, eight, sixteen and thirty seconds, then the ceiling again.
    expect(router.times.slice(0, 9)).toEqual([0, 1000, 3000, 7000, 15000, 31000, 61000, 91000, 91000]
      .map((at) => T0 + at))
    expect(router.logs).toEqual([
      { text: 'another instance reports session session-a, so the start is retried once its lease lapses',
        to: 'transcript' },
      { text: 'took over session session-a from a silent instance', to: 'transcript' },
    ])
    await prompt($, clock)
    expect(events(router).slice(-1)).toEqual(['activity'])
  })

test('unknown_previous_instance re-sends the start without it', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  router.answer(() => refusal('instance_conflict', { instance_id: 'instance-old' }))
  router.answer(() => refusal('unknown_previous_instance'))
  await start($, clock)
  await prompt($, clock)
  expect(router.requests.map((body) => [body.event, previousInstance(body)])).toEqual([
    ['session_start', undefined],
    ['session_start', 'instance-old'],
    ['session_start', undefined],
    ['activity', undefined],
  ])
  expect(router.refusals.map((answer) => answer.code)).toEqual(['instance_conflict', 'unknown_previous_instance'])
})

test('agent_exists, unknown_agent, stale_request_generation and agent_released are answered as the table says',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    router.answer(() => refusal('unknown_agent'))
    router.answer(() => refusal('agent_exists'))
    await prompt($, clock)
    router.answer(() => refusal('stale_request_generation', { request_generation: 4 }))
    await prompt($, clock)
    router.answer(() => refusal('stale_request_generation', { request_generation: 5 }))
    router.answer(() => refusal('stale_request_generation', { request_generation: 6 }))
    await prompt($, clock)
    router.answer(() => refusal('agent_released', { request_generation: 7 }))
    await prompt($, clock)
    router.answer(() => refusal('unknown_agent'))
    await prompt($, clock)
    router.answer(() => refusal('stale_request_generation'))
    await prompt($, clock)
    router.answer(() => refusal('agent_released'))
    await prompt($, clock)
    const summary = (body: Body): unknown[] => [body.event, 'agent_id' in body ? body.agent_id : undefined,
      body.request_generation]
    expect(router.requests.map(summary)).toEqual([
      ['session_start', undefined, undefined],
      // unknown_agent puts the announcement ahead, agent_exists drops it and re-registers, then the activity follows
      ['activity', 'main', 1],
      ['agent_start', 'main', 1],
      ['session_start', undefined, undefined],
      ['activity', 'main', 1],
      // a stale generation is adopted and the report sent once more with it
      ['activity', 'main', 1],
      ['activity', 'main', 4],
      // a second stale answer drops the report, and the next report carries the generation it named
      ['activity', 'main', 4],
      ['activity', 'main', 5],
      // a release drops the report and keeps the generation for the agent's next announcement
      ['activity', 'main', 6],
      ['activity', 'main', 7],
      ['agent_start', 'main', 7],
      ['activity', 'main', 7],
      // without the generation, the report is dropped and the session registers again to learn it
      ['activity', 'main', 7],
      ['session_start', undefined, undefined],
      ['activity', 'main', 7],
      ['session_start', undefined, undefined],
    ])
  })

test('a cleared session ends and the new id registers with a fresh sequence under the same instance', CONFIGURED,
  async ($, on) => {
    mock.env(on, { ANTHROPIC_AUTH_TOKEN: KEY })
    const clock = mock.clock(on)
    const router = fakeRouter(on, clock)
    await replay($, on, lines(runB, 0, 41), clock, router)
    const first = nth(router.requests, 0)
    expect(router.requests.at(-1)).toMatchObject({
      event: 'session_end',
      session_id: '1cad27fc-c749-448a-ad5b-e5fa5ae2dcbf',
      instance_id: first.instance_id,
    })
    const ended = router.requests.length
    await replay($, on, lines(runB, 41, 50), clock, router)
    expect(router.requests).toHaveLength(ended)
    await replay($, on, lines(runB, 50, 51), clock, router)
    expect(router.requests[ended]).toMatchObject({
      event: 'session_start',
      session_id: 'c35dc0d5-c915-4fd2-8606-fec71e0dad72',
      instance_id: first.instance_id,
    })
    // The prompt at run-b.jsonl:51 registers the new id at the clock it moved to.
    expect(nth(router.requests, ended).sequence, 'a fresh record\'s first body carries the clock, so a ' +
      're-registration after a reload never draws stale_sequence').toBeGreaterThanOrEqual(1790936545000)
    await replay($, on, lines(runB, 51), clock, router)
    expect(router.requests.slice(ended).map((body) => body.session_id))
      .toEqual(Array(router.requests.length - ended).fill('c35dc0d5-c915-4fd2-8606-fec71e0dad72'))
    expect(router.requests.at(-1)).toMatchObject({ event: 'session_end' })
  })

test('a resumed session ends and the resumed id registers', CONFIGURED, async ($, on) => {
  mock.env(on, { ANTHROPIC_AUTH_TOKEN: KEY })
  const clock = mock.clock(on)
  const router = fakeRouter(on, clock)
  const first = '3ccc7c43-d075-4181-977f-f4e0e178f298'
  const resumed = '1cad27fc-c749-448a-ad5b-e5fa5ae2dcbf'
  await replay($, on, lines(runE, 0, 64), clock, router)
  // A second /resume goes back to the first id in the same process.
  await end($, clock, 'resume', resumed)
  router.setId(first)
  await prompt($, clock)
  const bounds = router.requests.filter((body) => body.event === 'session_start' || body.event === 'session_end')
  expect(bounds.map((body) => [body.event, body.session_id])).toEqual([
    ['session_start', first],
    ['session_end', first],
    ['session_start', resumed],
    ['session_end', resumed],
    ['session_start', first],
  ])
  for (const body of router.requests) expect(body.instance_id).toBe(nth(bounds, 0).instance_id)
  for (const [index, body] of router.requests.entries()) {
    if (body.event !== 'session_start') expect(body.sequence).toBeGreaterThan(nth(router.requests, index - 1).sequence)
  }
  // The return to the first id takes the clock, past every sequence the router took for that session and instance.
  const lastOfFirst = Math.max(...router.requests.filter((body, index) =>
    body.session_id === first && index < router.requests.indexOf(nth(bounds, 4))).map((body) => body.sequence))
  expect(nth(bounds, 4).sequence).toBeGreaterThan(lastOfFirst)
  expect(router.refusals).toEqual([])
})

test('a return to an earlier id registers past the last sequence the router took for it, with no climb',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    for (let at = 0; at < 3; at += 1) await prompt($, clock)
    await clock.advance(1000)
    router.setId('session-b')
    await prompt($, clock)
    await clock.advance(1000)
    router.setId('session-a')
    await prompt($, clock)
    expect(router.requests.map((body) => [body.event, body.session_id])).toEqual([
      ['session_start', 'session-a'],
      ['activity', 'session-a'],
      ['activity', 'session-a'],
      ['activity', 'session-a'],
      ['session_start', 'session-b'],
      ['activity', 'session-b'],
      ['session_start', 'session-a'],
      ['activity', 'session-a'],
    ])
    // The fake router refuses a sequence at or below the last it took per session and instance, as the router does.
    expect(router.refusals).toEqual([])
    expect(nth(router.requests, 6).sequence).toBeGreaterThan(nth(router.requests, 3).sequence)
  })

test('a registration refused twice in a row with the same code waits the backoff before it is sent again',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    for (let at = 0; at < 3; at += 1) router.answer(() => refusal('stale_sequence'))
    await start($, clock)
    await clock.advance(999)
    expect(events(router)).toEqual(['session_start', 'session_start'])
    await clock.advance(1)
    expect(events(router)).toEqual(['session_start', 'session_start', 'session_start'])
    await clock.advance(2000)
    expect(router.times).toEqual([T0, T0, T0 + 1000, T0 + 3000])
    expect(router.refusals.map((answer) => answer.code)).toEqual(['stale_sequence', 'stale_sequence', 'stale_sequence'])
    // The registration's answer resets the backoff, and a different code in between is no repeat.
    router.setId('session-b')
    router.answer(() => refusal('unknown_instance'))
    router.answer(() => refusal('stale_sequence'))
    await prompt($, clock)
    expect(router.times.slice(4)).toEqual([T0 + 3000, T0 + 3000, T0 + 3000, T0 + 3000])
    expect(events(router).slice(4)).toEqual(['session_start', 'session_start', 'session_start', 'activity'])
  })

describe('session end is sent at once ahead of the queue and past the request in flight', () => {
  const ends = { 'run-a': [runA, 94, 'other'], 'run-h': [runH, 128, 'prompt_input_exit'] } as const
  for (const [name, [log, at, reason]] of Object.entries(ends)) {
    test(`${name} reason ${reason}`, CONFIGURED, async ($, on) => {
      mock.env(on, { ANTHROPIC_AUTH_TOKEN: KEY })
      const clock = mock.clock(on)
      const router = fakeRouter(on, clock)
      await replay($, on, lines(log, 0, at), clock, router)
      router.answer(async (_body, ack) => {
        await clock.sleep(5000)
        return ok(ack)
      })
      await prompt($, clock, 'sdk')
      await prompt($, clock, 'sdk')
      const before = router.requests.length
      expect(events(router).at(-1)).toBe('activity')
      await replay($, on, lines(log, at, at + 1), clock, router)
      expect(router.requests).toHaveLength(before + 1)
      const sent = router.requests.at(-1) as Body
      expect(sent.event).toBe('session_end')
      expect(sent.session_id).toBe(JSON.parse(lines(log, at, at + 1)).sessionId)
      await clock.advance(60000)
      expect(router.requests).toHaveLength(before + 1)
    })
  }
})

describe('the mod sends nothing without a url, without a key and on a client older than 2.1.287', () => {
  const loads = [
    ['without a url', {}, {}, '2.1.292',
      [{ text: 'phoebis-companion: no management URL from the option or ANTHROPIC_BASE_URL', to: 'transcript' }]],
    ['without a key', CONFIGURED.options, {}, '2.1.292',
      [{ text: 'phoebis-companion: no router key from the option or the environment', to: 'transcript' }]],
    ['on 2.1.286', CONFIGURED.options, { ANTHROPIC_AUTH_TOKEN: KEY }, '2.1.286', []],
  ] as const
  for (const [name, options, variables, version, logs] of loads) {
    test(name, { options }, async ($, on) => {
      mock.env(on, variables)
      const clock = mock.clock(on, { now: T0 })
      const router = fakeRouter(on, clock, { version })
      await start($, clock)
      await prompt($, clock)
      await clock.advance(60000)
      await end($, clock, 'other', 'session-a')
      expect(router.reached.filter((op) => ['http.fetch', 'env.set'].includes(op))).toEqual([])
      expect(router.logs).toEqual(logs)
    })
  }
})

test('a token from the option without management_url sends nothing to ANTHROPIC_BASE_URL and says so in one ' +
  'transcript line', { options: { token: 'k-option' } }, async ($, on) => {
  mock.env(on, { ANTHROPIC_BASE_URL: 'http://repository.example', ANTHROPIC_AUTH_TOKEN: KEY })
  const clock = mock.clock(on, { now: T0 })
  const router = fakeRouter(on, clock)
  await start($, clock)
  await prompt($, clock)
  await clock.advance(60000)
  await end($, clock, 'other', 'session-a')
  expect(router.reached.filter((op) => ['http.fetch', 'env.set'].includes(op))).toEqual([])
  expect(router.logs).toEqual([{
    text: 'phoebis-companion: the token setting needs the Management URL, so this session reports nothing',
    to: 'transcript',
  }])
})

test('a token option with surrounding spaces reports under the trimmed key ahead of ANTHROPIC_AUTH_TOKEN',
  { options: { management_url: ROUTER_URL, token: ' k-option ' } }, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await prompt($, clock)
    expect(router.logs).toEqual([])
    expect(events(router)).toEqual(['session_start', 'activity'])
    expect(router.headers.map((headers) => headers.Authorization)).toEqual(['Bearer k-option', 'Bearer k-option'])
  })

test('a report the router refuses with a 400 or a 413 is dropped with one debug line naming the status, the code and ' +
  'the event', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  router.answer(() => ({ status: 400, body: { code: 'invalid_event' } }))
  await prompt($, clock)
  router.answer(() => ({ status: 413 }))
  await prompt($, clock)
  await clock.advance(5000)
  expect(events(router)).toEqual(['session_start', 'activity', 'activity'])
  expect(router.logs).toEqual([
    { text: 'the router answered status 400 with code invalid_event to the activity report, so the mod drops it',
      to: 'debug' },
    { text: 'the router answered status 413 with no code to the activity report, so the mod drops it', to: 'debug' },
  ])
})

test('the key appears in the Authorization header and nowhere else', CONFIGURED, async ($, on) => {
  mock.env(on, { ANTHROPIC_AUTH_TOKEN: KEY })
  const clock = mock.clock(on)
  const router = fakeRouter(on, clock)
  router.answer(() => refusal('instance_conflict'))
  await replay($, on, runB, clock, router)
  router.setId('session-z')
  router.answer(() => ({ status: 401 }))
  await prompt($, clock)
  expect(router.requests.length).toBeGreaterThan(3)
  // The recorded client is 2.1.287, so the start writes the debug line that stands in for the allowance tool.
  expect(router.logs.map((line) => line.to)).toEqual(['debug', 'transcript', 'debug'])
  for (const headers of router.headers) {
    expect(headers.Authorization).toBe(`Bearer ${KEY}`)
    const others = Object.entries(headers).filter(([name]) => name !== 'Authorization')
    expect(JSON.stringify(others)).not.toContain(KEY)
  }
  expect(JSON.stringify(router.requests)).not.toContain(KEY)
  expect(JSON.stringify(router.targets)).not.toContain(KEY)
  expect(JSON.stringify(router.logs)).not.toContain(KEY)
})

describe('a key the router refuses stops the mod for the process with one debug line naming the status', () => {
  const refusals = [
    [401, 'authentication_error', 'the presented key is not valid'],
    [403, 'permission_error', 'the presented key may not report sessions'],
  ] as const
  for (const [status, type, message] of refusals) {
    test(`${status} ${type}`, CONFIGURED, async ($, on) => {
      const { clock, router } = host(on)
      router.answer(() => ({
        status,
        body: { type: 'error', error: { type, message }, request_id: 'req-1' },
      }))
      await start($, clock)
      await prompt($, clock)
      await clock.advance(60000)
      router.setId('session-b')
      await prompt($, clock)
      await clock.advance(60000)
      await end($, clock, 'other', 'session-b')
      expect(events(router)).toEqual(['session_start'])
      expect(router.logs).toHaveLength(1)
      const line = nth(router.logs, 0)
      expect(line.to).toBe('debug')
      expect(line.text).toContain(String(status))
      expect(line.text).not.toContain(KEY)
    })
  }
})

describe('the request is a POST of protocol 1 to the events path with a JSON content type', () => {
  const urls = [
    [ROUTER_URL, `${ROUTER_URL}/v0/keepalive/events`],
    [`${ROUTER_URL}/r/`, `${ROUTER_URL}/r/v0/keepalive/events`],
  ] as const
  for (const [given, posted] of urls) {
    test(given, { options: { management_url: given } }, async ($, on) => {
      const { clock, router } = host(on)
      await start($, clock)
      await prompt($, clock)
      await end($, clock, 'other', 'session-a')
      expect(events(router)).toEqual(['session_start', 'activity', 'session_end'])
      expect(router.targets).toEqual(Array(3).fill({ method: 'POST', url: posted }))
      for (const headers of router.headers) expect(headers['Content-Type']).toBe('application/json')
      for (const body of router.requests) expect(body.protocol).toBe(1)
      expect(router.refusals).toEqual([])
    })
  }
})
