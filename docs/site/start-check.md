# The start check

At session start, once the settings resolve to a URL and a key, the mod sends one read of the allowance route, `GET
/v0/companion/allowance?session_id=<id>` ([The companion routes](../router/relay.md#the-companion-routes)), before and
apart from the keepalive registration, and waits up to three seconds for the answer. The answer settles three things at
once: whether a router answers at the URL, whether the key is valid, and whether the key may read the allowance.

The rows that register the tool hold on Claude Code 2.1.293 or later. Between 2.1.287, the oldest client the mod runs
on, and that version, the mod makes the same check and writes one line to Claude Code's debug log in place of
registering the tool ([Install](install.md#install)). The lifecycle reports of the `403` row go out while the setting
Cache warming reports is on ([Configure](install.md#configure)).

| Answer | What the mod does |
| --- | --- |
| `200` with the allowance body | Registers the tool and keeps the body as the first entry of the tool's cache. No line. |
| `403` with the code `companion_not_permitted` | Registers no tool, since the operator withheld the permission, and writes `phoebis-companion: this key may not read the allowance` to Claude Code's debug log alone. The lifecycle reports still go out. |
| `401` | Writes `phoebis-companion: the router at <url> refused the key (401), so this session reports nothing` to the transcript, registers no tool, and empties the keepalive queue, as a `401` on the keepalive route does. |
| anything else | Writes `phoebis-companion: no answer from the router at <url> (<status, failure or "not the allowance">), the allowance tool answers once it is back` to the transcript and registers the tool anyway. |

The last row covers a transport failure, a `5xx`, another `4xx`, the three-second limit, and a `200` whose body is not
the allowance, such as the console page the admin listener serves for an unknown path when the Management URL names the
admin listener in place of the proxy listener. The tool is registered anyway because the tool list sits at the front of
the prompt's cached prefix: a tool that appears later in the session rewrites the whole prefix once, and a resumed
session pays for its whole conversation. While the router stays unreachable, a call of the tool answers the failure's
text. The keepalive part retries along its backoff as [The relay](../router/relay.md#the-keepalive-protocol) states.

With Start check toasts on, each transcript line the mod writes at session start, the three lines
[Configure](install.md#configure) names for an unset setting included, also raises a toast with the same text. A failure
text, the URL included, has its secrets redacted before it reaches a transcript line, a toast or a tool result, since a
fetch error can carry the bearer.

A reload of the plugin runs the start check again, with the tool's cache cleared first, so a reload under a changed URL
or key never answers the earlier configuration's body, and registers the same tool under the same name, which replaces
the registration without a second entry in the tool list. A reload or a later start whose check does not refuse the key
clears the refusal an earlier `401` left and registers the session again, so a key fixed in the `/plugin` menu needs no
restart. A `401` on the keepalive route also unconfigures the tool: until such a start, a call answers that the session
has no usable router configuration, and sends no request. A `403` on the keepalive route empties the queue as a `401`
does but leaves the tool reading: it comes from something in front of the router, so it refuses the request and not the
key. It says nothing about whether the key may read the allowance, which the tool's own route answers.
