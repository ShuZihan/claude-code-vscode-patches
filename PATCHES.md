# Patch inventory

The repository currently adds these personal features to the official extension:

- Codex-like responsive conversation width and message navigation rail.
- Native Markdown rendering for user questions and live Markdown presentation in the composer.
- Copy-as-Markdown actions for assistant answers, user questions, and tables.
- A Codex-style Fork action beside assistant-answer copy: it mirrors the next user
  message's normal Fork behavior, or duplicates the complete session at the latest answer,
  without rewinding workspace files.
- Native and custom Fork session discoverability: every fork receives a persisted title
  before its new tab opens, so large transcripts whose first prompt falls beyond the
  vendor's 64 KiB list scan still resume with their complete history. Forked transcript
  entries are also normalized to the `claude-vscode` entrypoint so the vendor does not
  hide them as SDK-generated sessions.
- VS Code-themed fenced-code highlighting with copy-safe source newlines, code-block selection fixes, and compact tables.
- Right-side editor-group reuse, Markdown preview opening, and a prominent maximize/restore action.
- Codex-like active-plan progress with checked completed steps, a rotating active-step
  ring, pending-step rings, a proportional blue overall ring, and per-turn changed-file
  statistics with hover popovers (including newly created files).
- Provider-agnostic balance/usage presentation with DeepSeek and New API-compatible adapters,
  per-chat project settings resolution, one extension-host 60-second refresh scheduler,
  a 60-second in-memory cache, manual cache-bypassing refresh, stale-result fallback, and
  in-flight request deduplication. No provider configuration file watcher is installed.
- Safe Webview lifecycle cleanup: the usage bridge captures each live Webview before
  registering its disposal callback, so closing or restoring chat/session views cannot
  leave a disposed view in the extension's active-view registry.
- Immediate session-list deletion feedback: locally hidden session IDs are excluded from
  both disk-backed sessions and open-editor `sessionStates`, preventing an open tab from
  recreating a deleted row until Reload. Failed host deletes roll the optimistic hide back.
- Stable completed-thinking durations without changing vendor labels: once the SDK replaces
  a streaming block with its non-partial final block, the displayed duration is frozen at that
  final block's timestamp even if a late stream event never supplies an explicit end time.
- Visible unofficial custom-build identity in the extension list and sidebar titles.
- Typography and spacing adjustments that remain materially different from vendor defaults.

Release builds currently target macOS Apple Silicon (`darwin-arm64`) and Windows x64
(`win32-x64`).

The current custom patch-set version is `custom.0.1.0`. It is combined with the untouched
official extension version in Release tags and asset names, such as
`v2.1.238-custom.0.1.0`.

The build does not modify the VS Code application bundle. All runtime changes stay inside the
`anthropic.claude-code` extension directory.

## Compatibility policy

Minified vendor bundles are patched with exact, counted anchors. A build stops when any anchor is
missing or ambiguous. This is intentional: an official update must never produce a partially
patched release.

Patch files contain only custom code, CSS overlays, and short compatibility anchors. Official
VSIX files and Anthropic binaries are downloaded during the build and are not committed here.
