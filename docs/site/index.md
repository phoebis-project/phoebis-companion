# Phoebis Companion

This part is for the operator installing and configuring the companion mod on a client machine. The mod is a Claude Code
plugin that runs inside the Claude Code process. It reports session liveness and agent state to the router, which the
router's keepalive engine reads to decide which sessions' prompt caches to keep warm, checks the router at session start
and names a misconfiguration in the session, and gives the model one tool, `allowance`, which reads what the key's pool
has left so the model can pace its own work. The mod reports facts and holds no policy: every ceiling and switch belongs
to the router ([Keepalive](../router/keepalive.md)), and what a key's companion may do is a permission set on the key
([The key's permissions](../router/companion-mod.md#the-keys-permissions)).

[Install and settings](install.md) covers installing the mod, its settings and the variables they fall back to.
[The start check](start-check.md) says what the mod asks the router at session start, and [The allowance
tool](allowance-tool.md) what the model reads through the tool. [What the mod reports](reports.md) lists each report
with the parks, the presence and the owner header, and [Development](development.md) says how to verify a checkout.

## Where it runs

The mod runs wherever Claude Code loads the plugin: the Agent SDK, `claude -p`, a cloud session that carries the plugin,
the Desktop app, the terminal and the VS Code extension's chat panel. It behaves the same everywhere: with a URL and a
key it reports, checks and answers the tool unless Claude Code refuses its fetch (see
[Configure](install.md#configure)), and without them it writes its one transcript line and does nothing else. A `claude
-p` run registers, reports its turns, its background commands and its subagents, and ends its session when it exits. The
mod draws nothing beyond the toasts of the start check. Its messages are the transcript lines of
[Configure](install.md#configure) and [The start check](start-check.md), the conflict line and the takeover line of [The
owner header](reports.md#the-owner-header), and the lines in Claude Code's debug log: a dropped report, a refused key, a
report whose fetch threw, a start hook that threw, a tool registration the engine refused, the allowance permission the
operator withheld, and the client process's identity read at load.
