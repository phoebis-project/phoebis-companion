# Install and settings

## Install

Inside Claude Code:

```text
/plugin marketplace add phoebis-project/phoebis-marketplace
/plugin install phoebis-companion@phoebis
```

The install line resolves once the marketplace is added. From a shell, `claude plugin marketplace add` and
`claude plugin install` take the same arguments. For development, `claude --plugin-dir <checkout>` loads a checkout of
[the companion repository](https://github.com/phoebis-project/phoebis-companion) for one session.

The mod needs Claude Code 2.1.299 or later. An older client runs the session without the mod: its engine refuses the
hooks module and writes the refusal to Claude Code's debug log. A foreground headless run with text output that loads a
checkout with `--plugin-dir` also writes it to its error output (both checked on Claude Code 2.1.287 and 2.1.296). A
start with `--debug-file <path>` writes the debug log to the file at that path (checked on Claude Code 2.1.287, 2.1.296
and 2.1.328).

## Configure

Claude Code asks for the mod's settings when it installs the mod, and the `/plugin` menu changes them later. The mod
needs a URL to report to and read from, and the router key to do so under. It takes each from the first source that has
one:

| Setting | Default | Fallback when empty |
| --- | --- | --- |
| Management URL (`management_url`): where to report and to read | empty | `ANTHROPIC_BASE_URL` |
| Router key (`token`): the key, kept in Claude Code's secure storage | empty | `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN` |
| Session reports (`reports`): whether the mod reports the session, its agents and their states | on | none |
| Cache warming (`cache_warming`): whether the router keeps this session's prompt caches warm | on | none |
| Start check toasts (`notifications`): whether a start check's transcript line also raises a toast | on | none |
| Agent reports (`report_agents`): whether each subagent's description, type and name are reported | off | none |
| Project reports (`report_project`): whether the project directory, the repository and the branch are reported | off | none |
| Session title reports (`report_title`): whether the session's custom title is reported | off | none |

An empty or blank value counts as unset. The three variables rank as Claude Code ranks them when it picks its own
credential, so the key the mod reports under is the key the client sends. When Claude Code already reaches the router
through `ANTHROPIC_BASE_URL` with a router key in `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN`, both fields can stay empty. Without a URL or without a key from any source the mod writes one
transcript line, `phoebis-companion: no management URL from the option or ANTHROPIC_BASE_URL` or `phoebis-companion: no
router key from the option or the environment`, and does nothing else. A URL from either source that fails the check
below writes `phoebis-companion: the management URL from the option or ANTHROPIC_BASE_URL is not usable (<reason>)`
instead, and the mod does nothing else either. Claude Code shows each of the mod's transcript lines under the mod's
name.

A key set in Router key goes to the Management URL alone and never to the host `ANTHROPIC_BASE_URL` names. The settings
are user-level: Claude Code reads a plugin's configuration from the user's settings file, a `--settings` file or managed
settings, and never from a repository's project or local settings file. A repository therefore cannot change a setting,
but a project's settings `env` block can set `ANTHROPIC_BASE_URL`, so that URL serves the environment's own token alone.
With Router key set and Management URL empty, the mod sends nothing and writes `phoebis-companion: the token setting
needs the Management URL, so this session reports nothing` to the transcript.

The URL may carry a path prefix, such as `https://gateway.example/router`. The mod drops one trailing slash and appends
the route to what is left. It accepts plain HTTP on any host, as the model traffic to the same base URL does. A save of
the Management URL is refused with `an http or https URL with a host` for a value that is not one (an empty value is
accepted, since empty means the environment), with `a URL with a username or password` for a credential inside the URL,
with `a URL with a query` for a `?`, and with `a URL with a fragment` for a `#`. The session start runs the same check
on the URL it resolves, from the option or from `ANTHROPIC_BASE_URL`, so a value edited by hand into a settings file or
a base URL with a query or a fragment reaches no request, and the start line names the reason. The Router key is trimmed
when it is saved. The mod's requests go through Claude Code's fetch, so the plugin network access policy described below
applies to them and Claude Code handles their TLS.

With `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` set, Claude Code checks the organization's policy for plugin network
access before a mod's first fetch, against `api.anthropic.com` with the credential it holds. A router key fails that
check, and every report and read is then refused inside the process. `CLAUDE_CODE_SUBSCRIPTION_TYPE=max` beside a router
key in `CLAUDE_CODE_OAUTH_TOKEN` marks the session a consumer subscription, which no organization policy governs, so the
check is skipped and the requests go out. Claude Code documents that variable nowhere. [The environment
block](../router/client.md#the-environment-block) on the router's page The client carries it, and
[`CLAUDE_CODE_SUBSCRIPTION_TYPE`](../router/client.md#claude_code_subscription_type) there says what the client does
with it.

With Session reports off, the mod sends no report, and the start check and the tool still run. With Cache warming off,
the mod reports as before, and its registration tells the router to keep no prompt of the session, so the router warms
no cache for it. The option needs Session reports on. The backoff, the heartbeat interval, the presence throttle, the
request limit, the start check's wait, the tool's cache and the write limit are constants, and the mod has no other
setting. A report that did not get through, for a transport failure, a 5xx, a limit or no answer within the request
limit of 10 seconds, goes out again along a fixed backoff. A heartbeat goes out at a share of the remaining lease,
within fixed bounds, and both figures are on [The relay](../router/relay.md#the-companion-protocol). A presence report
goes out at most once a minute ([Presence](reports.md#presence)).

With Session title reports on, the mod reports the title a `/rename` gave the session, for the console's [Sessions
view](../router/console.md#sessions). The option needs Session reports on. Turned off, it clears the title it reported
at the next start of the session ([Reported facts](reports.md#reported-facts)). With Project reports on, the mod reports
the branch, the project directory, the repository as `host/path`, the repository's root and the working directory of the
session. This option needs Session reports on too. Turned off, it clears what it reported at the next start of the
session. With Agent reports on, the mod reports each subagent's description, its type and its name. It needs Session
reports on as well. Turned off, it drops what it reported at the session's next registration: a running session
registers again when the option changes, and a session that does not run registers at its next start. A session that
nobody starts again keeps its agents' names, types and descriptions until the router's request retention, 365 days by
default. Each of these options works on every client the mod loads on, and where a client lacks what a fact is read
from, the mod leaves that fact out and reports the rest.
