<!-- markdownlint-disable-file MD033 MD041 -->
<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="Phoebis Companion" width="360">
  </picture>
</div>

Phoebis Companion is a Claude Code plugin for sessions that reach Claude through Phoebis Router. The mod reports session
liveness and agent state to the router, which reads the reports to decide which sessions' prompt caches to keep warm. At
session start it checks the router once and names a misconfiguration in the session, and it gives the model one tool,
`allowance`, which reads what the key's pool has left so the model can pace its own work. The mod reports facts and
holds no policy: every ceiling and switch belongs to the router, and what a key's companion may do is a permission set
on the key.

The [companion mod page](https://github.com/daystrom-labs/phoebis/blob/main/docs/site/companion-mod.md) of the
documentation site covers the start check, the tool, what the mod reports and the key's permissions in full.

## Install

Inside Claude Code:

```text
/plugin marketplace add daystrom-labs/phoebis-marketplace
/plugin install phoebis-companion@phoebis
```

From a shell, `claude plugin marketplace add` and `claude plugin install` take the same arguments. The mod needs Claude
Code 2.1.287 or later, and on an older client it does nothing. The `allowance` tool needs 2.1.293 or later: on a client
between the two versions the mod reports and runs its start check, and writes one line to Claude Code's debug log in
place of registering the tool.

## Settings

Claude Code asks for the settings when it installs the mod, and the `/plugin` menu changes them later. The mod needs a
URL to report to and read from, and the router key to do so under. It takes each from the first source that has one, and
an empty or blank value counts as unset.

| Setting | Default | Fallback when empty |
| --- | --- | --- |
| Management URL (`management_url`) | empty | `ANTHROPIC_BASE_URL` |
| Router key (`token`) | empty | `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN` |
| Cache warming reports (`keepalive`) | on | none |
| Start check toasts (`notifications`) | on | none |

Management URL is where the mod reports to and reads from. It may carry a path prefix, and the mod appends each route to
it. Router key is the key the mod reports under, kept in Claude Code's secure storage. A key set there goes to the
Management URL alone and never to the host `ANTHROPIC_BASE_URL` names. With Cache warming reports off, the mod sends no
keepalive event, and the start check and the tool still run. With Start check toasts on, each transcript line the mod
writes at session start also raises a toast with the same text.

## Development

`claude --plugin-dir <checkout>` loads a checkout for one session. From the checkout:

```sh
claude plugin validate .
claude plugin test .
```

The tests in `hooks/*.test.ts` run against a stubbed router on a mocked clock, and no test opens a socket. A hooks
module may import sibling files of the plugin (checked on Claude Code 2.1.319).

Two answers from the plugin API types of Claude Code 2.1.304, the `claude-code.d.ts` that build's engine lays beside a
loaded mod, settle how the start check runs:

**Hook budget.** `HookBudget.ms` gives a hook 10 seconds per dispatch, and the clock stops while a `next(e)` call or any
`$` call of the hook's is in flight, a `$.clock` wait excepted. The start check's three-second `$.clock.sleep` counts
against the budget and its GET does not, so both fit.

**Tool registration.** The doc of `$.tool.register` says a name registered again is replaced, and the call rejects until
the session binds, at `session.start`. A reload runs `session.start` again and registers the same tool under the same
name, which replaces the registration without a second entry in the tool list.

## License

Released under the MIT license. See [`LICENSE`](LICENSE) for the full text.
