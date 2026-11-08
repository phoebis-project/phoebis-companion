import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { fakeRouter, SAMPLE_ALLOWANCE } from './testing.ts'
import type { FakeRouter } from './testing.ts'

const ROUTER = 'http://127.0.0.1:1'
const KEY = 'k-test'
const CONFIGURED = { options: { management_url: ROUTER } }
const T0 = 1_790_000_000_000
const SAMPLE_TEXT = JSON.stringify(SAMPLE_ALLOWANCE)
const PAGE = '<!doctype html><title>Phoebis</title>'
const TOOL_CALL = 'mcp__phoebis-companion__allowance'

type Result = { content: { type: 'text'; text: string }[]; isError?: true }

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

async function call($: Engine): Promise<Result> {
  calls += 1
  const answer = await $.tool.call({ tool: TOOL_CALL, tool_use_id: `toolu_${calls}` } as
    Parameters<Engine['tool']['call']>[0])
  return answer.result as Result
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
  const line = `phoebis-companion: the router at ${ROUTER} refused the key (401), so this session reports nothing`
  const cases = [
    ['with the toast on by default', {}, [line]],
    ['with notifications off', { notifications: false }, []],
  ] as const
  for (const [name, options, toasts] of cases) {
    test(name, { options: { management_url: ROUTER, ...options } }, async ($, on) => {
      const { clock, router } = host(on)
      router.answerGet(() => ({ status: 401 }))
      await start($, clock)
      await clock.advance(1000)
      expect(router.logs).toEqual([{ text: line, to: 'transcript' }])
      expect(router.toasts).toEqual(toasts)
      expect(router.requests.map((body) => body.event)).not.toContain('session_start')
      expect(router.tools).toEqual([])
    })
  }
})

test('a 403 companion_not_permitted registers no tool and writes a debug line only', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  router.answerGet(() => ({ status: 403, body: { code: 'companion_not_permitted' } }))
  await start($, clock)
  expect(router.tools).toEqual([])
  expect(router.logs).toEqual([{ text: 'phoebis-companion: this key may not read the allowance', to: 'debug' }])
  expect(router.toasts).toEqual([])
  expect(router.requests.map((body) => body.event)).toEqual(['session_start'])
})

test('a 200 registers the tool once and a second call inside ten seconds answers the cached body with no second GET',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    expect(router.tools).toHaveLength(1)
    expect(router.tools[0]).toMatchObject({ name: 'allowance', isDeferred: false })
    await clock.set(T0 + 9999)
    expect(await call($)).toEqual({ content: [{ type: 'text', text: SAMPLE_TEXT }] })
    expect(router.gets).toHaveLength(1)
    await clock.set(T0 + 10000)
    expect(await call($)).toEqual({ content: [{ type: 'text', text: SAMPLE_TEXT }] })
    expect(router.gets).toHaveLength(2)
    await clock.set(T0 + 12_000)
    expect(await call($)).toEqual({ content: [{ type: 'text', text: SAMPLE_TEXT }] })
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
    expect(answer.isError).toBe(true)
    expect(answer.content[0]?.text).toContain('connection refused')
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
    expect(answer.isError).toBe(true)
    expect(answer.content[0]?.text).toContain('not the allowance')
  })

test('a reload whose start GET fails answers the error text, not the earlier body', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  expect(await call($)).toEqual({ content: [{ type: 'text', text: SAMPLE_TEXT }] })
  router.answerGet(() => ({ fail: 'connection refused' }))
  router.answerGet(() => ({ fail: 'connection refused' }))
  await start($, clock)
  const answer = await call($)
  expect(answer.isError).toBe(true)
  expect(answer.content[0]?.text).toContain('connection refused')
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
    let answer: Result | undefined
    const called = call($).then((result) => {
      answer = result
      settledAt = clock.now()
    })
    await clock.advance(3_000)
    expect(settledAt).toBe(T0 + 3_000)
    expect(answer?.isError).toBe(true)
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
      `phoebis-companion: the router at ${ROUTER} refused the key (401), so this session reports nothing`,
    ])
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
    expect(router.requests.slice(2).map((body) => body.event)).toEqual(['activity'])
    expect(router.headers.slice(2).map((headers) => headers.Authorization)).toEqual(['Bearer k-c'])
  })

test('a second session start registers the tool again under the same name', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  await start($, clock)
  expect(router.tools.map((tool) => tool.name)).toEqual(['allowance', 'allowance'])
})

test('a start that resolves no key leaves the tool answering an error, not the earlier configuration\'s body',
  CONFIGURED, async ($, on) => {
    const variables = new Map([['ANTHROPIC_AUTH_TOKEN', KEY]])
    on('env.get', (_$, e) => ({ value: variables.get(e.name) }))
    const clock = mock.clock(on, { now: T0 })
    const router = fakeRouter(on, clock)
    await start($, clock)
    expect(await call($)).toEqual({ content: [{ type: 'text', text: SAMPLE_TEXT }] })
    variables.delete('ANTHROPIC_AUTH_TOKEN')
    await start($, clock)
    const answer = await call($)
    expect(answer.isError).toBe(true)
    expect(router.gets).toHaveLength(1)
  })

test('a client between 2.1.287 and 2.1.293 runs the start check and reports, with one debug line in place of the tool',
  CONFIGURED, async ($, on) => {
    mock.env(on, { ANTHROPIC_AUTH_TOKEN: KEY })
    const clock = mock.clock(on, { now: T0 })
    const router = fakeRouter(on, clock, { version: '2.1.292' })
    await start($, clock)
    expect(router.gets).toHaveLength(1)
    expect(router.tools).toEqual([])
    expect(router.logs.map((line) => line.to)).toEqual(['debug'])
    expect(router.requests.map((body) => body.event)).toEqual(['session_start'])
  })
