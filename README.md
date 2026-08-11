# Unofficial Claude Code for VS Code patches

> **Unofficial.** This is a personal patch-and-build repository. It is not affiliated with,
> endorsed by, or supported by Anthropic or Microsoft.

This repository downloads the official `anthropic.claude-code` VSIX, applies a deterministic set
of personal UI and workflow patches, verifies the result, and publishes a private GitHub Release
named `claude-code-vscode-custom-<version>.vsix`.

No official VSIX, Anthropic executable, API key, account data, or VS Code application file is
committed to the repository.

## What it changes

See [PATCHES.md](PATCHES.md) for the maintained feature inventory. The important boundary is that
all runtime modifications remain inside the Claude Code extension; VS Code itself is not patched.

## Reproducible build

Requirements: Node.js 20 or newer, `unzip`, and `zip`.

```bash
npm test
node scripts/build.mjs \
  --vsix /path/to/official-darwin-arm64.vsix \
  --version 2.1.226
```

The result is written to `dist/claude-code-vscode-custom-<version>.vsix`.

The patcher uses exact match counts for every minified-bundle anchor. Missing or ambiguous anchors
fail the build before packaging. `scripts/verify-patch.mjs` then checks package identity, required
features, JavaScript syntax, archive integrity, and obvious secret material.

## Upstream automation

The scheduled workflow wakes daily, but the Marketplace request is gated by persisted elapsed
time. It performs a real upstream query only after at least 48 hours, avoiding the irregular
month-boundary behavior of day-of-month cron expressions.

When a version has no matching custom Release, the workflow:

1. Downloads the official `darwin-arm64` VSIX.
2. Applies and verifies the patches.
3. Publishes `v<version>-custom.1` with the custom VSIX asset.
4. Opens one GitHub issue if an upstream change breaks a compatibility anchor.

Manual workflow runs bypass the 48-hour gate.

## Installation and updates

Install a Release asset with VS Code's **Extensions: Install from VSIX** command, or with the VS
Code CLI:

```bash
code --install-extension claude-code-vscode-custom-<version>.vsix --force
```

VS Code disables automatic updates by default for extensions installed from VSIX. GitHub Releases
therefore provide the update source. After `gh auth login`, the included updater can install the
latest private Release:

```bash
node scripts/update-installed.mjs --dry-run
node scripts/update-installed.mjs
```

For unattended updates, schedule that command locally after the repository is cloned. Do not
re-enable Marketplace auto-update for this extension, because it would replace the custom build
with the official package.

On this Mac, the included LaunchAgent template runs the updater once when loaded and then every
172800 seconds (48 hours). It records the installed Release tag and asset digest, verifies the
downloaded SHA-256 when GitHub provides one, and refuses to downgrade a newer installed version.

Official references:

- [Install from VSIX](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix)
- [Package and publish extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

## Repository visibility and rights

Keep this repository private unless you have independently confirmed that redistribution of the
resulting official-derived VSIX is permitted. Anthropic's original extension and executable remain
subject to Anthropic's terms; this repository makes no claim over them.
