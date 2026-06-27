import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import { McpOrchestrationServiceLive } from "./Layers/McpOrchestrationService.ts";
import { McpOrchestrationService } from "./Services/McpOrchestrationService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadTurnStartBootstrapDispatcher } from "../orchestration/Services/ThreadTurnStartBootstrapDispatcher.ts";
import { ProjectionThreadMessageSearchRepository } from "../persistence/Services/ProjectionThreadMessageSearch.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
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
  repositoryIdentity: input.repositoryIdentity,
  defaultModelSelection: input.defaultModelSelection ?? null,
  scripts: input.scripts ?? [],
  createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
  updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
});

const makeThreadShell = (
  input: Partial<OrchestrationThreadShell> & Pick<OrchestrationThreadShell, "id" | "projectId">,
): OrchestrationThreadShell => ({
  id: input.id,
  projectId: input.projectId,
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

const makeThreadDetail = (
  input: Partial<OrchestrationThread> & Pick<OrchestrationThread, "id" | "projectId">,
): OrchestrationThread => ({
  id: input.id,
  projectId: input.projectId,
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
  driver: ServerProvider["driver"];
  models?: ReadonlyArray<ServerProvider["models"][number]>;
  displayName?: string;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: input.driver,
  displayName: input.displayName,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  availability: "available",
  models: [...(input.models ?? [])],
  slashCommands: [],
  skills: [],
});

const projectionQueryMock = (input?: {
  projects?: ReadonlyArray<OrchestrationProjectShell> | undefined;
  threads?: ReadonlyArray<OrchestrationThreadShell> | undefined;
  threadDetail?: OrchestrationThread | null | undefined;
  searchThreadIds?: ReadonlyArray<string> | undefined;
}) =>
  ProjectionSnapshotQuery.of({
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getProjectShellById: (projectId) =>
      Effect.succeed(
        (() => {
          const project = input?.projects?.find((candidate) => candidate.id === projectId);
          return project ? Option.some(project) : Option.none();
        })(),
      ),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: (threadId) =>
      Effect.succeed(
        (() => {
          const thread = input?.threads?.find((candidate) => candidate.id === threadId);
          return thread ? Option.some(thread) : Option.none();
        })(),
      ),
    getThreadDetailById: (threadId) =>
      Effect.succeed(
        input?.threadDetail && input.threadDetail.id === threadId
          ? Option.some(input.threadDetail)
          : Option.none(),
      ),
    listProjectShells: () => Effect.succeed(input?.projects ?? []),
    listThreadShellsByProject: ({ projectId, archived }) =>
      Effect.succeed(
        (input?.threads ?? []).filter((thread) => {
          if (thread.projectId !== projectId) return false;
          if (archived === "exclude") return thread.archivedAt === null;
          if (archived === "only") return thread.archivedAt !== null;
          return true;
        }),
      ),
    searchThreadMessagesByProject: () =>
      Effect.succeed(
        (input?.searchThreadIds ?? []).map((threadId, index) => ({
          threadId: ThreadId.make(threadId),
          messageId: `message-${index + 1}` as never,
          role: "user",
          snippet: `snippet ${index + 1}`,
          rank: index + 1,
          createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
        })),
      ),
  });

const searchRepositoryMock = (threadIds: ReadonlyArray<string> = []) =>
  ProjectionThreadMessageSearchRepository.of({
    searchByProject: () =>
      Effect.succeed(
        threadIds.map((threadId, index) => ({
          threadId: ThreadId.make(threadId),
          messageId: `message-${index + 1}` as never,
          role: "user",
          snippet: `snippet ${index + 1}`,
          rank: index + 1,
          createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
        })),
      ),
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

const makeReadHarnessLayer = (input?: {
  providers?: ReadonlyArray<ServerProvider>;
  settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
  projects?: ReadonlyArray<OrchestrationProjectShell>;
  threads?: ReadonlyArray<OrchestrationThreadShell>;
  threadDetail?: OrchestrationThread | null;
  searchThreadIds?: ReadonlyArray<string>;
  session?: OrchestrationSession | null;
}) => {
  const unsupported = (operation: string) => Effect.die(new Error(`${operation} unused`)) as never;

  return McpOrchestrationServiceLive.pipe(
    Layer.provideMerge(
      Layer.succeed(
        ThreadTurnStartBootstrapDispatcher,
        ThreadTurnStartBootstrapDispatcher.of({
          dispatch: () => Effect.die("unused"),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: "environment-1" as never,
        threadId: ThreadId.make("thread-current"),
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["orchestration.read"] as const),
        issuedAt: 0,
        expiresAt: 60_000,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderRegistry, providerRegistryMock(input?.providers ?? [])),
    ),
    Layer.provideMerge(
      Layer.succeed(
        ProviderService,
        ProviderService.of({
          startSession: () => unsupported("startSession"),
          sendTurn: () => unsupported("sendTurn"),
          interruptTurn: () => unsupported("interruptTurn"),
          respondToRequest: () => unsupported("respondToRequest"),
          respondToUserInput: () => unsupported("respondToUserInput"),
          stopSession: () => unsupported("stopSession"),
          listSessions: () => Effect.succeed([]),
          getCapabilities: () => unsupported("getCapabilities"),
          getInstanceInfo: () => unsupported("getInstanceInfo"),
          rollbackConversation: () => unsupported("rollbackConversation"),
          streamEvents: Stream.empty,
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        OrchestrationEngineService,
        OrchestrationEngineService.of({
          dispatch: () => Effect.die("unused"),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
        }),
      ),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest(input?.settings ?? {})),
    Layer.provideMerge(
      Layer.succeed(
        ProjectionSnapshotQuery,
        projectionQueryMock({
          projects: input?.projects,
          threads: input?.threads,
          searchThreadIds: input?.searchThreadIds,
          threadDetail:
            input?.threadDetail ??
            (input?.session
              ? makeThreadDetail({
                  id: ThreadId.make("thread-current"),
                  projectId: ProjectId.make("project-current"),
                  session: input.session,
                })
              : null),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        ProjectionThreadMessageSearchRepository,
        searchRepositoryMock(input?.searchThreadIds),
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
    Layer.provideMerge(NodeServices.layer),
  );
};

it.effect("listMcpModels excludes models disabled in server settings", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.listMcpModels();

    const codexProvider = result.providers[ProviderInstanceId.make("codex")];
    expect(codexProvider?.models["gpt-5.5"]).toBeDefined();
    expect(codexProvider?.models["gpt-disabled"]).toBeUndefined();
  }).pipe(
    Effect.provide(
      makeReadHarnessLayer({
        providers: [
          makeProvider({
            instanceId: "codex",
            driver: ProviderDriverKind.make("codex"),
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
    expect(result.projects[0]).not.toHaveProperty("scripts");
    expect(result.projects[0]).not.toHaveProperty("defaultModelSelection");
    expect(result.projects[0]).not.toHaveProperty("repositoryIdentity");
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
    expect(result.repositorySummary).not.toHaveProperty("remoteUrl");
    expect(result.repositorySummary).not.toHaveProperty("canonicalKey");
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
    expect(result.actions.flatMap((action) => Object.values(action))).not.toContain("bun test");
    expect(result.actions.flatMap((action) => Object.values(action))).not.toContain("bun dev");
    for (const action of result.actions) {
      expect(action).not.toHaveProperty("command");
    }
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

it.effect("listThreads merges title matches with message-hit matches without duplicates", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.listThreads({
      projectId: ProjectId.make("project-1"),
      search: "deploy",
    });

    expect(result.threads[0]).toMatchObject({
      id: ThreadId.make("thread-title"),
      threadDepth: 0,
      maxThreadDepth: 1,
      canCreateChildThread: true,
    });
    expect(result.threads[0]).not.toHaveProperty("modelSelection");
    expect(result.threads[0]).not.toHaveProperty("runtimeMode");
    expect(result.threads[0]).not.toHaveProperty("interactionMode");
    expect(result.threads.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-title"),
      ThreadId.make("thread-message"),
    ]);
  }).pipe(
    Effect.provide(
      makeReadHarnessLayer({
        threads: [
          makeThreadShell({
            id: ThreadId.make("thread-title"),
            projectId: ProjectId.make("project-1"),
            title: "Deploy worktree",
          }),
          makeThreadShell({
            id: ThreadId.make("thread-message"),
            projectId: ProjectId.make("project-1"),
            title: "Release prep",
          }),
        ],
        searchThreadIds: ["thread-message", "thread-title", "thread-message"],
      }),
    ),
  ),
);

it.effect("listThreads defaults to excluding archived threads", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.listThreads({
      projectId: ProjectId.make("project-1"),
    });

    expect(result.threads.map((thread) => thread.id)).toEqual([ThreadId.make("thread-active")]);
  }).pipe(
    Effect.provide(
      makeReadHarnessLayer({
        threads: [
          makeThreadShell({
            id: ThreadId.make("thread-active"),
            projectId: ProjectId.make("project-1"),
            archivedAt: null,
          }),
          makeThreadShell({
            id: ThreadId.make("thread-archived"),
            projectId: ProjectId.make("project-1"),
            archivedAt: "2026-01-02T00:00:00.000Z",
          }),
        ],
      }),
    ),
  ),
);

it.effect("getThreadSettings resolves provider and option labels for the MCP thread", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.getThreadSettings({});

    expect(result).toMatchObject({
      threadId: ThreadId.make("thread-current"),
      projectId: ProjectId.make("project-current"),
      title: "Current MCP Thread",
      parentThreadId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      modelSelection: defaultModelSelection({
        options: [{ id: "reasoningEffort", value: "high" }],
      }),
      checkoutMode: "new_worktree",
      branch: "feat/mcp-read",
      worktreePath: "/worktrees/thread-current",
      session: {
        status: "running",
      },
      threadDepth: 0,
      maxThreadDepth: 1,
      canCreateChildThread: true,
    });
    expect(result.modelSelection).toEqual(
      defaultModelSelection({
        options: [{ id: "reasoningEffort", value: "high" }],
      }),
    );
    expect(result.resolvedModel?.provider).toMatchObject({
      instanceId: ProviderInstanceId.make("codex"),
      driver: "codex",
      name: "Codex",
    });
    expect(result.resolvedModel?.model).toMatchObject({
      slug: "gpt-5.5",
      name: "GPT-5.5",
    });
    expect(result.resolvedModel?.options).toEqual([
      {
        id: "reasoningEffort",
        value: "high",
        label: "Reasoning",
        valueLabel: "High",
      },
    ]);
  }).pipe(
    Effect.provide(
      makeReadHarnessLayer({
        providers: [
          makeProvider({
            instanceId: "codex",
            driver: ProviderDriverKind.make("codex"),
            models: [
              {
                slug: "gpt-5.5",
                name: "GPT-5.5",
                isCustom: false,
                capabilities: createModelCapabilities({
                  optionDescriptors: [
                    {
                      id: "reasoningEffort",
                      label: "Reasoning",
                      type: "select",
                      options: [
                        { id: "high", label: "High", isDefault: true },
                        { id: "low", label: "Low" },
                      ],
                    } satisfies ProviderOptionDescriptor,
                  ],
                }),
              },
            ],
            displayName: "Codex",
          }),
        ],
        threadDetail: makeThreadDetail({
          id: ThreadId.make("thread-current"),
          projectId: ProjectId.make("project-current"),
          title: "Current MCP Thread",
          modelSelection: defaultModelSelection({
            options: [{ id: "reasoningEffort", value: "high" }],
          }),
          runtimeMode: "full-access",
          interactionMode: "plan",
          branch: "feat/mcp-read",
          worktreePath: "/worktrees/thread-current",
          session: {
            threadId: ThreadId.make("thread-current"),
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      }),
    ),
  ),
);

it.effect("getThreadSettings reads an explicit non-current thread when threadId is provided", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.getThreadSettings({
      threadId: ThreadId.make("thread-explicit"),
    });

    expect(result.threadId).toBe(ThreadId.make("thread-explicit"));
    expect(result.projectId).toBe(ProjectId.make("project-explicit"));
    expect(result.title).toBe("Explicit MCP Thread");
    expect(result.parentThreadId).toBe(ThreadId.make("thread-parent"));
    expect(result.threadDepth).toBe(1);
    expect(result.canCreateChildThread).toBe(false);
    expect(result.modelSelection).toEqual(defaultModelSelection());
    expect(result.resolvedModel?.provider.name).toBe("Codex");
    expect(result.resolvedModel?.model.slug).toBe("gpt-5.5");
  }).pipe(
    Effect.provide(
      makeReadHarnessLayer({
        providers: [
          makeProvider({
            instanceId: "codex",
            driver: ProviderDriverKind.make("codex"),
            models: [
              {
                slug: "gpt-5.5",
                name: "GPT-5.5",
                isCustom: false,
                capabilities: createModelCapabilities({ optionDescriptors: [] }),
              },
            ],
            displayName: "Codex",
          }),
        ],
        threadDetail: makeThreadDetail({
          id: ThreadId.make("thread-explicit"),
          projectId: ProjectId.make("project-explicit"),
          parentThreadId: ThreadId.make("thread-parent"),
          title: "Explicit MCP Thread",
          modelSelection: defaultModelSelection(),
        }),
      }),
    ),
  ),
);

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
