# Terminal Font Setting Design

## Context

T3 Code's web terminal is rendered by xterm in `TerminalViewport`. The terminal
currently hard-codes the CSS font-family stack:

```text
"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace
```

Users need a web-only setting that lets them choose the terminal pane font. This
setting does not apply to the native mobile terminal, chat mono text, terminal
context chips, diff code, or other non-terminal surfaces.

## Goals

- Add a web-only terminal font setting.
- Support both common presets and custom CSS font-family strings.
- Preserve the current font stack as the default and fallback.
- Apply font changes immediately to open terminal panes without remounting or
  reattaching terminal sessions.
- Store the setting through the existing client-only settings path.

## Non-Goals

- Do not change mobile native terminal font handling.
- Do not change the global mono font token or chat/code typography.
- Do not add installed-font detection.
- Do not add Nerd Fonts catalog support in this slice.

## Data Model

Add `terminalFontFamily` to `ClientSettingsSchema`.

The setting is a trimmed CSS font-family string. Its decoding default is the
current hard-coded terminal stack:

```text
"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace
```

Add `terminalFontFamily` to `ClientSettingsPatch` so `useUpdateSettings()` routes
it to client persistence.

Validation accepts any trimmed non-empty CSS font-family string, caps length, and
rejects line breaks/control characters. Blank custom input in the UI resolves to
the default stack rather than storing an empty string.

Persisting the resolved CSS string keeps runtime behavior simple. The settings UI
derives whether the value is a known preset by comparing the stored string to the
preset table; unmatched strings are displayed as `Custom`.

## Settings UI

Add a `Terminal font` row to `GeneralSettingsPanel`, directly after `Theme`.

The select entries are:

- `Default`
- `JetBrains Mono`
- `SF Mono`
- `Cascadia Code`
- `Fira Code`
- `Source Code Pro`
- `Menlo`
- `Consolas`
- `Custom`

Choosing a preset stores that preset's CSS font-family stack. Choosing `Custom`
shows a `DraftInput` prefilled with the current resolved stack so users can edit
from their current value. Committing a blank custom value resets to the default
stack.

The row uses the existing settings reset button pattern when
`terminalFontFamily` differs from the default.

## Terminal Runtime

`TerminalViewport` reads `terminalFontFamily` through `useSettings`.

On terminal mount, xterm receives:

```ts
fontFamily: terminalFontFamily
```

Font changes must not be added to the main terminal mount effect dependency list.
Instead, a separate effect updates the existing xterm instance:

1. Set `terminal.options.fontFamily`.
2. Capture whether the terminal was scrolled to the bottom.
3. Run `fitTerminalSafely(fitAddon)`.
4. Restore bottom scroll when appropriate.
5. Send `api.terminal.resize({ cols, rows })` with the recalculated terminal size.

This applies the setting immediately without disposing the xterm instance,
dropping history, or reattaching the terminal session.

## Tests

Implementation should be test-first.

Add or update tests for:

- Client settings schema: missing `terminalFontFamily` decodes to the default,
  valid custom strings decode, and invalid blank/control-character values are
  rejected or normalized away before persistence.
- Settings logic/UI: known CSS stacks map to their preset select value, unknown
  strings map to `Custom`, and blank custom input resolves to the default stack.
- Terminal browser behavior: `TerminalViewport` passes the configured font to
  xterm on mount, and changing settings updates xterm options without disposing
  or recreating the terminal.

Before the task is considered complete, `vp check` and `vp run typecheck` must
pass.

## Future Consideration: Nerd Fonts

Nerd Fonts support can be added later as a separate metadata-backed preset
feature. The Nerd Fonts repository exposes metadata such as `fonts.json`, but
its `master` paths are not considered stable and cloning the repository is not
recommended because of size. A future slice should use a pinned release artifact
or generated metadata snapshot rather than relying on live repository paths.
