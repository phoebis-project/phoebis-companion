# Development

`claude --plugin-dir <checkout>` loads a checkout for one session.

## Verify

From a checkout of the companion repository:

```sh
claude plugin validate .
claude plugin validate --strict .
claude plugin test .
```

The validation passes with no warning (checked on Claude Code 2.1.328). Its listing of the hooks module is the statement
of what the mod does: the events it hooks, the engine calls it makes, the variables it reads and writes (it writes
`ANTHROPIC_CUSTOM_HEADERS` and no other), and the state values `types/index.d.ts` declares. The gating hooks sit where a
hook could refuse what was asked, on `agent.spawn`, `classic.SessionStart`, `classic.Stop`, `classic.SubagentStop`,
`classic.UserPromptSubmit`, `prompt.submit` and `tool.call`, the hooks on `classic.SessionStart` and
`classic.UserPromptSubmit` only with Session title reports on. Each passes its event on unchanged, and its `.catch`
passes the event on when the mod fails, so the mod refuses no prompt, tool call, spawn or stop. The settings hooks on
`config.set` refuse a Management URL as [Configure](install.md#configure) states and nothing else.

`claude plugin test` runs the cases in `hooks/*.test.ts` (checked on Claude Code 2.1.299 and 2.1.328). They replay the
event logs under `hooks/fixtures/`, recorded from sessions of Claude Code 2.1.287 and 2.1.328, and hand-built events
where no log shows a row, against a stubbed router whose answers each case scripts, on a clock the case advances. No
test opens a socket.

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

## Releasing

A release of the companion is a GitHub release with no asset. The `Release` workflow guards it and then writes the
release's tag and commit into the entry `phoebis-companion` of the catalog, `phoebis-project/phoebis-marketplace`, with
the token of a GitHub App. The App's client id is the variable `CATALOG_APP_CLIENT_ID` and its key the secret
`CATALOG_APP_PRIVATE_KEY` of the environment `catalog`. The workflow runs on a published release, on a manual dispatch,
and on a pull request that touches a file the guard reads (`.claude-plugin/plugin.json`, the workflow or
`docs/site/changelog.md`). To release:

1. Run the three commands of [Verify](#verify) at the commit, since no workflow runs them.
2. Set `version` in `.claude-plugin/plugin.json` to the version (`X.Y.Z`, or `X.Y.Z-rc.1` for a prerelease), rename the
   changelog's `## Unreleased` heading to `## X.Y.Z`, or write that section where no change opened one, and merge to
   `main`. The changelog's heading and the release's tag are the version exactly as this step sets it, a suffix
   included: `## X.Y.Z-rc.1` and the tag `X.Y.Z-rc.1` for a prerelease. A commit on `main` reaches no installed user
   ahead of a release, and a release reaches one only under a raised version, since Claude Code takes a plugin's version
   from the manifest.
3. Run the manual dispatch (Actions, Release, Run workflow) on `main` as the dry run. It proves the guard, the App's
   token and the read of the catalog: the job `catalog` prints the entry that a release of the manifest's version would
   write, and it writes nothing.
4. Create the release on GitHub with the tag `X.Y.Z`, no `v` prefix, at the commit that the dry run proved, with the
   version as its title and a link to the [changelog](changelog.md) in its notes. Publishing it starts the workflow.
5. The workflow's guard refuses the release when the manifest states no version
   (`.claude-plugin/plugin.json states no version`) or states one that is not `X.Y.Z` or `X.Y.Z-suffix`, a number with a
   leading zero included (`.claude-plugin/plugin.json states a version that is not X.Y.Z or X.Y.Z-suffix`), when the tag
   has another form (`release tag '{TAG}' is not X.Y.Z or X.Y.Z-suffix`), when it differs from the manifest's version
   (`release tag '{TAG}' differs from the version '{version}' in .claude-plugin/plugin.json`), or when it has no section
   in the changelog (`docs/site/changelog.md has no '## {TAG}' section for this release`). On a dispatch and on a pull
   request the guard reads the manifest's version in the place of a tag
   (`docs/site/changelog.md has no '## {version}' section for the manifest's version`). Behind the guard a full release
   writes the entry: the job `catalog` sets the entry's source to the companion's `https://` address with the tag as its
   `ref` and the tagged commit as its `sha`, in one commit on the catalog's `main` with the message
   `Name phoebis-companion X.Y.Z`. A prerelease, which is a tag with a suffix or a release that GitHub marks as one,
   writes nothing. A release whose version is not higher than the one that the catalog names is refused
   (`the catalog names '{ref}', which is not lower than '{TAG}', so the catalog stays`), so a release cut from an
   earlier line takes no user back.

No step by hand follows a release: the catalog names the release once its run ends, and a checkout of the catalog takes
the workflow's commit with a fast-forward pull. A release whose run fails for a reason in its commit is deleted with its
tag and created again at the corrected commit behind a green dry run, as long as the run did not write the catalog. Once
the catalog names the release, the correction ships as the next patch version. A change that a user sees writes its
entry under `## Unreleased`, the first section of the [changelog](changelog.md), and step 2 renames that heading to the
version.
