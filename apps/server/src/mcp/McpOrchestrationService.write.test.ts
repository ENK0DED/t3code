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
  type ProviderSession,
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
import { ThreadTurnStartBootstrapDispatcherLive } from "../orchestration/Services/ThreadTurnStartBootstrapDispatcher.ts";
import { ProjectionThreadMessageSearchRepository } from "../persistence/Services/ProjectionThreadMessageSearch.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../provider/providerMaintenance.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";

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
  continuationGroupKey?: string | null;
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
  ...(input.continuationGroupKey === null
    ? {}
    : {
        continuation: {
          groupKey:
            input.continuationGroupKey ??
            `${String(input.driver ?? ProviderDriverKind.make("codex"))}:instance:${input.instanceId}`,
        },
      }),
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
  readonly runtimeSessions?: ReadonlyArray<ProviderSession>;
  readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
  readonly dispatchedCommands?: Array<OrchestrationCommand>;
  readonly createWorktreeCalls?: Array<{
    readonly cwd: string;
    readonly refName: string;
    readonly newRefName?: string | undefined;
    readonly path: string | null;
  }>;
  readonly setupRunCalls?: Array<{
    readonly threadId: string;
    readonly projectId?: string;
    readonly projectCwd?: string;
    readonly worktreePath: string;
  }>;
  readonly refreshStatusCalls?: Array<string>;
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
  const runtimeSessions = input?.runtimeSessions ?? [];
  const createWorktreeCalls = input?.createWorktreeCalls ?? [];
  const setupRunCalls = input?.setupRunCalls ?? [];
  const refreshStatusCalls = input?.refreshStatusCalls ?? [];
  const unsupported = (operation: string) => Effect.die(new Error(`${operation} unused`)) as never;

  return McpOrchestrationServiceLive.pipe(
    Layer.provideMerge(ThreadTurnStartBootstrapDispatcherLive),
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
          listSessions: () => Effect.succeed(runtimeSessions),
          getCapabilities: () => unsupported("getCapabilities"),
          getInstanceInfo: () => unsupported("getInstanceInfo"),
          rollbackConversation: () => unsupported("rollbackConversation"),
          streamEvents: Stream.empty,
        }),
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
    Layer.provideMerge(
      Layer.succeed(
        GitWorkflowService,
        GitWorkflowService.of({
          status: () => unsupported("status"),
          localStatus: () => unsupported("localStatus"),
          remoteStatus: () => unsupported("remoteStatus"),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
          pullCurrentBranch: () => unsupported("pullCurrentBranch"),
          runStackedAction: () => unsupported("runStackedAction"),
          resolvePullRequest: () => unsupported("resolvePullRequest"),
          preparePullRequestThread: () => unsupported("preparePullRequestThread"),
          listRefs: () => unsupported("listRefs"),
          createWorktree: (call) =>
            Effect.sync(() => {
              createWorktreeCalls.push(call);
              return {
                worktree: {
                  refName: call.newRefName ?? call.refName,
                  path: "/work/current/.worktrees/mcp-bootstrap",
                },
              };
            }),
          removeWorktree: () => unsupported("removeWorktree"),
          createRef: () => unsupported("createRef"),
          switchRef: () => unsupported("switchRef"),
          renameBranch: () => unsupported("renameBranch"),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        ProjectSetupScriptRunner,
        ProjectSetupScriptRunner.of({
          runForThread: (call) =>
            Effect.sync(() => {
              setupRunCalls.push(call);
              return {
                status: "started" as const,
                scriptId: "setup",
                scriptName: "Setup",
                terminalId: "terminal-setup",
                cwd: call.worktreePath,
              };
            }),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        VcsStatusBroadcaster,
        VcsStatusBroadcaster.of({
          getStatus: () => unsupported("getStatus"),
          refreshLocalStatus: () => unsupported("refreshLocalStatus"),
          refreshStatus: (cwd) =>
            Effect.sync(() => {
              refreshStatusCalls.push(cwd);
              return {
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: false,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
                pr: null,
              };
            }),
          streamStatus: () => Stream.empty,
        }),
      ),
    ),
  );
};

it.effect("addProject returns already_exists for an existing normalized path", () =>
  (() => {
    const dispatchedCommands: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = yield* service.addProject({ path: "/work/current" });

      expect(result).toMatchObject({
        status: "already_exists",
        project: {
          id: "project-current",
        },
      });
      expect(dispatchedCommands).toHaveLength(0);
    }).pipe(
      Effect.provide(
        makeWriteHarnessLayer({
          projects: [
            makeProjectShell({
              id: ProjectId.make("project-current"),
              title: "Current Project",
              workspaceRoot: "/work/current/",
            }),
            makeProjectShell({
              id: ProjectId.make("project-other"),
              title: "Other Project",
              workspaceRoot: "/work/other",
            }),
          ],
          dispatchedCommands,
        }),
      ),
    );
  })(),
);

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
      const error = Cause.squash(exit.cause) as {
        readonly _tag: string;
        readonly code: string;
      };
      expect(error._tag).toBe("McpOrchestrationError");
      expect(error.code).toBe("project_settings_empty_update");
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

it.effect("createThread defaults placement to child_of_current for the current project", () =>
  (() => {
    const dispatchedCommands: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = yield* service.createThread({
        title: "Top-level Thread",
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
        title: "Top-level Thread",
      });
    }).pipe(Effect.provide(makeWriteHarnessLayer({ dispatchedCommands })));
  })(),
);

it.effect("createThread with a message creates the thread before starting the turn", () =>
  (() => {
    const dispatchedCommands: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = (yield* service.createThread({
        title: "Investigate reconnects",
        message: "Please inspect reconnect failures",
        checkoutMode: "current_checkout",
      })) as { readonly threadId: ThreadId };

      expect(result).toMatchObject({
        status: "accepted",
        threadId: expect.any(String),
        messageId: expect.any(String),
        sequence: 2,
      });
      expect(dispatchedCommands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
      ]);
      expect(dispatchedCommands[0]).toMatchObject({
        type: "thread.create",
        parentThreadId: "thread-current",
        projectId: "project-current",
        title: "Investigate reconnects",
      });
      expect(dispatchedCommands[1]).toMatchObject({
        type: "thread.turn.start",
        threadId: result.threadId,
        message: {
          role: "user",
          text: "Please inspect reconnect failures",
          attachments: [],
        },
      });
      if (dispatchedCommands[1]?.type === "thread.turn.start") {
        expect(dispatchedCommands[1].bootstrap).toBeUndefined();
      }
    }).pipe(Effect.provide(makeWriteHarnessLayer({ dispatchedCommands })));
  })(),
);

it.effect(
  "createThread with a message inherits branch metadata without forcing worktree preparation",
  () =>
    (() => {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktreeCalls: Array<{
        readonly cwd: string;
        readonly refName: string;
        readonly newRefName?: string | undefined;
        readonly path: string | null;
      }> = [];
      const setupRunCalls: Array<{
        readonly threadId: string;
        readonly projectId?: string;
        readonly projectCwd?: string;
        readonly worktreePath: string;
      }> = [];
      return Effect.gen(function* () {
        const service = yield* McpOrchestrationService;
        const result = (yield* service.createThread({
          title: "Follow-up thread",
          message: "Continue from the current state",
        })) as { readonly threadId: ThreadId };

        expect(result).toMatchObject({
          status: "accepted",
          threadId: expect.any(String),
          messageId: expect.any(String),
          sequence: 2,
        });
        expect(dispatchedCommands.map((command) => command.type)).toEqual([
          "thread.create",
          "thread.turn.start",
        ]);
        expect(dispatchedCommands[0]).toMatchObject({
          type: "thread.create",
          parentThreadId: "thread-current",
          projectId: "project-current",
          title: "Follow-up thread",
          branch: "feature/current",
          worktreePath: "/work/current/.worktrees/current",
        });
        expect(dispatchedCommands[1]).toMatchObject({
          type: "thread.turn.start",
          threadId: result.threadId,
          message: {
            role: "user",
            text: "Continue from the current state",
            attachments: [],
          },
        });
        expect(createWorktreeCalls).toEqual([]);
        expect(setupRunCalls).toEqual([]);
      }).pipe(
        Effect.provide(
          makeWriteHarnessLayer({
            dispatchedCommands,
            createWorktreeCalls,
            setupRunCalls,
            threadDetails: [
              threadDetail({
                id: ThreadId.make("thread-current"),
                projectId: ProjectId.make("project-current"),
                title: "Current Thread",
                branch: "feature/current",
                worktreePath: "/work/current/.worktrees/current",
              }),
            ],
          }),
        ),
      );
    })(),
);

it.effect(
  "createThread in another project does not inherit the source thread checkout metadata",
  () =>
    (() => {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktreeCalls: Array<{
        readonly cwd: string;
        readonly refName: string;
        readonly newRefName?: string | undefined;
        readonly path: string | null;
      }> = [];
      const setupRunCalls: Array<{
        readonly threadId: string;
        readonly projectId?: string;
        readonly projectCwd?: string;
        readonly worktreePath: string;
      }> = [];
      return Effect.gen(function* () {
        const service = yield* McpOrchestrationService;
        const result = (yield* service.createThread({
          projectId: ProjectId.make("project-other"),
          title: "Cross-project follow-up",
          message: "Start this in the other project",
        })) as { readonly threadId: ThreadId };

        expect(result).toMatchObject({
          status: "accepted",
          threadId: expect.any(String),
          messageId: expect.any(String),
          sequence: 2,
        });
        expect(dispatchedCommands.map((command) => command.type)).toEqual([
          "thread.create",
          "thread.turn.start",
        ]);
        expect(dispatchedCommands[0]).toMatchObject({
          type: "thread.create",
          parentThreadId: null,
          projectId: "project-other",
          title: "Cross-project follow-up",
          branch: null,
          worktreePath: null,
        });
        expect(dispatchedCommands[1]).toMatchObject({
          type: "thread.turn.start",
          threadId: result.threadId,
          message: {
            role: "user",
            text: "Start this in the other project",
            attachments: [],
          },
        });
        expect(createWorktreeCalls).toEqual([]);
        expect(setupRunCalls).toEqual([]);
      }).pipe(
        Effect.provide(
          makeWriteHarnessLayer({
            dispatchedCommands,
            createWorktreeCalls,
            setupRunCalls,
            threadDetails: [
              threadDetail({
                id: ThreadId.make("thread-current"),
                projectId: ProjectId.make("project-current"),
                title: "Current Thread",
                branch: "feature/current",
                worktreePath: "/work/current/.worktrees/current",
              }),
            ],
          }),
        ),
      );
    })(),
);

it.effect(
  "createThread with a new worktree prepares checkout and setup before starting the turn",
  () =>
    (() => {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktreeCalls: Array<{
        readonly cwd: string;
        readonly refName: string;
        readonly newRefName?: string | undefined;
        readonly path: string | null;
      }> = [];
      const setupRunCalls: Array<{
        readonly threadId: string;
        readonly projectId?: string;
        readonly projectCwd?: string;
        readonly worktreePath: string;
      }> = [];
      const refreshStatusCalls: Array<string> = [];
      return Effect.gen(function* () {
        const service = yield* McpOrchestrationService;
        const result = (yield* service.createThread({
          title: "New worktree task",
          message: "Set up an isolated branch",
          checkoutMode: "new_worktree",
          baseBranch: "main",
          branch: "t3code/mcp-bootstrap",
        })) as { readonly threadId: ThreadId };

        expect(result).toMatchObject({
          status: "accepted",
          sequence: 5,
          thread: {
            branch: "t3code/mcp-bootstrap",
            worktreePath: "/work/current/.worktrees/mcp-bootstrap",
          },
        });
        expect(dispatchedCommands.map((command) => command.type)).toEqual([
          "thread.create",
          "thread.meta.update",
          "thread.activity.append",
          "thread.activity.append",
          "thread.turn.start",
        ]);
        expect(createWorktreeCalls).toEqual([
          {
            cwd: "/work/current",
            refName: "main",
            newRefName: "t3code/mcp-bootstrap",
            path: null,
          },
        ]);
        expect(setupRunCalls).toEqual([
          {
            threadId: result.threadId,
            projectId: "project-current",
            projectCwd: "/work/current",
            worktreePath: "/work/current/.worktrees/mcp-bootstrap",
          },
        ]);
        yield* Effect.yieldNow;
        expect(refreshStatusCalls).toEqual(["/work/current/.worktrees/mcp-bootstrap"]);
        if (dispatchedCommands[4]?.type === "thread.turn.start") {
          expect(dispatchedCommands[4].bootstrap).toBeUndefined();
        }
      }).pipe(
        Effect.provide(
          makeWriteHarnessLayer({
            dispatchedCommands,
            createWorktreeCalls,
            setupRunCalls,
            refreshStatusCalls,
          }),
        ),
      );
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
  "updateThreadSettings uses the live bound session model when persisted thread metadata is stale",
  () =>
    (() => {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      return Effect.gen(function* () {
        const service = yield* McpOrchestrationService;
        const result = yield* service.updateThreadSettings({
          threadId: ThreadId.make("thread-current"),
          modelSelection: defaultModelSelection({
            instanceId: ProviderInstanceId.make("codex-home"),
            model: "gpt-5.5-pro",
          }),
        });

        expect(result).toMatchObject({
          status: "updated",
          threadId: "thread-current",
          sequence: 1,
        });
        expect(dispatchedCommands).toHaveLength(1);
        expect(dispatchedCommands[0]).toMatchObject({
          type: "thread.meta.update",
          threadId: "thread-current",
          modelSelection: {
            instanceId: "codex-home",
            model: "gpt-5.5-pro",
          },
        });
      }).pipe(
        Effect.provide(
          makeWriteHarnessLayer({
            dispatchedCommands,
            providers: [
              makeProvider({
                instanceId: "codex-home",
                requiresNewThreadForModelChange: true,
                models: [
                  { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
                  {
                    slug: "gpt-5.5-pro",
                    name: "GPT-5.5 Pro",
                    isCustom: false,
                    capabilities: null,
                  },
                ],
              }),
            ],
            runtimeSessions: [
              {
                provider: ProviderDriverKind.make("codex"),
                providerInstanceId: ProviderInstanceId.make("codex-home"),
                status: "ready",
                runtimeMode: "full-access",
                model: "gpt-5.5-pro",
                threadId: ThreadId.make("thread-current"),
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
            threadDetails: [
              threadDetail({
                id: ThreadId.make("thread-current"),
                modelSelection: defaultModelSelection({
                  instanceId: ProviderInstanceId.make("codex-home"),
                  model: "gpt-5.5",
                }),
                session: {
                  threadId: ThreadId.make("thread-current"),
                  status: "ready",
                  providerName: "codex",
                  providerInstanceId: ProviderInstanceId.make("codex-home"),
                  runtimeMode: "full-access",
                  activeTurnId: null,
                  lastError: null,
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              }),
            ],
          }),
        ),
      );
    })(),
);

it.effect(
  "updateThreadSettings validates model switches against the bound session provider instance",
  () =>
    Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const exit = yield* Effect.exit(
        service.updateThreadSettings({
          threadId: ThreadId.make("thread-current"),
          modelSelection: defaultModelSelection({
            instanceId: ProviderInstanceId.make("codex-work"),
          }),
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("incompatible_model_session_switch");
      }
    }).pipe(
      Effect.provide(
        makeWriteHarnessLayer({
          providers: [
            makeProvider({
              instanceId: "codex-home",
              continuationGroupKey: "codex:home:/home/user/.codex",
            }),
            makeProvider({
              instanceId: "codex-work",
              continuationGroupKey: "codex:home:/work/.codex",
            }),
          ],
          threadDetails: [
            threadDetail({
              id: ThreadId.make("thread-current"),
              modelSelection: defaultModelSelection({
                instanceId: ProviderInstanceId.make("codex-work"),
              }),
              session: {
                threadId: ThreadId.make("thread-current"),
                status: "ready",
                providerName: "codex",
                providerInstanceId: ProviderInstanceId.make("codex-home"),
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            }),
          ],
        }),
      ),
    ),
);

it.effect("updateThreadSettings treats missing-vs-present continuation keys as incompatible", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.updateThreadSettings({
        threadId: ThreadId.make("thread-current"),
        modelSelection: defaultModelSelection({
          instanceId: ProviderInstanceId.make("codex-work"),
        }),
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("incompatible_model_session_switch");
    }
  }).pipe(
    Effect.provide(
      makeWriteHarnessLayer({
        providers: [
          makeProvider({
            instanceId: "codex-home",
            continuationGroupKey: null,
          }),
          makeProvider({
            instanceId: "codex-work",
            continuationGroupKey: "codex:home:/work/.codex",
          }),
        ],
        threadDetails: [
          threadDetail({
            id: ThreadId.make("thread-current"),
            modelSelection: defaultModelSelection({
              instanceId: ProviderInstanceId.make("codex-home"),
            }),
            session: {
              threadId: ThreadId.make("thread-current"),
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex-home"),
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          }),
        ],
      }),
    ),
  ),
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
