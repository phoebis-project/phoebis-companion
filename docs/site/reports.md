# What the mod reports

The mod reports on main, the session's own agent, and on each subagent the client lists. Each agent has an open set: the
background commands and the subagents it started that have not ended yet. The session's crons and wakeups belong to
main. Every report is one request to the router's events route, and the route, the eight events with their fields, the
acknowledgment, the refusal codes and how the mod queues, sends and retries are on [The
relay](../router/relay.md#the-companion-protocol).

| Mod event | Fact | Report |
| --- | --- | --- |
| `session.start` | the process is up | the instance fence, then `session_start` |
| `classic.SessionStart` | the session's custom title, with Session title reports on | none of its own: the mod keeps the title for the next read |
| `prompt.submit` from `bridge`, `composer`, `sdk` or `slack-ping` | a real prompt | `activity` kind `prompt` for main |
| `prompt.submit` from `scheduled-trigger` | a cron or a wakeup fired | it leaves the crons or moves to its next fire |
| `classic.UserPromptSubmit` | the session's custom title, with Session title reports on | none of its own: the mod keeps the title for the next read |
| `prompt.edit` | the person is typing | `activity` kind `presence` for main, at most once a minute |
| `turn.step` | a model request of main or a subagent | `state busy` when the agent was not busy. A step of a loop the mod meets first reads the client's agent list, and where a clear or a resume replaced the session during that read, the step counts for no agent, with each option off too |
| `tool.call` before the tool runs | a tool runs | `state busy` when the agent was not busy. A call of a loop the mod meets first reads the client's agent list, and where a clear or a resume replaced the session during that read, the call counts for no agent and what it starts joins no open set, with each option off too |
| `tool.call` after Bash | a command started in the background | it joins the agent's open set with its deadline |
| `tool.call` after CronCreate or ScheduleWakeup | a wakeup is scheduled | it joins the crons with its next fire |
| `tool.call` after CronDelete | a cron is gone | it leaves the crons |
| `agent.spawn` | a subagent started | `agent_start`, then `agent_facts` behind the start's acknowledgment with Agent reports on, and it joins its parent's open set |
| `classic.Stop` | main's turn ended, with the client's background list | a command the background list no longer runs leaves its owner's open set |
| `classic.SubagentStop` | a subagent's turn ended, with the background list | the same |
| `turn.complete` of a subagent | the subagent's turn ended | `state parked` on its open set, or `state released` |
| `turn.complete` of main | main's turn ended | `state idle`, or `state parked` with its park |
| an acknowledged `session_start`, a `prompt.submit` and a `turn.complete` of main | the session's facts are read | `session_facts` where the set changed, and after each registration where the set or the last set sent holds a fact or a report is still owed to the router |
| `session.end` | the session ends or changes id | `session_end`, one request |
| the heartbeat timer | time passed | the session id check, the reconcile, then `heartbeat`, and with Agent reports on, `agent_facts` for an agent whose description, type or name changed on the client's list |

A prompt is the person's own when its origin is `bridge` (sent through Remote Control), `composer` (typed at the
prompt), `sdk` (handed over by an SDK host) or `slack-ping` (sent from Slack). The router marks main busy on that prompt
itself, and a prompt of any other origin reports no activity.

A stop event, `classic.Stop` at the end of main's turn and `classic.SubagentStop` at the end of a subagent's, carries
the client's background list: every background command and subagent, with its id, type and status. A command in an open
set that the background list reads as ended, whatever ended it, or no longer holds, leaves its owner's open set there.
The mod reads no notification's text: a subagent's end is the agent list's to tell, and a notification that names a
subagent changes nothing, so a subagent that stopped with a background command of its own stays parked on that command
until a stop event's background list no longer runs it.

A Bash call counts as a background command when its result carries `backgroundTaskId`. A tool call that another plugin
raises marks no agent busy, although a background command or a cron it starts still counts for the session. A loop the
client's agent list never names, such as a workflow's agent or one of Claude Code's own forks, counts for the agent that
started it, or for main, and is never reported as an agent.

The mod reads `$.session.id()` at session start, at every prompt and at every heartbeat. After a `/clear` or a
`/resume`, `session.end` ends the registered session at once and no `session.start` follows, so the next prompt that
reads the new id registers it under the same instance. Nothing the old session had open or scheduled carries over. At
each heartbeat the mod also releases the subagents the client's agent list reads `completed`, `failed` or `killed` or no
longer lists, and closes the background commands past their deadline. A read of the client's agent list that does not
answer within 5 seconds counts as a failed read, at a heartbeat, behind a registration and at a loop the mod meets
first, and the next read asks again. The agent list describes the agents the mod held when it asked for it, so a
subagent spawned while the answer was out is judged at the next heartbeat, and an answer that arrives after a `/clear`
or a `/resume` replaced the session is dropped. A tool result or a spawn answer that lands after such a replacement is
dropped the same way: the work belongs to the session that started it.

The mod writes its tracked work, each agent's open set, the session's crons, the subagents it released and those the
router last named released, to the plugin's host state whenever it changes. A write that the host refuses, or does not
finish within 5 seconds, holds no report back, and the mod writes the work again with its next send. A hot reload of the
module in the same session reads it back before the registration's answer is reconciled, so a park the router holds is
kept rather than replaced with a fresh busy main, the commands and crons the earlier load tracked still close and fire,
and a released subagent stays released. A new session id starts from nothing.

## Parks

When main's turn ends, main reports `idle`, or `parked` with a `park_kind`:

- `background` while its open set holds anything
- `scheduled` while a cron or a wakeup is pending
- `both` while both hold

`wake_at` is the earliest time the client fires one of the session's crons or wakeups, in epoch milliseconds. The mod
computes it as the client's scheduler does, from the cron expression, the time of creation or of the last fire, and the
cron's id. A wakeup's `wake_at` is the `scheduledFor` time its ScheduleWakeup call answered. `deadline` is the latest
deadline among the open background commands, in epoch milliseconds, and the report carries it only while every open
entry is a command, because a subagent has no deadline.

A background command's deadline is its start plus the call's `timeout`, or plus 30 minutes when the call names none, and
at most 2 hours after its start. These are the limits at which the client stops a background command, and the two
variables only raise them: `BASH_DEFAULT_TIMEOUT_MS` above 30 minutes becomes the default, and the larger of
`BASH_MAX_TIMEOUT_MS` and `BASH_DEFAULT_TIMEOUT_MS`, when it is above 2 hours, becomes the cap. The mod reads both at
session start. The router reads whole milliseconds, so the mod rounds the deadline of a fractional `timeout` up to the
next whole millisecond.

A subagent parks the same way on its own open set when its turn ends. A subagent whose turn ends with nothing open
reports `released`, since its work went back to its parent, and its next turn under the same id starts it again with
`agent_start`.

An entry leaves its open set on the first of these:

- a stop event of main or of a subagent whose background list no longer runs it
- the end of a subagent: its release at its turn end, or the client's agent list reading it ended or no longer naming it
- the first heartbeat after a background command's deadline
- main's next real prompt, for every command an earlier turn of main started, still running or not

A long-running command, such as a dev server, therefore parks main only until main's next real prompt. A prompt typed
into main's running turn keeps the commands that turn started. A cron leaves the crons when CronDelete removes it or
when it fires as a one-shot, however far away that is, since a one-shot has no age limit. A recurring cron moves to its
next fire each time it fires, until the fire at which it is seven days old: the client removes it after that fire, and
so does the mod. A new ScheduleWakeup replaces the pending wakeup, and one called with `stop` cancels it.

Two wakeups never reach the mod: the fallback wakeup Claude Code arms on its own when the model does not reschedule a
`/loop` turn, and the durable crons a previous process left in `.claude/scheduled_tasks.json`. While one of them is
pending, main reads `idle`, and the router's idle ceiling ([The ceilings](../router/keepalive.md#the-ceilings)) governs
how long the cache stays warm for it.

## Presence

`prompt.edit` fires while the person types at the prompt. The mod reports it as `activity` kind `presence` for main, at
most once a minute. The router resets main's idle clock on a presence and does nothing else with it, so no agent turns
busy and no state changes.

## Reported facts

With Session title reports on ([Configure](install.md#configure)), the mod reports the session's custom title, the one
a `/rename` gave it, in a `session_facts` report. The title rides `classic.SessionStart` and `classic.UserPromptSubmit`,
and the mod reads the session's facts when the router acknowledges a `session_start`, at each prompt and at the end of
each of main's turns. A title counts only for the session id its event names, so a title seen before a `/clear` never
goes out under the new id. In a default install a session reports no fact.

With Project reports on, the report also carries the branch, the project directory, the repository, the repository's
root and the working directory of the session. The project directory is the session's root, the working directory its
present directory, and the repository the `origin` remote reduced to `host/path` with the ASCII letters of the host in
lower case: the scheme, the user information, the port, the query, the fragment, one trailing `.git` and each trailing
slash are cut before the value leaves the machine, so no credential is sent. A `file` URL, a local path, a remote with
an `@` behind its host part and each other remote the mod cannot read send no repository. The branch is read with
`git symbolic-ref --short -q HEAD` in the working directory that the same read took, at each read and only inside a
repository, with a timeout of 2 seconds. A detached HEAD, a git call that fails, a host that runs no process, a missing
git and the timeout send no branch. A read during which the working directory changed reports the place it took, with
that place's branch, and the next read reports the new place. A path or a reduced repository over 1,024 bytes and a
branch over 256 bytes are left out.

A `session_facts` report states the whole set, so a fact that is gone is left out of the next report and the router
clears it. The mod sends the set where it changed, and after each acknowledged registration where the set or the last
set sent holds a fact or where a report the router did not confirm is still owed, a clear among them, since the router's
record may be a new one. The mod cleans each value before it sends it: each run of line breaks and tabs folds to one
space, control characters, format characters and unpaired surrogates go, the ends are trimmed, and a title past 256
bytes is cut on a whole character. The router applies the same rules, and [the event's
members](../router/relay.md#the-companion-protocol) are on the router's page The relay.

A facts report goes out behind each lifecycle report in the queue and waits under a backoff of its own, so a report the
router refuses or cannot take costs the facts alone and never a heartbeat. A request with no answer within 10 seconds
counts as a failed send: the report goes back into the queue under its backoff, and an answer that arrives later changes
nothing. An answer with a 2xx status that does not name the report's session and its sequence, as a page from something
in front of the router gives, is no acknowledgment, and the report goes back into the queue under its backoff. Each
registration names the kinds of facts that this install reports, and the router drops each stored kind of the session
that the list leaves out, so an option turned off sends no report of its own. A fact that leaves while its option is on,
such as a title the session no longer has, goes out as the set without it and stays owed until the router confirms that
report. Each registration until then sends the set again, also after a reload of the mod, since the mod keeps the last
set it sent and the owed mark in the plugin's host state beside its tracked work. A router that does not know
`session_facts` refuses each facts report with status 400, and the mod drops it with one debug line and sends the set
again only once it changes or the router acknowledges a registration.

With Agent reports on, an `agent_facts` report carries a subagent's description, its type and its name, read from the
spawn call and from then on from the client's agent list, and states the whole set as `session_facts` does. It goes out
only for an agent the router acknowledged, behind its start, and each lifecycle report that may go out passes it. An
agent that ends while its start is out is the one exception to that order: its set goes out once, ahead of its release,
since the router holds the run only until then. Facts the router refuses for an agent it does not hold are dropped and
never start an agent, and the set goes out again behind the agent's next acknowledged start. A clear the router has not
acknowledged survives a reload, as the session's does. A description or a name is cut at 256 bytes on a whole character,
and a type over 256 bytes is left out. A workflow's agents and main report none.

<a id="the-owner-header"></a>

## The instance header

At session start the mod fences the process: it mints one v4 uuid, the instance id, and writes one
`X-Phoebis-Instance-Id: <instance id>` line into `ANTHROPIC_CUSTOM_HEADERS`. That line replaces any line of the same
header already there, whatever the case of the header's name, and the variable keeps its other lines. Claude Code sends
the header on each model request of the process, and each report names the same id, so the router can tell this
process's requests from another process's on the same session id. A `/clear` or a `/resume` keeps the id, since the
instance is the process.

Claude Code holds the plugin's own state per session, and that state survives a hot reload of the module. The mod keeps
the instance in that state under each session id it adopts: at session start, and at the first prompt after a `/clear`
or a `/resume` moves the process to another id. The mod also keeps the instance in the plugin's store under one key for
each client process, `identity:<process id>`, for the newest eight processes. The store outlives the session, so a
reload that comes before the first prompt under a new id finds the instance there while the store still holds the key of
the process. A reload reuses the instance while the header line still names it, so the line stays as it is, and the
router's session keeps its instance. A child process inherits the line but runs as another process, for which the store
holds no instance, so it mints its own and registers under it. Where Claude Code cannot run the command that reads the
process's identity, a reload that comes before the first prompt under a new id mints a new instance. A child process
that never runs the fence keeps the parent's line: one on a client that does not load the mod
([Install](install.md#install)), one with the mod disabled, or one without a URL or a key. That line matters only for a
child that sends the parent's session id.

A `session_start` the router refuses with a bare `instance_conflict`, since another instance holds the session under a
live lease, leaves the session live. The mod writes one line to the transcript, `phoebis-companion: another instance
reports session <id>, so the start is retried once its lease lapses`, and sends the start again under its backoff, from
one second up to thirty and every thirty seconds from then on. Claude Code shows each of the mod's transcript lines
under the mod's name. Once the holder's 90-second lease lapses, the router names the silent holder, and the mod's next
start takes the session over with `previous_instance_id`: the router replaces the session's agents, the next requests
arm recipes again, and the mod writes `phoebis-companion: took over session <id> from a silent instance`.

What the router does with a request whose instance header names another instance than the session's registration is on
the router's page [The companion mod](../router/companion-mod.md), under "An instance mismatch".

## What the mod leaves alone

The mod runs one shell command at load, `echo $PPID`, to read the client process's identity. With Project reports on it
also runs `git symbolic-ref --short -q HEAD` to read the branch, and it runs no other command. It hooks two
settings-hook events, `classic.Stop` and `classic.SubagentStop`, for the background list they carry. With Session title
reports on it also hooks `classic.SessionStart` and `classic.UserPromptSubmit` and reads their title member and their
session id alone, never a prompt's text. It reads no transcript, no background command's output and no conversation
text. It reads no file. It keeps the keys `identity:<process id>` in its own store, which Claude Code holds as a file
under the user's configuration directory, and its settings live where Claude Code keeps a plugin's configuration, the
Router key in its secure storage.
