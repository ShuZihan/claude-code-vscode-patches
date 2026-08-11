# Patch inventory

The repository currently adds these personal features to the official extension:

- Codex-like responsive conversation width and message navigation rail.
- Native Markdown rendering for user questions and live Markdown presentation in the composer.
- Copy-as-Markdown actions for assistant answers, user questions, and tables.
- VS Code-themed fenced-code highlighting, code-block selection fixes, and compact tables.
- Right-side editor-group reuse, Markdown preview opening, and a prominent maximize/restore action.
- Codex-like active-plan progress and per-turn changed-file statistics with hover popovers.
- Provider-agnostic balance/usage presentation with the first adapter for DeepSeek.
- Visible unofficial custom-build identity in the extension list and sidebar titles.
- Typography and spacing adjustments that remain materially different from vendor defaults.

Release builds currently target macOS Apple Silicon (`darwin-arm64`) and Windows x64
(`win32-x64`).

The build does not modify the VS Code application bundle. All runtime changes stay inside the
`anthropic.claude-code` extension directory.

## Compatibility policy

Minified vendor bundles are patched with exact, counted anchors. A build stops when any anchor is
missing or ambiguous. This is intentional: an official update must never produce a partially
patched release.

Patch files contain only custom code, CSS overlays, and short compatibility anchors. Official
VSIX files and Anthropic binaries are downloaded during the build and are not committed here.
