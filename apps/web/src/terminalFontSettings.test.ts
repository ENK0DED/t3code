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
    expect(
      resolveCustomTerminalFontFamilyCommit("a".repeat(MAX_TERMINAL_FONT_FAMILY_LENGTH + 1)),
    ).toEqual({
      ok: false,
      message: `Terminal font must be ${MAX_TERMINAL_FONT_FAMILY_LENGTH} characters or fewer.`,
    });
  });
});
