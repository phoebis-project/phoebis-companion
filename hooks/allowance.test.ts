import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { fakeRouter, SAMPLE_ALLOWANCE } from './testing'
import type { FakeRouter } from './testing'

const ROUTER = 'http://127.0.0.1:1'
const KEY = 'k-test'
const CONFIGURED = { options: { management_url: ROUTER } }
const T0 = 1_790_000_000_000
const SAMPLE_TEXT = JSON.stringify(SAMPLE_ALLOWANCE)
const OTHER_ALLOWANCE = { ...SAMPLE_ALLOWANCE, now: '2026-11-08T12:00:05Z' }
const PAGE = '<!doctype html><title>Phoebis</title>'
const TOOL_CALL = 'mcp__phoebis-companion__allowance'

type Answer = { result?: string; deny?: string }

function host(on: On, key = KEY): { clock: MockClock; router: FakeRouter } {
  mock.env(on, { ANTHROPIC_AUTH_TOKEN: key })
  const clock = mock.clock(on, { now: T0 })
  return { clock, router: fakeRouter(on, clock) }
}

async function start($: Engine, clock: MockClock): Promise<void> {
  await $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
  await clock.settle()
}

let calls = 0

async function call($: Engine): Promise<Answer> {
  calls += 1
  const answer = await $.tool.call({ tool: TOOL_CALL, tool_use_id: `toolu_${calls}` } as
    Parameters<Engine['tool']['call']>[0])
  return answer as Answer
}

test('the allowance GET joins the path prefix and carries the bearer',
  { options: { management_url: `${ROUTER}/team/a` } }, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    expect(router.gets).toEqual([{
      url: `${ROUTER}/team/a/v0/companion/allowance?session_id=session-a`,
      headers: { authorization: `Bearer ${KEY}` },
    }])
  })

describe('a 401 at start writes one transcript line, empties the queue and registers no tool', () => {
  const line = `the router at ${ROUTER} refused the key (401), so this session reports nothing`
  test('with the toast on by default', { options: { management_url: ROUTER } }, async ($, on) => {
    const { clock, router } = host(on)
    router.answerGet(() => ({ status: 401 }))
    await start($, clock)
    await clock.advance(1000)
    expect(router.logs).toEqual([{ text: line, to: 'transcript' }])
    expect(router.toasts).toEqual([line])
    expect(router.requests.map((body) => body.event)).not.toContain('session_start')
    expect(router.tools).toEqual([])
  })
})

test('a 403 companion_not_permitted registers no tool and writes a debug line only', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  router.answerGet(() => ({ status: 403, body: { code: 'companion_not_permitted' } }))
  await start($, clock)
  expect(router.tools).toEqual([])
  expect(router.logs).toEqual([{ text: 'this key may not read the allowance', to: 'debug' }])
  expect(router.toasts).toEqual([])
  expect(router.requests.map((body) => body.event)).toEqual(['session_start'])
})

test('a 403 with another code registers the tool and writes the transcript line naming 403', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    // The route answers no other 403, so this one comes from something in front of the router.
    router.answerGet(() => ({ status: 403, body: { code: 'forbidden' } }))
    await start($, clock)
    expect(router.tools).toHaveLength(1)
    expect(router.logs.map((line) => line.to)).toEqual(['transcript'])
    expect(router.logs[0]?.text).toContain('(403)')
  })

test('a 200 registers the tool once and a second call inside ten seconds answers the cached body with no second GET',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    expect(router.tools).toHaveLength(1)
    expect(router.tools[0]).toMatchObject({ name: 'allowance', isDeferred: false })
    await clock.set(T0 + 9999)
    expect(await call($)).toEqual({ result: SAMPLE_TEXT })
    expect(router.gets).toHaveLength(1)
    await clock.set(T0 + 10000)
    expect(await call($)).toEqual({ result: SAMPLE_TEXT })
    expect(router.gets).toHaveLength(2)
    await clock.set(T0 + 12_000)
    expect(await call($)).toEqual({ result: SAMPLE_TEXT })
    expect(router.gets).toHaveLength(2)
  })

test('a start GET that fails registers the tool and a call answers the redacted error text', CONFIGURED,
  async ($, on) => {
    const sentinel = 'k-sentinel-9f3a'
    const { clock, router } = host(on, sentinel)
    router.answerGet(() => ({ fail: `connection refused for Bearer ${sentinel}` }))
    router.answerGet(() => ({ fail: `connection refused for Bearer ${sentinel}` }))
    await start($, clock)
    expect(router.tools).toHaveLength(1)
    expect(router.logs).toHaveLength(1)
    expect(router.logs[0]).toMatchObject({ to: 'transcript' })
    expect(router.logs[0]?.text).toContain(ROUTER)
    const answer = await call($)
    expect(answer.deny).toContain('connection refused')
    for (const text of [JSON.stringify(router.logs), JSON.stringify(router.toasts), JSON.stringify(answer)]) {
      expect(text).not.toContain(sentinel)
    }
  })

test('a 200 that is not the allowance registers the tool and a call answers the error text', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    router.answerGet(() => ({ status: 200, body: PAGE }))
    router.answerGet(() => ({ status: 200, body: PAGE }))
    await start($, clock)
    expect(router.tools).toHaveLength(1)
    expect(router.logs.map((line) => line.to)).toEqual(['transcript'])
    expect(router.logs[0]?.text).toContain('not the allowance')
    const answer = await call($)
    expect(answer.deny).toContain('not the allowance')
  })

test('a reload whose start GET fails answers the error text, not the earlier body', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  expect(await call($)).toEqual({ result: SAMPLE_TEXT })
  router.answerGet(() => ({ fail: 'connection refused' }))
  router.answerGet(() => ({ fail: 'connection refused' }))
  await start($, clock)
  const answer = await call($)
  expect(answer.deny).toContain('connection refused')
})

test('a call GET that lands after a later start under another URL refilled the cache leaves the later body cached',
  { options: { keepalive: false } }, async ($, on) => {
    const variables = new Map([['ANTHROPIC_AUTH_TOKEN', KEY], ['ANTHROPIC_BASE_URL', ROUTER]])
    on('env.get', (_$, e) => ({ value: variables.get(e.name) }))
    const clock = mock.clock(on, { now: T0 })
    const router = fakeRouter(on, clock)
    await start($, clock)
    await clock.set(T0 + 10_000)
    router.answerGet(async () => {
      await clock.sleep(1_000)
      return { status: 200, body: SAMPLE_ALLOWANCE }
    })
    router.answerGet(() => ({ status: 200, body: OTHER_ALLOWANCE }))
    const pending = call($)
    await clock.settle()
    variables.set('ANTHROPIC_BASE_URL', 'http://127.0.0.1:2')
    await start($, clock)
    await clock.advance(1_000)
    await pending
    expect(await call($)).toEqual({ result: JSON.stringify(OTHER_ALLOWANCE) })
    expect(router.gets).toHaveLength(3)
  })

test('an overtaken start leaves the reports and the tool to the later start under another URL and key',
  async ($, on) => {
    const variables = new Map([['ANTHROPIC_AUTH_TOKEN', 'k-a'], ['ANTHROPIC_BASE_URL', ROUTER]])
    on('env.get', (_$, e) => ({ value: variables.get(e.name) }))
    const clock = mock.clock(on, { now: T0 })
    const router = fakeRouter(on, clock)
    router.answerGet(async () => {
      await clock.sleep(1_000)
      return { status: 200, body: SAMPLE_ALLOWANCE }
    })
    router.answerGet(() => ({ status: 200, body: OTHER_ALLOWANCE }))
    const first = $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
    await clock.settle()
    variables.set('ANTHROPIC_AUTH_TOKEN', 'k-b')
    variables.set('ANTHROPIC_BASE_URL', 'http://127.0.0.1:2')
    await start($, clock)
    await clock.advance(1_000)
    await first
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
    await clock.settle()
    expect(router.requests.map((body) => body.event)).toEqual(['session_start', 'activity'])
    expect(router.headers.map((headers) => headers.Authorization)).toEqual(['Bearer k-b', 'Bearer k-b'])
    expect(router.tools).toHaveLength(1)
    expect(await call($)).toEqual({ result: JSON.stringify(OTHER_ALLOWANCE) })
  })

test('a start with no key during an earlier start\'s GET leaves nothing reported and the tool unconfigured',
  CONFIGURED, async ($, on) => {
    const variables = new Map([['ANTHROPIC_AUTH_TOKEN', KEY]])
    on('env.get', (_$, e) => ({ value: variables.get(e.name) }))
    const clock = mock.clock(on, { now: T0 })
    const router = fakeRouter(on, clock)
    router.answerGet(async () => {
      await clock.sleep(1_000)
      return { status: 200, body: SAMPLE_ALLOWANCE }
    })
    const first = $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
    await clock.settle()
    variables.delete('ANTHROPIC_AUTH_TOKEN')
    await start($, clock)
    await clock.advance(1_000)
    await first
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
    await clock.settle()
    const answer = await call($)
    expect(router.requests).toEqual([])
    expect(router.tools).toEqual([])
    expect(answer).toEqual({ deny: expect.any(String) })
    expect(router.gets).toHaveLength(1)
  })

test('the start whose session id read lands last holds the reports and the tool alone', async ($, on) => {
  const variables = new Map([['ANTHROPIC_AUTH_TOKEN', 'k-a'], ['ANTHROPIC_BASE_URL', ROUTER]])
  on('env.get', (_$, e) => ({ value: variables.get(e.name) }))
  const clock = mock.clock(on, { now: T0 })
  const router = fakeRouter(on, clock)
  router.delayId(1_000)
  const first = $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
  await clock.settle()
  variables.set('ANTHROPIC_AUTH_TOKEN', 'k-b')
  variables.set('ANTHROPIC_BASE_URL', 'http://127.0.0.1:2')
  await start($, clock)
  await clock.advance(1_000)
  await first
  await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
  await clock.settle()
  // Past the cache window of the first start's read, so the call reads the router itself.
  await clock.set(T0 + 12_000)
  await call($)
  expect(router.targets.at(-1)?.url).toBe(`${ROUTER}/v0/keepalive/events`)
  expect(router.gets.at(-1)).toEqual({
    url: `${ROUTER}/v0/companion/allowance?session_id=session-a`,
    headers: { authorization: 'Bearer k-a' },
  })
})

test('a start that fails while an earlier start waits at its session id read leaves the session unconfigured',
  async ($, on) => {
    const variables = new Map([['ANTHROPIC_AUTH_TOKEN', 'k-a'], ['ANTHROPIC_BASE_URL', ROUTER]])
    on('env.get', (_$, e) => ({ value: variables.get(e.name) }))
    const clock = mock.clock(on, { now: T0 })
    const router = fakeRouter(on, clock)
    router.delayId(1_000)
    const first = $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
    await clock.settle()
    // The second start holds settings of its own and fails behind them, at its id read.
    router.denyId('the session id could not be read')
    await start($, clock)
    await clock.advance(1_000)
    await first
    const answer = await call($)
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
    await clock.settle()
    expect(answer).toEqual({ deny: expect.any(String) })
    expect(router.gets).toEqual([])
    expect(router.tools).toEqual([])
    expect(router.requests).toEqual([])
  })

test('a start that works behind a failed one keeps the configuration when an earlier session id read lands',
  async ($, on) => {
    const variables = new Map([['ANTHROPIC_AUTH_TOKEN', 'k-a'], ['ANTHROPIC_BASE_URL', ROUTER]])
    on('env.get', (_$, e) => ({ value: variables.get(e.name) }))
    const clock = mock.clock(on, { now: T0 })
    const router = fakeRouter(on, clock)
    router.delayId(1_000)
    const first = $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
    await clock.settle()
    router.denyId('the session id could not be read')
    await start($, clock)
    variables.set('ANTHROPIC_AUTH_TOKEN', 'k-c')
    variables.set('ANTHROPIC_BASE_URL', 'http://127.0.0.1:3')
    await start($, clock)
    await clock.advance(1_000)
    await first
    // The third start sent a report and a GET of its own to the same URL. Each count is taken behind them, so a
    // session that the first start left without a configuration fails on a list with no entry.
    const reports = router.targets.length
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
    await clock.settle()
    const reported = router.targets.slice(reports).map((target) => target.url)
    // Past the cache window of the third start's read, so the call reads the router itself.
    await clock.set(T0 + 12_000)
    const gets = router.gets.length
    await call($)
    expect(reported).toEqual(['http://127.0.0.1:3/v0/keepalive/events'])
    expect(router.gets.slice(gets)).toEqual([{
      url: 'http://127.0.0.1:3/v0/companion/allowance?session_id=session-a',
      headers: { authorization: 'Bearer k-c' },
    }])
  })

test('a start with no key during an earlier start\'s lifecycle fence leaves nothing reported', CONFIGURED,
  async ($, on) => {
    const variables = new Map([['ANTHROPIC_AUTH_TOKEN', KEY]])
    const clock = mock.clock(on, { now: T0 })
    let fenceHeld = false
    // The fence's first read is held, so the second start lands after the first start's check and before its
    // settings.
    on('env.get', async (_$, e) => {
      if (e.name === 'ANTHROPIC_CUSTOM_HEADERS' && !fenceHeld) {
        fenceHeld = true
        await clock.sleep(1_000)
      }
      return { value: variables.get(e.name) }
    })
    const router = fakeRouter(on, clock)
    const first = $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
    await clock.settle()
    variables.delete('ANTHROPIC_AUTH_TOKEN')
    await start($, clock)
    await clock.advance(1_000)
    await first
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
    await clock.settle()
    expect(router.requests).toEqual([])
  })

test('a start whose lifecycle fence throws after a later start took over leaves the later configuration standing',
  async ($, on) => {
    const variables = new Map([['ANTHROPIC_AUTH_TOKEN', 'k-a'], ['ANTHROPIC_BASE_URL', ROUTER]])
    const clock = mock.clock(on, { now: T0 })
    let fenceFailed = false
    // The fence's first read fails a second late, so the second start takes over before the first start throws.
    on('env.get', async (_$, e) => {
      if (e.name === 'ANTHROPIC_CUSTOM_HEADERS' && !fenceFailed) {
        fenceFailed = true
        await clock.sleep(1_000)
        return { deny: 'the environment could not be read' }
      }
      return { value: variables.get(e.name) }
    })
    const router = fakeRouter(on, clock)
    router.answerGet(() => ({ status: 200, body: SAMPLE_ALLOWANCE }))
    router.answerGet(() => ({ status: 200, body: OTHER_ALLOWANCE }))
    const first = $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
    await clock.settle()
    variables.set('ANTHROPIC_AUTH_TOKEN', 'k-b')
    variables.set('ANTHROPIC_BASE_URL', 'http://127.0.0.1:2')
    await start($, clock)
    await clock.advance(1_000)
    await first
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
    await clock.settle()
    expect(router.requests.map((body) => body.event)).toEqual(['session_start', 'activity'])
    expect(router.headers.map((headers) => headers.Authorization)).toEqual(['Bearer k-b', 'Bearer k-b'])
    expect(await call($)).toEqual({ result: JSON.stringify(OTHER_ALLOWANCE) })
  })

test('a start that set current last and then throws in its fence leaves no configuration behind', async ($, on) => {
  const variables = new Map([['ANTHROPIC_AUTH_TOKEN', 'k-a'], ['ANTHROPIC_BASE_URL', ROUTER]])
  const clock = mock.clock(on, { now: T0 })
  let fenceReads = 0
  // The second start's fence reads first, so the second fence read is the first start's, and it fails.
  on('env.get', (_$, e) => {
    if (e.name === 'ANTHROPIC_CUSTOM_HEADERS') {
      fenceReads += 1
      if (fenceReads === 2) return { deny: 'the environment could not be read' }
    }
    return { value: variables.get(e.name) }
  })
  const router = fakeRouter(on, clock)
  router.delayId(1_000)
  router.answerGet(() => ({ status: 200, body: OTHER_ALLOWANCE }))
  const first = $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
  await clock.settle()
  variables.set('ANTHROPIC_AUTH_TOKEN', 'k-b')
  variables.set('ANTHROPIC_BASE_URL', 'http://127.0.0.1:2')
  await start($, clock)
  await clock.advance(1_000)
  await first
  await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
  await clock.settle()
  const answer = await call($)
  expect(router.requests.map((body) => body.event)).toEqual(['session_start'])
  expect(answer).toEqual({ deny: expect.any(String) })
  expect(router.gets).toHaveLength(2)
})

test('a start that resolves no key after a later start began leaves the later configuration standing', CONFIGURED,
  async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    let keyReads = 0
    // The first start's key read answers no key a second late, after the second start has run to the end.
    on('env.get', async (_$, e) => {
      if (e.name !== 'ANTHROPIC_AUTH_TOKEN') return { value: undefined }
      keyReads += 1
      if (keyReads === 1) {
        await clock.sleep(1_000)
        return { value: undefined }
      }
      return { value: 'k-b' }
    })
    const router = fakeRouter(on, clock)
    router.answerGet(() => ({ status: 200, body: OTHER_ALLOWANCE }))
    const first = $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await start($, clock)
    await clock.advance(1_000)
    await first
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
    await clock.settle()
    expect(router.requests.map((body) => body.event)).toEqual(['session_start', 'activity'])
    expect(router.headers.map((headers) => headers.Authorization)).toEqual(['Bearer k-b', 'Bearer k-b'])
    expect(await call($)).toEqual({ result: JSON.stringify(OTHER_ALLOWANCE) })
  })

test('a call whose session id read a later start overtook reads under the later start\'s URL',
  { options: { keepalive: false } }, async ($, on) => {
    const variables = new Map([['ANTHROPIC_AUTH_TOKEN', KEY], ['ANTHROPIC_BASE_URL', ROUTER]])
    on('env.get', (_$, e) => ({ value: variables.get(e.name) }))
    const clock = mock.clock(on, { now: T0 })
    const router = fakeRouter(on, clock)
    await start($, clock)
    await clock.set(T0 + 10_000)
    router.delayId(1_000)
    const pending = call($)
    await clock.settle()
    variables.set('ANTHROPIC_BASE_URL', 'http://127.0.0.1:2')
    // The later start's GET fails, so the cache holds no body the call could answer from.
    router.answerGet(() => ({ fail: 'connection refused' }))
    await start($, clock)
    await clock.advance(1_000)
    await pending
    expect(router.gets.map((get) => get.url)).toEqual([
      `${ROUTER}/v0/companion/allowance?session_id=session-a`,
      'http://127.0.0.1:2/v0/companion/allowance?session_id=session-a',
      'http://127.0.0.1:2/v0/companion/allowance?session_id=session-a',
    ])
  })

test('a start GET past the limit registers the tool and the session start is not held longer', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    router.answerGet(async () => {
      await clock.sleep(4_000)
      return { status: 200, body: SAMPLE_ALLOWANCE }
    })
    let settledAt: number | undefined
    const started = $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
      .then(() => {
        settledAt = clock.now()
      })
    await clock.advance(3_000)
    expect(settledAt).toBe(T0 + 3_000)
    expect(router.tools).toHaveLength(1)
    await started
    // The body that arrives after the limit is dropped, so the next call reads the router itself.
    await clock.advance(1_000)
    await call($)
    expect(router.gets).toHaveLength(2)
  })

test('a call whose GET passes the limit answers an error at the limit and caches nothing', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    router.answerGet(() => ({ fail: 'connection refused' }))
    await start($, clock)
    router.answerGet(async () => {
      await clock.sleep(4_000)
      return { status: 200, body: SAMPLE_ALLOWANCE }
    })
    let settledAt: number | undefined
    let answer: Answer | undefined
    const called = call($).then((result) => {
      answer = result
      settledAt = clock.now()
    })
    await clock.advance(3_000)
    expect(settledAt).toBe(T0 + 3_000)
    expect(answer).toEqual({ deny: expect.any(String) })
    await called
    await clock.advance(1_000)
    await call($)
    expect(router.gets).toHaveLength(3)
  })

test('a call under a new session id inside ten seconds reads that session\'s allowance with a GET', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    router.setId('session-b')
    await clock.set(T0 + 1_000)
    await call($)
    expect(router.gets.map((get) => get.url)).toEqual([
      `${ROUTER}/v0/companion/allowance?session_id=session-a`,
      `${ROUTER}/v0/companion/allowance?session_id=session-b`,
    ])
  })

test('a key refused at a later start leaves nothing reported under the key an earlier start resolved', CONFIGURED,
  async ($, on) => {
    const variables = new Map([['ANTHROPIC_AUTH_TOKEN', 'k-a']])
    on('env.get', (_$, e) => ({ value: variables.get(e.name) }))
    const clock = mock.clock(on, { now: T0 })
    const router = fakeRouter(on, clock)
    await start($, clock)
    await $.session.end({ reason: 'clear', sessionId: 'session-a', resume: { id: 'session-a' } })
    await clock.settle()
    router.setId('session-b')
    variables.set('ANTHROPIC_AUTH_TOKEN', 'k-b')
    router.answerGet(() => ({ status: 401 }))
    await start($, clock)
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
    await clock.advance(60_000)
    expect(router.requests.map((body) => body.event)).toEqual(['session_start', 'session_end'])
    expect(router.logs.filter((line) => line.to === 'transcript').map((line) => line.text)).toEqual([
      `the router at ${ROUTER} refused the key (401), so this session reports nothing`,
    ])
  })

test('a 401 on the events route leaves the tool unconfigured', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  router.answer(() => ({ status: 401 }))
  await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
  await clock.settle()
  await clock.advance(10_000)
  const answer = await call($)
  expect(answer).toEqual({ deny: expect.any(String) })
  expect(router.gets).toHaveLength(1)
})

test('a 403 on the events route leaves the tool reading', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  router.answer(() => ({ status: 403 }))
  await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
  await clock.settle()
  expect(await call($)).toEqual({ result: SAMPLE_TEXT })
})

test('a 401 on a report sent under the settings a start replaced leaves the start in flight current', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    // The refusal lands while the second start's GET is out, before that start installs its own settings.
    router.answer(async () => {
      await clock.sleep(1000)
      return { status: 401 }
    })
    router.answerGet(async () => {
      await clock.sleep(2000)
      return { status: 200, body: SAMPLE_ALLOWANCE }
    })
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
    await clock.settle()
    const held = $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await clock.advance(1000)
    await clock.advance(1000)
    await held
    await clock.settle()
    expect(router.requests.map((body) => body.event)).toEqual(['session_start', 'activity', 'session_start'])
    expect(await call($)).toEqual({ result: SAMPLE_TEXT })
  })

test('a valid key at a later start under the same session id sends nothing queued before a refused start', CONFIGURED,
  async ($, on) => {
    const variables = new Map([['ANTHROPIC_AUTH_TOKEN', 'k-a']])
    on('env.get', (_$, e) => ({ value: variables.get(e.name) }))
    const clock = mock.clock(on, { now: T0 })
    const router = fakeRouter(on, clock)
    await start($, clock)
    // The 503 leaves the activity waiting in the queue for its retry.
    router.answer(() => ({ status: 503 }))
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
    await clock.settle()
    expect(router.requests.map((body) => body.event)).toEqual(['session_start', 'activity'])
    variables.set('ANTHROPIC_AUTH_TOKEN', 'k-b')
    router.answerGet(() => ({ status: 401 }))
    await start($, clock)
    variables.set('ANTHROPIC_AUTH_TOKEN', 'k-c')
    await start($, clock)
    // The retry falls due first, so a report the refusal left queued would go out before the prompt's own.
    await clock.advance(2_000)
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
    await clock.settle()
    expect(router.requests.slice(2).map((body) => body.event)).toEqual(['session_start', 'activity'])
    expect(router.headers.slice(2).map((headers) => headers.Authorization)).toEqual(['Bearer k-c', 'Bearer k-c'])
  })

test('a valid key at a later start under the same session id sends nothing queued before a start with no key',
  CONFIGURED, async ($, on) => {
    const variables = new Map([['ANTHROPIC_AUTH_TOKEN', 'k-a']])
    on('env.get', (_$, e) => ({ value: variables.get(e.name) }))
    const clock = mock.clock(on, { now: T0 })
    const router = fakeRouter(on, clock)
    await start($, clock)
    // The 503 leaves the activity waiting in the queue for its retry.
    router.answer(() => ({ status: 503 }))
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
    await clock.settle()
    expect(router.requests.map((body) => body.event)).toEqual(['session_start', 'activity'])
    variables.delete('ANTHROPIC_AUTH_TOKEN')
    await start($, clock)
    variables.set('ANTHROPIC_AUTH_TOKEN', 'k-c')
    await start($, clock)
    // The retry falls due first, so a report the start with no key left queued would go out before the prompt's own.
    await clock.advance(2_000)
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
    await clock.settle()
    expect(router.requests.slice(2).map((body) => body.event)).toEqual(['session_start', 'activity'])
    expect(router.headers.slice(2).map((headers) => headers.Authorization)).toEqual(['Bearer k-c', 'Bearer k-c'])
  })

test('a session start that fails leaves the tool unconfigured and the next prompt sends nothing', CONFIGURED,
  async ($, on) => {
    // The second start fails at its first read, before it holds settings of its own.
    const denials: string[] = []
    on('env.get', (_$, e) => {
      const denial = denials.shift()
      if (denial !== undefined) return { deny: denial }
      return { value: e.name === 'ANTHROPIC_AUTH_TOKEN' ? KEY : undefined }
    })
    const clock = mock.clock(on, { now: T0 })
    const router = fakeRouter(on, clock)
    await start($, clock)
    denials.push('the environment could not be read')
    await start($, clock)
    const answer = await call($)
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
    await clock.settle()
    expect(answer).toEqual({ deny: expect.any(String) })
    expect(router.gets).toHaveLength(1)
    expect(router.requests.map((body) => body.event)).toEqual(['session_start'])
  })

test('a second session start registers the tool again under the same name', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  await start($, clock)
  expect(router.tools.map((tool) => tool.name)).toEqual(['allowance', 'allowance'])
})

test('a registration the engine rejects costs the tool alone, with one debug line, and the keepalive still starts',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    router.denyRegister('tool limit reached')
    await start($, clock)
    expect(router.logs.map((line) => line.to)).toEqual(['debug'])
    expect(router.logs[0]?.text).toContain('tool limit reached')
    expect(router.requests.map((body) => body.event)).toEqual(['session_start'])
  })
