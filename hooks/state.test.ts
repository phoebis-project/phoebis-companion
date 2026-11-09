import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { SavedTask } from '../types/index.d.ts'
import runA from './fixtures/run-a.ts'
import runB from './fixtures/run-b.ts'
import runC from './fixtures/run-c.ts'
import runE from './fixtures/run-e.ts'
import runH from './fixtures/run-h.ts'
import { commandDeadline, isRealPrompt, nextFireAt, parkOf } from './rules.ts'
import type { AgentRecord, Body, Cron } from './rules.ts'
import { fakeRouter, LEASE_MS, replay } from './testing.ts'
import type { FakeRouter, Reply } from './testing.ts'

const CONFIGURED = { options: { management_url: 'http://127.0.0.1:1' } }
const KEY = 'k-test'
const T0 = 1_790_000_000_000
const LOGS = { 'run-a': runA, 'run-b': runB, 'run-c': runC, 'run-e': runE, 'run-h': runH }
const SUBAGENT = 'a79c058078a9c7b86'

// Every origin the 2.1.292 declarations name for a submitted prompt.
const ORIGINS = [
  'auto-continuation', 'bridge', 'channel', 'composer', 'coordinator', 'observer', 'observer-activity', 'peer',
  'peer-send-message', 'plugin', 'projects-relay', 'scheduled-trigger', 'sdk', 'slack-ping', 'task-notification',
  'unclassified',
]

const ok = (body: unknown): Reply => ({ status: 200, body })

// A local time in October 2026, where the 14th is a Wednesday, since a cron expression reads local time.
function local(day: number, hour: number, minute: number, second = 0): number {
  return new Date(2026, 9, day, hour, minute, second).getTime()
}

function host(on: On, now = T0, variables: Record<string, string> = {}): { clock: MockClock; router: FakeRouter } {
  mock.env(on, { ANTHROPIC_AUTH_TOKEN: KEY, ...variables })
  const clock = mock.clock(on, { now })
  return { clock, router: fakeRouter(on, clock, { id: 'session-a' }) }
}

function replayHost(on: On): { clock: MockClock; router: FakeRouter } {
  mock.env(on, { ANTHROPIC_AUTH_TOKEN: KEY })
  const clock = mock.clock(on)
  return { clock, router: fakeRouter(on, clock) }
}

function lines(log: string, from: number, to?: number): string {
  return log.split('\n').slice(from, to).join('\n')
}

async function start($: Engine, clock: MockClock): Promise<void> {
  await $.session.start({ cwd: '/tmp/probe-ws', surface: 'terminal', isInteractive: true })
  await clock.settle()
}

async function submit($: Engine, clock: MockClock, kind: string, text = 'hi', turnId?: string): Promise<void> {
  await $.prompt.submit({
    text,
    origin: { kind } as { kind: 'composer' },
    wait: false,
    ...(turnId === undefined ? {} : { turnId }),
  })
  await clock.settle()
}

// The test's `$` declares no `prompt.edit`, but the kit raises it as the engine does.
async function edit($: Engine, clock: MockClock): Promise<void> {
  const prompt = ($ as unknown as { prompt: { edit: (e: unknown) => Promise<unknown> } }).prompt
  await prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'a' })
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

let calls = 0

// A tool call the recorded logs lack, answered by the host with the result the tool declares.
async function call($: Engine, clock: MockClock, router: FakeRouter, input: Record<string, unknown>,
  result: unknown): Promise<void> {
  calls += 1
  router.answerTool(() => result)
  await $.tool.call({ tool_use_id: `toolu_${calls}`, ...input } as Parameters<Engine['tool']['call']>[0])
  await clock.settle()
}

async function spawn($: Engine, clock: MockClock, parentAgentId?: string): Promise<void> {
  await $.agent.spawn({
    prompt: '',
    description: '',
    subagentType: 'Explore',
    ...(parentAgentId === undefined ? {} : { parentAgentId }),
  } as Parameters<Engine['agent']['spawn']>[0])
  await clock.settle()
}

function bash(task: string, timeout?: number): [Record<string, unknown>, unknown] {
  const input: Record<string, unknown> = { tool: 'Bash', command: 'sleep 600', run_in_background: true }
  if (timeout !== undefined) input.timeout = timeout
  return [input, { stdout: '', stderr: '', interrupted: false, backgroundTaskId: task }]
}

function notification(task: string, status?: string): string {
  const tail = status === undefined ? '' : `\n<status>${status}</status>`
  return `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>toolu_1</tool-use-id>${tail}\n` +
    '</task-notification>'
}

function said(body: Body): string {
  switch (body.event) {
    case 'activity':
      return `activity ${body.agent_id} ${body.kind}`
    case 'agent_start':
      return `agent_start ${body.agent_id}`
    case 'state':
      return ['state', body.agent_id, body.state, body.park_kind, body.wake_at, body.deadline]
        .filter((part) => part !== undefined).join(' ')
    default:
      return body.event
  }
}

// Every body but the heartbeats, whose times the lease sets rather than the agents.
function told(router: FakeRouter): string[] {
  return router.requests.filter((body) => body.event !== 'heartbeat').map(said)
}

function states(router: FakeRouter): string[] {
  return router.requests.filter((body) => body.event === 'state').map(said)
}

function record(open: SavedTask[]): AgentRecord {
  return { id: 'main', state: 'idle', open: new Map(open.map((task) => [task.id, task])), lastPresence: 0 }
}

function cron(id: string, wakeAt: number): Cron {
  return { id, wakeAt, recurring: true, expression: '* * * * *', createdAt: T0 }
}

test('run-h: a background command parks main with its deadline, and the stop after its notification turn closes it',
  CONFIGURED, async ($, on) => {
    const { clock, router } = replayHost(on)
    await replay($, on, lines(runH, 0, 44), clock, router)
    expect(told(router)).toEqual([
      'session_start',
      'activity main prompt',
      `state main parked background ${1790937877955 + 1800000}`,
    ])
    // The notification's turn ends with a stop whose registry no longer runs the command.
    await replay($, on, lines(runH, 44, 59), clock, router)
    expect(told(router).slice(3)).toEqual(['state main busy', 'state main idle'])
  })

test('run-h: a subagent starts under main, main parks on it without a deadline, and its turn end releases it',
  CONFIGURED, async ($, on) => {
    const { clock, router } = replayHost(on)
    await replay($, on, lines(runH, 0, 59), clock, router)
    const before = told(router).length
    await replay($, on, lines(runH, 59, 79), clock, router)
    expect(told(router).slice(before)).toEqual(['activity main prompt', `agent_start ${SUBAGENT}`])
    await replay($, on, lines(runH, 79, 97), clock, router)
    expect(told(router).slice(before + 2)).toEqual(['state main parked background'])
    await replay($, on, lines(runH, 97, 104), clock, router)
    expect(told(router).slice(before + 3)).toEqual([`state ${SUBAGENT} released`, 'state main idle'])
    await replay($, on, lines(runH, 104, 115), clock, router)
    expect(told(router).slice(before + 5)).toEqual(['state main busy', 'state main idle'])
  })

test('run-a: a non interactive run reports both tasks, the subagent and its end', CONFIGURED, async ($, on) => {
  const { clock, router } = replayHost(on)
  await replay($, on, runA, clock, router)
  const parked = `state main parked background ${1790937871788 + 1800000}`
  expect(told(router)).toEqual([
    'session_start',
    'activity main prompt',
    'agent_start a7596ead013ce1281',
    'state a7596ead013ce1281 released',
    parked,
    'state main busy',
    'state main idle',
    'state main busy',
    'state main idle',
    'session_end',
  ])
})

describe('run-b and run-e: a clear and a resume reset the model under the new id', () => {
  const runs = {
    'run-b': [runB, 29, '1cad27fc-c749-448a-ad5b-e5fa5ae2dcbf', 'c35dc0d5-c915-4fd2-8606-fec71e0dad72',
      1790936485092 + 285000, 1790936485092 + 1800000],
    'run-e': [runE, 30, '3ccc7c43-d075-4181-977f-f4e0e178f298', '1cad27fc-c749-448a-ad5b-e5fa5ae2dcbf',
      1790937090521 + 285000, 1790937090521 + 1800000],
  } as const
  for (const [name, [log, at, first, next, wakeAt, deadline]] of Object.entries(runs)) {
    test(name, CONFIGURED, async ($, on) => {
      const { clock, router } = replayHost(on)
      await replay($, on, lines(log, 0, at), clock, router)
      // The first id leaves a cron and a background command open when it ends.
      await submit($, clock, 'composer')
      await call($, clock, router, { tool: 'CronCreate', cron: '*/5 * * * *', prompt: 'check' },
        { id: 'cron-1', humanSchedule: 'Every 5 minutes', recurring: true })
      await call($, clock, router, ...bash('bg-1'))
      await complete($, clock)
      await replay($, on, lines(log, at), clock, router)
      const under = (id: string): string[] =>
        router.requests.filter((body) => body.session_id === id && body.event === 'state').map(said)
      expect(under(first).at(-1)).toBe(`state main parked both ${wakeAt} ${deadline}`)
      expect(under(next)).toEqual(['state main idle'])
    })
  }
})

test('a cron parks main scheduled with the earliest wake and a deleted cron leaves', CONFIGURED, async ($, on) => {
  const at = local(14, 10, 0)
  const { clock, router } = host(on, at)
  await start($, clock)
  await submit($, clock, 'composer')
  await call($, clock, router, { tool: 'CronCreate', cron: '*/5 * * * *', prompt: 'check the build' },
    { id: 'cron-1', humanSchedule: 'Every 5 minutes', recurring: true })
  await call($, clock, router, { tool: 'ScheduleWakeup', delaySeconds: 90, reason: 'the build runs', prompt: 'go on' },
    { scheduledFor: at + 90000, clampedDelaySeconds: 90, wasClamped: false })
  await complete($, clock)
  await clock.advance(10000)
  await submit($, clock, 'composer')
  await call($, clock, router, { tool: 'CronDelete', id: 'cron-1' }, { id: 'cron-1' })
  await complete($, clock)
  await clock.advance(80000)
  await submit($, clock, 'scheduled-trigger', 'go on')
  expect(states(router)).toEqual([
    `state main parked scheduled ${at + 90000}`,
    `state main parked scheduled ${at + 90000}`,
    'state main idle',
  ])
})

test('a new wakeup replaces the pending one, and a wakeup with stop cancels it and leaves the crons', CONFIGURED,
  async ($, on) => {
  const at = local(14, 10, 0)
  const { clock, router } = host(on, at)
  await start($, clock)
  await submit($, clock, 'composer')
  await call($, clock, router, { tool: 'CronCreate', cron: '*/5 * * * *', prompt: 'check the build' },
    { id: 'cron-1', humanSchedule: 'Every 5 minutes', recurring: true })
  for (const delay of [90, 120]) {
    await call($, clock, router, { tool: 'ScheduleWakeup', delaySeconds: delay, reason: 'waiting', prompt: 'go on' },
      { scheduledFor: at + delay * 1000, clampedDelaySeconds: delay, wasClamped: false })
  }
  await complete($, clock)
  await submit($, clock, 'composer')
  await call($, clock, router, { tool: 'ScheduleWakeup', stop: true },
    { scheduledFor: at + 60000, clampedDelaySeconds: 60, wasClamped: false, stopped: true, cancelledWakeups: 2 })
  await complete($, clock)
  expect(states(router)).toEqual([
    `state main parked scheduled ${at + 120000}`,
    `state main parked scheduled ${local(14, 10, 4, 45)}`,
  ])
})

test('a five-minute cron fires every 285 seconds from its creation, as the client schedules it', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on, local(14, 10, 3))
    await start($, clock)
    await submit($, clock, 'composer')
    await call($, clock, router, { tool: 'CronCreate', cron: '*/5 * * * *', prompt: 'tick' },
      { id: '00000000', humanSchedule: 'Every 5 minutes', recurring: true })
    await complete($, clock)
    await clock.set(local(14, 10, 7, 45))
    await submit($, clock, 'scheduled-trigger', 'tick')
    // The client's scheduler fires on its next one-second check, and the next fire counts from that.
    await clock.set(local(14, 10, 12, 30) + 400)
    await submit($, clock, 'scheduled-trigger', 'tick')
    // A trigger read a moment before the computed time counts from that time, as the client's own fire does.
    await clock.set(local(14, 10, 17, 13) + 400)
    await submit($, clock, 'scheduled-trigger', 'tick')
    expect(states(router)).toEqual([
      `state main parked scheduled ${local(14, 10, 7, 45)}`,
      `state main parked scheduled ${local(14, 10, 12, 30)}`,
      `state main parked scheduled ${local(14, 10, 17, 15) + 400}`,
      `state main parked scheduled ${local(14, 10, 22) + 400}`,
    ])
  })

test('a recurring cron fires its grid time plus the delay its id gives, from the time it fired', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on, local(14, 10, 0))
    await start($, clock)
    await submit($, clock, 'composer')
    // An id of c0000000 spreads three quarters of half the hour, 22.5 minutes.
    await call($, clock, router, { tool: 'CronCreate', cron: '0 * * * *', prompt: 'hourly' },
      { id: 'c0000000', humanSchedule: 'Every hour', recurring: true })
    await complete($, clock)
    await clock.set(local(14, 11, 22, 30))
    await submit($, clock, 'scheduled-trigger', 'hourly')
    expect(states(router)).toEqual([
      `state main parked scheduled ${local(14, 11, 22, 30)}`,
      `state main parked scheduled ${local(14, 12, 22, 30)}`,
    ])
  })

test('a scheduled prompt a lower hook drops still advances its cron', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on, local(14, 10, 0))
  await start($, clock)
  await submit($, clock, 'composer')
  await call($, clock, router, { tool: 'CronCreate', cron: '0 * * * *', prompt: 'hourly' },
    { id: 'c0000000', humanSchedule: 'Every hour', recurring: true })
  await complete($, clock)
  await clock.set(local(14, 11, 22, 30))
  router.answerSubmit(() => ({ drop: 'no' }))
  await submit($, clock, 'scheduled-trigger', 'hourly')
  expect(states(router)).toEqual([
    `state main parked scheduled ${local(14, 11, 22, 30)}`,
    `state main parked scheduled ${local(14, 12, 22, 30)}`,
  ])
})

test('an every-minute cron advances a minute per fire, and a trigger between fires leaves it', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on, local(14, 9, 59, 30))
    await start($, clock)
    await submit($, clock, 'composer')
    // An id of 40000000 spreads a quarter of half the minute, 7.5 seconds.
    await call($, clock, router, { tool: 'CronCreate', cron: '* * * * *', prompt: 'tick' },
      { id: '40000000', humanSchedule: 'Every minute', recurring: true })
    await complete($, clock)
    await clock.set(local(14, 10, 0, 7) + 500)
    await submit($, clock, 'scheduled-trigger', 'tick')
    await clock.set(local(14, 10, 0, 40))
    await submit($, clock, 'scheduled-trigger', 'other')
    await clock.set(local(14, 10, 1, 7) + 500)
    await submit($, clock, 'scheduled-trigger', 'tick')
    expect(states(router)).toEqual([
      `state main parked scheduled ${local(14, 10, 0, 7) + 500}`,
      `state main parked scheduled ${local(14, 10, 1, 7) + 500}`,
      `state main parked scheduled ${local(14, 10, 2, 7) + 500}`,
    ])
  })

test('a one-shot on a half hour fires its early time, any other one-shot its own, each counted within five seconds',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on, local(14, 10, 0))
    await start($, clock)
    await submit($, clock, 'composer')
    // An id of 80000000 brings a half-hour one-shot forward by half of 90 seconds.
    await call($, clock, router, { tool: 'CronCreate', cron: '30 10 * * *', prompt: 'once', recurring: false },
      { id: '80000000', humanSchedule: 'At 10:30 AM', recurring: false })
    await call($, clock, router, { tool: 'CronCreate', cron: '45 10 * * *', prompt: 'later', recurring: false },
      { id: '80000001', humanSchedule: 'At 10:45 AM', recurring: false })
    await complete($, clock)
    await clock.set(local(14, 10, 29, 9) + 999)
    await submit($, clock, 'scheduled-trigger', 'once')
    expect(states(router)).toEqual([`state main parked scheduled ${local(14, 10, 29, 15)}`])
    await clock.set(local(14, 10, 29, 10))
    await submit($, clock, 'scheduled-trigger', 'once')
    await clock.set(local(14, 10, 45))
    await submit($, clock, 'scheduled-trigger', 'later')
    expect(states(router)).toEqual([
      `state main parked scheduled ${local(14, 10, 29, 15)}`,
      `state main parked scheduled ${local(14, 10, 45)}`,
      'state main idle',
    ])
  })

test('a wakeup on a half hour counts a trigger from the first time the client may fire it', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on, local(14, 10, 28, 10))
    await start($, clock)
    await submit($, clock, 'composer')
    // Ninety seconds from 10:28:10 rounds up to 10:30, and the client may fire it from 10:29:40 on.
    await call($, clock, router, { tool: 'ScheduleWakeup', delaySeconds: 90, reason: 'waiting', prompt: 'go on' },
      { scheduledFor: local(14, 10, 30), clampedDelaySeconds: 90, wasClamped: false })
    await complete($, clock)
    await clock.set(local(14, 10, 29, 34) + 999)
    await submit($, clock, 'scheduled-trigger', 'other')
    await clock.set(local(14, 10, 29, 41))
    await submit($, clock, 'scheduled-trigger', 'go on')
    expect(states(router)).toEqual([`state main parked scheduled ${local(14, 10, 30)}`, 'state main idle'])
    const idle = router.requests.findIndex((body) => said(body) === 'state main idle')
    expect(router.times[idle]).toBe(local(14, 10, 29, 41))
  })

test('nextFireAt mirrors the client\'s scheduler for each kind of cron', () => {
  const now = local(14, 10, 3)
  expect(nextFireAt('*/5 * * * *', now, '00000000', true)).toBe(local(14, 10, 7, 45))
  expect(nextFireAt('*/5 * * * *', now, 'ffffffff', true)).toBe(local(14, 10, 7, 45))
  expect(nextFireAt('*/10 * * * *', now, '00000000', true)).toBe(local(14, 10, 10))
  expect(nextFireAt('*/10 * * * *', now, '80000000', true)).toBe(local(14, 10, 12, 30))
  expect(nextFireAt('0 * * * *', now, 'c0000000', true)).toBe(local(14, 11, 22, 30))
  // The delay stops at thirty minutes, and an id that is no hexadecimal number gives none.
  expect(nextFireAt('0 9 * * *', now, '80000000', true)).toBe(local(15, 9, 30))
  expect(nextFireAt('0 9 * * *', now, 'zz-cron', true)).toBe(local(15, 9, 0))
  // A one-shot fires no earlier than its creation.
  expect(nextFireAt('30 10 * * *', now, '80000000', false)).toBe(local(14, 10, 29, 15))
  expect(nextFireAt('30 10 * * *', local(14, 10, 29, 50), 'ffffffff', false)).toBe(local(14, 10, 29, 50))
  expect(nextFireAt('45 10 * * *', now, 'ffffffff', false)).toBe(local(14, 10, 45))
  // The search is bounded by the client's own walk, a leap year of minutes, so a fire months away is found.
  expect(nextFireAt('0 9 1 1 *', now, '00000000', true)).toBe(new Date(2027, 0, 1, 9, 0).getTime())
  expect(nextFireAt('0 9 * * MON', now, '00000000', true)).toBeUndefined()
})

test('the park kinds compose: background, scheduled, both and idle, and the deadline is sent only when every open ' +
  'task is a command', () => {
  const early: SavedTask = { id: 'bg-early', kind: 'command', deadline: T0 + 1000 }
  const late: SavedTask = { id: 'bg-late', kind: 'command', deadline: T0 + 5000 }
  const child: SavedTask = { id: 'agent-1', kind: 'subagent' }
  expect(parkOf(record([]), [])).toEqual({ state: 'idle' })
  expect(parkOf(record([early, late]), []))
    .toEqual({ state: 'parked', park_kind: 'background', deadline: T0 + 5000 })
  expect(parkOf(record([early, child]), [])).toEqual({ state: 'parked', park_kind: 'background' })
  expect(parkOf(record([child]), [])).toEqual({ state: 'parked', park_kind: 'background' })
  expect(parkOf(record([]), [cron('c-1', T0 + 9000), cron('c-2', T0 + 3000)]))
    .toEqual({ state: 'parked', park_kind: 'scheduled', wake_at: T0 + 3000 })
  expect(parkOf(record([late]), [cron('c-1', T0 + 9000)]))
    .toEqual({ state: 'parked', park_kind: 'both', wake_at: T0 + 9000, deadline: T0 + 5000 })
  expect(parkOf(record([late, child]), [cron('c-1', T0 + 9000)]))
    .toEqual({ state: 'parked', park_kind: 'both', wake_at: T0 + 9000 })
})

test('a command\'s deadline is its start plus its timeout or a default of at least thirty minutes, capped at two ' +
  'hours or more, and the variables only raise the bounds', () => {
  expect(commandDeadline(T0, undefined, {})).toBe(T0 + 1800000)
  expect(commandDeadline(T0, undefined, { defaultMs: 90000 })).toBe(T0 + 1800000)
  expect(commandDeadline(T0, undefined, { defaultMs: 3600000 })).toBe(T0 + 3600000)
  expect(commandDeadline(T0, undefined, { defaultMs: 9000000 })).toBe(T0 + 9000000)
  expect(commandDeadline(T0, undefined, { maxMs: 60000 })).toBe(T0 + 1800000)
  expect(commandDeadline(T0, 9000000, {})).toBe(T0 + 7200000)
  expect(commandDeadline(T0, 9000000, { maxMs: 60000 })).toBe(T0 + 7200000)
  expect(commandDeadline(T0, 9000000, { maxMs: 10800000 })).toBe(T0 + 9000000)
  expect(commandDeadline(T0, 120000, { defaultMs: 90000, maxMs: 3600000 })).toBe(T0 + 120000)
  expect(commandDeadline(T0, 3000000000, { maxMs: 3000000000 })).toBe(T0 + 2147483647)
})

test('a fractional timeout rounds the command\'s deadline up to a whole millisecond, so the router takes the park',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    await call($, clock, router, ...bash('bg-1', 90000.25))
    await complete($, clock)
    expect(states(router)).toEqual([`state main parked background ${T0 + 90001}`])
    expect(router.refusals).toEqual([])
  })

describe('BASH_DEFAULT_TIMEOUT_MS and BASH_MAX_TIMEOUT_MS read at session start raise a background command\'s ' +
  'deadline and never lower it', () => {
    const loads = [
      ['unset', {}, T0 + 1800000, T0 + 7200000],
      ['ninety seconds and an hour', { BASH_DEFAULT_TIMEOUT_MS: '90000', BASH_MAX_TIMEOUT_MS: '3600000' },
        T0 + 1800000, T0 + 7200000],
      ['a default of two and a half hours', { BASH_DEFAULT_TIMEOUT_MS: '9000000' }, T0 + 9000000, T0 + 9000000],
      ['not a positive number', { BASH_DEFAULT_TIMEOUT_MS: 'soon', BASH_MAX_TIMEOUT_MS: '0' }, T0 + 1800000,
        T0 + 7200000],
    ] as const
    for (const [name, variables, first, second] of loads) {
      test(name, CONFIGURED, async ($, on) => {
        const { clock, router } = host(on, T0, variables)
        await start($, clock)
        await submit($, clock, 'composer')
        await call($, clock, router, ...bash('bg-1'))
        await complete($, clock)
        await submit($, clock, 'composer')
        await call($, clock, router, ...bash('bg-2', 9000000))
        await complete($, clock)
        expect(states(router)).toEqual([
          `state main parked background ${first}`,
          `state main parked background ${second}`,
        ])
      })
    }
  })

test('nextFireAt reads a five field expression in local time and answers nothing for one that never fires', () => {
  const now = local(14, 10, 0)
  expect(nextFireAt('0 9 * * 1', now, '00000000', false)).toBe(local(19, 9, 0))
  expect(nextFireAt('*/15 * * * *', now, '00000000', false)).toBe(local(14, 10, 15))
  expect(nextFireAt('*/15 * * * *', local(14, 10, 7, 30), '00000000', false)).toBe(local(14, 10, 15))
  expect(nextFireAt('* * * * *', now, '00000000', false)).toBe(local(14, 10, 1))
  expect(nextFireAt('* * * * *', local(14, 9, 59, 30), '00000000', false)).toBe(now)
  expect(nextFireAt('0 0 31 2 *', now, '00000000', false)).toBeUndefined()
  // Lists, ranges with steps, Sunday as 7, and a day of month or a day of week when both are given.
  expect(nextFireAt('30 14 1-3,20 * *', now, '00000000', false)).toBe(local(20, 14, 30))
  expect(nextFireAt('0 9-17/4 * * *', now, '00000000', false)).toBe(local(14, 13, 0))
  expect(nextFireAt('0 12 * * 7', now, '00000000', false)).toBe(local(18, 12, 0))
  expect(nextFireAt('0 12 16 * 1', now, '00000000', false)).toBe(local(16, 12, 0))
  expect(nextFireAt('0 12 20 * 1', now, '00000000', false)).toBe(local(19, 12, 0))
  // A fire months away is found, as the client's bounded walk finds it. A field out of range, a name and a short
  // expression answer nothing.
  expect(nextFireAt('0 9 1 1 *', now, '00000000', false)).toBe(new Date(2027, 0, 1, 9, 0).getTime())
  expect(nextFireAt('60 * * * *', now, '00000000', false)).toBeUndefined()
  expect(nextFireAt('0 9 * * MON', now, '00000000', false)).toBeUndefined()
  expect(nextFireAt('* * * *', now, '00000000', false)).toBeUndefined()
})

test('a stop event\'s task registry closes the commands it no longer runs wherever they are open, and a subagent ' +
  'with nothing left is released', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  await submit($, clock, 'composer')
  await spawn($, clock)
  await spawn($, clock)
  // Each subagent's own background commands, which its loop's tool calls carry.
  await call($, clock, router, { ...bash('bg-3', 60000)[0], agentId: 'agent-1' }, bash('bg-3')[1])
  await call($, clock, router, { ...bash('bg-4', 90000)[0], agentId: 'agent-2' }, bash('bg-4')[1])
  router.setAgents([{ id: 'agent-1', status: 'waiting' }, { id: 'agent-2', status: 'waiting' }])
  await complete($, clock, 'agent-1')
  await complete($, clock, 'agent-2')
  await call($, clock, router, ...bash('bg-1', 120000))
  await call($, clock, router, ...bash('bg-2', 180000))
  await complete($, clock)
  const settled = told(router).length
  // Each stop event's registry names what still runs, main's and a subagent's alike. A subagent whose last command
  // ended has nothing left of its own, so it is released.
  const live = (ids: string[]) => ids.map((id) => ({ id, type: 'shell', status: 'running' }))
  await stop($, clock, live(['bg-4', 'bg-1', 'bg-2']))
  await stop($, clock, live(['bg-1', 'bg-2']), 'agent-2')
  await stop($, clock, live(['bg-1']))
  await stop($, clock, [])
  expect(told(router).slice(settled - 3)).toEqual([
    `state agent-1 parked background ${T0 + 60000}`,
    `state agent-2 parked background ${T0 + 90000}`,
    'state main parked background',
    'state agent-1 released',
    'state agent-2 released',
    `state main parked background ${T0 + 180000}`,
    `state main parked background ${T0 + 120000}`,
    'state main idle',
  ])
})

// A stop event of main or of a subagent, with the task registry the client attaches to it.
async function stop($: Engine, clock: MockClock, tasks: { id: string; type: string; status: string }[],
  agentId?: string): Promise<void> {
  const classic = ($ as unknown as { classic: Record<string, (input: unknown) => Promise<unknown>> }).classic
  const payload = { background_tasks: tasks, session_crons: [] }
  if (agentId === undefined) await classic.Stop?.(payload)
  else await classic.SubagentStop?.({ agent_id: agentId, ...payload })
  await clock.settle()
}

test('a subagent parked on its own command stays parked through a notification naming it, and a stop whose task ' +
  'list no longer runs the command releases it', CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    await spawn($, clock)
    await call($, clock, router, { ...bash('bg-3', 60000)[0], agentId: 'agent-1' }, bash('bg-3')[1])
    router.setAgents([{ id: 'agent-1', status: 'waiting' }])
    await complete($, clock, 'agent-1')
    const settled = told(router).length
    // The client notifies the parent at once when a subagent stops with background work of its own, and the mod
    // reads nothing from that text: the subagent stays parked on its command.
    await submit($, clock, 'task-notification', notification('agent-1', 'completed'))
    await stop($, clock, [{ id: 'bg-3', type: 'shell', status: 'running' }, { id: 'agent-1', type: 'subagent', status: 'running' }])
    await complete($, clock)
    expect(told(router).slice(settled)).toEqual(['state main parked background'])
    // The next stop event's registry no longer runs the command, so the subagent has nothing open and is released.
    await stop($, clock, [{ id: 'agent-1', type: 'subagent', status: 'running' }])
    expect(told(router).slice(settled)).toEqual(['state main parked background', 'state agent-1 released', 'state main idle'])
  })

test('a subagent\'s own child joins its open set, it parks on it at its turn end, and the child\'s end releases it',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    await spawn($, clock)
    await spawn($, clock, 'agent-1')
    router.setAgents([{ id: 'agent-1', status: 'waiting' }, { id: 'agent-2', status: 'running', parentId: 'agent-1' }])
    await complete($, clock, 'agent-1')
    await complete($, clock)
    router.setAgents([
      { id: 'agent-1', status: 'waiting' },
      { id: 'agent-2', status: 'completed', parentId: 'agent-1' },
    ])
    await complete($, clock, 'agent-2')
    expect(told(router).slice(2)).toEqual([
      'agent_start agent-1',
      'agent_start agent-2',
      'state agent-1 parked background',
      'state main parked background',
      'state agent-2 released',
      'state agent-1 released',
      'state main idle',
    ])
  })

test('the heartbeat reconcile releases a subagent the list reads completed, failed, killed or absent and closes a ' +
  'command past its deadline', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  await submit($, clock, 'composer')
  await call($, clock, router, ...bash('bg-1', 60000))
  for (let spawned = 0; spawned < 4; spawned += 1) await spawn($, clock)
  await complete($, clock)
  router.setAgents([
    { id: 'agent-1', status: 'completed' },
    { id: 'agent-2', status: 'failed' },
    { id: 'agent-3', status: 'killed' },
  ])
  const settled = told(router).length
  await clock.advance(25000)
  expect(told(router).slice(settled)).toEqual([
    'state agent-1 released',
    'state agent-2 released',
    'state agent-3 released',
    'state agent-4 released',
    `state main parked background ${T0 + 60000}`,
  ])
  await clock.advance(25000)
  expect(told(router).slice(settled + 5)).toEqual([])
  await clock.advance(25000)
  expect(told(router).slice(settled + 5)).toEqual(['state main idle'])
  const idle = router.requests.findIndex((body) => said(body) === 'state main idle')
  expect(router.times[idle]).toBe(T0 + 75000)
})

test('a recurring cron leaves after the fire at which it is seven days old, as the client removes it, and no ' +
  'heartbeat drops it sooner', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on, local(14, 10, 30))
  await start($, clock)
  await submit($, clock, 'composer')
  await call($, clock, router, { tool: 'CronCreate', cron: '0 10 * * *', prompt: 'daily' },
    { id: '00000000', humanSchedule: 'Every day at 10:00 AM', recurring: true })
  await complete($, clock)
  // The first heartbeat is dropped, so no timer runs while the week passes.
  router.answer(() => ({ status: 400, body: { code: 'invalid_event' } }))
  await clock.advance(25000)
  for (let day = 15; day <= 21; day += 1) {
    await clock.set(local(day, 10, 0))
    await submit($, clock, 'scheduled-trigger', 'daily')
  }
  // Seven days after its creation, between fires: a presence finds the session gone, the registration's answer arms
  // the heartbeat again, and its reconcile leaves the cron for its final fire.
  await clock.set(local(21, 11, 0))
  router.answer(() => ({ status: 409, body: { code: 'unknown_instance' } }))
  await edit($, clock)
  await clock.advance(25000)
  await clock.set(local(22, 10, 0))
  await submit($, clock, 'scheduled-trigger', 'daily')
  const parkedOn = (day: number): string => `state main parked scheduled ${local(day, 10, 0)}`
  expect(states(router)).toEqual([
    ...[15, 16, 17, 18, 19, 20, 21, 22].map(parkedOn),
    parkedOn(22),
    'state main idle',
  ])
  const idle = router.requests.findIndex((body) => said(body) === 'state main idle')
  expect(router.times[idle]).toBe(local(22, 10, 0))
})

test('a one-shot due in nine days parks main until it fires, past any age limit', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on, local(14, 10, 0))
  await start($, clock)
  await submit($, clock, 'composer')
  await call($, clock, router, { tool: 'CronCreate', cron: '0 10 23 * *', prompt: 'once', recurring: false },
    { id: '00000000', humanSchedule: 'At 10:00 AM on the 23rd', recurring: false })
  await complete($, clock)
  const parked = `state main parked scheduled ${local(23, 10, 0)}`
  expect(states(router)).toEqual([parked])
  router.answer(() => ({ status: 400, body: { code: 'invalid_event' } }))
  await clock.advance(25000)
  // A week later the session is re-registered, and the heartbeat's reconcile keeps the one-shot.
  await clock.set(local(21, 12, 0))
  router.answer(() => ({ status: 409, body: { code: 'unknown_instance' } }))
  await edit($, clock)
  await clock.advance(25000)
  await clock.set(local(23, 10, 0))
  await submit($, clock, 'scheduled-trigger', 'once')
  expect(states(router)).toEqual([parked, parked, 'state main idle'])
  const idle = router.requests.findIndex((body) => said(body) === 'state main idle')
  expect(router.times[idle]).toBe(local(23, 10, 0))
})


test('the registration acknowledgment reconciles the mod\'s agents against the router\'s', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    await call($, clock, router, ...bash('bg-1'))
    await spawn($, clock)
    await complete($, clock)
    router.setAgents([
      { id: 'agent-1', status: 'running' },
      { id: 'y', status: 'running', parentId: 'agent-1' },
    ])
    // The heartbeat finds the session gone, and the registration answers with the router's view of it.
    router.answer(() => ({ status: 409, body: { code: 'unknown_instance' } }))
    router.answer((_body, ack) => ok({
      ...ack,
      agents: [
        { agent_id: 'main', state: 'idle', request_generation: 1 },
        { agent_id: 'x', state: 'busy', request_generation: 1 },
        { agent_id: 'y', state: 'idle', request_generation: 2 },
        { agent_id: 'z', state: 'released', request_generation: 1 },
      ],
    }))
    const settled = told(router).length
    await clock.advance(25000)
    expect(told(router).slice(settled)).toEqual([
      'session_start',
      'state main parked background',
      'state x released',
      'state y busy',
      'agent_start agent-1',
      'state agent-1 busy',
    ])
    expect(router.requests.find((body) => said(body) === 'state y busy')?.request_generation).toBe(2)
    // The rebuilt agent is busy in the mod, so its next step reports nothing.
    await step($, clock, 'y')
    expect(told(router).slice(settled + 6)).toEqual([])
  })

test('a registration answer with a stale park is corrected by a state report', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  await submit($, clock, 'composer')
  await call($, clock, router, ...bash('bg-1'))
  await complete($, clock)
  router.answer(() => ({ status: 409, body: { code: 'unknown_instance' } }))
  router.answer((_body, ack) => ok({
    ...ack,
    agents: [
      { agent_id: 'main', state: 'parked', park_kind: 'background', deadline: T0 + 1740000, request_generation: 1 },
    ],
  }))
  const settled = told(router).length
  await clock.advance(25000)
  expect(told(router).slice(settled)).toEqual(['session_start', `state main parked background ${T0 + 1800000}`])
})

test('a registration answer with the same park sends nothing', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  await submit($, clock, 'composer')
  await call($, clock, router, ...bash('bg-1'))
  await complete($, clock)
  router.answer(() => ({ status: 409, body: { code: 'unknown_instance' } }))
  router.answer((_body, ack) => ok({
    ...ack,
    agents: [
      { agent_id: 'main', state: 'parked', park_kind: 'background', deadline: T0 + 1800000, request_generation: 1 },
    ],
  }))
  const settled = told(router).length
  await clock.advance(25000)
  expect(told(router).slice(settled)).toEqual(['session_start'])
})

test('a registration answer that parks main with no park is corrected by a state report', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  await submit($, clock, 'composer')
  await call($, clock, router, ...bash('bg-1'))
  await complete($, clock)
  router.answer(() => ({ status: 409, body: { code: 'unknown_instance' } }))
  router.answer((_body, ack) => ok({ ...ack, agents: [{ agent_id: 'main', state: 'parked', request_generation: 1 }] }))
  const settled = told(router).length
  await clock.advance(25000)
  expect(told(router).slice(settled)).toEqual(['session_start', `state main parked background ${T0 + 1800000}`])
})

test('a registration answer with the same scheduled park sends nothing', CONFIGURED, async ($, on) => {
  const at = local(14, 10, 0)
  const { clock, router } = host(on, at)
  await start($, clock)
  await submit($, clock, 'composer')
  await call($, clock, router, { tool: 'ScheduleWakeup', delaySeconds: 90, reason: 'the build runs', prompt: 'go on' },
    { scheduledFor: at + 90000, clampedDelaySeconds: 90, wasClamped: false })
  await complete($, clock)
  router.answer(() => ({ status: 409, body: { code: 'unknown_instance' } }))
  router.answer((_body, ack) => ok({
    ...ack,
    agents: [{ agent_id: 'main', state: 'parked', park_kind: 'scheduled', wake_at: at + 90000, request_generation: 1 }],
  }))
  const settled = told(router).length
  await clock.advance(25000)
  expect(told(router).slice(settled)).toEqual(['session_start'])
})

test('an answer that omits a parked subagent the router last named released leaves it unannounced until its next ' +
  'turn', CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await releasedByRouter($, clock, router)
    const settled = told(router).length
    // The released record left the engine since, so the next registration's answer omits it.
    router.answer(() => ({ status: 409, body: { code: 'unknown_instance' } }))
    router.answer((_body, ack) => ok({
      ...ack,
      agents: [{ agent_id: 'main', state: 'parked', park_kind: 'background', request_generation: 1 }],
    }))
    await clock.advance(25000)
    expect(told(router).slice(settled)).toEqual(['session_start'])
    const saved = router.values.get('model') as { agents: { id: string }[] }
    expect(saved.agents.find((agent) => agent.id === 'main')).toEqual({
      id: 'main', state: 'parked', open: [{ id: 'agent-1', kind: 'subagent' }], lastPresence: 0,
    })
    await step($, clock, 'agent-1')
    expect(told(router).slice(settled + 1)).toEqual(['agent_start agent-1', 'state agent-1 busy'])
  })

test('a start the router accepts after an answer named the subagent released again leaves it out of what the router ' +
  'last named released, so the end of that run sends its release', CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await releasedByRouter($, clock, router)
    const settled = told(router).length
    // The router restarted while the subagent's next start was out, and the registration that follows still names it
    // released, so the start goes out behind that answer.
    router.answer(() => ({ status: 409, body: { code: 'unknown_instance' } }))
    router.answer((_body, ack) => ok({
      ...ack,
      agents: [
        { agent_id: 'main', state: 'parked', park_kind: 'background', request_generation: 1 },
        { agent_id: 'agent-1', state: 'released', request_generation: 2 },
      ],
    }))
    await step($, clock, 'agent-1')
    await complete($, clock, 'agent-1')
    // The next stop event's registry no longer runs the subagent's command, so the run the router took ends.
    await stop($, clock, [{ id: 'agent-1', type: 'subagent', status: 'running' }])
    expect(told(router).slice(settled)).toEqual([
      'agent_start agent-1',
      'session_start',
      'agent_start agent-1',
      'state agent-1 busy',
      `state agent-1 parked background ${T0 + 1800000}`,
      'state agent-1 released',
      'state main idle',
    ])
    expect(router.values.get('model')).toMatchObject({
      agents: [{ id: 'main', state: 'idle', open: [], lastPresence: 0 }],
      routerReleased: [],
    })
  })

test('an answer that names a subagent released while its start waits in the queue leaves it out of what the router ' +
  'last named released, so a release before that start goes out follows it', CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await releasedByRouter($, clock, router)
    const settled = told(router).length
    router.answer(() => ({ status: 409, body: { code: 'unknown_instance' } }))
    router.answer((_body, ack) => ok({
      ...ack,
      agents: [
        { agent_id: 'main', state: 'parked', request_generation: 1 },
        { agent_id: 'agent-1', state: 'released', request_generation: 2 },
      ],
    }))
    // The restored start meets a 503, so it waits out the backoff while the run ends.
    router.answer(() => ({ status: 503, body: { code: 'quiesced' } }))
    await step($, clock, 'agent-1')
    // The registry no longer runs the subagent's command while its turn runs, and the turn then ends with nothing open.
    await stop($, clock, [{ id: 'agent-1', type: 'subagent', status: 'running' }])
    await complete($, clock, 'agent-1')
    await clock.advance(1000)
    expect(told(router).slice(settled)).toEqual([
      'agent_start agent-1',
      'session_start',
      'agent_start agent-1',
      'agent_start agent-1',
      'state agent-1 released',
      'state main idle',
    ])
    expect(router.values.get('model')).toMatchObject({
      agents: [{ id: 'main', state: 'idle', open: [], lastPresence: 0 }],
      routerReleased: [],
    })
  })

test('a parked subagent that resumes while a registration is in flight stays out of what the router last named ' +
  'released, so its release before the recovery start is answered follows that start', CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    await spawn($, clock)
    await call($, clock, router, { ...bash('bg-3')[0], agentId: 'agent-1' }, bash('bg-3')[1])
    router.setAgents([{ id: 'agent-1', status: 'waiting' }])
    await complete($, clock, 'agent-1')
    await complete($, clock)
    const settled = told(router).length
    router.answer(() => ({ status: 409, body: { code: 'unknown_instance' } }))
    router.answer(async (_body, ack) => {
      await clock.sleep(2000)
      return ok({
        ...ack,
        agents: [
          { agent_id: 'main', state: 'parked', request_generation: 1 },
          { agent_id: 'agent-1', state: 'released', request_generation: 2 },
        ],
      })
    })
    await clock.advance(25000)
    // The run is still announced while the registration is out, so the resumed turn queues a busy state alone.
    await step($, clock, 'agent-1')
    // The refused heartbeat goes out again behind the registration. The released record left the engine since, so the
    // busy state meets unknown_agent, and the turn ends while the recovery start is out.
    router.answer((_body, ack) => ok(ack))
    router.answer(() => ({ status: 409, body: { code: 'unknown_agent' } }))
    router.answer(async (_body, ack) => {
      await clock.sleep(2000)
      return ok(ack)
    })
    await clock.advance(2000)
    await stop($, clock, [{ id: 'agent-1', type: 'subagent', status: 'running' }])
    await complete($, clock, 'agent-1')
    await clock.advance(2000)
    expect(told(router).slice(settled)).toEqual([
      'session_start',
      'state agent-1 busy',
      'agent_start agent-1',
      'state agent-1 released',
      'state main idle',
    ])
    expect(router.values.get('model')).toMatchObject({ routerReleased: [] })
  })

test('a busy state queued before a delayed registration answer keeps the subagent out of what the router last named ' +
  'released, so a release while the recovery start waits out its backoff follows that start', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    await spawn($, clock)
    await call($, clock, router, { ...bash('bg-3')[0], agentId: 'agent-1' }, bash('bg-3')[1])
    router.setAgents([{ id: 'agent-1', status: 'waiting' }])
    await complete($, clock, 'agent-1')
    await complete($, clock)
    const settled = told(router).length
    // The heartbeat's refusal is slow, so the resumed turn's busy state waits behind the registration it brings.
    router.answer(async () => {
      await clock.sleep(1000)
      return { status: 409, body: { code: 'unknown_instance' } }
    })
    router.answer(async (_body, ack) => {
      await clock.sleep(2000)
      return ok({
        ...ack,
        agents: [
          { agent_id: 'main', state: 'parked', request_generation: 1 },
          { agent_id: 'agent-1', state: 'released', request_generation: 2 },
        ],
      })
    })
    // The refused heartbeat goes out again behind the registration. The released record left the engine since, and
    // the recovery start meets a 503, so it waits out the backoff while the turn ends.
    router.answer((_body, ack) => ok(ack))
    router.answer(() => ({ status: 409, body: { code: 'unknown_agent' } }))
    router.answer(() => ({ status: 503, body: { code: 'quiesced' } }))
    await clock.advance(25000)
    await step($, clock, 'agent-1')
    await clock.advance(3000)
    await stop($, clock, [{ id: 'agent-1', type: 'subagent', status: 'running' }])
    await complete($, clock, 'agent-1')
    await clock.advance(1000)
    expect(told(router).slice(settled)).toEqual([
      'session_start',
      'state agent-1 busy',
      'agent_start agent-1',
      'agent_start agent-1',
      'state agent-1 released',
      'state main idle',
    ])
    expect(router.values.get('model')).toMatchObject({ routerReleased: [] })
  })

test('an acknowledgment that omits main restates main without announcing it', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  router.answer((_body, ack) => ok({ ...ack, agents: [] }))
  await start($, clock)
  expect(told(router)).toEqual(['session_start', 'state main busy'])
})

test('an agent the router holds and the client runs after a reload joins its parent\'s open set until it ends',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    // The registration of a reloaded module finds main parked on a child the earlier load announced.
    router.setAgents([{ id: 'agent-9', status: 'running' }])
    router.answer((_body, ack) => ok({
      ...ack,
      agents: [
        { agent_id: 'main', state: 'parked', request_generation: 1 },
        { agent_id: 'agent-9', state: 'busy', request_generation: 3 },
      ],
    }))
    await start($, clock)
    await complete($, clock)
    router.setAgents([{ id: 'agent-9', status: 'completed' }])
    await complete($, clock, 'agent-9')
    expect(told(router)).toEqual([
      'session_start',
      'state main busy',
      'state agent-9 busy',
      'state main parked background',
      'state agent-9 released',
      'state main idle',
    ])
  })

test('a loop the client\'s list never names counts for main and is never announced', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  await complete($, clock)
  // A fork after main's turn: its request is main's work, and its end rests main again.
  await step($, clock, 'fork-1')
  await complete($, clock, 'fork-1')
  // A fork inside main's turn changes nothing while that turn runs.
  await submit($, clock, 'composer')
  await step($, clock)
  await step($, clock, 'fork-2')
  await complete($, clock, 'fork-2')
  // A workflow's agent is no router agent, and the command it starts is its parent's.
  await $.agent.spawn({
    prompt: '',
    description: '',
    subagentType: 'general-purpose',
    workflow: { runId: 'wf_1', agentIndex: 1 },
  } as Parameters<Engine['agent']['spawn']>[0])
  await clock.settle()
  await call($, clock, router, { ...bash('bg-1')[0], agentId: 'agent-1' }, bash('bg-1')[1])
  await step($, clock, 'agent-1')
  await complete($, clock, 'agent-1')
  await complete($, clock)
  await clock.advance(25000)
  expect(told(router)).toEqual([
    'session_start',
    'state main idle',
    'state main busy',
    'state main idle',
    'activity main prompt',
    `state main parked background ${T0 + 1800000}`,
  ])
})

test('a real prompt closes the background commands whose notification never came', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  await submit($, clock, 'composer')
  await call($, clock, router, ...bash('bg-1'))
  await complete($, clock)
  await submit($, clock, 'peer')
  await submit($, clock, 'composer')
  await complete($, clock)
  expect(states(router)).toEqual([`state main parked background ${T0 + 1800000}`, 'state main idle'])
})

// A plugin that raises a background command on the session's loop when a phone attaches.
const RAISER = {
  name: 'raiser',
  register: (on: On): void => {
    on('session.attach', async ($, e, next) => {
      await $.tool.call({ tool: 'Bash', command: 'sleep 600', run_in_background: true } as
        Parameters<Engine['tool']['call']>[0])
      return next(e)
    })
  },
}

test('a tool call another plugin raises is not the model\'s work, though what it starts is the session\'s',
  { ...CONFIGURED, plugins: [RAISER] }, async ($, on) => {
    const { clock, router } = host(on)
    on('session.attach', (_$, e) => ({ clientId: e.clientId }))
    await start($, clock)
    await complete($, clock)
    router.answerTool(() => bash('bg-1')[1])
    await $.session.attach({ surface: 'mobile', clientId: 'phone' } as Parameters<Engine['session']['attach']>[0])
    await clock.settle()
    expect(states(router)).toEqual(['state main idle', `state main parked background ${T0 + 1800000}`])
  })

test('a command leaves its open set only when a stop event\'s registry no longer runs it', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    for (const [task, timeout] of [['bg-1', 60000], ['bg-2', 120000], ['bg-3', 180000], ['bg-4', 240000],
      ['bg-5', 300000]] as const) {
      await call($, clock, router, ...bash(task, timeout))
    }
    await complete($, clock)
    const settled = states(router).length
    // A registry that still runs every command, pending or running, leaves the set as it is, whichever loop's stop
    // carries it.
    const all = (status: string) => ['bg-1', 'bg-2', 'bg-3', 'bg-4', 'bg-5'].map((id) => ({ id, type: 'shell', status }))
    await stop($, clock, all('running'))
    await stop($, clock, all('pending'))
    await stop($, clock, all('running'), 'agent-9')
    expect(states(router).slice(settled)).toEqual([])
    // A command the registry lists as ended, whatever ended it, leaves the set, as does one it no longer lists.
    const remaining = ['bg-1', 'bg-2', 'bg-3', 'bg-4', 'bg-5']
    const ended = [['bg-5', 'completed'], ['bg-4', 'failed'], ['bg-3', 'killed'], ['bg-2', 'stopped']] as const
    for (const [task, status] of ended) {
      remaining.splice(remaining.indexOf(task), 1)
      await stop($, clock, [...remaining.map((id) => ({ id, type: 'shell', status: 'running' })), { id: task, type: 'shell', status }])
    }
    await stop($, clock, [])
    expect(states(router).slice(settled)).toEqual([
      `state main parked background ${T0 + 240000}`,
      `state main parked background ${T0 + 180000}`,
      `state main parked background ${T0 + 120000}`,
      `state main parked background ${T0 + 60000}`,
      'state main idle',
    ])
  })

test('a release still queued when the agent\'s next turn starts goes out before its new announcement', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    await spawn($, clock)
    router.answer(async (_body, ack) => {
      await clock.sleep(2000)
      return ok(ack)
    })
    await complete($, clock)
    router.setAgents([{ id: 'agent-1', status: 'waiting' }])
    await complete($, clock, 'agent-1')
    await step($, clock, 'agent-1')
    await clock.advance(2000)
    expect(told(router).slice(3)).toEqual([
      'state main parked background',
      'state agent-1 released',
      'state main parked background',
      'agent_start agent-1',
      'state agent-1 busy',
    ])
  })

test('an agent released before its announcement went out is announced again for its next turn', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    router.answer(async (_body, ack) => {
      await clock.sleep(2000)
      return ok(ack)
    })
    await submit($, clock, 'composer')
    await spawn($, clock)
    router.setAgents([{ id: 'agent-1', status: 'waiting' }])
    await complete($, clock, 'agent-1')
    await step($, clock, 'agent-1')
    await clock.advance(2000)
    expect(told(router).slice(1)).toEqual([
      'activity main prompt',
      'agent_start agent-1',
      'state agent-1 released',
      'agent_start agent-1',
      'state agent-1 busy',
    ])
  })

test('a release refused once is sent again before the agent\'s new announcement', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  await submit($, clock, 'composer')
  await spawn($, clock)
  router.setAgents([{ id: 'agent-1', status: 'waiting' }])
  router.answer(async () => {
    await clock.sleep(1000)
    return { status: 503, body: { code: 'quiesced' } }
  })
  await complete($, clock, 'agent-1')
  await step($, clock, 'agent-1')
  await clock.advance(1000)
  await clock.advance(1000)
  expect(told(router).slice(2)).toEqual([
    'agent_start agent-1',
    'state agent-1 released',
    'state agent-1 released',
    'agent_start agent-1',
    'state agent-1 busy',
  ])
})

test('a second release of an agent drops the run it ended and keeps the first, with no second start', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    await spawn($, clock)
    router.answer(async (_body, ack) => {
      await clock.sleep(2000)
      return ok(ack)
    })
    await complete($, clock)
    router.setAgents([{ id: 'agent-1', status: 'waiting' }])
    await complete($, clock, 'agent-1')
    await step($, clock, 'agent-1')
    await complete($, clock, 'agent-1')
    await clock.advance(2000)
    expect(told(router).slice(2)).toEqual([
      'agent_start agent-1',
      'state main parked background',
      'state agent-1 released',
      'state main idle',
    ])
  })

test('a release queued behind the agent\'s start in flight is followed by a new start for its next turn', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    router.answer(async (_body, ack) => {
      await clock.sleep(2000)
      return ok(ack)
    })
    await spawn($, clock)
    router.setAgents([{ id: 'agent-1', status: 'waiting' }])
    await complete($, clock, 'agent-1')
    await step($, clock, 'agent-1')
    await clock.advance(2000)
    expect(told(router).slice(2)).toEqual([
      'agent_start agent-1',
      'state agent-1 released',
      'agent_start agent-1',
      'state agent-1 busy',
    ])
  })

test('a start answered after the agent\'s release leaves it unannounced, so its next turn starts it again',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    router.answer(async (_body, ack) => {
      await clock.sleep(2000)
      return ok(ack)
    })
    await spawn($, clock)
    router.setAgents([{ id: 'agent-1', status: 'waiting' }])
    await complete($, clock, 'agent-1')
    await clock.advance(2000)
    await clock.advance(1000)
    await step($, clock, 'agent-1')
    expect(told(router).slice(2)).toEqual([
      'agent_start agent-1',
      'state agent-1 released',
      'agent_start agent-1',
      'state agent-1 busy',
    ])
    expect(router.refusals).toEqual([])
  })

// Main parked on a subagent that parks on its own commands, then a registration whose answer names the subagent
// released, as the router does once the park's ceiling released it.
async function releasedByRouter($: Engine, clock: MockClock, router: FakeRouter,
  commands = [bash('bg-3')]): Promise<void> {
  await start($, clock)
  await submit($, clock, 'composer')
  await spawn($, clock)
  for (const [input, result] of commands) await call($, clock, router, { ...input, agentId: 'agent-1' }, result)
  router.setAgents([{ id: 'agent-1', status: 'waiting' }])
  await complete($, clock, 'agent-1')
  await complete($, clock)
  router.answer(() => ({ status: 409, body: { code: 'unknown_instance' } }))
  router.answer((_body, ack) => ok({
    ...ack,
    agents: [
      { agent_id: 'main', state: 'parked', request_generation: 1 },
      { agent_id: 'agent-1', state: 'released', request_generation: 2 },
    ],
  }))
  await clock.advance(25000)
}

const PARKED_ON_AGENT = [
  { id: 'main', state: 'parked', open: [{ id: 'agent-1', kind: 'subagent' }], lastPresence: 0 },
  {
    id: 'agent-1', parent: 'main', state: 'parked', open: [{ id: 'bg-3', kind: 'command', deadline: T0 + 1800000 }],
    lastPresence: 0,
  },
]

test('a subagent the router last named released is written with the tracked work', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await releasedByRouter($, clock, router)
  expect(router.values.get('model')).toEqual({
    id: 'session-a',
    agents: PARKED_ON_AGENT,
    crons: [],
    released: [],
    routerReleased: ['agent-1'],
  })
})

test('a reload keeps a subagent the router last named released unannounced when the registration\'s answer omits it',
  CONFIGURED, async ($, on) => {
    const saved = { id: 'session-a', agents: PARKED_ON_AGENT, crons: [], released: [], routerReleased: ['agent-1'] }
    const { clock, router } = reloaded(on, saved)
    router.setAgents([{ id: 'agent-1', status: 'waiting' }])
    router.answer((_body, ack) => ok({
      ...ack,
      agents: [{ agent_id: 'main', state: 'parked', park_kind: 'background', request_generation: 1 }],
    }))
    await start($, clock)
    expect(told(router)).toEqual(['session_start'])
    await step($, clock, 'agent-1')
    expect(told(router)).toEqual(['session_start', 'agent_start agent-1', 'state agent-1 busy'])
  })

test('a clear drops what the router last named released, so the subagent is announced afresh under the new id',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await releasedByRouter($, clock, router)
    router.answer(() => ({ status: 409, body: { code: 'unknown_instance' } }))
    router.answer((_body, ack) => ok({
      ...ack,
      agents: [{ agent_id: 'main', state: 'parked', request_generation: 1 }],
    }))
    await clock.advance(25000)
    expect(router.values.get('model')).toMatchObject({ id: 'session-a', routerReleased: ['agent-1'] })
    await end($, clock, 'clear', 'session-a')
    router.setId('session-b')
    router.setAgents([{ id: 'agent-1', status: 'running' }])
    await submit($, clock, 'composer')
    expect(router.values.get('model')).toMatchObject({ id: 'session-b', routerReleased: [] })
    await step($, clock, 'agent-1')
    expect(under(router, 'session-b')).toEqual([
      'session_start',
      'activity main prompt',
      'agent_start agent-1',
      'state agent-1 busy',
    ])
  })

test('the end of the open work of a subagent the router last named released drops it with no report', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    await releasedByRouter($, clock, router)
    const settled = told(router).length
    // The next stop event's registry no longer runs the subagent's command, so its work is done.
    await stop($, clock, [{ id: 'agent-1', type: 'subagent', status: 'running' }])
    expect(told(router).slice(settled)).toEqual(['state main idle'])
    expect(router.values.get('model')).toEqual({
      id: 'session-a',
      agents: [{ id: 'main', state: 'idle', open: [], lastPresence: 0 }],
      crons: [],
      released: ['agent-1'],
      routerReleased: [],
    })
  })

test('one stop event that ends two commands of a released subagent reports main\'s idle alone', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    // The command the stop removes first holds the later deadline, so its removal alone would move the park.
    await releasedByRouter($, clock, router, [bash('bg-3'), bash('bg-4', 60000)])
    const settled = told(router).length
    await stop($, clock, [{ id: 'agent-1', type: 'subagent', status: 'running' }])
    expect(told(router).slice(settled)).toEqual(['state main idle'])
  })

test('a registration answered while the agent\'s release waits does not adopt it again from the client\'s list',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    await spawn($, clock)
    await complete($, clock)
    // The heartbeat finds the session gone, and the registration's answer, which still names the agent the router
    // holds, lands after the agent's run ended while the client still lists it as waiting.
    router.answer(() => ({ status: 409, body: { code: 'unknown_instance' } }))
    router.answer(async (_body, ack) => {
      await clock.sleep(2000)
      return ok(ack)
    })
    await clock.advance(25000)
    router.setAgents([{ id: 'agent-1', status: 'waiting' }])
    await complete($, clock, 'agent-1')
    const settled = told(router).length
    await clock.advance(2000)
    // The queued release ends the run the answer names, so the worker stays released and main idle until the
    // client spawns the worker again or gives it a turn.
    expect(told(router).slice(settled)).toEqual(['state agent-1 released', 'state main idle'])
    await clock.advance(25000)
    expect(told(router).slice(settled)).toEqual(['state agent-1 released', 'state main idle'])
    await step($, clock, 'agent-1')
    expect(told(router).slice(settled + 2)).toEqual([
      'state main parked background',
      'agent_start agent-1',
      'state agent-1 busy',
    ])
  })

test('a start refused with a 503 while its run\'s release and the next run wait is sent again ahead of the release',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    router.answer(async () => {
      await clock.sleep(2000)
      return { status: 503, body: { code: 'quiesced' } }
    })
    await spawn($, clock)
    router.setAgents([{ id: 'agent-1', status: 'waiting' }])
    await complete($, clock, 'agent-1')
    await step($, clock, 'agent-1')
    await clock.advance(2000)
    await clock.advance(1000)
    // The router never took the first start, so the release that ends its run follows a start it did take.
    expect(told(router).slice(2)).toEqual([
      'agent_start agent-1',
      'agent_start agent-1',
      'state agent-1 released',
      'agent_start agent-1',
      'state agent-1 busy',
    ])
    expect(router.refusals.map((answer) => answer.status)).toEqual([503])
  })

test('a release refused with a 503 while the next run and its release wait is sent again in place of that run',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    await spawn($, clock)
    router.setAgents([{ id: 'agent-1', status: 'waiting' }])
    router.answer(async () => {
      await clock.sleep(2000)
      return { status: 503, body: { code: 'quiesced' } }
    })
    await complete($, clock, 'agent-1')
    await step($, clock, 'agent-1')
    await complete($, clock, 'agent-1')
    await clock.advance(2000)
    await clock.advance(1000)
    // The router still holds the agent from its first run, so a start for the second would meet agent_exists.
    expect(told(router).slice(2)).toEqual([
      'agent_start agent-1',
      'state agent-1 released',
      'state agent-1 released',
    ])
    expect(router.refusals.map((answer) => answer.status)).toEqual([503])
  })

test('a wakeup answered with no time, as for a loop that aged out, cancels the pending one and adds none',
  CONFIGURED, async ($, on) => {
    const at = local(14, 10, 0)
    const { clock, router } = host(on, at)
    await start($, clock)
    await submit($, clock, 'composer')
    await call($, clock, router, { tool: 'ScheduleWakeup', delaySeconds: 90, reason: 'waiting', prompt: 'go on' },
      { scheduledFor: at + 90000, clampedDelaySeconds: 90, wasClamped: false })
    await call($, clock, router, { tool: 'ScheduleWakeup', delaySeconds: 90, reason: 'waiting', prompt: 'go on' },
      { scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false })
    await complete($, clock)
    expect(states(router)).toEqual(['state main idle'])
  })

test('a prompt typed during main\'s turn keeps the commands that turn started', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  await submit($, clock, 'composer')
  await call($, clock, router, ...bash('bg-1', 60000))
  await complete($, clock)
  await submit($, clock, 'composer')
  await step($, clock)
  await call($, clock, router, ...bash('bg-2', 120000))
  await clock.advance(3000)
  await submit($, clock, 'composer', 'and the tests too', 'turn-1')
  await complete($, clock)
  // A later turn that a notification started holds none of the earlier turn's commands as its own.
  await submit($, clock, 'task-notification', 'progress')
  await step($, clock)
  await submit($, clock, 'composer', 'stop the build', 'turn-2')
  await complete($, clock)
  expect(states(router)).toEqual([
    `state main parked background ${T0 + 60000}`,
    `state main parked background ${T0 + 120000}`,
    'state main busy',
    'state main idle',
  ])
})

test('a prompt a lower hook drops leaves main\'s state and commands as they were', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  await submit($, clock, 'composer')
  await call($, clock, router, ...bash('bg-1', 60000))
  await complete($, clock)
  const settled = told(router).length
  router.answerSubmit(() => ({ drop: 'no' }))
  await submit($, clock, 'composer')
  // The router lost the session, so the tick registers again, and the mod restates main where the answer's busy
  // differs from what it holds.
  router.answer(() => ({ status: 409, body: { code: 'unknown_instance' } }))
  await clock.advance(25000)
  expect(told(router).slice(settled)).toEqual(['session_start', `state main parked background ${T0 + 60000}`])
})

test('a prompt whose chain finishes after a clear changes nothing', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  // The hooks beneath hold the prompt for two seconds, and the person clears the conversation meanwhile.
  router.answerSubmit(async () => {
    await clock.sleep(2000)
    return { text: 'hi' }
  })
  const held = $.prompt.submit({ text: 'hi', origin: { kind: 'composer' } as { kind: 'composer' }, wait: false })
  await clock.settle()
  await end($, clock, 'clear', 'session-a')
  router.setId('session-b')
  await clock.advance(2000)
  await held
  await clock.settle()
  expect(under(router, 'session-a')).toEqual(['session_start', 'session_end'])
  expect(under(router, 'session-b')).toEqual([])
  await submit($, clock, 'composer')
  expect(under(router, 'session-b')).toEqual(['session_start', 'activity main prompt'])
})

test('a prompt whose chain finishes after a clear\'s start leaves the new session alone', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    router.answerSubmit(async () => {
      await clock.sleep(2000)
      return { text: 'hi' }
    })
    const held = $.prompt.submit({ text: 'hi', origin: { kind: 'composer' } as { kind: 'composer' }, wait: false })
    await clock.settle()
    await end($, clock, 'clear', 'session-a')
    router.setId('session-b')
    // The clear's own start registers the new id while the prompt is still held, so the session is live again.
    await start($, clock)
    await clock.advance(2000)
    await held
    await clock.settle()
    expect(under(router, 'session-b')).toEqual(['session_start'])
  })

test('an agent the list names only after its first step is judged again at its spawn and at the tick', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    await step($, clock, 'agent-1')
    await spawn($, clock)
    await step($, clock, 'agent-1')
    await complete($, clock)
    router.setAgents([{ id: 'agent-1', status: 'completed' }])
    await complete($, clock, 'agent-1')
    // A loop first met unlisted that the list names by the next tick no longer counts for main at its turn end.
    await submit($, clock, 'composer')
    await step($, clock, 'agent-7')
    await complete($, clock)
    router.setAgents([{ id: 'agent-7', status: 'running' }])
    await clock.advance(25000)
    await complete($, clock, 'agent-7')
    expect(told(router)).toEqual([
      'session_start',
      'activity main prompt',
      'agent_start agent-1',
      'state main parked background',
      'state agent-1 released',
      'state main idle',
      'activity main prompt',
      'state main idle',
    ])
  })

test('the registration acknowledgment adopts a parent before its child, whatever the order it lists them in',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    router.setAgents([
      { id: 'agent-8', status: 'running', parentId: 'agent-7' },
      { id: 'agent-7', status: 'running' },
    ])
    router.answer((_body, ack) => ok({
      ...ack,
      agents: [
        { agent_id: 'agent-8', state: 'busy', request_generation: 1 },
        { agent_id: 'main', state: 'busy', request_generation: 1 },
        { agent_id: 'agent-7', state: 'busy', request_generation: 1 },
      ],
    }))
    await start($, clock)
    await complete($, clock)
    router.setAgents([
      { id: 'agent-8', status: 'running', parentId: 'agent-7' },
      { id: 'agent-7', status: 'waiting' },
    ])
    await complete($, clock, 'agent-7')
    router.setAgents([
      { id: 'agent-8', status: 'completed', parentId: 'agent-7' },
      { id: 'agent-7', status: 'waiting' },
    ])
    await complete($, clock, 'agent-8')
    expect(told(router)).toEqual([
      'session_start',
      'state agent-7 busy',
      'state agent-8 busy',
      'state main parked background',
      'state agent-7 parked background',
      'state agent-8 released',
      'state agent-7 released',
      'state main idle',
    ])
  })

test('a subagent whose turn ends with the list reading it live and nothing open is released', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    await spawn($, clock)
    await complete($, clock)
    router.setAgents([{ id: 'agent-1', status: 'idle' }])
    await complete($, clock, 'agent-1')
    expect(told(router).slice(2)).toEqual([
      'agent_start agent-1',
      'state main parked background',
      'state agent-1 released',
      'state main idle',
    ])
  })

// A plugin that raises a tool call on a subagent's loop when a phone attaches.
const LOOPER = {
  name: 'looper',
  register: (on: On): void => {
    on('session.attach', async ($, e, next) => {
      await $.tool.call({ tool: 'Read', file_path: '/tmp/x', agentId: 'agent-5' } as
        Parameters<Engine['tool']['call']>[0])
      return next(e)
    })
  },
}

test('a subagent the registration answer restates with nothing open is released', { ...CONFIGURED,
  plugins: [LOOPER] }, async ($, on) => {
  const { clock, router } = host(on)
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  await start($, clock)
  await complete($, clock)
  // Another plugin's call on the loop of an agent the mod never met adopts it at rest, with nothing open.
  router.setAgents([{ id: 'agent-5', status: 'running' }])
  router.answerTool(() => ({ type: 'text', file: { content: '' } }))
  await $.session.attach({ surface: 'mobile', clientId: 'phone' } as Parameters<Engine['session']['attach']>[0])
  await clock.settle()
  router.answer(() => ({ status: 409, body: { code: 'unknown_instance' } }))
  await clock.advance(25000)
  expect(told(router)).toEqual([
    'session_start',
    'state main idle',
    'state main parked background',
    'session_start',
    'agent_start agent-5',
    'state agent-5 released',
    'state main idle',
  ])
})

test('a prompt from the composer, the sdk, the bridge or a Slack ping is an activity of kind prompt and other ' +
  'origins are not', CONFIGURED, async ($, on) => {
    expect(ORIGINS.filter((kind) => isRealPrompt({ kind }))).toEqual(['bridge', 'composer', 'sdk', 'slack-ping'])
    const { clock, router } = host(on)
    await start($, clock)
    await complete($, clock)
    for (const kind of ORIGINS) await submit($, clock, kind)
    expect(told(router)).toEqual([
      'session_start',
      'state main idle',
      'activity main prompt',
      'activity main prompt',
      'activity main prompt',
      'activity main prompt',
    ])
  })

test('a person editing the prompt is present at most once a minute and the presence leaves the state alone',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await complete($, clock)
    await edit($, clock)
    await clock.advance(30000)
    await edit($, clock)
    await clock.advance(60000 - 30001)
    await edit($, clock)
    await clock.advance(1)
    await edit($, clock)
    await step($, clock)
    expect(told(router)).toEqual([
      'session_start',
      'state main idle',
      'activity main presence',
      'activity main presence',
      'state main busy',
    ])
    const present = router.requests.flatMap((body, index) => body.event === 'activity' ? [router.times[index]] : [])
    expect(present).toEqual([T0, T0 + 60000])
  })

describe('unknown is never sent', () => {
  for (const [name, log] of Object.entries(LOGS)) {
    test(name, CONFIGURED, async ($, on) => {
      const { clock, router } = replayHost(on)
      await replay($, on, log, clock, router)
      const unknown = router.requests.filter((body) => body.event === 'state' && (body.state as string) === 'unknown')
      expect(unknown).toEqual([])
      expect(JSON.stringify(router.requests)).not.toContain('unknown')
      // The host refuses a body the router's decoder would, so none was refused.
      expect(router.refusals).toEqual([])
    })
  }
})

test('the agent id the mod reports is the one string the spawn, the steps, the completion and the notification carry',
  CONFIGURED, async ($, on) => {
    const { clock, router } = replayHost(on)
    await replay($, on, runH, clock, router)
    const agents = router.requests.flatMap((body) => 'agent_id' in body && body.agent_id !== 'main' ? [said(body)] : [])
    expect(agents).toEqual([`agent_start ${SUBAGENT}`, `state ${SUBAGENT} released`])
    // The release took the id out of main's open set, so main ends idle after the notification's turn.
    expect(states(router).at(-1)).toBe('state main idle')
  })

test('an unknown_agent answer takes the agent out of the announced set so its next report announces it again',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    await spawn($, clock)
    await call($, clock, router, { ...bash('bg-1')[0], agentId: 'agent-1' }, bash('bg-1')[1])
    router.setAgents([{ id: 'agent-1', status: 'waiting' }])
    router.answer(() => ({ status: 409, body: { code: 'unknown_agent' } }))
    router.answer(() => ({ status: 400, body: { code: 'invalid_event' } }))
    await complete($, clock, 'agent-1')
    await step($, clock, 'agent-1')
    const parked = `state agent-1 parked background ${T0 + 1800000}`
    expect(told(router).slice(2)).toEqual([
      'agent_start agent-1',
      parked,
      'agent_start agent-1',
      parked,
      'agent_start agent-1',
      'state agent-1 busy',
    ])
  })

test('a newer state queued during the flight is sent after the late acknowledgment and the state in flight is never ' +
  'collapsed away', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  await complete($, clock)
  router.answer(async (_body, ack) => {
    await clock.sleep(2000)
    return ok(ack)
  })
  await step($, clock)
  await clock.advance(500)
  await call($, clock, router, ...bash('bg-1'))
  await complete($, clock)
  await clock.advance(1499)
  expect(told(router)).toEqual(['session_start', 'state main idle', 'state main busy'])
  await clock.advance(1)
  expect(told(router)).toEqual([
    'session_start',
    'state main idle',
    'state main busy',
    `state main parked background ${T0 + 500 + 1800000}`,
  ])
  expect(router.times).toEqual([T0, T0, T0, T0 + 2000])
})

test('the heartbeat deadline is moved by a registration or a heartbeat acknowledgment alone while states are reported',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await call($, clock, router, ...bash('bg-1'))
    for (let turn = 0; turn < 120; turn += 1) {
      await clock.advance(500)
      await complete($, clock)
      await clock.advance(500)
      await step($, clock)
    }
    const renewals = router.requests
      .map((body, index) => ({ event: body.event, at: router.times[index] as number }))
      .filter((request) => request.event === 'session_start' || request.event === 'heartbeat')
    expect(renewals.map((request) => request.at)).toEqual([T0, T0 + 25000, T0 + 50000, T0 + 75000, T0 + 100000])
    for (const [index, renewal] of renewals.slice(1).entries()) {
      expect(renewal.at).toBeLessThan((renewals[index]?.at as number) + LEASE_MS)
    }
    const parked = `state main parked background ${T0 + 1800000}`
    const reported = states(router)
    expect(reported).toHaveLength(240)
    expect(reported.filter((state, index) => state !== (index % 2 === 0 ? parked : 'state main busy'))).toEqual([])
  })

async function end($: Engine, clock: MockClock, reason: 'clear' | 'resume' | 'other', id: string): Promise<void> {
  await $.session.end({ reason, sessionId: id, resume: { id } })
  await clock.settle()
}

function under(router: FakeRouter, id: string): string[] {
  return router.requests.filter((body) => body.session_id === id && body.event !== 'heartbeat').map(said)
}

function timesOf(router: FakeRouter, what: (body: Body) => boolean): number[] {
  return router.requests.flatMap((body, index) => what(body) ? [router.times[index] as number] : [])
}

test('a start refused for the agent limit is retried under its own deadline while the heartbeats and the other ' +
  'agents\' reports go on', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  await submit($, clock, 'composer')
  await spawn($, clock)
  // Every start of the second agent meets the router's agent limit for longer than a lease.
  for (let answers = 0; answers < 60; answers += 1) {
    router.answer((body, ack) => body.event === 'agent_start' && body.agent_id === 'agent-2'
      ? { status: 429, body: { code: 'agent_limit' } }
      : ok(ack))
  }
  await spawn($, clock)
  await complete($, clock)
  await clock.advance(20000)
  // The first agent's run ends while the second's start is still refused.
  router.setAgents([{ id: 'agent-1', status: 'waiting' }, { id: 'agent-2', status: 'running' }])
  await complete($, clock, 'agent-1')
  await clock.advance(LEASE_MS + 10000)
  const beats = timesOf(router, (body) => body.event === 'heartbeat')
  expect(beats).toEqual([T0 + 25000, T0 + 50000, T0 + 75000, T0 + 100000])
  for (const [index, beat] of beats.slice(1).entries()) expect(beat).toBeLessThan((beats[index] as number) + LEASE_MS)
  const starts = timesOf(router, (body) => body.event === 'agent_start' && body.agent_id === 'agent-2')
  expect(starts).toEqual([T0, T0 + 1000, T0 + 3000, T0 + 7000, T0 + 15000, T0 + 31000, T0 + 61000, T0 + 91000])
  // Main stays parked on the second agent, so the first one's release moves no park of main.
  expect(told(router).filter((line) => !line.includes('agent-2'))).toEqual([
    'session_start',
    'activity main prompt',
    'agent_start agent-1',
    'state main parked background',
    'state agent-1 released',
  ])
  const released = router.requests.findIndex((body) => said(body) === 'state agent-1 released')
  expect(router.times[released]).toBe(T0 + 20000)
  expect(router.refusals.map((answer) => answer.code)).toEqual(Array(8).fill('agent_limit'))
})

test('a tool result or a spawn that lands after a clear replaced the session is not the new session\'s work',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    // The command's result and the spawn's answer arrive two seconds later, after the clear.
    router.answerTool(async () => {
      await clock.sleep(2000)
      return bash('bg-1')[1]
    })
    router.answerSpawn(async () => {
      await clock.sleep(2000)
      return { agentId: 'agent-9' }
    })
    const call = $.tool.call({ tool_use_id: 'toolu_late', ...bash('bg-1')[0] } as
      Parameters<Engine['tool']['call']>[0])
    const spawning = $.agent.spawn({ prompt: '', description: '', subagentType: 'Explore' } as
      Parameters<Engine['agent']['spawn']>[0])
    await clock.settle()
    await end($, clock, 'clear', 'session-a')
    router.setId('session-b')
    await submit($, clock, 'composer')
    await clock.advance(2000)
    await call
    await spawning
    await complete($, clock)
    expect(under(router, 'session-b')).toEqual(['session_start', 'activity main prompt', 'state main idle'])
  })

test('a reload in the same session restores the tracked work before the registration is reconciled, and a new id ' +
  'starts fresh', CONFIGURED, async ($, on) => {
  // The module that loaded before this one left main parked on a command, and the router still holds that park.
  const saved = {
    id: 'session-a',
    agents: [{
      id: 'main', state: 'parked', open: [{ id: 'bg-1', kind: 'command', deadline: T0 + 60000 }], lastPresence: 0,
    }],
    crons: [],
    released: [],
    routerReleased: [],
  }
  const { clock, router } = reloaded(on, saved)
  router.answer((_body, ack) => ok({
    ...ack,
    agents: [
      { agent_id: 'main', state: 'parked', park_kind: 'background', deadline: T0 + 60000, request_generation: 1 },
    ],
  }))
  await start($, clock)
  expect(told(router)).toEqual(['session_start'])
  // The restored open set is what the registry closes, so main rests idle.
  await stop($, clock, [])
  expect(told(router)).toEqual(['session_start', 'state main idle'])
  // A new id is a new conversation: nothing the saved model held carries over.
  router.setId('session-b')
  await submit($, clock, 'composer')
  await stop($, clock, [])
  await complete($, clock)
  expect(under(router, 'session-b')).toEqual(['session_start', 'activity main prompt', 'state main idle'])
})

test('the tracked work is written to the host\'s state as it changes', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  await submit($, clock, 'composer')
  await call($, clock, router, ...bash('bg-1', 60000))
  await complete($, clock)
  expect(router.values.get('model')).toEqual({
    id: 'session-a',
    agents: [{
      id: 'main', state: 'parked', open: [{ id: 'bg-1', kind: 'command', deadline: T0 + 60000 }], lastPresence: 0,
    }],
    crons: [],
    released: [],
    routerReleased: [],
  })
  await stop($, clock, [])
  expect(router.values.get('model')).toEqual({
    id: 'session-a',
    agents: [{ id: 'main', state: 'idle', open: [], lastPresence: 0 }],
    crons: [],
    released: [],
    routerReleased: [],
  })
  // A subagent the mod released is remembered as such, for a reload's registration to answer with its release.
  await submit($, clock, 'composer')
  await spawn($, clock)
  router.setAgents([{ id: 'agent-1', status: 'waiting' }])
  await complete($, clock, 'agent-1')
  expect(router.values.get('model')).toMatchObject({ released: ['agent-1'] })
})

// The host of a module reloaded in the same process: it holds the pair the earlier load minted and the work it tracked.
function reloaded(on: On, saved: unknown): { clock: MockClock; router: FakeRouter } {
  mock.env(on, {
    ANTHROPIC_AUTH_TOKEN: KEY,
    ANTHROPIC_CUSTOM_HEADERS: 'X-Keepalive-Owner-Id: u-1',
    PHOEBIS_KEEPALIVE_INSTANCE: 'i-1',
  })
  const clock = mock.clock(on, { now: T0 })
  const router = fakeRouter(on, clock, {
    id: 'session-a', state: { instance: 'i-1', owner: 'u-1' }, values: { model: saved },
  })
  return { clock, router }
}

test('a registration answered after the worker\'s release was acknowledged re-sends the release when the answer ' +
  'still names it busy', CONFIGURED, async ($, on) => {
  const { clock, router } = host(on)
  await start($, clock)
  await submit($, clock, 'composer')
  await spawn($, clock)
  await complete($, clock)
  router.setAgents([{ id: 'agent-1', status: 'waiting' }])
  await complete($, clock, 'agent-1')
  expect(told(router).slice(-2)).toEqual(['state agent-1 released', 'state main idle'])
  // The router restarted from a save older than the release: the heartbeat finds the session gone, and the
  // registration's answer still holds the worker busy.
  router.answer(() => ({ status: 409, body: { code: 'unknown_instance' } }))
  router.answer((_body, ack) => ok({
    ...ack,
    agents: [
      { agent_id: 'main', state: 'idle', request_generation: 1 },
      { agent_id: 'agent-1', state: 'busy', request_generation: 1 },
    ],
  }))
  const settled = told(router).length
  await clock.advance(25000)
  expect(told(router).slice(settled)).toEqual(['session_start', 'state agent-1 released'])
  await clock.advance(25000)
  expect(told(router).slice(settled)).toEqual(['session_start', 'state agent-1 released'])
  await step($, clock, 'agent-1')
  expect(told(router).slice(settled + 2)).toEqual([
    'state main parked background',
    'agent_start agent-1',
    'state agent-1 busy',
  ])
  expect(router.refusals.map((answer) => answer.code)).toEqual(['unknown_instance'])
})

test('the released set survives a reload, so a registration that still names the worker re-sends its release',
  CONFIGURED, async ($, on) => {
    const saved = {
      id: 'session-a',
      agents: [{ id: 'main', state: 'idle', open: [], lastPresence: 0 }],
      crons: [],
      released: ['agent-1'],
      routerReleased: [],
    }
    const { clock, router } = reloaded(on, saved)
    router.setAgents([{ id: 'agent-1', status: 'waiting' }])
    router.answer((_body, ack) => ok({
      ...ack,
      agents: [
        { agent_id: 'main', state: 'idle', request_generation: 1 },
        { agent_id: 'agent-1', state: 'busy', request_generation: 1 },
      ],
    }))
    await start($, clock)
    expect(told(router)).toEqual(['session_start', 'state agent-1 released'])
  })

test('a presence during the new id\'s registration read never writes the old session\'s work under the new id',
  CONFIGURED, async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await submit($, clock, 'composer')
    await call($, clock, router, ...bash('bg-1', 60000))
    await complete($, clock)
    await end($, clock, 'clear', 'session-a')
    router.setId('session-b')
    // The new id's registration reads the held work two seconds late, and the person types meanwhile.
    router.delayModel(2000)
    const registering = $.prompt.submit({
      text: 'hi', origin: { kind: 'composer' } as { kind: 'composer' }, wait: false,
    })
    await clock.settle()
    await edit($, clock)
    expect(router.values.get('model')).toMatchObject({ id: 'session-a' })
    await clock.advance(2000)
    await registering
    await clock.settle()
    expect(router.values.get('model')).toEqual({
      id: 'session-b',
      agents: [{ id: 'main', state: 'busy', open: [], lastPresence: 0 }],
      crons: [],
      released: [],
      routerReleased: [],
    })
  })

test('an agent spawned while the heartbeat\'s list is pending is not released against that list', CONFIGURED,
  async ($, on) => {
    const { clock, router } = host(on)
    await start($, clock)
    await complete($, clock)
    // The heartbeat's list answers two seconds late, and the spawn lands in between.
    router.delayList(2000)
    await clock.advance(25000)
    await submit($, clock, 'composer')
    await spawn($, clock)
    await complete($, clock)
    await clock.advance(2000)
    router.setAgents([{ id: 'agent-1', status: 'running' }])
    await clock.advance(25000)
    expect(told(router)).toEqual([
      'session_start',
      'state main idle',
      'activity main prompt',
      'agent_start agent-1',
      'state main parked background',
    ])
  })
