# Development

`claude --plugin-dir <checkout>` loads a checkout for one session.

## Verify

From a checkout of the companion repository:

```sh
claude plugin validate .
claude plugin validate --strict .
claude plugin test .
```

The validation passes with no warning. Its listing of the hooks module is the statement of what the mod does: the events
it hooks, the engine calls it makes, the variables it reads and writes (it writes `ANTHROPIC_CUSTOM_HEADERS` and
`PHOEBIS_KEEPALIVE_INSTANCE` and no other), and the state values `types/index.d.ts` declares. The gating hooks sit where
a hook could refuse what was asked, on `agent.spawn`, `classic.Stop`, `classic.SubagentStop`, `prompt.submit` and
`tool.call`. Each passes its event on unchanged, and its `.catch` passes the event on when the mod fails, so the mod
refuses no prompt, tool call, spawn or stop. The settings hooks on `config.set` refuse a Management URL as
[Configure](install.md#configure) states and nothing else.

`claude plugin test` runs the cases in `hooks/*.test.ts`. They replay the event logs under `hooks/fixtures/`, recorded
from Claude Code sessions, and hand-built events where no log shows a row, against a stubbed router whose answers each
case scripts, on a clock the case advances. No test opens a socket.

A hooks module may import sibling files of the plugin (checked on Claude Code 2.1.319).

Where the console shows a session the mod reports is on the router's page [The companion
mod](../router/companion-mod.md), under "The Sessions view".

## The start check and the plugin API

Two answers from the plugin API types of Claude Code 2.1.304, the `claude-code.d.ts` that build's engine lays beside a
loaded mod, settle how the start check runs:

**Hook budget.** `HookBudget.ms` gives a hook 10 seconds per dispatch, and the clock stops while a `next(e)` call or any
`$` call of the hook's is in flight, a `$.clock` wait excepted. The start check's three-second `$.clock.sleep` counts
against the budget and its GET does not, so both fit.

**Tool registration.** The doc of `$.tool.register` says a name registered again is replaced, and the call rejects until
the session binds, at `session.start`. A reload runs `session.start` again and registers the same tool under the same
name, which replaces the registration without a second entry in the tool list.
