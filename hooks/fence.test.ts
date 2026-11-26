import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Identity } from '../types'
import runB from './fixtures/run-b'
import runC from './fixtures/run-c'
import { instanceHeaderLines, instanceOf, nextSequence, reusable } from './rules'
import type { Body } from './rules'
import { fakeRouter, replay } from './testing'
import type { FakeOptions, FakeRouter, Reply } from './testing'

const CONFIGURED = { options: { management_url: 'http://127.0.0.1:1' } }
const KEY = 'k-test'
const HEADERS = 'ANTHROPIC_CUSTOM_HEADERS'
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// The time run-h's session started, as the clock a reloaded module finds.
const RELOAD_AT = 1795442783684
// What a module that loaded earlier in this process left behind: its header line and its state.
const INHERITED = { ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_CUSTOM_HEADERS: 'X-Phoebis-Instance-Id: i-1\nX-B: 2' }
const HELD: Identity = { instance: 'i-1' }
// Two client processes as `echo $PPID` prints them, long enough that no minted uuid or sequence holds either by chance.
const PROCESS = '3141592'
const CHILD = '2718281'
const PROCESS_KEY = 'identity:3141592'
const CHILD_KEY = 'identity:2718281'

const ok = (body: unknown): Reply => ({ status: 200, body })

function host(on: On, variables: Record<string, string>, state?: Identity, now = RELOAD_AT):
  { clock: MockClock; router: FakeRouter } {
  mock.env(on, variables)
  const clock = mock.clock(on, { now })
  return { clock, router: fakeRouter(on, clock, { id: 'session-a', ...(state === undefined ? {} : { state }) }) }
}

// A load under a later session id, whose host state starts empty, in the client process the options name.
function processHost(on: On, variables: Record<string, string>, options: FakeOptions):
  { clock: MockClock; router: FakeRouter } {
  mock.env(on, variables)
  const clock = mock.clock(on, { now: RELOAD_AT })
  return { clock, router: fakeRouter(on, clock, { id: 'session-b', ...options }) }
}

// The process identity keys the store alone, so no header, no variable and no report carries it.
function keptInStore(router: FakeRouter, process: string): void {
  expect(JSON.stringify(router.envWrites)).not.toContain(process)
  expect(JSON.stringify(router.headers)).not.toContain(process)
  expect(JSON.stringify(router.requests)).not.toContain(process)
}

async function start($: Engine, clock: MockClock): Promise<void> {
  await $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
  await clock.settle()
}

async function prompt($: Engine, clock: MockClock): Promise<void> {
  await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
  await clock.settle()
}

function nth<T>(list: readonly T[], index: number): T {
  const found = list[index]
  if (found === undefined) throw new Error(`nothing at ${index} of ${list.length}`)
  return found
}

function registrations(router: FakeRouter): Body[] {
  return router.requests.filter((body) => body.event === 'session_start')
}

// The instance a load minted, read off the header line it wrote.
function minted(router: FakeRouter): string {
  const instance = instanceOf(router.envWrites.find((write) => write.name === HEADERS)?.value)
  if (instance === undefined) throw new Error('no identity was written')
  return instance
}

test('the instance header is appended to an existing value with a newline and the instance id rides session_start',
  CONFIGURED, async ($, on) => {
    mock.env(on, { ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_CUSTOM_HEADERS: 'X-A: 1' })
    const clock = mock.clock(on)
    const router = fakeRouter(on, clock)
    // The non-interactive run with a key, as its session start records (tokenSet true).
    await replay($, on, runC, clock, router)
    const first = nth(router.requests, 0)
    expect(first.event).toBe('session_start')
    expect(router.envWrites).toEqual([{ name: HEADERS, value: `X-A: 1\nX-Phoebis-Instance-Id: ${first.instance_id}` }])
    expect(router.refusals).toEqual([])
  })

test('a minted uuid has the v4 shape', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on, { ANTHROPIC_AUTH_TOKEN: KEY })
  await start($, clock)
  const instance = minted(router)
  expect(instance).toMatch(V4)
  expect(router.state).toEqual({ instance })
  expect(nth(router.requests, 0)).toMatchObject({ event: 'session_start', instance_id: instance })
})

test('a reload in the same process keeps the instance and its header line and continues the sequence past the clock',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on, INHERITED, HELD)
    // The module that loaded before this one reported up to a moment ago, so a sequence counted from one is stale.
    router.answer((body, ack) => body.sequence > RELOAD_AT - 1
      ? ok(ack)
      : { status: 409, body: { code: 'stale_sequence' } })
    await start($, clock)
    await prompt($, clock)
    expect(router.envWrites).toEqual([{ name: HEADERS, value: 'X-B: 2\nX-Phoebis-Instance-Id: i-1' }])
    const first = nth(router.requests, 0)
    expect(first).toMatchObject({ event: 'session_start', instance_id: 'i-1' })
    expect(first.sequence).toBeGreaterThanOrEqual(RELOAD_AT)
    // The instance is never minted again, so the state takes no write.
    expect(router.state).toBeUndefined()
    expect(router.refusals).toEqual([])
    expect(router.requests.map((body) => body.event)).toEqual(['session_start', 'activity'])
  })

test('a child process that inherited the header line registers as its own instance', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on, INHERITED)
  await start($, clock)
  await prompt($, clock)
  const instance = minted(router)
  expect(instance).toMatch(V4)
  // The inherited line is replaced rather than doubled, so the relay reads one instance.
  expect(router.envWrites).toEqual([{ name: HEADERS, value: `X-B: 2\nX-Phoebis-Instance-Id: ${instance}` }])
  expect(router.state).toEqual({ instance })
  expect(nth(router.requests, 0)).toMatchObject({ event: 'session_start', instance_id: instance })
  expect(JSON.stringify(router.requests)).not.toContain('i-1')
})

test('a state that names another instance than the header line mints a fresh instance', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on, INHERITED, { instance: 'i-0' })
  await start($, clock)
  await prompt($, clock)
  const instance = minted(router)
  expect(instance).toMatch(V4)
  expect(router.envWrites).toEqual([{ name: HEADERS, value: `X-B: 2\nX-Phoebis-Instance-Id: ${instance}` }])
  expect(router.state).toEqual({ instance })
  expect(nth(router.requests, 0)).toMatchObject({ event: 'session_start', instance_id: instance })
  for (const old of ['i-0', 'i-1']) expect(JSON.stringify(router.requests)).not.toContain(old)
})

test('a clear keeps the instance', CONFIGURED, async ($, on) => {
  mock.env(on, { ANTHROPIC_AUTH_TOKEN: KEY })
  const clock = mock.clock(on)
  const router = fakeRouter(on, clock)
  await replay($, on, runB, clock, router)
  const [first, second] = registrations(router)
  if (first === undefined || second === undefined) throw new Error('two registrations expected')
  expect(second.session_id).not.toBe(first.session_id)
  expect(second.instance_id).toBe(first.instance_id)
  // The cleared session's first prompt, at run-b.jsonl:51, is what registers the new id.
  expect(second.sequence, 'a fresh record takes the clock as its first sequence').toBeGreaterThanOrEqual(1790936545000)
})

test('a reload under a later session id of the same process reuses the instance the store keeps for that process',
  CONFIGURED, async ($, on) => {
    // A clear moved the process to a session id under which the host's state holds nothing, so the store's entry for
    // the process is the one record of the instance.
    const other: Identity = { instance: 'i-2' }
    const store = { [PROCESS_KEY]: HELD, [CHILD_KEY]: other }
    const { clock, router } = processHost(on, INHERITED, { process: PROCESS, store })
    await start($, clock)
    await prompt($, clock)
    expect(router.envWrites).toEqual([{ name: HEADERS, value: 'X-B: 2\nX-Phoebis-Instance-Id: i-1' }])
    expect(nth(router.requests, 0)).toMatchObject({ event: 'session_start', session_id: 'session-b',
      instance_id: 'i-1' })
    // The state takes the instance beside the store, so the next reload under this id reads it there.
    expect(router.state).toEqual(HELD)
    expect([...router.store], 'the reused instance is the newest').toEqual([[CHILD_KEY, other], [PROCESS_KEY, HELD]])
    // A second start in the same load reads no process again.
    await start($, clock)
    expect(router.commands).toEqual([['sh', '-c', 'echo $PPID']])
    expect(router.logs.map((line) => line.to)).toEqual(['debug'])
    keptInStore(router, PROCESS)
  })

test('a start after a clear in the same process keeps the instance once the store no longer holds the process',
  CONFIGURED, async ($, on) => {
    mock.env(on, INHERITED)
    const clock = mock.clock(on, { now: RELOAD_AT })
    const router = fakeRouter(on, clock, { id: 'session-a', state: HELD, process: PROCESS,
      store: { [PROCESS_KEY]: HELD } })
    await start($, clock)
    // A clear raises no start, so the prompt is what moves the mod to the new id.
    router.setId('session-b')
    await prompt($, clock)
    // The fences of eight later processes push this one out of the store.
    router.store.delete(PROCESS_KEY)
    for (let at = 0; at < 8; at += 1) router.store.set(`identity:${1000001 + at}`, { instance: `other-${at}` })
    // The fence picks its instance from the host's state, the header line, the store and the process id, and a reload
    // reads each of them again to the same value, so a second start in the load decides as a reload does.
    await start($, clock)
    expect(router.envWrites).toEqual([
      { name: HEADERS, value: 'X-B: 2\nX-Phoebis-Instance-Id: i-1' },
      { name: HEADERS, value: 'X-B: 2\nX-Phoebis-Instance-Id: i-1' },
    ])
  })

test('a start replaced while its fence reads writes none of its identity', CONFIGURED, async ($, on) => {
  const { clock, router } = processHost(on, { ANTHROPIC_AUTH_TOKEN: KEY }, { process: PROCESS })
  // The first start's read of its key answers a second late, and a second start runs to its end meanwhile.
  router.delayStore(1000)
  const replaced = $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await start($, clock)
  await clock.advance(1000)
  await replaced
  const instance = nth(registrations(router), 0).instance_id
  expect(router.envWrites).toEqual([{ name: HEADERS, value: `X-Phoebis-Instance-Id: ${instance}` }])
  expect(router.state).toEqual({ instance })
  expect([...router.store]).toEqual([[PROCESS_KEY, { instance }]])
})

test('a replaced start\'s header write that the host lands late comes before the current start\'s identity',
  CONFIGURED, async ($, on) => {
    const { clock, router } = processHost(on, { ANTHROPIC_AUTH_TOKEN: KEY }, { process: PROCESS })
    // The host completes the first start's header write a second late, and a second start replaces it meanwhile.
    router.delayEnvSet(1000)
    const replaced = $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
    await clock.settle()
    // The second start's fence waits for the first start's delayed header write, so awaiting it before the clock moves
    // would not return.
    const current = $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await clock.advance(1000)
    await replaced
    await current
    const registration = nth(registrations(router), 0)
    expect(router.envWrites.slice(-1)).toEqual([
      { name: HEADERS, value: `X-Phoebis-Instance-Id: ${registration.instance_id}` },
    ])
  })

test('a fence whose write the host refuses leaves the next start\'s fence to run', CONFIGURED, async ($, on) => {
  const { clock, router } = processHost(on, { ANTHROPIC_AUTH_TOKEN: KEY }, { process: PROCESS })
  // Another plugin's hook on the variable refuses the first start's header write, and a hook's own deny rejects the
  // call where the engine's hold would resolve.
  router.denyEnvSet('another plugin holds the variable')
  await start($, clock)
  await start($, clock)
  const registration = nth(registrations(router), 0)
  expect(router.envWrites.slice(-1)).toEqual([
    { name: HEADERS, value: `X-Phoebis-Instance-Id: ${registration.instance_id}` },
  ])
})

test('a state write the host refuses when a prompt adopts a new id leaves the next start\'s fence to run', CONFIGURED,
  async ($, on) => {
    mock.env(on, INHERITED)
    const clock = mock.clock(on, { now: RELOAD_AT })
    const router = fakeRouter(on, clock, { id: 'session-a', state: HELD, process: PROCESS,
      store: { [PROCESS_KEY]: HELD } })
    await start($, clock)
    router.setId('session-b')
    // The host refuses the write that keeps the instance under the id the prompt adopts.
    router.denyIdentityWrite('another hook refuses the write')
    await prompt($, clock)
    await start($, clock)
    expect(router.envWrites).toEqual([
      { name: HEADERS, value: 'X-B: 2\nX-Phoebis-Instance-Id: i-1' },
      { name: HEADERS, value: 'X-B: 2\nX-Phoebis-Instance-Id: i-1' },
    ])
  })

test('a child process mints its own instance beside the one the store keeps for its parent', CONFIGURED,
  async ($, on) => {
    const { clock, router } = processHost(on, INHERITED, { process: CHILD, store: { [PROCESS_KEY]: HELD } })
    await start($, clock)
    await prompt($, clock)
    const instance = minted(router)
    expect(instance).toMatch(V4)
    expect(router.envWrites).toEqual([{ name: HEADERS, value: `X-B: 2\nX-Phoebis-Instance-Id: ${instance}` }])
    expect(router.state).toEqual({ instance })
    expect([...router.store]).toEqual([[PROCESS_KEY, HELD], [CHILD_KEY, { instance }]])
    expect(JSON.stringify(router.requests)).not.toContain('i-1')
    keptInStore(router, PROCESS)
    keptInStore(router, CHILD)
  })

test('an entry that another process writes while a fence is between its read and its write stays in the store',
  CONFIGURED, async ($, on) => {
    const { clock, router } = processHost(on, { ANTHROPIC_AUTH_TOKEN: KEY }, { process: CHILD })
    // The fence has read the empty store when the host holds its identity write, which comes ahead of its store write.
    router.delayIdentityWrite(1000)
    const starting = $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
    await clock.settle()
    // The parent's fence writes its entry meanwhile.
    router.store.set(PROCESS_KEY, HELD)
    await clock.advance(1000)
    await starting
    const instance = minted(router)
    expect([...router.store]).toEqual([[PROCESS_KEY, HELD], [CHILD_KEY, { instance }]])
  })

test('the header line alone makes no instance reusable in a process the store keeps no instance for', CONFIGURED,
  async ($, on) => {
    const { clock, router } = processHost(on, INHERITED, { process: PROCESS })
    await start($, clock)
    await prompt($, clock)
    const instance = minted(router)
    expect(instance).toMatch(V4)
    expect(nth(router.requests, 0)).toMatchObject({ event: 'session_start', instance_id: instance })
    expect([...router.store]).toEqual([[PROCESS_KEY, { instance }]])
    expect(JSON.stringify(router.requests)).not.toContain('i-1')
    keptInStore(router, PROCESS)
  })

test('the store keeps the newest eight instances, so a ninth process drops the oldest', CONFIGURED, async ($, on) => {
  const older = Array.from({ length: 8 }, (_, at) => [`identity:${1000001 + at}`, { instance: `other-${at}` }] as const)
  const { clock, router } = processHost(on, INHERITED, { process: CHILD, store: Object.fromEntries(older) })
  await start($, clock)
  const instance = minted(router)
  expect([...router.store]).toEqual([...older.slice(1), [CHILD_KEY, { instance }]])
})

test('a host that runs no command mints as a child process does and leaves the store alone', CONFIGURED,
  async ($, on) => {
    const { clock, router } = processHost(on, INHERITED, { store: { [PROCESS_KEY]: HELD } })
    await start($, clock)
    const instance = minted(router)
    expect(instance).toMatch(V4)
    expect([...router.store]).toEqual([[PROCESS_KEY, HELD]])
    expect(router.logs).toEqual([])
  })

test('the instance id reaches no log line and no header of the mod\'s own requests', CONFIGURED, async ($, on) => {
  mock.env(on, { ANTHROPIC_AUTH_TOKEN: KEY })
  const clock = mock.clock(on)
  const router = fakeRouter(on, clock)
  router.answer(() => ({ status: 409, body: { code: 'instance_conflict' } }))
  await replay($, on, runB, clock, router)
  router.setId('session-z')
  router.answer(() => ({ status: 401 }))
  await prompt($, clock)
  const instance = minted(router)
  expect(router.logs.map((line) => line.to)).toEqual(['transcript', 'debug'])
  expect(JSON.stringify(router.logs)).not.toContain(instance)
  expect(JSON.stringify(router.headers)).not.toContain(instance)
  expect(JSON.stringify(router.targets)).not.toContain(instance)
})

test('the instance line is read and replaced whatever the case of its name, and every other line stays', () => {
  expect(instanceOf(undefined)).toBeUndefined()
  expect(instanceOf('X-A: 1')).toBeUndefined()
  expect(instanceOf('X-A: 1\r\nx-phoebis-instance-id:  i-1 \nX-B: 2')).toBe('i-1')
  // Two instance lines leave the relay's reading unclear, so neither is evidence.
  expect(instanceOf('X-Phoebis-Instance-Id: i-1\nX-Phoebis-Instance-Id: i-2')).toBeUndefined()
  expect(instanceOf('X-Phoebis-Instance-Id: ')).toBeUndefined()
  expect(instanceHeaderLines(undefined, 'i-1')).toBe('X-Phoebis-Instance-Id: i-1')
  expect(instanceHeaderLines('', 'i-1')).toBe('X-Phoebis-Instance-Id: i-1')
  expect(instanceHeaderLines('X-A: 1\n\nx-phoebis-instance-id: i-0\r\nX-B: b:c\n', 'i-1'))
    .toBe('X-A: 1\nX-B: b:c\nX-Phoebis-Instance-Id: i-1')
})

test('the held identity is reused only when the header line names its instance', () => {
  expect(reusable(HELD, 'i-1')).toBe(true)
  expect(reusable(HELD, undefined)).toBe(false)
  expect(reusable(HELD, 'i-2')).toBe(false)
})

test('the next sequence is the clock or one past the previous, whichever is higher', () => {
  expect(nextSequence(0, RELOAD_AT)).toBe(RELOAD_AT)
  expect(nextSequence(RELOAD_AT, RELOAD_AT)).toBe(RELOAD_AT + 1)
  expect(nextSequence(RELOAD_AT + 5, RELOAD_AT + 2)).toBe(RELOAD_AT + 6)
  expect(nextSequence(RELOAD_AT, RELOAD_AT + 2000)).toBe(RELOAD_AT + 2000)
})
