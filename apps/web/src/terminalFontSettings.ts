import * as Schema from "effect/Schema";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  MAX_TERMINAL_FONT_FAMILY_LENGTH,
  TerminalFontFamily,
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

const decodeTerminalFontFamily = Schema.decodeUnknownSync(TerminalFontFamily);

function hasControlCharacter(value: string): boolean {
  return value.split("").some((char) => char.charCodeAt(0) <= 0x1f || char.charCodeAt(0) === 0x7f);
}

function formatTerminalFontFamilyError(fontFamily: string): string {
  if (hasControlCharacter(fontFamily)) {
    return "Terminal font cannot contain line breaks or control characters.";
  }
  if (fontFamily.length > MAX_TERMINAL_FONT_FAMILY_LENGTH) {
    return `Terminal font must be ${MAX_TERMINAL_FONT_FAMILY_LENGTH} characters or fewer.`;
  }
  return "Terminal font must be a valid terminal font family.";
}

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

  try {
    return { ok: true, fontFamily: decodeTerminalFontFamily(fontFamily) };
  } catch {
    return {
      ok: false,
      message: formatTerminalFontFamilyError(fontFamily),
    };
  }
}
