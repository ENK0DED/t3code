import type { CommandId, EnvironmentId, OrchestrationCommand, ProjectId } from "@t3tools/contracts";
import { DEFAULT_MODEL, ProviderInstanceId } from "@t3tools/contracts";
import {
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  normalizeProjectPathForComparison,
  resolveProjectPathForDispatch,
} from "./projectPaths.ts";

export {
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
  resolveProjectPathForDispatch,
} from "./projectPaths.ts";

export function resolveAddProjectPath(input: {
  readonly rawPath: string;
  readonly currentProjectCwd?: string | null;
  readonly platform: string;
}): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string } {
  const rawPath = input.rawPath.trim();
  if (rawPath.length === 0) {
    return { ok: false, error: "Enter a project path." };
  }
  if (isUnsupportedWindowsProjectPath(rawPath, input.platform)) {
    return { ok: false, error: "Windows-style paths are only supported on Windows environments." };
  }
  if (isExplicitRelativeProjectPath(rawPath) && !input.currentProjectCwd) {
    return { ok: false, error: "Relative paths require an active project in this environment." };
  }
  const path = resolveProjectPathForDispatch(rawPath, input.currentProjectCwd);
  return path.length === 0 ? { ok: false, error: "Enter a project path." } : { ok: true, path };
}

export function findExistingAddProject<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot?: string;
    readonly cwd?: string;
  },
>(input: {
  readonly projects: ReadonlyArray<T>;
  readonly environmentId: EnvironmentId;
  readonly path: string;
}): T | null {
  const normalizedCandidate = normalizeProjectPathForComparison(input.path);
  if (normalizedCandidate.length === 0) {
    return null;
  }

  return (
    input.projects.find((project) => {
      if (project.environmentId !== input.environmentId) {
        return false;
      }
      const workspaceRoot = project.workspaceRoot ?? project.cwd;
      return workspaceRoot
        ? normalizeProjectPathForComparison(workspaceRoot) === normalizedCandidate
        : false;
    }) ?? null
  );
}

export function buildProjectCreateCommand(input: {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly createdAt: string;
  readonly createWorkspaceRootIfMissing?: boolean;
}): Extract<OrchestrationCommand, { type: "project.create" }> {
  return {
    type: "project.create",
    commandId: input.commandId,
    projectId: input.projectId,
    title: inferProjectTitleFromPath(input.workspaceRoot),
    workspaceRoot: input.workspaceRoot,
    createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing ?? true,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: DEFAULT_MODEL,
    },
    createdAt: input.createdAt,
  };
}
