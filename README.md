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

The documentation lives under [`docs/site/`](docs/site/index.md), starting with [Install and
settings](docs/site/install.md), and is published at <https://phoebis-project.github.io/phoebis-docs/> once GitHub Pages
is enabled for the documentation site. It covers the settings, the start check, the tool and what the mod reports in
full, and the key's permissions stand in the router's part of the same site.

## Install

Inside Claude Code:

```text
/plugin marketplace add phoebis-project/phoebis-marketplace
/plugin install phoebis-companion@phoebis
```

## License

Released under the MIT license. See [`LICENSE`](LICENSE) for the full text.
