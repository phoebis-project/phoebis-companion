import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Identity } from '../types/index.d.ts'
import runA from './fixtures/run-a.ts'
import runB from './fixtures/run-b.ts'
import runC from './fixtures/run-c.ts'
import runE from './fixtures/run-e.ts'
import runH from './fixtures/run-h.ts'
import { nextSequence, ownerHeaderLines, ownerOf, reusable } from './rules.ts'
import type { Body } from './rules.ts'
import { fakeRouter, replay } from './testing.ts'
import type { FakeOptions, FakeRouter, Reply } from './testing.ts'

const CONFIGURED = { options: { management_url: 'http://127.0.0.1:1' } }
const KEY = 'k-test'
const HEADERS = 'ANTHROPIC_CUSTOM_HEADERS'
const INSTANCE = 'PHOEBIS_KEEPALIVE_INSTANCE'
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const LOGS = { 'run-a': runA, 'run-b': runB, 'run-c': runC, 'run-e': runE, 'run-h': runH }
// The time run-h's session started, as the clock a reloaded module finds.
const RELOAD_AT = 1790937865035
// What a module that loaded earlier in this process left behind: its header line, its variable and its state.
const INHERITED = {
  ANTHROPIC_AUTH_TOKEN: KEY,
  ANTHROPIC_CUSTOM_HEADERS: 'X-Keepalive-Owner-Id: u-old\nX-B: 2',
  PHOEBIS_KEEPALIVE_INSTANCE: 'i-1',
}
const HELD: Identity = { instance: 'i-1', owner: 'u-old' }
// Two client processes as `echo $PPID` prints them, long enough that no minted uuid or sequence holds either by chance.
const PROCESS = '3141592'
const CHILD = '2718281'

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

function ownerOfBody(body: Body): string | undefined {
  return body.event === 'session_start' ? body.owner_id : undefined
}

function registrations(router: FakeRouter): Body[] {
  return router.requests.filter((body) => body.event === 'session_start')
}

// The pair a load minted, read off the variable and the header line it wrote.
function minted(router: FakeRouter): Identity {
  const header = router.envWrites.find((write) => write.name === HEADERS)?.value
  const instance = router.envWrites.find((write) => write.name === INSTANCE)?.value
  const owner = ownerOf(header)
  if (instance === undefined || owner === undefined) throw new Error('no identity was written')
  return { instance, owner }
}

test('the owner header is appended to an existing value with a newline and the owner id rides session_start',
  CONFIGURED, async ($, on) => {
    mock.env(on, { ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_CUSTOM_HEADERS: 'X-A: 1' })
    const clock = mock.clock(on)
    const router = fakeRouter(on, clock)
    // The non-interactive run with a key, as its session start records (tokenSet true).
    await replay($, on, runC, clock, router)
    const first = nth(router.requests, 0)
    const owner = ownerOfBody(first)
    expect(first.event).toBe('session_start')
    expect(owner).toMatch(V4)
    expect(router.envWrites).toEqual([
      { name: HEADERS, value: `X-A: 1\nX-Keepalive-Owner-Id: ${owner}` },
      { name: INSTANCE, value: first.instance_id },
    ])
    expect(router.refusals).toEqual([])
  })

describe('the header is set once when the variable is empty', () => {
  const loads = [['unset', {}], ['empty', { ANTHROPIC_CUSTOM_HEADERS: '' }]] as const
  for (const [name, variables] of loads) {
    test(name, CONFIGURED, async ($, on) => {
      const { clock, router } = host(on, { ANTHROPIC_AUTH_TOKEN: KEY, ...variables })
      await start($, clock)
      const { owner } = minted(router)
      expect(router.envWrites.filter((write) => write.name === HEADERS))
        .toEqual([{ name: HEADERS, value: `X-Keepalive-Owner-Id: ${owner}` }])
    })
  }
})

test('a minted uuid has the v4 shape', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on, { ANTHROPIC_AUTH_TOKEN: KEY })
  await start($, clock)
  const { instance, owner } = minted(router)
  expect(instance).toMatch(V4)
  expect(owner).toMatch(V4)
  expect(owner).not.toBe(instance)
  expect(router.state).toEqual({ instance, owner })
  expect(nth(router.requests, 0)).toMatchObject({ event: 'session_start', instance_id: instance, owner_id: owner })
})

test('a reload in the same process keeps the owner line and the instance and continues the sequence past the clock',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on, INHERITED, HELD)
    // The module that loaded before this one reported up to a moment ago, so a sequence counted from one is stale.
    router.answer((body, ack) => body.sequence > RELOAD_AT - 1
      ? ok(ack)
      : { status: 409, body: { code: 'stale_sequence' } })
    await start($, clock)
    await prompt($, clock)
    expect(router.envWrites).toEqual([
      { name: HEADERS, value: 'X-B: 2\nX-Keepalive-Owner-Id: u-old' },
      { name: INSTANCE, value: 'i-1' },
    ])
    const first = nth(router.requests, 0)
    expect(first).toMatchObject({ event: 'session_start', owner_id: 'u-old', instance_id: 'i-1' })
    expect(first.sequence).toBeGreaterThanOrEqual(RELOAD_AT)
    // The tracked work is written as it changes, and the pair is never minted again.
    expect([...router.values.keys()]).toEqual(['model'])
    expect(router.state).toBeUndefined()
    expect(router.refusals).toEqual([])
    expect(router.requests.map((body) => body.event)).toEqual(['session_start', 'activity'])
  })

test('a child process that inherited the variables registers as its own instance under its own owner', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on, INHERITED)
    await start($, clock)
    await prompt($, clock)
    const { instance, owner } = minted(router)
    expect(owner).toMatch(V4)
    expect(instance).toMatch(V4)
    // The inherited line is replaced rather than doubled, so the relay reads one owner.
    expect(router.envWrites).toEqual([
      { name: HEADERS, value: `X-B: 2\nX-Keepalive-Owner-Id: ${owner}` },
      { name: INSTANCE, value: instance },
    ])
    expect(router.state).toEqual({ instance, owner })
    expect(nth(router.requests, 0)).toMatchObject({ event: 'session_start', instance_id: instance, owner_id: owner })
    expect(JSON.stringify(router.requests)).not.toContain('u-old')
    expect(JSON.stringify(router.requests)).not.toContain('i-1')
  })

test('a state that names other values than the environment mints a fresh pair', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on, INHERITED, { instance: 'i-0', owner: 'u-0' })
  await start($, clock)
  await prompt($, clock)
  const { instance, owner } = minted(router)
  expect(owner).toMatch(V4)
  expect(instance).toMatch(V4)
  expect(router.envWrites).toEqual([
    { name: HEADERS, value: `X-B: 2\nX-Keepalive-Owner-Id: ${owner}` },
    { name: INSTANCE, value: instance },
  ])
  expect(router.state).toEqual({ instance, owner })
  expect(nth(router.requests, 0)).toMatchObject({ event: 'session_start', instance_id: instance, owner_id: owner })
  for (const old of ['u-0', 'i-0', 'u-old', 'i-1']) expect(JSON.stringify(router.requests)).not.toContain(old)
})

test('a clear keeps the uuid and the instance', CONFIGURED, async ($, on) => {
  mock.env(on, { ANTHROPIC_AUTH_TOKEN: KEY })
  const clock = mock.clock(on)
  const router = fakeRouter(on, clock)
  await replay($, on, runB, clock, router)
  const [first, second] = registrations(router)
  if (first === undefined || second === undefined) throw new Error('two registrations expected')
  expect(second.session_id).not.toBe(first.session_id)
  expect(second.instance_id).toBe(first.instance_id)
  expect(ownerOfBody(second)).toBe(ownerOfBody(first))
  // The cleared session's first prompt, at run-b.jsonl:51, is what registers the new id.
  expect(second.sequence, 'a fresh record takes the clock as its first sequence').toBeGreaterThanOrEqual(1790936545000)
  expect(router.envWrites.map((write) => write.name)).toEqual([HEADERS, INSTANCE])
})

test('a reload under a later session id of the same process reuses the pair the store keeps for that process',
  CONFIGURED, async ($, on) => {
    // A clear moved the process to a session id under which the host's state holds nothing, so the store's entry for
    // the process is the one record of the pair.
    const other: Identity = { instance: 'i-2', owner: 'u-2' }
    const store = { identities: [[PROCESS, HELD], [CHILD, other]] }
    const { clock, router } = processHost(on, INHERITED, { process: PROCESS, store })
    await start($, clock)
    await prompt($, clock)
    expect(router.envWrites).toEqual([
      { name: HEADERS, value: 'X-B: 2\nX-Keepalive-Owner-Id: u-old' },
      { name: INSTANCE, value: 'i-1' },
    ])
    expect(nth(router.requests, 0)).toMatchObject({ event: 'session_start', session_id: 'session-b',
      instance_id: 'i-1', owner_id: 'u-old' })
    // The state takes the pair beside the store, so the next reload under this id reads it there.
    expect(router.state).toEqual(HELD)
    expect(router.store.get('identities'), 'the reused pair is the newest').toEqual([[CHILD, other], [PROCESS, HELD]])
    // A second start in the same load reads no process again.
    await start($, clock)
    expect(router.commands).toEqual([['sh', '-c', 'echo $PPID']])
    expect(router.logs).toEqual([
      { text: `phoebis-companion: the client process reads as ${PROCESS}, which keys the pair the mod reuses across ` +
        'a clear', to: 'debug' },
    ])
    keptInStore(router, PROCESS)
  })

test('a start replaced while its fence reads writes none of its identity', CONFIGURED, async ($, on) => {
  const { clock, router } = processHost(on, { ANTHROPIC_AUTH_TOKEN: KEY }, { process: PROCESS })
  // The first start's read of the stored pairs answers a second late, and a second start runs to its end meanwhile.
  router.delayStore(1000)
  const replaced = $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await start($, clock)
  await clock.advance(1000)
  await replaced
  const registration = nth(registrations(router), 0)
  const pair = { instance: registration.instance_id, owner: ownerOfBody(registration) }
  expect(router.envWrites).toEqual([
    { name: HEADERS, value: `X-Keepalive-Owner-Id: ${pair.owner}` },
    { name: INSTANCE, value: pair.instance },
  ])
  expect(router.state).toEqual(pair)
  expect(router.store.get('identities')).toEqual([[PROCESS, pair]])
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
    expect(router.envWrites.slice(-2)).toEqual([
      { name: HEADERS, value: `X-Keepalive-Owner-Id: ${ownerOfBody(registration)}` },
      { name: INSTANCE, value: registration.instance_id },
    ])
  })

test('a child process mints its own pair beside the one the store keeps for its parent', CONFIGURED,
  async ($, on) => {
    const { clock, router } = processHost(on, INHERITED, { process: CHILD, store: { identities: [[PROCESS, HELD]] } })
    await start($, clock)
    await prompt($, clock)
    const { instance, owner } = minted(router)
    expect(owner).toMatch(V4)
    expect(instance).toMatch(V4)
    expect(router.envWrites).toEqual([
      { name: HEADERS, value: `X-B: 2\nX-Keepalive-Owner-Id: ${owner}` },
      { name: INSTANCE, value: instance },
    ])
    expect(router.state).toEqual({ instance, owner })
    expect(router.store.get('identities')).toEqual([[PROCESS, HELD], [CHILD, { instance, owner }]])
    for (const old of ['u-old', 'i-1']) expect(JSON.stringify(router.requests)).not.toContain(old)
    keptInStore(router, PROCESS)
    keptInStore(router, CHILD)
  })

test('the two variables alone make no pair reusable in a process the store keeps no pair for', CONFIGURED,
  async ($, on) => {
    const { clock, router } = processHost(on, INHERITED, { process: PROCESS })
    await start($, clock)
    await prompt($, clock)
    const { instance, owner } = minted(router)
    expect(owner).toMatch(V4)
    expect(instance).toMatch(V4)
    expect(nth(router.requests, 0)).toMatchObject({ event: 'session_start', instance_id: instance, owner_id: owner })
    expect(router.store.get('identities')).toEqual([[PROCESS, { instance, owner }]])
    for (const old of ['u-old', 'i-1']) expect(JSON.stringify(router.requests)).not.toContain(old)
    keptInStore(router, PROCESS)
  })

test('the store keeps the newest eight pairs, so a ninth process drops the oldest', CONFIGURED, async ($, on) => {
  const older = Array.from({ length: 8 }, (_, at) => [String(1000001 + at), { instance: `i-${at}`, owner: `u-${at}` }])
  const { clock, router } = processHost(on, INHERITED, { process: CHILD, store: { identities: older } })
  await start($, clock)
  const { instance, owner } = minted(router)
  expect(router.store.get('identities')).toEqual([...older.slice(1), [CHILD, { instance, owner }]])
})

test('a host that runs no command mints as a child process does and leaves the store alone', CONFIGURED,
  async ($, on) => {
    const { clock, router } = processHost(on, INHERITED, { store: { identities: [[PROCESS, HELD]] } })
    await start($, clock)
    const { instance, owner } = minted(router)
    expect(owner).toMatch(V4)
    expect(instance).toMatch(V4)
    expect(router.store.get('identities')).toEqual([[PROCESS, HELD]])
    expect(router.logs).toEqual([])
  })

describe('the owner id is never sent on any event but session_start', () => {
  for (const [name, log] of Object.entries(LOGS)) {
    test(name, CONFIGURED, async ($, on) => {
      mock.env(on, { ANTHROPIC_AUTH_TOKEN: KEY })
      const clock = mock.clock(on)
      const router = fakeRouter(on, clock)
      await replay($, on, log, clock, router)
      const { owner } = minted(router)
      expect(registrations(router).length).toBeGreaterThan(0)
      for (const body of router.requests) {
        if (body.event === 'session_start') expect(body.owner_id).toBe(owner)
        else expect(JSON.stringify(body)).not.toContain(owner)
      }
    })
  }
})

test('the owner id reaches no log line and no header of the mod\'s own requests', CONFIGURED, async ($, on) => {
  mock.env(on, { ANTHROPIC_AUTH_TOKEN: KEY })
  const clock = mock.clock(on)
  const router = fakeRouter(on, clock)
  router.answer(() => ({ status: 409, body: { code: 'instance_conflict' } }))
  await replay($, on, runB, clock, router)
  router.setId('session-z')
  router.answer(() => ({ status: 401 }))
  await prompt($, clock)
  const { owner } = minted(router)
  // The recorded client is 2.1.287, so the start writes the debug line that stands in for the allowance tool.
  expect(router.logs.map((line) => line.to)).toEqual(['debug', 'transcript', 'debug'])
  expect(JSON.stringify(router.logs)).not.toContain(owner)
  expect(JSON.stringify(router.headers)).not.toContain(owner)
  expect(JSON.stringify(router.targets)).not.toContain(owner)
})

test('the owner line is read and replaced whatever the case of its name, and every other line stays', () => {
  expect(ownerOf(undefined)).toBeUndefined()
  expect(ownerOf('X-A: 1')).toBeUndefined()
  expect(ownerOf('X-A: 1\r\nx-keepalive-owner-id:  u-1 \nX-B: 2')).toBe('u-1')
  // Two owner lines leave the relay's reading unclear, so neither is evidence.
  expect(ownerOf('X-Keepalive-Owner-Id: u-1\nX-Keepalive-Owner-Id: u-2')).toBeUndefined()
  expect(ownerOf('X-Keepalive-Owner-Id: ')).toBeUndefined()
  expect(ownerHeaderLines(undefined, 'u-1')).toBe('X-Keepalive-Owner-Id: u-1')
  expect(ownerHeaderLines('', 'u-1')).toBe('X-Keepalive-Owner-Id: u-1')
  expect(ownerHeaderLines('X-A: 1\n\nx-keepalive-owner-id: u-0\r\nX-B: b:c\n', 'u-1'))
    .toBe('X-A: 1\nX-B: b:c\nX-Keepalive-Owner-Id: u-1')
})

test('the held identity is reused only when it names both the variable and the header\'s owner', () => {
  expect(reusable(HELD, 'i-1', 'u-old')).toBe(true)
  expect(reusable(HELD, undefined, 'u-old')).toBe(false)
  expect(reusable(HELD, 'i-1', undefined)).toBe(false)
  expect(reusable(HELD, 'i-2', 'u-old')).toBe(false)
  expect(reusable(HELD, 'i-1', 'u-new')).toBe(false)
})

test('the next sequence is the clock or one past the previous, whichever is higher', () => {
  expect(nextSequence(0, RELOAD_AT)).toBe(RELOAD_AT)
  expect(nextSequence(RELOAD_AT, RELOAD_AT)).toBe(RELOAD_AT + 1)
  expect(nextSequence(RELOAD_AT + 5, RELOAD_AT + 2)).toBe(RELOAD_AT + 6)
  expect(nextSequence(RELOAD_AT, RELOAD_AT + 2000)).toBe(RELOAD_AT + 2000)
})
