# The allowance tool

The mod declares one tool, `allowance`, which takes no input and sits in the prompt's tool list, so the model sees it
from its first turn and calls it as `mcp__phoebis-companion__allowance`. A call answers the router's JSON body as text,
from a cache of ten seconds or a fresh read of the allowance route, so a model that calls twice inside ten seconds reads
one answer and the router sees one request. A read that fails answers a short text naming the failure, marked as an
error for the model and never thrown, and only a body that is the allowance is cached. The tool's description tells the
model what the answer holds and when a call pays: before a long autonomous run, before a fan-out of subagents, and after
a turn that felt slow. It proposes no model or effort change and names no account by anything but its pseudonym.

The answer is the key's pool as the router reads it at that instant. The protocol page lists every field with its type
([The companion routes](../router/relay.md#the-companion-routes)). This page says what the model learns from each part.

`pool` carries the pool's `pinning` mode and its `strategy`. `accounts` holds one entry per active account of the pool
under its pseudonym `id`, with its `funding` (`plan`, `usage_based` or `api_key`), its rate-limit `tier`, the
`obstacle`, a hold the selector keeps on the whole account at that instant (`budget`, `budget_unknown`, `cooldown`,
`overage` or `spent`, the last for a usage-based seat at its spend cap, and `null` with no such hold, where each
window's `fit` says whether new work lands), the `slow_down` in force on it or `null`, its `windows`, and its `spend`,
one row per spend budget the ledger has reported for the account, with the period, the dollars spent, the budget
and the period's end.

`windows` holds one entry per plan window the account has a reading of, keyed by the window id (`five_hour`,
`seven_day`, or a model's own week, as [The windows the router works
from](../router/routing.md#the-windows-the-router-works-from) names them), and is empty for an API-key account.
`utilization` is the share used now, from 0 to 1 of the window. `burn_per_hour` is the share the account's sessions burn
in an hour, and `demand_per_hour` what they would burn with no slow-down holding them. `horizon_at` is the window's
reset, or the account's subscription end when that comes first, and `null` where neither is known.
`projected_at_horizon` is the predicted share at the earlier of `horizon_at` and five hours from now. `ceiling` is the
share of the window the pool fills an account to, the pool's 5-hour ceiling on `five_hour` and its weekly ceiling on the
other windows. `fit` is the word a fresh placement reads on the window for a request that prices no rewrite: `fits`
where a fresh session at the pool's usual burn stays under the ceiling until the earlier of `horizon_at` and five hours
from now, `rewrite_only` where a request still lands under the ceiling and the usual burn after it reaches the ceiling
before that instant, `least_bad` at or over the ceiling, `ending` where the window has allowance left and the account is
inside its wind-down, and `spent` where the share stands at 1.0 or more, so the window holds no allowance until
`horizon_at`. `runway_minutes` is the whole minutes until the share reaches the pool's ceiling at the current burn, with
the band's hours weighed as the projection weighs them ([The windows the router works
from](../router/routing.md#the-windows-the-router-works-from)): `0` at or above the ceiling, a number while the burn
would reach the ceiling before the window resets and before an end of the account's subscription that lies ahead, and
`null` where nothing bounds the runway, because nothing burns or because the window resets or the subscription ends
first.

`pins` holds one entry per pin of this session under the key: the `agent` (`main` or the subagent's id), the `model`,
the `account` by its pseudonym, when the pin was placed and last used, `warm` and `warm_until` for its cache entry, its
`runway_minutes` on the window that binds it (`binding_window`), read by the same rule as a window's with the account's
subscription end counted only while it lies ahead, and its `slow_down` figures.

A model reads the answer for pace alone. A window's `fit` says whether new work has room on it, and `fits` leaves room
for a long run or a fan-out. A `null` runway means that nothing burns, or that the window resets or the account's
subscription ends before the share reaches the ceiling. A short runway on the account a pin names means the pool is
close to its ceiling on that window at the current burn, and the model can finish its work before then, wait for the
reset where `horizon_at` names one, or spread its work out. Where `horizon_at` names the account's subscription end, the
quota left on the window is lost there. The router keeps the final say on placement: the tool steers no placement, no
pin and no shedding round.

The accounts are pseudonymous. An account's `id` is eight lowercase hexadecimal characters, a keyed digest of the
account's id under a key the router derives from its storage key, so the pseudonym is the same across sessions and
router restarts on one installation, differs between two installations, and reverses to nothing. The answer names no
label, email, account id, key id or notes field. The console shows each account's pseudonym as its Companion id on the
account's details, so an operator can tell which account the model named ([Accounts](../router/console.md#accounts)).
