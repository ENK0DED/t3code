import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import { McpOrchestrationServiceLive } from "./Layers/McpOrchestrationService.ts";
import { McpOrchestrationService } from "./Services/McpOrchestrationService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadMessageSearchRepository } from "../persistence/Services/ProjectionThreadMessageSearch.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../provider/providerMaintenance.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";

const defaultModelSelection = (overrides?: Partial<ModelSelection>): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.5",
  ...overrides,
});

const makeProjectShell = (
  input: Partial<OrchestrationProjectShell> & Pick<OrchestrationProjectShell, "id">,
): OrchestrationProjectShell => ({
  id: input.id,
  title: input.title ?? "Project",
  workspaceRoot: input.workspaceRoot ?? "/work/project",
  repositoryIdentity: input.repositoryIdentity ?? null,
  defaultModelSelection: input.defaultModelSelection ?? null,
  scripts: input.scripts ?? [],
  createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
  updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
});

const threadShell = (
  input: Partial<OrchestrationThreadShell> & Pick<OrchestrationThreadShell, "id">,
): OrchestrationThreadShell => ({
  id: input.id,
  projectId: input.projectId ?? ProjectId.make("project-current"),
  parentThreadId: input.parentThreadId ?? null,
  title: input.title ?? "Thread",
  modelSelection: input.modelSelection ?? defaultModelSelection(),
  runtimeMode: input.runtimeMode ?? "full-access",
  interactionMode: input.interactionMode ?? "default",
  branch: input.branch ?? null,
  worktreePath: input.worktreePath ?? null,
  latestTurn: input.latestTurn ?? null,
  createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
  updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
  archivedAt: input.archivedAt ?? null,
  session: input.session ?? null,
  latestUserMessageAt: input.latestUserMessageAt ?? null,
  hasPendingApprovals: input.hasPendingApprovals ?? false,
  hasPendingUserInput: input.hasPendingUserInput ?? false,
  hasActionableProposedPlan: input.hasActionableProposedPlan ?? false,
});

const threadDetail = (
  input: Partial<OrchestrationThread> & Pick<OrchestrationThread, "id">,
): OrchestrationThread => ({
  id: input.id,
  projectId: input.projectId ?? ProjectId.make("project-current"),
  parentThreadId: input.parentThreadId ?? null,
  title: input.title ?? "Thread",
  modelSelection: input.modelSelection ?? defaultModelSelection(),
  runtimeMode: input.runtimeMode ?? "full-access",
  interactionMode: input.interactionMode ?? "default",
  branch: input.branch ?? null,
  worktreePath: input.worktreePath ?? null,
  latestTurn: input.latestTurn ?? null,
  createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
  updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
  archivedAt: input.archivedAt ?? null,
  deletedAt: input.deletedAt ?? null,
  messages: input.messages ?? [],
  proposedPlans: input.proposedPlans ?? [],
  activities: input.activities ?? [],
  checkpoints: input.checkpoints ?? [],
  session: input.session ?? null,
});

const makeProvider = (input: {
  instanceId: string;
  driver?: ServerProvider["driver"];
  models?: ReadonlyArray<ServerProvider["models"][number]>;
  displayName?: string;
  requiresNewThreadForModelChange?: boolean;
  continuationGroupKey?: string;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: input.driver ?? ProviderDriverKind.make("codex"),
  displayName: input.displayName,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  availability: "available",
  continuation: {
    groupKey:
      input.continuationGroupKey ??
      `${String(input.driver ?? ProviderDriverKind.make("codex"))}:instance:${input.instanceId}`,
  },
  ...(typeof input.requiresNewThreadForModelChange === "boolean"
    ? { requiresNewThreadForModelChange: input.requiresNewThreadForModelChange }
    : {}),
  models: [
    ...(input.models ?? [
      {
        slug: "gpt-5.5",
        name: "GPT-5.5",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning effort",
              type: "select",
              options: [
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
              ],
              currentValue: "medium",
            },
            {
              id: "fastMode",
              label: "Fast mode",
              type: "boolean",
              currentValue: false,
            },
          ],
        }),
      },
    ]),
  ],
  slashCommands: [],
  skills: [],
});

const projectionQueryMock = (input: {
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly threadDetailById?: Readonly<Record<string, OrchestrationThread>>;
  readonly threadShellById?: Readonly<Record<string, OrchestrationThreadShell>>;
}) =>
  ProjectionSnapshotQuery.of({
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
      Effect.succeed(
        (() => {
          const project = input.projects?.find(
            (candidate) => candidate.workspaceRoot === workspaceRoot,
          );
          return project ? Option.some({ ...project, deletedAt: null } as never) : Option.none();
        })(),
      ),
    getProjectShellById: (projectId) =>
      Effect.succeed(
        (() => {
          const project = input.projects?.find((candidate) => candidate.id === projectId);
          return project ? Option.some(project) : Option.none();
        })(),
      ),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    listProjectShells: () => Effect.succeed(input.projects ?? []),
    listThreadShellsByProject: () => Effect.succeed([]),
    getThreadShellById: (threadId) =>
      Effect.succeed(
        input.threadShellById?.[String(threadId)]
          ? Option.some(input.threadShellById[String(threadId)]!)
          : Option.none(),
      ),
    getThreadDetailById: (threadId) =>
      Effect.succeed(
        input.threadDetailById?.[String(threadId)]
          ? Option.some(input.threadDetailById[String(threadId)]!)
          : Option.none(),
      ),
    searchThreadMessagesByProject: () => Effect.succeed([]),
  });

const providerRegistryMock = (providers: ReadonlyArray<ServerProvider>) =>
  ProviderRegistry.of({
    getProviders: Effect.succeed(providers),
    refresh: () => Effect.succeed(providers),
    refreshInstance: () => Effect.succeed(providers),
    getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
      Effect.succeed(
        makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null }),
      ),
    setProviderMaintenanceActionState: () => Effect.succeed(providers),
    streamChanges: Stream.empty,
  });

const makeWriteHarnessLayer = (input?: {
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly threadDetails?: ReadonlyArray<OrchestrationThread>;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
  readonly dispatchedCommands?: Array<OrchestrationCommand>;
}) => {
  const projects = input?.projects ?? [
    makeProjectShell({
      id: ProjectId.make("project-current"),
      title: "Current Project",
      workspaceRoot: "/work/current",
    }),
    makeProjectShell({
      id: ProjectId.make("project-other"),
      title: "Other Project",
      workspaceRoot: "/work/other",
    }),
  ];
  const threadDetails = input?.threadDetails ?? [
    threadDetail({
      id: ThreadId.make("thread-current"),
      projectId: ProjectId.make("project-current"),
      title: "Current Thread",
    }),
  ];
  const threads =
    input?.threads ??
    threadDetails.map((thread) =>
      threadShell({
        id: thread.id,
        projectId: thread.projectId,
        parentThreadId: thread.parentThreadId,
        title: thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        latestTurn: thread.latestTurn,
        session: thread.session,
        archivedAt: thread.archivedAt,
      }),
    );
  const threadDetailById = Object.fromEntries(threadDetails.map((thread) => [thread.id, thread]));
  const threadShellById = Object.fromEntries(threads.map((thread) => [thread.id, thread]));
  const dispatchedCommands = input?.dispatchedCommands ?? [];

  return McpOrchestrationServiceLive.pipe(
    Layer.provideMerge(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: "environment-1" as never,
        threadId: ThreadId.make("thread-current"),
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["orchestration.write", "orchestration.read"] as const),
        issuedAt: 0,
        expiresAt: 60_000,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(
        ProjectionSnapshotQuery,
        projectionQueryMock({
          projects,
          threadDetailById,
          threadShellById,
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        ProviderRegistry,
        providerRegistryMock(input?.providers ?? [makeProvider({ instanceId: "codex" })]),
      ),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest(input?.settings ?? {})),
    Layer.provideMerge(
      Layer.succeed(
        OrchestrationEngineService,
        OrchestrationEngineService.of({
          dispatch: (command) =>
            Effect.sync(() => {
              dispatchedCommands.push(command);
              return { sequence: dispatchedCommands.length };
            }),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        ProjectionThreadMessageSearchRepository,
        ProjectionThreadMessageSearchRepository.of({
          searchByProject: () => Effect.succeed([]),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        TextGeneration,
        TextGeneration.of({
          generateCommitMessage: () => Effect.die("unused"),
          generatePrContent: () => Effect.die("unused"),
          generateBranchName: () => Effect.die("unused"),
          generateThreadTitle: () => Effect.die("unused"),
          generateThreadSummary: () => Effect.die("unused"),
        }),
      ),
    ),
  );
};

it.effect("addProject returns already_exists for an existing normalized path", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.addProject({ path: "/work/current/" });

    expect(result).toMatchObject({
      status: "already_exists",
      project: {
        id: "project-current",
      },
    });
  }).pipe(Effect.provide(makeWriteHarnessLayer())),
);

it.effect("createThread defaults placement to child_of_current", () =>
  (() => {
    const dispatchedCommands: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = yield* service.createThread({
        title: "Child Thread",
      });

      expect(result).toMatchObject({
        status: "created",
        threadId: expect.any(String),
        sequence: 1,
      });
      expect(dispatchedCommands[0]).toMatchObject({
        type: "thread.create",
        parentThreadId: "thread-current",
        projectId: "project-current",
        title: "Child Thread",
      });
    }).pipe(Effect.provide(makeWriteHarnessLayer({ dispatchedCommands })));
  })(),
);

it.effect("createThread rejects cross-project child_of_thread", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.createThread({
        projectId: ProjectId.make("project-other"),
        placement: "child_of_thread",
        parentThreadId: ThreadId.make("thread-current"),
        title: "Invalid child",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("cross_project_parent");
    }
  }).pipe(Effect.provide(makeWriteHarnessLayer())),
);

it.effect("createThread rejects MCP-disabled model", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.createThread({
        title: "Disabled model",
        modelSelection: defaultModelSelection({ model: "gpt-disabled" }),
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("mcp_disabled_model");
    }
  }).pipe(
    Effect.provide(
      makeWriteHarnessLayer({
        providers: [
          makeProvider({
            instanceId: "codex",
            models: [
              { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
              { slug: "gpt-disabled", name: "Disabled", isCustom: false, capabilities: null },
            ],
          }),
        ],
        settings: {
          mcpDisabledModelsByProvider: {
            [ProviderInstanceId.make("codex")]: ["gpt-disabled"],
          },
        },
      }),
    ),
  ),
);

it.effect("sendThreadMessage rejects running target threads", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.sendThreadMessage({
        threadId: ThreadId.make("thread-running"),
        message: "Continue",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("non_idle_thread");
    }
  }).pipe(
    Effect.provide(
      makeWriteHarnessLayer({
        threads: [
          threadShell({
            id: ThreadId.make("thread-running"),
            session: {
              status: "running",
              activeTurnId: "turn-1",
            } as never,
            latestTurn: {
              state: "running",
            } as never,
          }),
        ],
        threadDetails: [
          threadDetail({
            id: ThreadId.make("thread-running"),
            session: {
              status: "running",
              activeTurnId: "turn-1",
            } as never,
            latestTurn: {
              state: "running",
            } as never,
          }),
        ],
      }),
    ),
  ),
);

it.effect(
  "sendThreadMessage dispatches thread.turn.start and returns messageId plus sequence",
  () =>
    (() => {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      return Effect.gen(function* () {
        const service = yield* McpOrchestrationService;
        const result = yield* service.sendThreadMessage({
          threadId: ThreadId.make("thread-current"),
          message: "Continue",
        });

        expect(result).toMatchObject({
          status: "accepted",
          threadId: "thread-current",
          messageId: expect.any(String),
          sequence: 1,
        });
        expect(dispatchedCommands[0]).toMatchObject({
          type: "thread.turn.start",
          threadId: "thread-current",
          message: {
            role: "user",
            text: "Continue",
            attachments: [],
          },
          titleSeed: "Current Thread",
          runtimeMode: "full-access",
          interactionMode: "default",
        });
      }).pipe(Effect.provide(makeWriteHarnessLayer({ dispatchedCommands })));
    })(),
);

it.effect("updateThreadSettings rejects invalid option values", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.updateThreadSettings({
        threadId: ThreadId.make("thread-current"),
        modelSelection: defaultModelSelection({
          options: [{ id: "reasoningEffort", value: "ultra" }],
        }),
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("invalid_model_option");
    }
  }).pipe(Effect.provide(makeWriteHarnessLayer())),
);

it.effect(
  "updateThreadSettings dispatches meta, runtime, and interaction commands for valid idle threads",
  () =>
    (() => {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      return Effect.gen(function* () {
        const service = yield* McpOrchestrationService;
        const result = yield* service.updateThreadSettings({
          threadId: ThreadId.make("thread-current"),
          modelSelection: defaultModelSelection({
            model: "gpt-5.5",
            options: [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          }),
          runtimeMode: "approval-required",
          interactionMode: "plan",
          branch: "feature/refactor",
          worktreePath: "/work/current-refactor",
        });

        expect(result).toMatchObject({
          status: "updated",
          threadId: "thread-current",
          sequence: 4,
        });
        expect(dispatchedCommands.map((command) => command.type)).toEqual([
          "thread.meta.update",
          "thread.runtime-mode.set",
          "thread.interaction-mode.set",
          "thread.meta.update",
        ]);
      }).pipe(Effect.provide(makeWriteHarnessLayer({ dispatchedCommands })));
    })(),
);
