# Terminal Font Setting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a web-only setting that lets users choose the xterm terminal font from presets or a custom CSS font-family string.

**Architecture:** Store one resolved CSS `font-family` string in client settings, derive preset/custom UI state from that value, and apply it directly to existing xterm instances. Keep preset matching and custom commit validation in a small web helper module so the large settings panel stays thin.

**Tech Stack:** TypeScript, React, Effect Schema, xterm, Vite+ browser/unit tests.

## Global Constraints

- `vp check` and `vp run typecheck` must pass before considering the task complete.
- The setting is web-only; do not change native mobile terminal code.
- The setting applies only to xterm terminal panes, not global mono typography, chat code, diffs, terminal context chips, or mobile.
- Persist the setting through client-only settings, not server settings.
- Use TDD: write each failing test before production code.
- Do not edit `.repos/`.

---

## File Structure

- Modify `packages/contracts/src/settings.ts`: export terminal font defaults and add `terminalFontFamily` to client settings schemas.
- Modify `packages/contracts/src/settings.test.ts`: cover default decoding, normalization, and invalid client setting values.
- Create `apps/web/src/terminalFontSettings.ts`: define preset ids/stacks and custom commit helpers.
- Create `apps/web/src/terminalFontSettings.test.ts`: cover preset matching and custom input behavior.
- Modify `apps/web/src/components/settings/SettingsPanels.tsx`: add the `Terminal font` row and reset/restore-defaults integration.
- Modify `apps/web/src/components/settings/SettingsPanels.browser.tsx`: assert the General settings row renders and reveals custom input.
- Modify `apps/web/src/components/ThreadTerminalDrawer.tsx`: read the setting and apply it to xterm on mount and live changes without remounting.
- Modify `apps/web/src/components/ThreadTerminalDrawer.browser.tsx`: assert xterm receives and live-updates the configured font without disposal.

---

### Task 1: Client Settings Schema

**Files:**
- Modify: `packages/contracts/src/settings.ts`
- Test: `packages/contracts/src/settings.test.ts`

**Interfaces:**
- Produces: `DEFAULT_TERMINAL_FONT_FAMILY: string`
- Produces: `MAX_TERMINAL_FONT_FAMILY_LENGTH: number`
- Produces: `TerminalFontFamily` schema and type
- Produces: `ClientSettings["terminalFontFamily"]`
- Produces: `ClientSettingsPatch["terminalFontFamily"]`

- [ ] **Step 1: Write the failing contract tests**

Add these imports in `packages/contracts/src/settings.test.ts`:

```ts
import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  DEFAULT_TERMINAL_FONT_FAMILY,
  MAX_TERMINAL_FONT_FAMILY_LENGTH,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";
```

Replace the existing settings import with the block above, then add these decoders near the existing decoder constants:

```ts
const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
```

Append this test block:

```ts
describe("ClientSettings terminalFontFamily", () => {
  it("defaults missing terminalFontFamily to the current terminal stack", () => {
    const decoded = decodeClientSettings({});

    expect(decoded.terminalFontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
  });

  it("trims custom terminal font settings while decoding settings and patches", () => {
    const decoded = decodeClientSettings({
      terminalFontFamily: '  "Berkeley Mono", "JetBrains Mono", monospace  ',
    });
    const patch = decodeClientSettingsPatch({
      terminalFontFamily: '  "Cascadia Code", Consolas, monospace  ',
    });

    expect(decoded.terminalFontFamily).toBe('"Berkeley Mono", "JetBrains Mono", monospace');
    expect(patch.terminalFontFamily).toBe('"Cascadia Code", Consolas, monospace');
  });

  it("rejects blank, control-character, and overlong terminal font values", () => {
    expect(() => decodeClientSettings({ terminalFontFamily: "   " })).toThrow();
    expect(() =>
      decodeClientSettings({ terminalFontFamily: '"Bad Font"\\nmonospace' }),
    ).toThrow();
    expect(() =>
      decodeClientSettings({
        terminalFontFamily: "a".repeat(MAX_TERMINAL_FONT_FAMILY_LENGTH + 1),
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the contract tests and verify they fail**

Run: `vp test packages/contracts/src/settings.test.ts`

Expected: FAIL because `ClientSettingsSchema`, `ClientSettingsPatch`, `DEFAULT_TERMINAL_FONT_FAMILY`, and `MAX_TERMINAL_FONT_FAMILY_LENGTH` do not yet expose terminal font support.

- [ ] **Step 3: Add terminal font schema support**

Add these exports after `DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT`:

```ts
export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace';
export const MAX_TERMINAL_FONT_FAMILY_LENGTH = 240;

const TERMINAL_FONT_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

export const TerminalFontFamily = TrimmedNonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(MAX_TERMINAL_FONT_FAMILY_LENGTH)),
  Schema.check(
    Schema.makeFilter((value) => !TERMINAL_FONT_CONTROL_CHARACTER_PATTERN.test(value), {
      expected: "font family without control characters",
    }),
  ),
);
export type TerminalFontFamily = typeof TerminalFontFamily.Type;
```

Add the field to `ClientSettingsSchema` near the other display preferences:

```ts
terminalFontFamily: TerminalFontFamily.pipe(
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_TERMINAL_FONT_FAMILY)),
),
```

Add the field to `ClientSettingsPatch`:

```ts
terminalFontFamily: Schema.optionalKey(TerminalFontFamily),
```

- [ ] **Step 4: Run the contract tests and verify they pass**

Run: `vp test packages/contracts/src/settings.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts
git commit -m "feat: add terminal font client setting"
```

---

### Task 2: Terminal Font Preset Helpers

**Files:**
- Create: `apps/web/src/terminalFontSettings.ts`
- Test: `apps/web/src/terminalFontSettings.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_TERMINAL_FONT_FAMILY`, `MAX_TERMINAL_FONT_FAMILY_LENGTH`
- Produces: `TERMINAL_FONT_CUSTOM_PRESET_ID`
- Produces: `TERMINAL_FONT_PRESETS`
- Produces: `resolveTerminalFontPresetId(fontFamily: string): TerminalFontPresetId`
- Produces: `resolveTerminalFontFamilyForPreset(presetId: TerminalFontPresetId, fallbackFontFamily: string): string`
- Produces: `resolveCustomTerminalFontFamilyCommit(input: string): TerminalFontFamilyCommitResult`

- [ ] **Step 1: Write the failing helper tests**

Create `apps/web/src/terminalFontSettings.test.ts`:

```ts
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  MAX_TERMINAL_FONT_FAMILY_LENGTH,
} from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  TERMINAL_FONT_CUSTOM_PRESET_ID,
  TERMINAL_FONT_PRESETS,
  resolveCustomTerminalFontFamilyCommit,
  resolveTerminalFontFamilyForPreset,
  resolveTerminalFontPresetId,
} from "./terminalFontSettings";

describe("terminal font settings", () => {
  it("maps known font stacks to preset ids and unknown stacks to Custom", () => {
    expect(resolveTerminalFontPresetId(DEFAULT_TERMINAL_FONT_FAMILY)).toBe("default");
    expect(
      resolveTerminalFontPresetId('"Cascadia Code", "Cascadia Mono", Consolas, monospace'),
    ).toBe("cascadia-code");
    expect(resolveTerminalFontPresetId('"Berkeley Mono", monospace')).toBe(
      TERMINAL_FONT_CUSTOM_PRESET_ID,
    );
  });

  it("resolves preset ids to CSS font-family strings", () => {
    expect(resolveTerminalFontFamilyForPreset("default", '"Other", monospace')).toBe(
      DEFAULT_TERMINAL_FONT_FAMILY,
    );
    expect(resolveTerminalFontFamilyForPreset("custom", '"Other", monospace')).toBe(
      '"Other", monospace',
    );
    expect(TERMINAL_FONT_PRESETS.map((preset) => preset.id)).toEqual([
      "default",
      "jetbrains-mono",
      "sf-mono",
      "cascadia-code",
      "fira-code",
      "source-code-pro",
      "menlo",
      "consolas",
    ]);
  });

  it("normalizes custom input commits", () => {
    expect(resolveCustomTerminalFontFamilyCommit("   ")).toEqual({
      ok: true,
      fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    });
    expect(resolveCustomTerminalFontFamilyCommit('  "Berkeley Mono", monospace  ')).toEqual({
      ok: true,
      fontFamily: '"Berkeley Mono", monospace',
    });
  });

  it("rejects custom input with control characters or excessive length", () => {
    expect(resolveCustomTerminalFontFamilyCommit('"Bad"\\nmonospace')).toEqual({
      ok: false,
      message: "Terminal font cannot contain line breaks or control characters.",
    });
    expect(resolveCustomTerminalFontFamilyCommit("a".repeat(MAX_TERMINAL_FONT_FAMILY_LENGTH + 1)))
      .toEqual({
        ok: false,
        message: `Terminal font must be ${MAX_TERMINAL_FONT_FAMILY_LENGTH} characters or fewer.`,
      });
  });
});
```

- [ ] **Step 2: Run the helper tests and verify they fail**

Run: `vp test apps/web/src/terminalFontSettings.test.ts`

Expected: FAIL because `apps/web/src/terminalFontSettings.ts` does not exist.

- [ ] **Step 3: Implement the helper module**

Create `apps/web/src/terminalFontSettings.ts`:

```ts
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  MAX_TERMINAL_FONT_FAMILY_LENGTH,
} from "@t3tools/contracts/settings";

export const TERMINAL_FONT_CUSTOM_PRESET_ID = "custom" as const;

export type TerminalFontPresetId =
  | "default"
  | "jetbrains-mono"
  | "sf-mono"
  | "cascadia-code"
  | "fira-code"
  | "source-code-pro"
  | "menlo"
  | "consolas"
  | typeof TERMINAL_FONT_CUSTOM_PRESET_ID;

export interface TerminalFontPreset {
  readonly id: Exclude<TerminalFontPresetId, typeof TERMINAL_FONT_CUSTOM_PRESET_ID>;
  readonly label: string;
  readonly fontFamily: string;
}

export type TerminalFontFamilyCommitResult =
  | { readonly ok: true; readonly fontFamily: string }
  | { readonly ok: false; readonly message: string };

const TERMINAL_FONT_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

export const TERMINAL_FONT_PRESETS = [
  {
    id: "default",
    label: "Default",
    fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    fontFamily: '"JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
  },
  {
    id: "sf-mono",
    label: "SF Mono",
    fontFamily: '"SF Mono", "SFMono-Regular", Menlo, Consolas, monospace',
  },
  {
    id: "cascadia-code",
    label: "Cascadia Code",
    fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
  },
  {
    id: "fira-code",
    label: "Fira Code",
    fontFamily: '"Fira Code", "JetBrains Mono", Consolas, monospace',
  },
  {
    id: "source-code-pro",
    label: "Source Code Pro",
    fontFamily: '"Source Code Pro", "JetBrains Mono", Consolas, monospace',
  },
  {
    id: "menlo",
    label: "Menlo",
    fontFamily: 'Menlo, "SF Mono", Consolas, monospace',
  },
  {
    id: "consolas",
    label: "Consolas",
    fontFamily: 'Consolas, "Liberation Mono", "JetBrains Mono", monospace',
  },
] as const satisfies ReadonlyArray<TerminalFontPreset>;

export function resolveTerminalFontPresetId(fontFamily: string): TerminalFontPresetId {
  return (
    TERMINAL_FONT_PRESETS.find((preset) => preset.fontFamily === fontFamily)?.id ??
    TERMINAL_FONT_CUSTOM_PRESET_ID
  );
}

export function resolveTerminalFontFamilyForPreset(
  presetId: TerminalFontPresetId,
  fallbackFontFamily: string,
): string {
  if (presetId === TERMINAL_FONT_CUSTOM_PRESET_ID) {
    return fallbackFontFamily;
  }
  return (
    TERMINAL_FONT_PRESETS.find((preset) => preset.id === presetId)?.fontFamily ??
    DEFAULT_TERMINAL_FONT_FAMILY
  );
}

export function resolveCustomTerminalFontFamilyCommit(
  input: string,
): TerminalFontFamilyCommitResult {
  const fontFamily = input.trim();
  if (fontFamily.length === 0) {
    return { ok: true, fontFamily: DEFAULT_TERMINAL_FONT_FAMILY };
  }
  if (fontFamily.length > MAX_TERMINAL_FONT_FAMILY_LENGTH) {
    return {
      ok: false,
      message: `Terminal font must be ${MAX_TERMINAL_FONT_FAMILY_LENGTH} characters or fewer.`,
    };
  }
  if (TERMINAL_FONT_CONTROL_CHARACTER_PATTERN.test(fontFamily)) {
    return {
      ok: false,
      message: "Terminal font cannot contain line breaks or control characters.",
    };
  }
  return { ok: true, fontFamily };
}
```

- [ ] **Step 4: Run the helper tests and verify they pass**

Run: `vp test apps/web/src/terminalFontSettings.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/web/src/terminalFontSettings.ts apps/web/src/terminalFontSettings.test.ts
git commit -m "feat: add terminal font preset helpers"
```

---

### Task 3: General Settings UI

**Files:**
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`
- Modify: `apps/web/src/components/settings/SettingsPanels.browser.tsx`

**Interfaces:**
- Consumes: helpers from `apps/web/src/terminalFontSettings.ts`
- Consumes: `settings.terminalFontFamily`
- Produces: `Terminal font` row directly after `Theme`

- [ ] **Step 1: Write the failing browser test**

In `apps/web/src/components/settings/SettingsPanels.browser.tsx`, add `DEFAULT_CLIENT_SETTINGS` to the contracts import:

```ts
DEFAULT_CLIENT_SETTINGS,
```

Add these tests inside `describe("GeneralSettingsPanel observability", ...)`, near the existing General settings test:

```ts
it("shows the terminal font setting and custom input for custom fonts", async () => {
  const desktopBridge = createDesktopBridgeStub();
  vi.mocked(desktopBridge.getClientSettings).mockResolvedValue({
    ...DEFAULT_CLIENT_SETTINGS,
    terminalFontFamily: '"Berkeley Mono", monospace',
  });
  window.desktopBridge = desktopBridge;
  setServerConfigSnapshot(createBaseServerConfig());

  mounted = await renderWithTestRouter(
    <AppAtomRegistryProvider>
      <GeneralSettingsPanel />
    </AppAtomRegistryProvider>,
  );

  await expect
    .element(page.getByRole("heading", { name: "Terminal font", exact: true }))
    .toBeInTheDocument();
  await expect.element(page.getByLabelText("Terminal font preference")).toHaveTextContent(
    "Custom",
  );
  await expect.element(page.getByLabelText("Custom terminal font")).toHaveValue(
    '"Berkeley Mono", monospace',
  );
});

it("hides custom terminal font input for preset fonts", async () => {
  window.desktopBridge = createDesktopBridgeStub();
  setServerConfigSnapshot(createBaseServerConfig());

  mounted = await renderWithTestRouter(
    <AppAtomRegistryProvider>
      <GeneralSettingsPanel />
    </AppAtomRegistryProvider>,
  );

  await expect
    .element(page.getByRole("heading", { name: "Terminal font", exact: true }))
    .toBeInTheDocument();
  await expect.element(page.getByLabelText("Terminal font preference")).toHaveTextContent(
    "Default",
  );
  await expect.element(page.getByLabelText("Custom terminal font")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the browser test and verify it fails**

Run: `vp test apps/web/src/components/settings/SettingsPanels.browser.tsx -t "terminal font setting"`

Expected: FAIL because the settings panel has no `Terminal font` row yet.

- [ ] **Step 3: Implement the settings row**

In `apps/web/src/components/settings/SettingsPanels.tsx`, add imports:

```ts
import {
  TERMINAL_FONT_CUSTOM_PRESET_ID,
  TERMINAL_FONT_PRESETS,
  resolveCustomTerminalFontFamilyCommit,
  resolveTerminalFontFamilyForPreset,
  resolveTerminalFontPresetId,
  type TerminalFontPresetId,
} from "../../terminalFontSettings";
```

In `useSettingsRestore`, add `Terminal font` to `changedSettingLabels`:

```ts
...(settings.terminalFontFamily !== DEFAULT_UNIFIED_SETTINGS.terminalFontFamily
  ? ["Terminal font"]
  : []),
```

Add `settings.terminalFontFamily` to that memo dependency list, and add this to the `restoreDefaults` patch:

```ts
terminalFontFamily: DEFAULT_UNIFIED_SETTINGS.terminalFontFamily,
```

Inside `GeneralSettingsPanel`, after `isGitWritingModelDirty`, add:

```ts
const terminalFontPresetId = resolveTerminalFontPresetId(settings.terminalFontFamily);
```

Then insert this row immediately after the existing `Theme` row:

```tsx
<SettingsRow
  title="Terminal font"
  description="Choose the font used by terminal panes."
  resetAction={
    settings.terminalFontFamily !== DEFAULT_UNIFIED_SETTINGS.terminalFontFamily ? (
      <SettingResetButton
        label="terminal font"
        onClick={() =>
          updateSettings({
            terminalFontFamily: DEFAULT_UNIFIED_SETTINGS.terminalFontFamily,
          })
        }
      />
    ) : null
  }
  control={
    <Select
      value={terminalFontPresetId}
      onValueChange={(value) => {
        const presetId = value as TerminalFontPresetId;
        updateSettings({
          terminalFontFamily: resolveTerminalFontFamilyForPreset(
            presetId,
            settings.terminalFontFamily,
          ),
        });
      }}
    >
      <SelectTrigger className="w-full sm:w-44" aria-label="Terminal font preference">
        <SelectValue>
          {terminalFontPresetId === TERMINAL_FONT_CUSTOM_PRESET_ID
            ? "Custom"
            : TERMINAL_FONT_PRESETS.find((preset) => preset.id === terminalFontPresetId)?.label ??
              "Default"}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {TERMINAL_FONT_PRESETS.map((preset) => (
          <SelectItem hideIndicator key={preset.id} value={preset.id}>
            {preset.label}
          </SelectItem>
        ))}
        <SelectItem hideIndicator value={TERMINAL_FONT_CUSTOM_PRESET_ID}>
          Custom
        </SelectItem>
      </SelectPopup>
    </Select>
  }
>
  {terminalFontPresetId === TERMINAL_FONT_CUSTOM_PRESET_ID ? (
    <div className="mt-3 pb-3">
      <DraftInput
        className="w-full font-mono text-xs"
        value={settings.terminalFontFamily}
        onCommit={(next) => {
          const result = resolveCustomTerminalFontFamilyCommit(next);
          if (!result.ok) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not update terminal font",
                description: result.message,
              }),
            );
            return;
          }
          updateSettings({ terminalFontFamily: result.fontFamily });
        }}
        placeholder={DEFAULT_UNIFIED_SETTINGS.terminalFontFamily}
        spellCheck={false}
        aria-label="Custom terminal font"
      />
    </div>
  ) : null}
</SettingsRow>
```

- [ ] **Step 4: Run the browser test and verify it passes**

Run: `vp test apps/web/src/components/settings/SettingsPanels.browser.tsx -t "terminal font setting"`

Expected: PASS.

- [ ] **Step 5: Run the helper tests again**

Run: `vp test apps/web/src/terminalFontSettings.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/web/src/components/settings/SettingsPanels.tsx apps/web/src/components/settings/SettingsPanels.browser.tsx
git commit -m "feat: add terminal font setting UI"
```

---

### Task 4: Terminal Runtime Application

**Files:**
- Modify: `apps/web/src/components/ThreadTerminalDrawer.tsx`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.browser.tsx`

**Interfaces:**
- Consumes: `settings.terminalFontFamily`
- Produces: live xterm font updates without terminal disposal or reattach

- [ ] **Step 1: Write the failing terminal browser tests**

In `apps/web/src/components/ThreadTerminalDrawer.browser.tsx`, extend the hoisted test harness:

```ts
terminalInstances: [] as Array<{ options: Record<string, unknown> }>,
settingsHarness: {
  terminalFontFamily:
    '"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace',
},
```

Destructure `terminalInstances` and `settingsHarness` from the hoisted object.

Add this mock before importing `TerminalViewport`:

```ts
vi.mock("~/hooks/useSettings", () => ({
  useSettings: (selector?: (settings: { terminalFontFamily: string }) => unknown) => {
    const settings = { terminalFontFamily: settingsHarness.terminalFontFamily };
    return selector ? selector(settings) : settings;
  },
}));
```

Update the mock terminal constructor to retain options:

```ts
options: Record<string, unknown>;

constructor(options: Record<string, unknown>) {
  this.options = { ...options };
  terminalInstances.push(this);
  terminalConstructorSpy(options);
}
```

Clear `terminalInstances` and reset `settingsHarness.terminalFontFamily` in `afterEach`.

Add these tests to `describe("TerminalViewport", ...)`:

```ts
it("passes the configured terminal font to xterm on mount", async () => {
  const environment = createEnvironmentApi();
  environmentApiById.set("environment-a", environment);
  settingsHarness.terminalFontFamily = '"Cascadia Code", Consolas, monospace';

  const mounted = await mountTerminalViewport({
    threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
  });

  try {
    await vi.waitFor(() => {
      expect(terminalConstructorSpy).toHaveBeenCalledTimes(1);
    });

    expect(terminalConstructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        fontFamily: '"Cascadia Code", Consolas, monospace',
      }),
    );
  } finally {
    await mounted.cleanup();
  }
});

it("updates the xterm font live without recreating the terminal", async () => {
  const environment = createEnvironmentApi();
  environmentApiById.set("environment-a", environment);
  settingsHarness.terminalFontFamily = '"Cascadia Code", Consolas, monospace';

  const mounted = await mountTerminalViewport({
    threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
  });

  try {
    await vi.waitFor(() => {
      expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
    });

    settingsHarness.terminalFontFamily = '"Fira Code", "JetBrains Mono", monospace';
    await mounted.rerender({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    await vi.waitFor(() => {
      expect(terminalInstances[0]?.options.fontFamily).toBe(
        '"Fira Code", "JetBrains Mono", monospace',
      );
    });
    expect(terminalConstructorSpy).toHaveBeenCalledTimes(1);
    expect(terminalDisposeSpy).not.toHaveBeenCalled();
    expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
    expect(environment.terminal.resize).toHaveBeenCalled();
  } finally {
    await mounted.cleanup();
  }
});
```

- [ ] **Step 2: Run the terminal browser tests and verify they fail**

Run: `vp test apps/web/src/components/ThreadTerminalDrawer.browser.tsx -t "terminal font"`

Expected: FAIL because `TerminalViewport` does not read or live-apply `terminalFontFamily`.

- [ ] **Step 3: Implement terminal font mount and live update**

In `apps/web/src/components/ThreadTerminalDrawer.tsx`, import `useSettings`:

```ts
import { useSettings } from "../hooks/useSettings";
```

Inside `TerminalViewport`, after the existing refs, add:

```ts
const terminalFontFamily = useSettings((settings) => settings.terminalFontFamily);
const terminalFontFamilyRef = useRef(terminalFontFamily);
```

Add an effect to keep the ref current:

```ts
useEffect(() => {
  terminalFontFamilyRef.current = terminalFontFamily;
}, [terminalFontFamily]);
```

Change the `new Terminal` options from the hard-coded `fontFamily` to:

```ts
fontFamily: terminalFontFamilyRef.current,
```

Add this live-update effect after the mount effect:

```ts
useEffect(() => {
  const api = readEnvironmentApi(environmentId);
  const terminal = terminalRef.current;
  const fitAddon = fitAddonRef.current;
  if (!api || !terminal || !fitAddon) return;
  if (terminal.options.fontFamily === terminalFontFamily) return;

  const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
  terminal.options.fontFamily = terminalFontFamily;
  const frame = window.requestAnimationFrame(() => {
    fitTerminalSafely(fitAddon);
    if (wasAtBottom) {
      terminal.scrollToBottom();
    }
    void api.terminal
      .resize({
        threadId,
        terminalId,
        cols: terminal.cols,
        rows: terminal.rows,
      })
      .catch(() => undefined);
  });

  return () => {
    window.cancelAnimationFrame(frame);
  };
}, [environmentId, terminalFontFamily, terminalId, threadId]);
```

- [ ] **Step 4: Run the terminal browser tests and verify they pass**

Run: `vp test apps/web/src/components/ThreadTerminalDrawer.browser.tsx -t "terminal font"`

Expected: PASS.

- [ ] **Step 5: Run the broader terminal drawer tests**

Run: `vp test apps/web/src/components/ThreadTerminalDrawer.test.ts apps/web/src/components/ThreadTerminalDrawer.browser.tsx`

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add apps/web/src/components/ThreadTerminalDrawer.tsx apps/web/src/components/ThreadTerminalDrawer.browser.tsx
git commit -m "feat: apply terminal font setting to xterm"
```

---

### Task 5: Final Verification

**Files:**
- No new implementation files.
- Verify all files changed by Tasks 1-4.

**Interfaces:**
- Consumes: all task outputs.
- Produces: verified branch state.

- [ ] **Step 1: Run focused tests**

Run:

```bash
vp test packages/contracts/src/settings.test.ts apps/web/src/terminalFontSettings.test.ts apps/web/src/components/settings/SettingsPanels.browser.tsx apps/web/src/components/ThreadTerminalDrawer.test.ts apps/web/src/components/ThreadTerminalDrawer.browser.tsx
```

Expected: PASS.

- [ ] **Step 2: Run required project checks**

Run:

```bash
vp check
vp run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git status --short
git diff --stat HEAD
```

Expected: only intended terminal-font-setting files are modified.

- [ ] **Step 4: Commit any verification-only fixes**

Only if Step 1 or Step 2 required code fixes, commit them:

```bash
git add packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts apps/web/src/terminalFontSettings.ts apps/web/src/terminalFontSettings.test.ts apps/web/src/components/settings/SettingsPanels.tsx apps/web/src/components/settings/SettingsPanels.browser.tsx apps/web/src/components/ThreadTerminalDrawer.tsx apps/web/src/components/ThreadTerminalDrawer.browser.tsx
git commit -m "fix: stabilize terminal font setting"
```

Expected: no commit is needed if all previous task commits already pass.
