import {
  MAX_SCRIPT_ID_LENGTH,
  SCRIPT_RUN_COMMAND_PATTERN,
  type KeybindingCommand,
  type ProjectScript,
  type ProjectScriptIcon,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);
export const DEFAULT_PROJECT_SCRIPT_ICON: ProjectScriptIcon = "play";

export interface CreateProjectScriptInput {
  readonly name: string;
  readonly command: string;
  readonly existingIds: Iterable<string>;
  readonly icon?: ProjectScriptIcon | undefined;
  readonly runOnWorktreeCreate?: boolean | undefined;
  readonly previewUrl?: string | null | undefined;
  readonly autoOpenPreview?: boolean | undefined;
}

export type ProjectScriptUpsertResult =
  | {
      readonly action: "created";
      readonly scripts: ReadonlyArray<ProjectScript>;
      readonly script: ProjectScript;
    }
  | {
      readonly action: "updated";
      readonly scripts: ReadonlyArray<ProjectScript>;
      readonly previousScript: ProjectScript;
      readonly script: ProjectScript;
    };

export type ProjectScriptRemoveResult =
  | {
      readonly removed: true;
      readonly scripts: ReadonlyArray<ProjectScript>;
      readonly script: ProjectScript;
    }
  | {
      readonly removed: false;
      readonly scripts: ReadonlyArray<ProjectScript>;
    };

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

function normalizeScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) return "script";
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) return cleaned;
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

export const commandForProjectScript = (scriptId: string): KeybindingCommand =>
  SCRIPT_RUN_COMMAND_PATTERN.make(`script.${scriptId}.run`);

export function projectScriptIdFromCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!isScriptRunCommand(trimmed)) return null;
  const [prefix, , suffix] = SCRIPT_RUN_COMMAND_PATTERN.parts;
  return trimmed.slice(prefix.literal.length, -suffix.literal.length);
}

export function nextProjectScriptId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(Array.from(existingIds));
  const baseId = normalizeScriptId(name);
  if (!taken.has(baseId)) return baseId;

  let suffix = 2;
  while (suffix < 10_000) {
    const candidate = `${baseId}-${suffix}`;
    const safeCandidate =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safeCandidate)) return safeCandidate;
    suffix += 1;
  }

  return `${baseId}-${Effect.runSync(Clock.currentTimeMillis)}`.slice(0, MAX_SCRIPT_ID_LENGTH);
}

export function createProjectScript(input: CreateProjectScriptInput): ProjectScript {
  const previewUrl = input.previewUrl?.trim();
  return {
    id: nextProjectScriptId(input.name, input.existingIds),
    name: input.name,
    command: input.command,
    icon: input.icon ?? DEFAULT_PROJECT_SCRIPT_ICON,
    runOnWorktreeCreate: input.runOnWorktreeCreate ?? false,
    ...(previewUrl ? { previewUrl } : {}),
    ...(previewUrl && input.autoOpenPreview ? { autoOpenPreview: true } : {}),
  };
}

export function upsertProjectScript(
  scripts: readonly ProjectScript[],
  script: ProjectScript,
): ProjectScriptUpsertResult {
  const existingIndex = scripts.findIndex((candidate) => candidate.id === script.id);
  const normalize = (candidate: ProjectScript): ProjectScript =>
    script.runOnWorktreeCreate && candidate.id !== script.id
      ? { ...candidate, runOnWorktreeCreate: false }
      : candidate;

  if (existingIndex === -1) {
    return {
      action: "created",
      script,
      scripts: [...scripts.map(normalize), script],
    };
  }

  const previousScript = scripts[existingIndex]!;
  return {
    action: "updated",
    previousScript,
    script,
    scripts: scripts.map((candidate, index) =>
      index === existingIndex ? script : normalize(candidate),
    ),
  };
}

export function removeProjectScript(
  scripts: readonly ProjectScript[],
  scriptId: string,
): ProjectScriptRemoveResult {
  const script = scripts.find((candidate) => candidate.id === scriptId);
  if (!script) return { removed: false, scripts };
  return {
    removed: true,
    script,
    scripts: scripts.filter((candidate) => candidate.id !== scriptId),
  };
}

export function primaryProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  const regular = scripts.find((script) => !script.runOnWorktreeCreate);
  return regular ?? scripts[0] ?? null;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    T3CODE_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.T3CODE_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}
