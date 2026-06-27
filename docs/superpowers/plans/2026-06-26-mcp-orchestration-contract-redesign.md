# MCP Orchestration Contract Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved MCP orchestration contract redesign from `docs/superpowers/specs/2026-06-25-t3code-mcp-orchestration-design.md`.

**Architecture:** Keep MCP handlers thin and route all behavior through `McpOrchestrationService`. Use shared helpers for ProjectScript/Action construction and list invariants, sanitize MCP read responses instead of returning projection shells directly, and keep first-turn worktree bootstrap behavior in the existing bootstrap dispatcher path.

**Tech Stack:** TypeScript, Effect services/layers, Effect Schema, `effect/unstable/ai` tools, Vite+ tests, existing orchestration event/command contracts.

## Global Constraints

- `vp check` and `vp run typecheck` must pass before completion.
- Use `vp test` for targeted tests during implementation.
- Every orchestration MCP tool must use an explicit object-shaped parameter schema; do not use `Tool.EmptyParams`.
- Read tools may default to current MCP context; write tools require explicit target ids.
- Project Action read/list/mutation responses must never include `command`.
- `list_projects` must return only `id`, `title`, and `workspaceRoot`.
- `list_threads` must exclude `modelSelection`, `runtimeMode`, and `interactionMode`.
- `get_thread_settings` replaces `get_current_thread_settings`; do not keep the current-only tool.
- Archived threads are readable but rejected by non-read thread tools.
- Deleted projects/threads are inaccessible for normal reads and should produce state-specific write errors when detectable.
- Project Actions are called "Actions" in MCP descriptions and UI copy; internal `ProjectScript` names stay for this pass.
- Do not add Action execution, Action keybinding management, thread archive/unarchive, project delete/remove, or sidebar grouping MCP tools in this pass.

---

## Scope Check

The spec touches three related surfaces: shared ProjectScript helpers, MCP project/action tools, and MCP thread tools. They belong in one implementation plan because all three change the same orchestration toolkit and service contract. The tasks below are split so each produces a testable state before the next task.

## File Structure

- `packages/shared/src/projectScripts.ts`: shared ProjectScript construction, id generation, command parsing, setup-action lookup, upsert, and remove helpers.
- `packages/shared/src/projectScripts.test.ts`: shared helper tests moved/expanded from the web helper tests.
- `packages/shared/package.json`: already exports `./projectScripts`; keep it unchanged unless type paths drift.
- `apps/web/src/projectScripts.ts`: shrink to a compatibility re-export or remove helper implementations after imports move.
- `apps/web/src/projectScripts.test.ts`: either remove helper tests moved to shared or keep web-only command integration tests importing shared helpers.
- `apps/web/src/components/ChatView.tsx`: use shared create/upsert/remove helpers for Action save/update/delete while preserving keybinding behavior.
- `apps/web/src/components/ProjectScriptsControl.tsx`: keep UI copy as Actions; no MCP changes needed unless imports shift.
- `apps/server/src/mcp/toolkits/orchestration/tools.ts`: replace/add tool schemas and descriptions.
- `apps/server/src/mcp/toolkits/orchestration/handlers.ts`: wire new tool names to service methods and remove `get_current_thread_settings`.
- `apps/server/src/mcp/toolkits/orchestration/tools.test.ts`: schema invariants for explicit objects, hidden command fields, no `child_of_current`, and turn-start worktree fields.
- `apps/server/src/mcp/Services/McpOrchestrationService.ts`: service interfaces/result types for project details/settings, Action CRUD, and thread settings.
- `apps/server/src/mcp/Layers/McpOrchestrationService.ts`: service implementation and validation helpers.
- `apps/server/src/mcp/McpOrchestrationService.read.test.ts`: read contracts for projects, threads, settings, stale models, and archived reads.
- `apps/server/src/mcp/McpOrchestrationService.write.test.ts`: write contracts for project settings, Actions, archived/deleted guards, checkout validation, and model resolution.
- `apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts`: HTTP-level tool name/schema/dispatch coverage.
- `apps/server/src/orchestration/commandInvariants.test.ts`: keep max-depth tests aligned; add only if MCP changes reveal missing command-level invariant coverage.

---

### Task 1: Shared Project Action Helpers

**Files:**

- Modify: `packages/shared/src/projectScripts.ts`
- Create: `packages/shared/src/projectScripts.test.ts`
- Modify: `apps/web/src/projectScripts.ts`
- Modify: `apps/web/src/projectScripts.test.ts`
- Modify: `apps/web/src/components/ChatView.tsx`

**Interfaces:**

- Produces:
  - `DEFAULT_PROJECT_SCRIPT_ICON: ProjectScriptIcon`
  - `commandForProjectScript(scriptId: string): KeybindingCommand`
  - `projectScriptIdFromCommand(command: string): string | null`
  - `nextProjectScriptId(name: string, existingIds: Iterable<string>): string`
  - `primaryProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null`
  - `createProjectScript(input: CreateProjectScriptInput): ProjectScript`
  - `upsertProjectScript(scripts: readonly ProjectScript[], script: ProjectScript): ProjectScriptUpsertResult`
  - `removeProjectScript(scripts: readonly ProjectScript[], scriptId: string): ProjectScriptRemoveResult`
- Consumes:
  - `ProjectScript`, `ProjectScriptIcon`, `KeybindingCommand`, `MAX_SCRIPT_ID_LENGTH`, `SCRIPT_RUN_COMMAND_PATTERN` from `@t3tools/contracts`.

- [ ] **Step 1: Write failing shared helper tests**

Add `packages/shared/src/projectScripts.test.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";
import {
  commandForProjectScript,
  createProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  projectScriptCwd,
  projectScriptIdFromCommand,
  projectScriptRuntimeEnv,
  removeProjectScript,
  setupProjectScript,
  upsertProjectScript,
} from "./projectScripts.ts";

describe("projectScripts helpers", () => {
  it("builds and parses script run commands", () => {
    const command = commandForProjectScript("lint");
    expect(command).toBe("script.lint.run");
    expect(projectScriptIdFromCommand(command)).toBe("lint");
    expect(projectScriptIdFromCommand("terminal.toggle")).toBeNull();
  });

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("creates scripts with shared defaults", () => {
    expect(
      createProjectScript({
        name: "Test",
        command: "bun test",
        existingIds: [],
      }),
    ).toEqual({
      id: "test",
      name: "Test",
      command: "bun test",
      icon: "play",
      runOnWorktreeCreate: false,
    });
  });

  it("omits auto-open preview unless a preview URL is present", () => {
    expect(
      createProjectScript({
        name: "Dev",
        command: "bun dev",
        existingIds: [],
        autoOpenPreview: true,
      }).autoOpenPreview,
    ).toBeUndefined();
    expect(
      createProjectScript({
        name: "Dev",
        command: "bun dev",
        existingIds: ["dev"],
        previewUrl: "http://localhost:5173",
        autoOpenPreview: true,
      }),
    ).toMatchObject({
      id: "dev-2",
      previewUrl: "http://localhost:5173",
      autoOpenPreview: true,
    });
  });

  it("upserts scripts while preserving the single setup action invariant", () => {
    const scripts = [
      createProjectScript({
        name: "Setup",
        command: "bun install",
        existingIds: [],
        runOnWorktreeCreate: true,
      }),
      createProjectScript({
        name: "Test",
        command: "bun test",
        existingIds: ["setup"],
      }),
    ];
    const lint = createProjectScript({
      name: "Lint",
      command: "bun lint",
      existingIds: ["setup", "test"],
      icon: "lint",
      runOnWorktreeCreate: true,
    });

    const result = upsertProjectScript(scripts, lint);

    expect(result.action).toBe("created");
    expect(result.scripts.map((script) => [script.id, script.runOnWorktreeCreate])).toEqual([
      ["setup", false],
      ["test", false],
      ["lint", true],
    ]);
  });

  it("updates scripts in place and returns the previous script", () => {
    const scripts = [
      createProjectScript({ name: "Test", command: "bun test", existingIds: [] }),
      createProjectScript({ name: "Lint", command: "bun lint", existingIds: ["test"] }),
    ];

    const result = upsertProjectScript(scripts, {
      ...scripts[0]!,
      command: "bun test --run",
    });

    expect(result.action).toBe("updated");
    if (result.action === "updated") {
      expect(result.previousScript.command).toBe("bun test");
      expect(result.scripts.map((script) => script.command)).toEqual([
        "bun test --run",
        "bun lint",
      ]);
    }
  });

  it("removes scripts with an observable missing case", () => {
    const scripts = [createProjectScript({ name: "Test", command: "bun test", existingIds: [] })];

    expect(removeProjectScript(scripts, "missing")).toEqual({
      removed: false,
      scripts,
    });

    const result = removeProjectScript(scripts, "test");
    expect(result.removed).toBe(true);
    if (result.removed) {
      expect(result.script.id).toBe("test");
      expect(result.scripts).toEqual([]);
    }
  });

  it("resolves primary and setup scripts", () => {
    const scripts = [
      createProjectScript({
        name: "Setup",
        command: "bun install",
        existingIds: [],
        icon: "configure",
        runOnWorktreeCreate: true,
      }),
      createProjectScript({
        name: "Test",
        command: "bun test",
        existingIds: ["setup"],
        icon: "test",
      }),
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("test");
    expect(setupProjectScript(scripts)?.id).toBe("setup");
  });

  it("builds default runtime env for scripts", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      worktreePath: "/repo/worktree-a",
    });

    expect(env).toMatchObject({
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo/worktree-a",
    });
  });

  it("allows overriding runtime env values", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      extraEnv: {
        T3CODE_PROJECT_ROOT: "/custom-root",
        CUSTOM_FLAG: "1",
      },
    });

    expect(env.T3CODE_PROJECT_ROOT).toBe("/custom-root");
    expect(env.CUSTOM_FLAG).toBe("1");
    expect(env.T3CODE_WORKTREE_PATH).toBeUndefined();
  });

  it("prefers the worktree path for script cwd resolution", () => {
    expect(projectScriptCwd({ project: { cwd: "/repo" }, worktreePath: "/repo/worktree-a" })).toBe(
      "/repo/worktree-a",
    );
    expect(projectScriptCwd({ project: { cwd: "/repo" }, worktreePath: null })).toBe("/repo");
  });
});
```

- [ ] **Step 2: Run shared helper tests and confirm they fail**

Run:

```sh
vp test run packages/shared/src/projectScripts.test.ts
```

Expected: failure because `commandForProjectScript`, `nextProjectScriptId`, `primaryProjectScript`, `createProjectScript`, `upsertProjectScript`, and `removeProjectScript` are not exported from `@t3tools/shared/projectScripts`.

- [ ] **Step 3: Implement shared helpers**

Update `packages/shared/src/projectScripts.ts` by adding the moved helpers and new list helpers:

```ts
import {
  MAX_SCRIPT_ID_LENGTH,
  SCRIPT_RUN_COMMAND_PATTERN,
  type KeybindingCommand,
  type ProjectScript,
  type ProjectScriptIcon,
} from "@t3tools/contracts";
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

  return `${baseId}-${Date.now()}`.slice(0, MAX_SCRIPT_ID_LENGTH);
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
```

Keep the existing `projectScriptCwd`, `projectScriptRuntimeEnv`, and `setupProjectScript` exports in the same file.

- [ ] **Step 4: Update web imports and remove duplicate helper implementation**

Replace `apps/web/src/projectScripts.ts` with a re-export:

```ts
export {
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  projectScriptIdFromCommand,
} from "@t3tools/shared/projectScripts";
```

In `apps/web/src/components/ChatView.tsx`, import the shared list helpers:

```ts
import {
  createProjectScript,
  projectScriptCwd,
  projectScriptRuntimeEnv,
  removeProjectScript,
  upsertProjectScript,
} from "@t3tools/shared/projectScripts";
```

Then replace inline Action creation/update/delete list logic:

```ts
const nextScript = createProjectScript({
  name: input.name,
  command: input.command,
  existingIds: activeProject.scripts.map((script) => script.id),
  icon: input.icon,
  runOnWorktreeCreate: input.runOnWorktreeCreate,
  previewUrl: input.previewUrl,
  autoOpenPreview: input.autoOpenPreview,
});
const nextScripts = upsertProjectScript(activeProject.scripts, nextScript).scripts;
```

For update, preserve the existing id and previous command replacement:

```ts
const updatedScript: ProjectScript = {
  ...existingScript,
  name: input.name,
  command: input.command,
  icon: input.icon,
  runOnWorktreeCreate: input.runOnWorktreeCreate,
  ...(input.previewUrl ? { previewUrl: input.previewUrl } : { previewUrl: undefined }),
  ...(input.autoOpenPreview
    ? { autoOpenPreview: input.autoOpenPreview }
    : { autoOpenPreview: undefined }),
};
const nextScripts = upsertProjectScript(activeProject.scripts, updatedScript).scripts;
```

For delete:

```ts
const removed = removeProjectScript(activeProject.scripts, scriptId);
const nextScripts = removed.scripts;
const deletedName = removed.removed ? removed.script.name : undefined;
```

- [ ] **Step 5: Run helper and web tests**

Run:

```sh
vp test run packages/shared/src/projectScripts.test.ts apps/web/src/projectScripts.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add packages/shared/src/projectScripts.ts packages/shared/src/projectScripts.test.ts apps/web/src/projectScripts.ts apps/web/src/projectScripts.test.ts apps/web/src/components/ChatView.tsx
git commit -m "feat: share project action helpers"
```

---

### Task 2: Project Read And Settings Tools

**Files:**

- Modify: `apps/server/src/mcp/Services/McpOrchestrationService.ts`
- Modify: `apps/server/src/mcp/Layers/McpOrchestrationService.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/tools.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/handlers.ts`
- Modify: `apps/server/src/mcp/McpOrchestrationService.read.test.ts`
- Modify: `apps/server/src/mcp/McpOrchestrationService.write.test.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/tools.test.ts`

**Interfaces:**

- Produces:
  - `getProjectDetails(input: { projectId?: ProjectId }): Effect<ProjectDetailsResult, McpOrchestrationError, McpInvocationContext>`
  - `getProjectSettings(input: { projectId?: ProjectId }): Effect<ProjectSettingsResult, McpOrchestrationError, McpInvocationContext>`
  - `updateProjectSettings(input: UpdateProjectSettingsInput): Effect<UpdateProjectSettingsResult, McpOrchestrationError, McpInvocationContext>`
  - `listProjects` returns `ReadonlyArray<{ id; title; workspaceRoot }>`
- Consumes:
  - Existing `ProjectionSnapshotQuery.getProjectShellById`, `listProjectShells`, `getCommandReadModel`
  - Existing `project.meta.update` orchestration command
  - Existing `validateMcpModelSelection`

- [ ] **Step 1: Add failing read tests for sanitized project list/details/settings**

In `apps/server/src/mcp/McpOrchestrationService.read.test.ts`, add tests:

```ts
it.effect("listProjects returns lightweight project selectors without settings or actions", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.listProjects({ search: "api" });

    expect(result.projects).toEqual([
      {
        id: ProjectId.make("project-api"),
        title: "API",
        workspaceRoot: "/work/api",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("scripts");
    expect(JSON.stringify(result)).not.toContain("defaultModelSelection");
    expect(JSON.stringify(result)).not.toContain("remoteUrl");
  }).pipe(
    Effect.provide(
      makeReadHarnessLayer({
        projects: [
          makeProjectShell({
            id: ProjectId.make("project-api"),
            title: "API",
            workspaceRoot: "/work/api",
            repositoryIdentity: {
              canonicalKey: "github:secret",
              locator: {
                source: "git-remote",
                remoteName: "origin",
                remoteUrl: "https://token@example.com/org/api.git",
              },
              displayName: "org/api",
              provider: "github",
              owner: "org",
              name: "api",
            },
            scripts: [
              {
                id: "test",
                name: "Test",
                command: "bun test",
                icon: "test",
                runOnWorktreeCreate: false,
              },
            ],
            defaultModelSelection: defaultModelSelection(),
          }),
        ],
      }),
    ),
  ),
);

it.effect("getProjectDetails returns safe repository summary and timestamps", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.getProjectDetails({ projectId: ProjectId.make("project-api") });

    expect(result).toEqual({
      projectId: ProjectId.make("project-api"),
      title: "API",
      workspaceRoot: "/work/api",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      repositorySummary: {
        displayName: "org/api",
        provider: "github",
        owner: "org",
        name: "api",
      },
    });
    expect(JSON.stringify(result)).not.toContain("remoteUrl");
    expect(JSON.stringify(result)).not.toContain("canonicalKey");
  }).pipe(
    Effect.provide(
      makeReadHarnessLayer({
        projects: [
          makeProjectShell({
            id: ProjectId.make("project-api"),
            title: "API",
            workspaceRoot: "/work/api",
            updatedAt: "2026-01-02T00:00:00.000Z",
            repositoryIdentity: {
              canonicalKey: "github:secret",
              locator: {
                source: "git-remote",
                remoteName: "origin",
                remoteUrl: "https://token@example.com/org/api.git",
              },
              displayName: "org/api",
              provider: "github",
              owner: "org",
              name: "api",
            },
          }),
        ],
      }),
    ),
  ),
);

it.effect("getProjectSettings returns raw and resolved default model", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.getProjectSettings({ projectId: ProjectId.make("project-api") });

    expect(result.projectId).toBe(ProjectId.make("project-api"));
    expect(result.title).toBe("API");
    expect(result.defaultModelSelection?.model).toBe("gpt-5.5");
    expect(result.resolvedDefaultModel?.provider.name).toBe("Codex");
    expect(result.resolvedDefaultModel?.model.name).toBe("GPT-5.5");
    expect(result.defaultModelResolutionWarning).toBeUndefined();
  }).pipe(
    Effect.provide(
      makeReadHarnessLayer({
        providers: [
          makeProvider({
            instanceId: "codex",
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex",
            models: [
              {
                slug: "gpt-5.5",
                name: "GPT-5.5",
                isCustom: false,
                capabilities: createModelCapabilities({ optionDescriptors: [] }),
              },
            ],
          }),
        ],
        projects: [
          makeProjectShell({
            id: ProjectId.make("project-api"),
            title: "API",
            defaultModelSelection: defaultModelSelection(),
          }),
        ],
      }),
    ),
  ),
);
```

- [ ] **Step 2: Add failing project settings write tests**

In `apps/server/src/mcp/McpOrchestrationService.write.test.ts`, add:

```ts
it.effect("updateProjectSettings dispatches project metadata updates", () =>
  (() => {
    const dispatchedCommands: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = yield* service.updateProjectSettings({
        projectId: ProjectId.make("project-current"),
        title: "Renamed Project",
        defaultModelSelection: defaultModelSelection({ model: "gpt-5.5" }),
      });

      expect(result).toMatchObject({
        status: "updated",
        projectId: ProjectId.make("project-current"),
      });
      expect(dispatchedCommands).toContainEqual(
        expect.objectContaining({
          type: "project.meta.update",
          projectId: ProjectId.make("project-current"),
          title: "Renamed Project",
          defaultModelSelection: defaultModelSelection({ model: "gpt-5.5" }),
        }),
      );
    }).pipe(
      Effect.provide(
        makeWriteHarnessLayer({
          dispatchedCommands,
          projects: [makeProjectShell({ id: ProjectId.make("project-current") })],
        }),
      ),
    );
  })(),
);

it.effect("updateProjectSettings rejects empty updates", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.updateProjectSettings({ projectId: ProjectId.make("project-current") }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.failureOption(exit.cause);
      expect(Option.getOrUndefined(error)?.code).toBe("project_settings_empty_update");
    }
  }).pipe(
    Effect.provide(
      makeWriteHarnessLayer({
        projects: [makeProjectShell({ id: ProjectId.make("project-current") })],
      }),
    ),
  ),
);

it.effect("updateProjectSettings treats null default model as an explicit clear", () =>
  (() => {
    const dispatchedCommands: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      yield* service.updateProjectSettings({
        projectId: ProjectId.make("project-current"),
        defaultModelSelection: null,
      });

      expect(dispatchedCommands).toContainEqual(
        expect.objectContaining({
          type: "project.meta.update",
          projectId: ProjectId.make("project-current"),
          defaultModelSelection: null,
        }),
      );
    }).pipe(
      Effect.provide(
        makeWriteHarnessLayer({
          dispatchedCommands,
          projects: [makeProjectShell({ id: ProjectId.make("project-current") })],
        }),
      ),
    );
  })(),
);
```

- [ ] **Step 3: Run the new tests and confirm they fail**

Run:

```sh
vp test run apps/server/src/mcp/McpOrchestrationService.read.test.ts apps/server/src/mcp/McpOrchestrationService.write.test.ts
```

Expected: failure because the service interface does not expose project details/settings methods and `listProjects` still returns full project shells.

- [ ] **Step 4: Add service result types and method signatures**

In `apps/server/src/mcp/Services/McpOrchestrationService.ts`, replace the full `OrchestrationProjectShell` list result with a selector result and add settings types:

```ts
export interface ProjectSelector {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface ListProjectsResult {
  readonly projects: ReadonlyArray<ProjectSelector>;
}

export interface ProjectRepositorySummary {
  readonly displayName?: string | undefined;
  readonly provider?: string | undefined;
  readonly owner?: string | undefined;
  readonly name?: string | undefined;
}

export interface ProjectDetailsResult {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly repositorySummary: ProjectRepositorySummary | null;
}

export interface ResolvedMcpModel {
  readonly provider: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly name: string;
  };
  readonly model: {
    readonly slug: string;
    readonly name: string;
  };
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly value: string | boolean;
    readonly label: string;
    readonly valueLabel?: string | undefined;
  }>;
}

export interface ProjectSettingsResult {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly resolvedDefaultModel: ResolvedMcpModel | null;
  readonly defaultModelResolutionWarning?: string | undefined;
}

export interface UpdateProjectSettingsInput {
  readonly projectId: ProjectId;
  readonly title?: string | undefined;
  readonly defaultModelSelection?: ModelSelection | null | undefined;
}

export interface UpdateProjectSettingsResult {
  readonly status: "updated";
  readonly projectId: ProjectId;
  readonly sequence: number;
}
```

Add to `McpOrchestrationServiceShape`:

```ts
readonly getProjectDetails: (
  input: { readonly projectId?: ProjectId | undefined },
) => Effect.Effect<ProjectDetailsResult, McpOrchestrationError, McpInvocationContext.McpInvocationContext>;
readonly getProjectSettings: (
  input: { readonly projectId?: ProjectId | undefined },
) => Effect.Effect<ProjectSettingsResult, McpOrchestrationError, McpInvocationContext.McpInvocationContext>;
readonly updateProjectSettings: (
  input: UpdateProjectSettingsInput,
) => Effect.Effect<UpdateProjectSettingsResult, McpOrchestrationError, McpInvocationContext.McpInvocationContext>;
```

- [ ] **Step 5: Add service helpers and project methods**

In `apps/server/src/mcp/Layers/McpOrchestrationService.ts`, add helpers near the existing helper functions:

```ts
const explicitUndefined = <T>(value: T | undefined): T | undefined => value;

function sanitizeProjectSelector(project: {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}) {
  return {
    id: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
  };
}

function repositorySummary(
  repositoryIdentity:
    | {
        readonly displayName?: string | undefined;
        readonly provider?: string | undefined;
        readonly owner?: string | undefined;
        readonly name?: string | undefined;
      }
    | null
    | undefined,
) {
  if (!repositoryIdentity) return null;
  const summary = {
    ...(repositoryIdentity.displayName ? { displayName: repositoryIdentity.displayName } : {}),
    ...(repositoryIdentity.provider ? { provider: repositoryIdentity.provider } : {}),
    ...(repositoryIdentity.owner ? { owner: repositoryIdentity.owner } : {}),
    ...(repositoryIdentity.name ? { name: repositoryIdentity.name } : {}),
  };
  return Object.keys(summary).length === 0 ? null : summary;
}
```

Add a tolerant resolver beside `validateMcpModelSelection`:

```ts
const resolveMcpModelSelection = Effect.fn("McpOrchestrationService.resolveMcpModelSelection")(
  function* (selection: ModelSelection) {
    const { providers } = yield* loadProvidersAndSettings();
    const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
    if (!provider) {
      return {
        resolved: null,
        warning: `Provider instance '${selection.instanceId}' is not available.`,
      };
    }
    const model = provider.models.find((candidate) => candidate.slug === selection.model);
    if (!model) {
      return {
        resolved: null,
        warning: `Model '${selection.model}' is not available on '${selection.instanceId}'.`,
      };
    }
    const hydratedDescriptors = getProviderOptionDescriptors({
      caps: model.capabilities ?? { optionDescriptors: [] },
      selections: selection.options,
    });
    return {
      resolved: {
        provider: {
          instanceId: provider.instanceId,
          driver: provider.driver,
          name: providerDisplayName(provider),
        },
        model: {
          slug: model.slug,
          name: model.name,
        },
        options: (selection.options ?? []).map((option) => {
          const descriptor = hydratedDescriptors.find((candidate) => candidate.id === option.id);
          return {
            id: option.id,
            value: option.value,
            label: descriptor?.label ?? option.id,
            ...(descriptor ? { valueLabel: getProviderOptionCurrentLabel(descriptor) } : {}),
          };
        }),
      },
    };
  },
);
```

Implement `listProjects`, `getProjectDetails`, `getProjectSettings`, and `updateProjectSettings` in the service object. `updateProjectSettings` must:

```text
if (input.title === undefined && input.defaultModelSelection === undefined) {
  return yield* new McpOrchestrationError({
    code: "project_settings_empty_update",
    message: "Provide at least one project setting to update.",
  });
}
const project = yield* requireProject(input.projectId);
if (input.defaultModelSelection !== undefined && input.defaultModelSelection !== null) {
  yield* validateMcpModelSelection(input.defaultModelSelection);
}
const accepted = yield* orchestrationEngine.dispatch({
  type: "project.meta.update",
  commandId: makeCommandId("project-meta-update"),
  projectId: project.id,
  ...(input.title !== undefined ? { title: input.title } : {}),
  ...(input.defaultModelSelection !== undefined
    ? { defaultModelSelection: input.defaultModelSelection }
    : {}),
});
return { status: "updated" as const, projectId: project.id, sequence: accepted.sequence };
```

- [ ] **Step 6: Add tools and handlers**

In `tools.ts`, add:

```ts
const EmptyObjectInput = Schema.Struct({});

export const GetProjectDetailsTool = Tool.make("get_project_details", {
  description:
    "Return safe read-only project details. Omits repository remote URLs and project Actions.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    projectId: OptionalCurrentProjectIdInput,
  }),
  dependencies,
});

export const GetProjectSettingsTool = Tool.make("get_project_settings", {
  description:
    "Return mutable project settings. Omit projectId to inspect the current MCP thread's project.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    projectId: OptionalCurrentProjectIdInput,
  }),
  dependencies,
});

export const UpdateProjectSettingsTool = Tool.make("update_project_settings", {
  description:
    "Update project settings such as title and default MCP model. Requires explicit projectId.",
  success: Schema.Unknown,
  failure: McpOrchestrationError,
  parameters: Schema.Struct({
    projectId: ProjectIdInput,
    title: OptionalTitleInput,
    defaultModelSelection: OptionalNullableModelSelectionInput,
  }),
  dependencies,
});
```

Replace `ListMcpModelsTool.parameters` with `EmptyObjectInput`.

In `handlers.ts`, add:

```ts
get_project_details: (input) =>
  invokeRead(McpOrchestrationService.pipe(Effect.flatMap((s) => s.getProjectDetails(input)))),
get_project_settings: (input) =>
  invokeRead(McpOrchestrationService.pipe(Effect.flatMap((s) => s.getProjectSettings(input)))),
update_project_settings: (input) =>
  invokeWrite(McpOrchestrationService.pipe(Effect.flatMap((s) => s.updateProjectSettings(input)))),
```

- [ ] **Step 7: Update schema tests**

In `tools.test.ts`, add assertions:

```ts
it("uses explicit object schemas for no-input orchestration tools", () => {
  const schema = Tool.getJsonSchema(OrchestrationToolkit.tools.list_mcp_models) as {
    readonly type?: unknown;
  };
  expect(schema.type).toBe("object");
});

it("exposes project settings tools separately from project selectors", () => {
  expect(OrchestrationToolkit.tools.list_projects).toBeDefined();
  expect(OrchestrationToolkit.tools.get_project_details).toBeDefined();
  expect(OrchestrationToolkit.tools.get_project_settings).toBeDefined();
  expect(OrchestrationToolkit.tools.update_project_settings).toBeDefined();
});
```

- [ ] **Step 8: Run targeted tests**

Run:

```sh
vp test run apps/server/src/mcp/toolkits/orchestration/tools.test.ts apps/server/src/mcp/McpOrchestrationService.read.test.ts apps/server/src/mcp/McpOrchestrationService.write.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```sh
git add apps/server/src/mcp/Services/McpOrchestrationService.ts apps/server/src/mcp/Layers/McpOrchestrationService.ts apps/server/src/mcp/toolkits/orchestration/tools.ts apps/server/src/mcp/toolkits/orchestration/handlers.ts apps/server/src/mcp/toolkits/orchestration/tools.test.ts apps/server/src/mcp/McpOrchestrationService.read.test.ts apps/server/src/mcp/McpOrchestrationService.write.test.ts
git commit -m "feat: add MCP project settings tools"
```

---

### Task 3: Project Action MCP CRUD

**Files:**

- Modify: `apps/server/src/mcp/Services/McpOrchestrationService.ts`
- Modify: `apps/server/src/mcp/Layers/McpOrchestrationService.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/tools.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/handlers.ts`
- Modify: `apps/server/src/mcp/McpOrchestrationService.read.test.ts`
- Modify: `apps/server/src/mcp/McpOrchestrationService.write.test.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/tools.test.ts`

**Interfaces:**

- Produces:
  - `ProjectActionSummary`
  - `listProjectActions({ projectId?: ProjectId })`
  - `createProjectAction(input)`
  - `updateProjectAction(input)`
  - `deleteProjectAction(input)`
- Consumes:
  - Shared `createProjectScript`, `upsertProjectScript`, `removeProjectScript`
  - Existing `project.meta.update` command

- [ ] **Step 1: Add failing Action read/write tests**

In `McpOrchestrationService.read.test.ts`:

```ts
it.effect("listProjectActions returns sanitized action metadata without commands", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.listProjectActions({ projectId: ProjectId.make("project-api") });

    expect(result).toEqual({
      projectId: ProjectId.make("project-api"),
      actions: [
        {
          id: "test",
          name: "Test",
          icon: "test",
          runOnWorktreeCreate: false,
        },
        {
          id: "dev",
          name: "Dev",
          icon: "play",
          runOnWorktreeCreate: true,
          previewUrl: "http://localhost:5173",
          autoOpenPreview: true,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("bun test");
    expect(JSON.stringify(result)).not.toContain("bun dev");
    expect(JSON.stringify(result)).not.toContain("command");
  }).pipe(
    Effect.provide(
      makeReadHarnessLayer({
        projects: [
          makeProjectShell({
            id: ProjectId.make("project-api"),
            scripts: [
              {
                id: "test",
                name: "Test",
                command: "bun test",
                icon: "test",
                runOnWorktreeCreate: false,
              },
              {
                id: "dev",
                name: "Dev",
                command: "bun dev",
                icon: "play",
                runOnWorktreeCreate: true,
                previewUrl: "http://localhost:5173",
                autoOpenPreview: true,
              },
            ],
          }),
        ],
      }),
    ),
  ),
);
```

In `McpOrchestrationService.write.test.ts`, add create/update/delete tests:

```ts
it.effect("createProjectAction appends a sanitized action and hides command", () =>
  (() => {
    const dispatchedCommands: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = yield* service.createProjectAction({
        projectId: ProjectId.make("project-current"),
        name: "Test",
        command: "bun test",
        icon: "test",
      });

      expect(result.createdAction).toEqual({
        id: "test",
        name: "Test",
        icon: "test",
        runOnWorktreeCreate: false,
      });
      expect(JSON.stringify(result)).not.toContain("bun test");
      expect(dispatchedCommands).toContainEqual(
        expect.objectContaining({
          type: "project.meta.update",
          projectId: ProjectId.make("project-current"),
          scripts: [
            {
              id: "test",
              name: "Test",
              command: "bun test",
              icon: "test",
              runOnWorktreeCreate: false,
            },
          ],
        }),
      );
    }).pipe(
      Effect.provide(
        makeWriteHarnessLayer({
          dispatchedCommands,
          projects: [makeProjectShell({ id: ProjectId.make("project-current"), scripts: [] })],
        }),
      ),
    );
  })(),
);

it.effect("updateProjectAction preserves hidden command when command is omitted", () =>
  (() => {
    const dispatchedCommands: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = yield* service.updateProjectAction({
        projectId: ProjectId.make("project-current"),
        actionId: "test",
        name: "Unit tests",
        runOnWorktreeCreate: true,
      });

      expect(result.updatedAction).toEqual({
        id: "test",
        name: "Unit tests",
        icon: "test",
        runOnWorktreeCreate: true,
      });
      const update = dispatchedCommands.find((command) => command.type === "project.meta.update");
      expect(update).toMatchObject({
        scripts: [
          {
            id: "test",
            name: "Unit tests",
            command: "bun test",
            icon: "test",
            runOnWorktreeCreate: true,
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain("bun test");
    }).pipe(
      Effect.provide(
        makeWriteHarnessLayer({
          dispatchedCommands,
          projects: [
            makeProjectShell({
              id: ProjectId.make("project-current"),
              scripts: [
                {
                  id: "test",
                  name: "Test",
                  command: "bun test",
                  icon: "test",
                  runOnWorktreeCreate: false,
                },
              ],
            }),
          ],
        }),
      ),
    );
  })(),
);

it.effect("deleteProjectAction returns sanitized deleted action and actionsAfterChange", () =>
  (() => {
    const dispatchedCommands: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = yield* service.deleteProjectAction({
        projectId: ProjectId.make("project-current"),
        actionId: "test",
      });

      expect(result).toEqual({
        deletedAction: {
          id: "test",
          name: "Test",
          icon: "test",
          runOnWorktreeCreate: false,
        },
        actionsAfterChange: [],
      });
      expect(JSON.stringify(result)).not.toContain("bun test");
      expect(dispatchedCommands).toContainEqual(
        expect.objectContaining({
          type: "project.meta.update",
          projectId: ProjectId.make("project-current"),
          scripts: [],
        }),
      );
    }).pipe(
      Effect.provide(
        makeWriteHarnessLayer({
          dispatchedCommands,
          projects: [
            makeProjectShell({
              id: ProjectId.make("project-current"),
              scripts: [
                {
                  id: "test",
                  name: "Test",
                  command: "bun test",
                  icon: "test",
                  runOnWorktreeCreate: false,
                },
              ],
            }),
          ],
        }),
      ),
    );
  })(),
);
```

Add these error tests in the same file:

```ts
it.effect("updateProjectAction rejects missing action ids", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.updateProjectAction({
        projectId: ProjectId.make("project-current"),
        actionId: "missing",
        name: "Missing",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.failureOption(exit.cause))?.code).toBe(
        "project_action_not_found",
      );
    }
  }).pipe(
    Effect.provide(
      makeWriteHarnessLayer({
        projects: [makeProjectShell({ id: ProjectId.make("project-current"), scripts: [] })],
      }),
    ),
  ),
);

it.effect("updateProjectAction rejects empty updates", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.updateProjectAction({
        projectId: ProjectId.make("project-current"),
        actionId: "test",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.failureOption(exit.cause))?.code).toBe(
        "project_action_empty_update",
      );
    }
  }).pipe(
    Effect.provide(
      makeWriteHarnessLayer({
        projects: [
          makeProjectShell({
            id: ProjectId.make("project-current"),
            scripts: [
              {
                id: "test",
                name: "Test",
                command: "bun test",
                icon: "test",
                runOnWorktreeCreate: false,
              },
            ],
          }),
        ],
      }),
    ),
  ),
);

it.effect("createProjectAction rejects auto-open preview without preview URL", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.createProjectAction({
        projectId: ProjectId.make("project-current"),
        name: "Dev",
        command: "bun dev",
        autoOpenPreview: true,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.failureOption(exit.cause))?.code).toBe(
        "project_action_invalid_preview",
      );
    }
  }).pipe(
    Effect.provide(
      makeWriteHarnessLayer({
        projects: [makeProjectShell({ id: ProjectId.make("project-current"), scripts: [] })],
      }),
    ),
  ),
);
```

- [ ] **Step 2: Run Action tests and confirm they fail**

Run:

```sh
vp test run apps/server/src/mcp/McpOrchestrationService.read.test.ts apps/server/src/mcp/McpOrchestrationService.write.test.ts
```

Expected: failure because Action service methods do not exist.

- [ ] **Step 3: Add Action service types**

In `Services/McpOrchestrationService.ts`, add:

```ts
export interface ProjectActionSummary {
  readonly id: string;
  readonly name: string;
  readonly icon: ProjectScriptIcon;
  readonly runOnWorktreeCreate: boolean;
  readonly previewUrl?: string | undefined;
  readonly autoOpenPreview?: boolean | undefined;
}

export interface ListProjectActionsResult {
  readonly projectId: ProjectId;
  readonly actions: ReadonlyArray<ProjectActionSummary>;
}

export interface CreateProjectActionInput {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly command: string;
  readonly icon?: ProjectScriptIcon | undefined;
  readonly runOnWorktreeCreate?: boolean | undefined;
  readonly previewUrl?: string | undefined;
  readonly autoOpenPreview?: boolean | undefined;
}

export interface UpdateProjectActionInput {
  readonly projectId: ProjectId;
  readonly actionId: string;
  readonly name?: string | undefined;
  readonly command?: string | undefined;
  readonly icon?: ProjectScriptIcon | undefined;
  readonly runOnWorktreeCreate?: boolean | undefined;
  readonly previewUrl?: string | null | undefined;
  readonly autoOpenPreview?: boolean | undefined;
}

export interface DeleteProjectActionInput {
  readonly projectId: ProjectId;
  readonly actionId: string;
}
```

Add result types:

```ts
export interface CreateProjectActionResult {
  readonly createdAction: ProjectActionSummary;
  readonly actionsAfterChange: ReadonlyArray<ProjectActionSummary>;
  readonly sequence: number;
}

export interface UpdateProjectActionResult {
  readonly updatedAction: ProjectActionSummary;
  readonly actionsAfterChange: ReadonlyArray<ProjectActionSummary>;
  readonly sequence: number;
}

export interface DeleteProjectActionResult {
  readonly deletedAction: ProjectActionSummary;
  readonly actionsAfterChange: ReadonlyArray<ProjectActionSummary>;
  readonly sequence: number;
}
```

Add methods to `McpOrchestrationServiceShape`.

- [ ] **Step 4: Implement Action sanitization and CRUD**

In `McpOrchestrationService.ts` layer, import shared helpers:

```ts
import {
  createProjectScript,
  removeProjectScript,
  upsertProjectScript,
} from "@t3tools/shared/projectScripts";
```

Add:

```ts
function sanitizeProjectAction(script: ProjectScript): ProjectActionSummary {
  return {
    id: script.id,
    name: script.name,
    icon: script.icon,
    runOnWorktreeCreate: script.runOnWorktreeCreate,
    ...(script.previewUrl ? { previewUrl: script.previewUrl } : {}),
    ...(script.autoOpenPreview ? { autoOpenPreview: script.autoOpenPreview } : {}),
  };
}

function validateProjectActionPreview(input: {
  readonly previewUrl?: string | null | undefined;
  readonly autoOpenPreview?: boolean | undefined;
  readonly resultingPreviewUrl?: string | undefined;
}): Effect.Effect<void, McpOrchestrationError> {
  if (input.autoOpenPreview === true && !input.previewUrl && !input.resultingPreviewUrl) {
    return Effect.fail(
      new McpOrchestrationError({
        code: "project_action_invalid_preview",
        message: "autoOpenPreview requires a previewUrl.",
      }),
    );
  }
  return Effect.void;
}
```

Implement methods:

- `listProjectActions`: resolve optional project id, require active project, return sanitized scripts.
- `createProjectAction`: require project, validate preview, call `createProjectScript`, `upsertProjectScript`, dispatch `project.meta.update`, return `createdAction` and `actionsAfterChange`.
- `updateProjectAction`: reject empty update, find existing script, preserve command when omitted, clear auto-open when preview URL null, validate resulting preview, dispatch.
- `deleteProjectAction`: use `removeProjectScript`, reject missing, dispatch.

- [ ] **Step 5: Add tools and handlers**

In `tools.ts`, add `ProjectActionIconInput` using the same literal icons as `ProjectScriptIcon`, then add:

```ts
ListProjectActionsTool;
CreateProjectActionTool;
UpdateProjectActionTool;
DeleteProjectActionTool;
```

Descriptions must say commands are intentionally not returned and Actions are called "Actions" in the UI.

In `handlers.ts`, wire:

```ts
list_project_actions;
create_project_action;
update_project_action;
delete_project_action;
```

- [ ] **Step 6: Add schema tests for command hiding and tool names**

In `tools.test.ts`, assert:

```ts
expect(OrchestrationToolkit.tools.list_project_actions).toBeDefined();
expect(OrchestrationToolkit.tools.create_project_action).toBeDefined();
expect(OrchestrationToolkit.tools.update_project_action).toBeDefined();
expect(OrchestrationToolkit.tools.delete_project_action).toBeDefined();
expect(
  JSON.stringify(Tool.getJsonSchema(OrchestrationToolkit.tools.list_project_actions)),
).not.toContain("command");
```

- [ ] **Step 7: Run targeted tests**

Run:

```sh
vp test run apps/server/src/mcp/toolkits/orchestration/tools.test.ts apps/server/src/mcp/McpOrchestrationService.read.test.ts apps/server/src/mcp/McpOrchestrationService.write.test.ts packages/shared/src/projectScripts.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```sh
git add apps/server/src/mcp/Services/McpOrchestrationService.ts apps/server/src/mcp/Layers/McpOrchestrationService.ts apps/server/src/mcp/toolkits/orchestration/tools.ts apps/server/src/mcp/toolkits/orchestration/handlers.ts apps/server/src/mcp/toolkits/orchestration/tools.test.ts apps/server/src/mcp/McpOrchestrationService.read.test.ts apps/server/src/mcp/McpOrchestrationService.write.test.ts
git commit -m "feat: add MCP project action management"
```

---

### Task 4: Thread Read Contract And Tool Rename

**Files:**

- Modify: `apps/server/src/mcp/Services/McpOrchestrationService.ts`
- Modify: `apps/server/src/mcp/Layers/McpOrchestrationService.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/tools.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/handlers.ts`
- Modify: `apps/server/src/mcp/McpOrchestrationService.read.test.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/tools.test.ts`
- Modify: `apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts`

**Interfaces:**

- Produces:
  - `getThreadSettings({ threadId?: ThreadId })`
  - `listThreads` selector/status rows with depth fields and without model/runtime/interaction settings
- Removes:
  - public tool `get_current_thread_settings`
  - service method `getCurrentThreadSettings`

- [ ] **Step 1: Rename read tests and add missing contract assertions**

Replace `getCurrentThreadSettings` tests with `getThreadSettings`.

Add assertions:

```ts
expect(result.title).toBe("Current MCP Thread");
expect(result.createdAt).toBe("2026-01-01T00:00:00.000Z");
expect(result.updatedAt).toBe("2026-01-01T00:00:00.000Z");
expect(result.archivedAt).toBeNull();
expect(result.modelSelection).toEqual(defaultModelSelection());
expect(result.resolvedModel?.provider.name).toBe("Codex");
expect(result.resolvedModel?.model.slug).toBe("gpt-5.5");
```

Add a stale model read test:

```ts
it.effect("getThreadSettings returns raw stale model selection with a warning", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.getThreadSettings({});

    expect(result.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("missing"),
      model: "missing-model",
    });
    expect(result.resolvedModel).toBeNull();
    expect(result.modelResolutionWarning).toContain("missing");
  }).pipe(
    Effect.provide(
      makeReadHarnessLayer({
        providers: [],
        threadDetail: makeThreadDetail({
          id: ThreadId.make("thread-current"),
          projectId: ProjectId.make("project-current"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("missing"),
            model: "missing-model",
          },
        }),
      }),
    ),
  ),
);
```

Add list thread contract assertions:

```ts
expect(result.threads[0]).toMatchObject({
  id: ThreadId.make("thread-1"),
  threadDepth: 0,
  maxThreadDepth: 1,
  canCreateChildThread: true,
});
expect(JSON.stringify(result.threads[0])).not.toContain("modelSelection");
expect(JSON.stringify(result.threads[0])).not.toContain("runtimeMode");
expect(JSON.stringify(result.threads[0])).not.toContain("interactionMode");
```

- [ ] **Step 2: Run read tests and confirm they fail**

Run:

```sh
vp test run apps/server/src/mcp/McpOrchestrationService.read.test.ts apps/server/src/mcp/toolkits/orchestration/tools.test.ts apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts
```

Expected: failure because `get_thread_settings` does not exist and `listThreads` still returns full shell settings.

- [ ] **Step 3: Update service result types**

In `Services/McpOrchestrationService.ts`, rename `CurrentThreadSettingsResult` to `ThreadSettingsResult` and shape it as:

```ts
export interface ThreadSettingsResult {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly parentThreadId: ThreadId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly modelSelection: ModelSelection;
  readonly resolvedModel: ResolvedMcpModel | null;
  readonly modelResolutionWarning?: string | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly checkoutMode: "current_checkout" | "new_worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly threadDepth: 0 | 1;
  readonly maxThreadDepth: 1;
  readonly canCreateChildThread: boolean;
  readonly session: unknown;
}
```

Update `ListThreadsResult` to remove model/runtime/interaction and add depth fields.

- [ ] **Step 4: Implement sanitized thread list and tolerant settings read**

In service layer:

```ts
function sanitizeThreadSelector(thread: OrchestrationThreadShell) {
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    title: thread.title,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    threadDepth: getThreadTreeDepth(thread),
    maxThreadDepth: MAX_THREAD_TREE_DEPTH,
    canCreateChildThread: canThreadCreateChild(thread),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    latestUserMessageAt: thread.latestUserMessageAt,
    latestTurn: thread.latestTurn,
    session: thread.session,
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
  };
}
```

Replace `getCurrentThreadSettings` with `getThreadSettings(input)`:

```text
const targetThreadId = input.threadId ?? invocation.threadId;
const thread = yield* requireThreadDetail(targetThreadId);
const resolved = yield* resolveMcpModelSelection(thread.modelSelection);
return {
  threadId: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  parentThreadId: thread.parentThreadId,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  archivedAt: thread.archivedAt,
  modelSelection: thread.modelSelection,
  resolvedModel: resolved.resolved,
  ...(resolved.warning ? { modelResolutionWarning: resolved.warning } : {}),
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  checkoutMode:
    thread.branch !== null || thread.worktreePath !== null ? "new_worktree" : "current_checkout",
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  threadDepth: getThreadTreeDepth(thread),
  maxThreadDepth: MAX_THREAD_TREE_DEPTH,
  canCreateChildThread: canThreadCreateChild(thread),
  session: thread.session,
};
```

- [ ] **Step 5: Replace tool and handler**

In `tools.ts`:

- delete `GetCurrentThreadSettingsTool`
- add `GetThreadSettingsTool` with `parameters: Schema.Struct({ threadId: OptionalThreadIdInput })`
- include `GetThreadSettingsTool` in `OrchestrationToolkit`

In `handlers.ts`, replace:

```ts
get_current_thread_settings: ...
```

with:

```ts
get_thread_settings: (input) =>
  invokeRead(McpOrchestrationService.pipe(Effect.flatMap((s) => s.getThreadSettings(input)))),
```

- [ ] **Step 6: Update schema and integration tests**

In `tools.test.ts`, assert:

```ts
expect(OrchestrationToolkit.tools.get_thread_settings).toBeDefined();
expect(OrchestrationToolkit.tools.get_current_thread_settings).toBeUndefined();
```

Update integration tests to call `get_thread_settings` with `{}` instead of `get_current_thread_settings`.

- [ ] **Step 7: Run targeted tests**

Run:

```sh
vp test run apps/server/src/mcp/toolkits/orchestration/tools.test.ts apps/server/src/mcp/McpOrchestrationService.read.test.ts apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```sh
git add apps/server/src/mcp/Services/McpOrchestrationService.ts apps/server/src/mcp/Layers/McpOrchestrationService.ts apps/server/src/mcp/toolkits/orchestration/tools.ts apps/server/src/mcp/toolkits/orchestration/handlers.ts apps/server/src/mcp/toolkits/orchestration/tools.test.ts apps/server/src/mcp/McpOrchestrationService.read.test.ts apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts
git commit -m "feat: reshape MCP thread read tools"
```

---

### Task 5: Thread Write Guards And Checkout Semantics

**Files:**

- Modify: `apps/server/src/mcp/Layers/McpOrchestrationService.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/tools.ts`
- Modify: `apps/server/src/mcp/McpOrchestrationService.write.test.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/tools.test.ts`

**Interfaces:**

- Produces:
  - Archived thread write rejection for `sendThreadMessage`, `updateThreadSettings`, and child parent validation.
  - Empty update rejection for `updateThreadSettings`.
  - `updateThreadSettings.title`.
  - Strict create/send branch/baseBranch/worktreePath schema and service validation.
  - Target-project-aware model resolution in `createThread`.

- [ ] **Step 1: Add failing write guard tests**

Add tests in `McpOrchestrationService.write.test.ts`:

```ts
it.effect("sendThreadMessage rejects archived threads", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.sendThreadMessage({
        threadId: ThreadId.make("thread-current"),
        message: "hello",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.failureOption(exit.cause))?.code).toBe("thread_archived");
    }
  }).pipe(
    Effect.provide(
      makeWriteHarnessLayer({
        threadDetailById: {
          "thread-current": threadDetail({
            id: ThreadId.make("thread-current"),
            archivedAt: "2026-01-02T00:00:00.000Z",
          }),
        },
      }),
    ),
  ),
);

it.effect("updateThreadSettings rejects empty updates", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.updateThreadSettings({ threadId: ThreadId.make("thread-current") }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.failureOption(exit.cause))?.code).toBe(
        "thread_settings_empty_update",
      );
    }
  }).pipe(
    Effect.provide(
      makeWriteHarnessLayer({
        threadDetailById: {
          "thread-current": threadDetail({ id: ThreadId.make("thread-current") }),
        },
      }),
    ),
  ),
);

it.effect("updateThreadSettings can rename an idle active thread", () =>
  (() => {
    const dispatchedCommands: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      yield* service.updateThreadSettings({
        threadId: ThreadId.make("thread-current"),
        title: "Renamed thread",
      });

      expect(dispatchedCommands).toContainEqual(
        expect.objectContaining({
          type: "thread.meta.update",
          threadId: ThreadId.make("thread-current"),
          title: "Renamed thread",
        }),
      );
    }).pipe(
      Effect.provide(
        makeWriteHarnessLayer({
          dispatchedCommands,
          threadDetailById: {
            "thread-current": threadDetail({ id: ThreadId.make("thread-current") }),
          },
        }),
      ),
    );
  })(),
);
```

Add these checkout validation tests in the same file:

```ts
it.effect("createThread rejects baseBranch when no first message prepares a worktree", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.createThread({
        checkoutMode: "new_worktree",
        baseBranch: "main",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.failureOption(exit.cause))?.code).toBe(
        "base_branch_without_first_turn_worktree",
      );
    }
  }).pipe(Effect.provide(makeWriteHarnessLayer({}))),
);

it.effect("createThread rejects branch without explicit new_worktree checkout mode", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.createThread({
        branch: "feature/mcp",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.failureOption(exit.cause))?.code).toBe(
        "checkout_mode_required",
      );
    }
  }).pipe(Effect.provide(makeWriteHarnessLayer({}))),
);

it.effect("sendThreadMessage rejects branch without explicit new_worktree checkout mode", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.sendThreadMessage({
        threadId: ThreadId.make("thread-current"),
        message: "hello",
        branch: "feature/mcp",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.failureOption(exit.cause))?.code).toBe(
        "checkout_mode_required",
      );
    }
  }).pipe(
    Effect.provide(
      makeWriteHarnessLayer({
        threadDetailById: {
          "thread-current": threadDetail({ id: ThreadId.make("thread-current") }),
        },
      }),
    ),
  ),
);

it.effect("sendThreadMessage rejects checkout bootstrap fields on non-empty threads", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.sendThreadMessage({
        threadId: ThreadId.make("thread-current"),
        message: "hello",
        checkoutMode: "new_worktree",
        baseBranch: "main",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.failureOption(exit.cause))?.code).toBe(
        "checkout_bootstrap_not_allowed",
      );
    }
  }).pipe(
    Effect.provide(
      makeWriteHarnessLayer({
        threadDetailById: {
          "thread-current": threadDetail({
            id: ThreadId.make("thread-current"),
            messages: [
              {
                id: "message-1" as never,
                role: "user",
                text: "existing",
                activities: [],
                checkpoints: [],
                session: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        },
      }),
    ),
  ),
);

it.effect("updateThreadSettings rejects current checkout with non-null worktreePath", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.updateThreadSettings({
        threadId: ThreadId.make("thread-current"),
        checkoutMode: "current_checkout",
        worktreePath: "/work/current/.worktrees/mcp",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.failureOption(exit.cause))?.code).toBe(
        "invalid_checkout_fields",
      );
    }
  }).pipe(
    Effect.provide(
      makeWriteHarnessLayer({
        threadDetailById: {
          "thread-current": threadDetail({ id: ThreadId.make("thread-current") }),
        },
      }),
    ),
  ),
);

it.effect("updateThreadSettings rejects non-empty new_worktree mode without a worktree path", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.updateThreadSettings({
        threadId: ThreadId.make("thread-current"),
        checkoutMode: "new_worktree",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.failureOption(exit.cause))?.code).toBe(
        "missing_worktree_path",
      );
    }
  }).pipe(
    Effect.provide(
      makeWriteHarnessLayer({
        threadDetailById: {
          "thread-current": threadDetail({
            id: ThreadId.make("thread-current"),
            messages: [
              {
                id: "message-1" as never,
                role: "user",
                text: "existing",
                activities: [],
                checkpoints: [],
                session: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        },
      }),
    ),
  ),
);
```

- [ ] **Step 2: Run write tests and confirm failures**

Run:

```sh
vp test run apps/server/src/mcp/McpOrchestrationService.write.test.ts apps/server/src/mcp/toolkits/orchestration/tools.test.ts
```

Expected: failure because current implementation allows several invalid combinations and lacks title support.

- [ ] **Step 3: Update schemas**

In `tools.ts`:

- create separate branch schemas:

```ts
const OptionalBootstrapBranchInput = Schema.optional(
  Schema.String.annotate({
    description:
      "Optional branch name for first-turn new_worktree bootstrap. Omit to let T3 Code derive a branch. Null is not accepted.",
  }),
).annotate({
  description:
    "Optional branch name for first-turn new_worktree bootstrap. Omit to let T3 Code derive a branch. Null is not accepted.",
});

const OptionalThreadMetadataBranchInput = Schema.optional(
  Schema.NullOr(
    Schema.String.annotate({
      description: "Git branch metadata for a new_worktree checkout, or null to clear it.",
    }),
  ),
).annotate({
  description: "Git branch metadata for a new_worktree checkout, or null to clear it.",
});
```

- remove `worktreePath` from `CreateThreadTool`.
- use `OptionalBootstrapBranchInput` for create/send.
- use nullable branch/worktreePath only in `UpdateThreadSettingsTool`.
- add `title` to `UpdateThreadSettingsTool`.

- [ ] **Step 4: Add service validation helpers**

In service layer, add:

```ts
function hasProvidedKey<T extends object>(input: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function rejectArchivedThread(thread: {
  readonly id: ThreadId;
  readonly archivedAt: string | null;
}) {
  if (thread.archivedAt === null) return Effect.void;
  return Effect.fail(
    new McpOrchestrationError({
      code: "thread_archived",
      message: `Tool did not execute because thread '${thread.id}' is archived.`,
    }),
  );
}

const requireWritableThread = Effect.fn("McpOrchestrationService.requireWritableThread")(function* (
  threadId: ThreadId,
) {
  const thread = yield* requireIdleThread(threadId);
  yield* rejectArchivedThread(thread);
  return thread;
});
```

Use `requireWritableThread` in `sendThreadMessage` and `updateThreadSettings`.

Add checkout validators:

```ts
const validateCreateThreadCheckout = (input, hasMessage) =>
  Effect.gen(function* () {
    if (input.worktreePath !== undefined) {
      return yield* new McpOrchestrationError({
        code: "invalid_checkout_fields",
        message:
          "create_thread does not accept worktreePath. Worktree paths are produced by first-turn bootstrap.",
      });
    }
    if (
      (input.branch !== undefined || input.baseBranch !== undefined) &&
      input.checkoutMode !== "new_worktree"
    ) {
      return yield* new McpOrchestrationError({
        code: "checkout_mode_required",
        message: "branch and baseBranch require checkoutMode 'new_worktree'.",
      });
    }
    if (!hasMessage && input.baseBranch !== undefined) {
      return yield* new McpOrchestrationError({
        code: "base_branch_without_first_turn_worktree",
        message: "baseBranch is only valid when a first message prepares a new worktree.",
      });
    }
    if (hasMessage && input.checkoutMode === "new_worktree" && !input.baseBranch) {
      return yield* new McpOrchestrationError({
        code: "missing_base_branch",
        message: "baseBranch is required when the first turn prepares a new worktree.",
      });
    }
  });
```

Use equivalent validation for `sendThreadMessage`.

- [ ] **Step 5: Implement target-project model resolution in createThread**

Replace:

```ts
const desiredModelSelection = input.modelSelection ?? currentThread.modelSelection;
```

with:

```text
const settings = yield* serverSettings.getSettings.pipe(
  Effect.mapError((error) => toInternalError("Failed to load server settings.", error)),
);
const desiredModelSelection =
  input.modelSelection ??
  targetProject.defaultModelSelection ??
  currentThread.modelSelection ??
  settings.textGenerationModelSelection;
yield* validateMcpModelSelection(desiredModelSelection);
```

Because `currentThread.modelSelection` is non-null, the server default is a defensive final fallback.

- [ ] **Step 6: Implement updateThreadSettings title and checkout rules**

Add `title` to the input type cast.

Before dispatches, reject empty input by checking provided keys:

```ts
const hasUpdate =
  input.title !== undefined ||
  input.modelSelection !== undefined ||
  input.runtimeMode !== undefined ||
  input.interactionMode !== undefined ||
  input.checkoutMode !== undefined ||
  hasProvidedKey(input, "branch") ||
  hasProvidedKey(input, "worktreePath");
```

When `title` differs, dispatch:

```ts
{
  type: "thread.meta.update",
  commandId: makeCommandId("thread-meta-title"),
  threadId: input.threadId,
  title: input.title,
}
```

Apply checkout rules from the spec exactly:

- current checkout clears metadata.
- current checkout rejects non-null branch/worktreePath.
- non-empty thread switching to new worktree requires resulting worktree path.
- null clears are allowed only when resulting state is valid.

- [ ] **Step 7: Run targeted tests**

Run:

```sh
vp test run apps/server/src/mcp/McpOrchestrationService.write.test.ts apps/server/src/mcp/toolkits/orchestration/tools.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```sh
git add apps/server/src/mcp/Layers/McpOrchestrationService.ts apps/server/src/mcp/toolkits/orchestration/tools.ts apps/server/src/mcp/McpOrchestrationService.write.test.ts apps/server/src/mcp/toolkits/orchestration/tools.test.ts
git commit -m "feat: harden MCP thread writes"
```

---

### Task 6: Toolkit Integration And HTTP Surface

**Files:**

- Modify: `apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/tools.test.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/handlers.ts`
- Modify: `apps/server/src/mcp/toolkits/orchestration/tools.ts`

**Interfaces:**

- Produces:
  - HTTP integration coverage for new tool names.
  - Schema coverage that no root `None`/`EmptyParams` shape remains.
  - Schema coverage that Action command fields are not present in read response descriptions/schemas where they do not belong.

- [ ] **Step 1: Add failing integration tests for new tools**

In `McpOrchestrationToolkit.integration.test.ts`, add HTTP calls for:

```ts
list_mcp_models with {}
get_thread_settings with {}
get_project_details with {}
get_project_settings with {}
list_project_actions with {}
update_project_settings with explicit projectId
```

For each call, assert the JSON-RPC result has no MCP error and the fake service dispatch/response matches the method.

- [ ] **Step 2: Update existing integration calls**

Replace all `get_current_thread_settings` calls with `get_thread_settings`.

Replace tool-count/name assertions so the toolkit includes:

```text
list_mcp_models
list_projects
get_project_details
get_project_settings
update_project_settings
list_threads
get_thread_settings
get_thread_history
list_project_actions
create_project_action
update_project_action
delete_project_action
add_project
create_thread
send_thread_message
update_thread_settings
```

- [ ] **Step 3: Run integration tests and confirm failures**

Run:

```sh
vp test run apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts apps/server/src/mcp/toolkits/orchestration/tools.test.ts
```

Expected: failure until all handler map keys and schemas are aligned.

- [ ] **Step 4: Fix handler map and toolkit export ordering**

Ensure `OrchestrationToolkit = Toolkit.make(...)` includes all tools exactly once and in the same conceptual order as the spec.

Ensure `OrchestrationToolkitHandlersLive` has a key for every toolkit tool and no key for `get_current_thread_settings`.

- [ ] **Step 5: Run integration tests**

Run:

```sh
vp test run apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts apps/server/src/mcp/toolkits/orchestration/tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts apps/server/src/mcp/toolkits/orchestration/tools.test.ts apps/server/src/mcp/toolkits/orchestration/handlers.ts apps/server/src/mcp/toolkits/orchestration/tools.ts
git commit -m "test: cover MCP orchestration toolkit surface"
```

---

### Task 7: Final Contract Sweep And Verification

**Files:**

- Modify: any implementation or test file from Tasks 1-6 when verification reveals a concrete mismatch
- Verify: `docs/superpowers/specs/2026-06-25-t3code-mcp-orchestration-design.md`

**Interfaces:**

- Consumes all previous task outputs.
- Produces a fully verified implementation matching the spec.

- [ ] **Step 1: Run focused MCP and helper tests**

Run:

```sh
vp test run packages/shared/src/projectScripts.test.ts apps/web/src/projectScripts.test.ts apps/server/src/mcp/toolkits/orchestration/tools.test.ts apps/server/src/mcp/McpOrchestrationService.read.test.ts apps/server/src/mcp/McpOrchestrationService.write.test.ts apps/server/src/mcp/McpOrchestrationToolkit.integration.test.ts apps/server/src/orchestration/commandInvariants.test.ts
```

Expected: PASS.

- [ ] **Step 2: Search for removed public tool and leaked command fields**

Run:

```sh
rg -n "get_current_thread_settings|child_of_current|Tool.EmptyParams" apps/server/src/mcp
rg -n "command" apps/server/src/mcp/toolkits/orchestration apps/server/src/mcp/Services/McpOrchestrationService.ts
```

Expected:

- first command prints no matches.
- second command may print create/update input definitions and test descriptions, but no read/list response type named `command` and no Action summary containing `command`.

- [ ] **Step 3: Run full required checks**

Run:

```sh
vp check
vp run typecheck
```

Expected: both commands exit 0. If typecheck prints the existing `redundantMapError` suggestion in `McpOrchestrationService.ts`, keep it only if the command exits 0; do not treat it as a failure.

- [ ] **Step 4: Update the spec only if implementation intentionally differs**

If implementation changed a field name or error code from the spec, update:

```text
docs/superpowers/specs/2026-06-25-t3code-mcp-orchestration-design.md
```

Do not change the spec to hide incomplete implementation. Bring the implementation back to the spec unless there is a stronger design reason and the changed contract is covered by tests.

- [ ] **Step 5: Final commit**

If Step 4 changed files or verification found cleanup edits:

```sh
git add <changed files>
git commit -m "chore: verify MCP orchestration contract"
```

If there are no changes after verification, do not create an empty commit.
