import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type OrchestrationThread,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { CheckpointDiffQuery } from "../checkpointing/CheckpointDiffQuery.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionThreadTurnLivenessRow,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadTurnLivenessQueryLive } from "../orchestration/Layers/ThreadTurnLivenessQuery.ts";
import { ThreadTurnSignalTrackerLive } from "../orchestration/Layers/ThreadTurnSignalTracker.ts";
import { ThreadTurnStartBootstrapDispatcher } from "../orchestration/Services/ThreadTurnStartBootstrapDispatcher.ts";
import { ProjectionThreadMessageSearchRepository } from "../persistence/Services/ProjectionThreadMessageSearch.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../provider/providerMaintenance.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import { McpOrchestrationServiceLive } from "./Layers/McpOrchestrationService.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import { OrchestrationToolkit } from "./toolkits/orchestration/tools.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const currentThreadId = ThreadId.make("thread-mcp-test");
const currentProjectId = ProjectId.make("project-mcp-test");
const providerInstanceId = ProviderInstanceId.make("codex");
const freshSignalAt = "2999-01-01T00:00:00.000Z";

const defaultModelSelection = (): ModelSelection => ({
  instanceId: providerInstanceId,
  model: "gpt-5.5",
});

const makeProvider = (): ServerProvider => ({
  instanceId: providerInstanceId,
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  availability: "available",
  continuation: {
    groupKey: "codex:instance:codex",
  },
  models: [
    {
      slug: "gpt-5.5",
      name: "GPT-5.5",
      isCustom: false,
      capabilities: createModelCapabilities({ optionDescriptors: [] }),
    },
  ],
  slashCommands: [],
  skills: [],
});

const currentProject: OrchestrationProjectShell = {
  id: currentProjectId,
  title: "MCP Test Project",
  workspaceRoot: "/work/mcp-test",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const currentThread: OrchestrationThread = {
  id: currentThreadId,
  projectId: currentProjectId,
  parentThreadId: null,
  title: "Current MCP Thread",
  modelSelection: defaultModelSelection(),
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const staleSignalAt = "1969-12-31T23:00:00.000Z";
const freshIso = () => freshSignalAt;

const runningThread = (turnId: TurnId): OrchestrationThread => {
  const timestamp = freshIso();
  return {
    ...currentThread,
    latestTurn: {
      turnId,
      state: "running",
      requestedAt: timestamp,
      startedAt: timestamp,
      completedAt: null,
      assistantMessageId: null,
    },
    session: {
      threadId: currentThreadId,
      status: "running",
      providerName: "codex",
      providerInstanceId,
      runtimeMode: "full-access",
      activeTurnId: turnId,
      lastError: null,
      updatedAt: timestamp,
    },
  };
};

const livenessRow = (
  input: Partial<ProjectionThreadTurnLivenessRow> & Pick<ProjectionThreadTurnLivenessRow, "turnId">,
): ProjectionThreadTurnLivenessRow => {
  const requestedAt = input.requestedAt ?? freshIso();
  const startedAt = input.startedAt ?? requestedAt;
  const lastProviderSignalAt = input.lastProviderSignalAt ?? null;
  return {
    threadId: input.threadId ?? currentThreadId,
    turnId: input.turnId,
    pendingMessageId: input.pendingMessageId ?? null,
    state: input.state ?? "running",
    requestedAt,
    startedAt,
    completedAt: input.completedAt ?? null,
    lastProviderSignalAt,
    lastObservableProgressAt: input.lastObservableProgressAt ?? lastProviderSignalAt ?? startedAt,
    lastSignalKind: input.lastSignalKind ?? null,
  };
};

const fakeEnvironment = ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const unsupportedProviderOperation = (operation: string) =>
  Effect.die(new Error(`${operation} unused`)) as never;
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

type IntegrationLayerOptions = {
  readonly getThreadDetailById?: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>>;
  readonly getThreadCreatorById?: (threadId: ThreadId) => Effect.Effect<
    Option.Option<{
      readonly createdVia: NonNullable<OrchestrationThread["createdVia"]>;
      readonly createdByThreadId: Exclude<OrchestrationThread["createdByThreadId"], undefined>;
    }>
  >;
  readonly getSnapshotSequence?: () => Effect.Effect<{ readonly snapshotSequence: number }>;
  readonly getThreadTurnLivenessRowById?: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<Option.Option<ProjectionThreadTurnLivenessRow>>;
  readonly onDispatch?: (command: OrchestrationCommand) => Effect.Effect<void>;
  readonly onBootstrapDispatch?: (input: {
    readonly command: OrchestrationCommand;
    readonly createdThread?: OrchestrationThreadShell | undefined;
  }) => Effect.Effect<void>;
};

const makeIntegrationLayer = (
  dispatchedCommands: Array<OrchestrationCommand>,
  options?: IntegrationLayerOptions,
) =>
  McpHttpServer.layer.pipe(
    Layer.provideMerge(McpSessionRegistry.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(McpOrchestrationServiceLive),
    Layer.provideMerge(ThreadTurnLivenessQueryLive),
    Layer.provideMerge(ThreadTurnSignalTrackerLive),
    Layer.provideMerge(
      Layer.succeed(
        PreviewAutomationBroker.PreviewAutomationBroker,
        PreviewAutomationBroker.PreviewAutomationBroker.of({
          connect: () => Effect.die("unused"),
          focusHost: () => Effect.die("unused"),
          respond: () => Effect.die("unused"),
          invoke: () => Effect.die("unused"),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        ProjectionSnapshotQuery,
        ProjectionSnapshotQuery.of({
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () =>
            options?.getSnapshotSequence?.() ?? Effect.succeed({ snapshotSequence: 1 }),
          getCounts: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          listProjectShells: () => Effect.succeed([currentProject]),
          getProjectShellById: (projectId) =>
            Effect.succeed(
              projectId === currentProjectId ? Option.some(currentProject) : Option.none(),
            ),
          getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
          listThreadShellsByProject: () => Effect.succeed([]),
          getThreadCheckpointContext: () => Effect.die("unused"),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.die("unused"),
          getThreadCreatorById: (threadId) =>
            options?.getThreadCreatorById?.(threadId) ?? Effect.succeed(Option.none()),
          getThreadDetailById: (threadId) =>
            options?.getThreadDetailById?.(threadId) ??
            Effect.succeed(
              threadId === currentThreadId ? Option.some(currentThread) : Option.none(),
            ),
          getThreadTurnStateById: () => Effect.succeed(Option.none()),
          getThreadTurnLivenessRowById: (input) =>
            options?.getThreadTurnLivenessRowById?.(input) ?? Effect.succeed(Option.none()),
          getThreadTurnStateByPendingMessageId: () => Effect.die("unused"),
          searchThreadMessagesByProject: () => Effect.succeed([]),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        CheckpointDiffQuery,
        CheckpointDiffQuery.of({
          getTurnDiff: () => Effect.die("unused"),
          getFullThreadDiff: () => Effect.die("unused"),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        OrchestrationEngineService,
        OrchestrationEngineService.of({
          dispatch: (command) =>
            Effect.gen(function* () {
              dispatchedCommands.push(command);
              if (options?.onDispatch) {
                yield* options.onDispatch(command);
              }
              return { sequence: dispatchedCommands.length };
            }),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        ThreadTurnStartBootstrapDispatcher,
        ThreadTurnStartBootstrapDispatcher.of({
          dispatch: (command) =>
            Effect.gen(function* () {
              let createdThread:
                | {
                    readonly id: ThreadId;
                    readonly projectId: ProjectId;
                    readonly parentThreadId: ThreadId | null;
                    readonly title: string;
                    readonly modelSelection: ModelSelection;
                    readonly runtimeMode: OrchestrationThread["runtimeMode"];
                    readonly interactionMode: OrchestrationThread["interactionMode"];
                    readonly branch: string | null;
                    readonly worktreePath: string | null;
                    readonly createdAt: string;
                    readonly updatedAt: string;
                    readonly archivedAt: null;
                    readonly latestTurn: null;
                    readonly session: null;
                    readonly latestUserMessageAt: null;
                    readonly hasPendingApprovals: false;
                    readonly hasPendingUserInput: false;
                    readonly hasActionableProposedPlan: false;
                  }
                | undefined;

              if (command.bootstrap?.createThread) {
                const createThread = command.bootstrap.createThread;
                createdThread = {
                  id: command.threadId,
                  projectId: createThread.projectId,
                  parentThreadId: createThread.parentThreadId,
                  title: createThread.title,
                  modelSelection: createThread.modelSelection,
                  runtimeMode: createThread.runtimeMode,
                  interactionMode: createThread.interactionMode,
                  branch: createThread.branch,
                  worktreePath: createThread.worktreePath,
                  createdAt: createThread.createdAt,
                  updatedAt: createThread.createdAt,
                  archivedAt: null,
                  latestTurn: null,
                  session: null,
                  latestUserMessageAt: null,
                  hasPendingApprovals: false,
                  hasPendingUserInput: false,
                  hasActionableProposedPlan: false,
                };
                dispatchedCommands.push({
                  type: "thread.create",
                  commandId: CommandId.make("test:bootstrap-thread-create"),
                  threadId: command.threadId,
                  projectId: createThread.projectId,
                  parentThreadId: createThread.parentThreadId,
                  title: createThread.title,
                  modelSelection: createThread.modelSelection,
                  runtimeMode: createThread.runtimeMode,
                  interactionMode: createThread.interactionMode,
                  branch: createThread.branch,
                  worktreePath: createThread.worktreePath,
                  createdAt: createThread.createdAt,
                });
              }

              if (command.bootstrap?.prepareWorktree) {
                const branch =
                  command.bootstrap.prepareWorktree.branch ??
                  command.bootstrap.prepareWorktree.baseBranch;
                const worktreePath = "/work/mcp-test/.worktrees/http-bootstrap";
                if (createdThread) {
                  createdThread = {
                    ...createdThread,
                    branch,
                    worktreePath,
                  };
                }
                dispatchedCommands.push({
                  type: "thread.meta.update",
                  commandId: CommandId.make("test:bootstrap-thread-meta-update"),
                  threadId: command.threadId,
                  branch,
                  worktreePath,
                });
              }

              const { bootstrap: _bootstrap, ...turnStartCommand } = command;
              dispatchedCommands.push(turnStartCommand);
              if (options?.onBootstrapDispatch) {
                yield* options.onBootstrapDispatch({
                  command: turnStartCommand,
                  createdThread,
                });
              }

              return {
                sequence: dispatchedCommands.length,
                ...(createdThread ? { createdThread } : {}),
              };
            }),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        ProviderRegistry,
        ProviderRegistry.of({
          getProviders: Effect.succeed([makeProvider()]),
          refresh: () => Effect.succeed([makeProvider()]),
          refreshInstance: () => Effect.succeed([makeProvider()]),
          getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null }),
            ),
          setProviderMaintenanceActionState: () => Effect.succeed([makeProvider()]),
          streamChanges: Stream.empty,
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        ProviderService,
        ProviderService.of({
          startSession: () => unsupportedProviderOperation("startSession"),
          sendTurn: () => unsupportedProviderOperation("sendTurn"),
          interruptTurn: () => unsupportedProviderOperation("interruptTurn"),
          respondToRequest: () => unsupportedProviderOperation("respondToRequest"),
          respondToUserInput: () => unsupportedProviderOperation("respondToUserInput"),
          stopSession: () => unsupportedProviderOperation("stopSession"),
          listSessions: () => Effect.succeed([]),
          getCapabilities: () => unsupportedProviderOperation("getCapabilities"),
          getInstanceInfo: () => unsupportedProviderOperation("getInstanceInfo"),
          rollbackConversation: () => unsupportedProviderOperation("rollbackConversation"),
          streamEvents: Stream.empty,
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
    Layer.provideMerge(ServerSettingsService.layerTest()),
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
    Layer.provideMerge(Layer.succeed(ServerEnvironment, fakeEnvironment)),
  );

function parseJsonRpcResponse(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("event:")) {
    return decodeUnknownJsonString(trimmed);
  }

  const data = trimmed
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  if (!data) {
    throw new Error(`MCP SSE response did not include a data line: ${text}`);
  }
  return decodeUnknownJsonString(data);
}

function initializeMcpSession(issuedToken: string) {
  return Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const initializeResponse = yield* httpClient.post("/mcp", {
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${issuedToken}`,
        "content-type": "application/json",
      },
      body: HttpBody.text(
        yield* encodeUnknownJsonString({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "mcp-orchestration-test", version: "1.0.0" },
          },
        }),
        "application/json",
      ),
    });
    expect(initializeResponse.status).toBe(200);
    return {
      sessionId: initializeResponse.headers["mcp-session-id"]!,
    };
  });
}

function callMcpToolResult(sessionId: string, issuedToken: string, name: string, args: unknown) {
  return Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.post("/mcp", {
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${issuedToken}`,
        "content-type": "application/json",
        "mcp-session-id": sessionId,
      },
      body: HttpBody.text(
        yield* encodeUnknownJsonString({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name,
            arguments: args,
          },
        }),
        "application/json",
      ),
    });
    expect(response.status).toBe(200);
    const payload = (yield* parseJsonRpcResponse(yield* response.text)) as {
      readonly result?: { readonly structuredContent?: unknown; readonly isError?: boolean };
      readonly error?: unknown;
    };
    expect(payload.error).toBeUndefined();
    return payload.result!;
  });
}

function callMcpTool(sessionId: string, issuedToken: string, name: string, args: unknown) {
  return callMcpToolResult(sessionId, issuedToken, name, args).pipe(
    Effect.tap((result) => Effect.sync(() => expect(result.isError).toBe(false))),
  );
}

function issueMcpToken() {
  return Effect.gen(function* () {
    const issued = yield* McpSessionRegistry.issueActiveMcpCredential({
      threadId: currentThreadId,
      providerInstanceId,
    });
    if (!issued) {
      return yield* Effect.die("MCP session registry was not active");
    }
    return issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
  });
}

const expectedToolNames = Object.keys(OrchestrationToolkit.tools);

it.effect("lists MCP-enabled models through the MCP transport", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(makeIntegrationLayer([]), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const issuedToken = yield* issueMcpToken();
      const initialize = yield* initializeMcpSession(issuedToken);
      const response = yield* callMcpTool(initialize.sessionId, issuedToken, "list_mcp_models", {});

      expect(response.structuredContent).toMatchObject({
        providers: {
          codex: {
            models: {
              "gpt-5.5": expect.any(Object),
            },
          },
        },
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("reads thread settings through the renamed MCP transport tool", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(makeIntegrationLayer([]), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const issuedToken = yield* issueMcpToken();
      const initialize = yield* initializeMcpSession(issuedToken);
      const response = yield* callMcpTool(
        initialize.sessionId,
        issuedToken,
        "get_thread_settings",
        {},
      );

      expect(response.structuredContent).toMatchObject({
        threadId: currentThreadId,
        projectId: currentProjectId,
        title: "Current MCP Thread",
        modelSelection: defaultModelSelection(),
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("serves the planned orchestration toolkit HTTP tool surface", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(makeIntegrationLayer([]), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const issuedToken = yield* issueMcpToken();
      const initialize = yield* initializeMcpSession(issuedToken);
      const httpClient = yield* HttpClient.HttpClient;
      const response = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${issuedToken}`,
          "content-type": "application/json",
          "mcp-session-id": initialize.sessionId,
        },
        body: HttpBody.text(
          yield* encodeUnknownJsonString({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/list",
            params: {},
          }),
          "application/json",
        ),
      });

      expect(response.status).toBe(200);
      const payload = (yield* parseJsonRpcResponse(yield* response.text)) as {
        readonly result?: { readonly tools?: ReadonlyArray<{ readonly name: string }> };
        readonly error?: unknown;
      };

      expect(payload.error).toBeUndefined();
      const orchestrationToolNames =
        payload.result?.tools
          ?.map((tool) => tool.name)
          .filter((name) =>
            expectedToolNames.includes(name as (typeof expectedToolNames)[number]),
          ) ?? [];
      expect(orchestrationToolNames).toEqual(expectedToolNames);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("handles turn liveness status wait and stale cancel through the MCP transport", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const turnId = TurnId.make("turn-mcp-liveness");
      const rowRef = yield* Ref.make(
        livenessRow({
          turnId,
          lastProviderSignalAt: freshIso(),
          lastSignalKind: "reasoning",
        }),
      );
      const sequenceRef = yield* Ref.make(1);
      yield* HttpRouter.serve(
        makeIntegrationLayer(dispatchedCommands, {
          getThreadDetailById: (threadId) =>
            Effect.succeed(
              threadId === currentThreadId ? Option.some(runningThread(turnId)) : Option.none(),
            ),
          getThreadTurnLivenessRowById: ({ threadId, turnId: requestedTurnId }) =>
            Ref.get(rowRef).pipe(
              Effect.map((row) =>
                row.threadId === threadId && row.turnId === requestedTurnId
                  ? Option.some(row)
                  : Option.none<ProjectionThreadTurnLivenessRow>(),
              ),
            ),
          getSnapshotSequence: () =>
            Ref.get(sequenceRef).pipe(Effect.map((snapshotSequence) => ({ snapshotSequence }))),
        }),
        {
          disableListenLog: true,
          disableLogger: true,
        },
      ).pipe(Layer.build);
      const issuedToken = yield* issueMcpToken();
      const initialize = yield* initializeMcpSession(issuedToken);

      const status = yield* callMcpTool(
        initialize.sessionId,
        issuedToken,
        "get_thread_turn_status",
        { threadId: currentThreadId, turnId },
      );
      expect(status.structuredContent).toMatchObject({
        threadId: currentThreadId,
        liveness: {
          turnId,
          state: "running",
        },
      });

      const invalidWait = yield* callMcpToolResult(
        initialize.sessionId,
        issuedToken,
        "wait_for_thread_update",
        {
          threadId: currentThreadId,
          turnId,
          since: "not-a-cursor",
          timeoutMs: 1_000,
        },
      );
      expect(invalidWait.isError).toBe(true);
      expect(yield* encodeUnknownJsonString(invalidWait)).toContain("Invalid thread update cursor");

      yield* Ref.set(
        rowRef,
        livenessRow({
          turnId,
          requestedAt: staleSignalAt,
          startedAt: staleSignalAt,
          lastProviderSignalAt: staleSignalAt,
          lastObservableProgressAt: staleSignalAt,
          lastSignalKind: "reasoning",
        }),
      );
      yield* Ref.set(sequenceRef, 2);
      const staleStatus = yield* callMcpTool(
        initialize.sessionId,
        issuedToken,
        "get_thread_turn_status",
        { threadId: currentThreadId, turnId },
      );
      expect(staleStatus.structuredContent).toMatchObject({
        threadId: currentThreadId,
        liveness: {
          stale: true,
          safeToInterrupt: true,
        },
      });
      const staleCursor = (staleStatus.structuredContent as { readonly cursor: string }).cursor;

      const cancel = yield* callMcpTool(
        initialize.sessionId,
        issuedToken,
        "cancel_stale_thread_turn",
        {
          threadId: currentThreadId,
          turnId,
          ifNoProgressSince: staleCursor,
        },
      );
      expect(cancel.structuredContent).toMatchObject({
        status: "interrupt_requested",
        threadId: currentThreadId,
        turnId,
        forced: false,
      });
      expect(dispatchedCommands.map((command) => command.type)).toEqual([
        "thread.activity.append",
        "thread.turn.interrupt",
      ]);
      expect(dispatchedCommands[1]).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: currentThreadId,
        turnId,
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("reads project details through the MCP transport", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(makeIntegrationLayer([]), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const issuedToken = yield* issueMcpToken();
      const initialize = yield* initializeMcpSession(issuedToken);
      const response = yield* callMcpTool(
        initialize.sessionId,
        issuedToken,
        "get_project_details",
        {},
      );

      expect(response.structuredContent).toMatchObject({
        projectId: currentProjectId,
        title: "MCP Test Project",
        workspaceRoot: "/work/mcp-test",
        repositorySummary: null,
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("reads project settings through the MCP transport", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(makeIntegrationLayer([]), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const issuedToken = yield* issueMcpToken();
      const initialize = yield* initializeMcpSession(issuedToken);
      const response = yield* callMcpTool(
        initialize.sessionId,
        issuedToken,
        "get_project_settings",
        {},
      );

      expect(response.structuredContent).toMatchObject({
        projectId: currentProjectId,
        title: "MCP Test Project",
        defaultModelSelection: null,
        resolvedDefaultModel: null,
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("lists project actions through the MCP transport", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(makeIntegrationLayer([]), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const issuedToken = yield* issueMcpToken();
      const initialize = yield* initializeMcpSession(issuedToken);
      const response = yield* callMcpTool(
        initialize.sessionId,
        issuedToken,
        "list_project_actions",
        {},
      );

      expect(response.structuredContent).toMatchObject({
        projectId: currentProjectId,
        actions: [],
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("updates project settings through the MCP transport with an explicit project id", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      yield* HttpRouter.serve(makeIntegrationLayer(dispatchedCommands), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const issuedToken = yield* issueMcpToken();
      const initialize = yield* initializeMcpSession(issuedToken);
      const response = yield* callMcpTool(
        initialize.sessionId,
        issuedToken,
        "update_project_settings",
        {
          projectId: currentProjectId,
          title: "Renamed MCP Test Project",
        },
      );

      expect(response.structuredContent).toMatchObject({
        status: "updated",
        projectId: currentProjectId,
      });
      expect(dispatchedCommands).toHaveLength(1);
      expect(dispatchedCommands[0]).toMatchObject({
        type: "project.meta.update",
        projectId: currentProjectId,
        title: "Renamed MCP Test Project",
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("creates a child thread through the MCP transport", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      yield* HttpRouter.serve(makeIntegrationLayer(dispatchedCommands), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const issuedToken = yield* issueMcpToken();
      const initialize = yield* initializeMcpSession(issuedToken);
      const response = yield* callMcpTool(initialize.sessionId, issuedToken, "create_thread", {
        placement: "child_of_thread",
        parentThreadId: currentThreadId,
        title: "Investigate failing tests",
      });

      expect(response.structuredContent).toMatchObject({
        thread: {
          parentThreadId: currentThreadId,
        },
      });
      expect(dispatchedCommands[0]).toMatchObject({
        type: "thread.create",
        parentThreadId: currentThreadId,
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("returns final bootstrap metadata for accepted create_thread responses", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      yield* HttpRouter.serve(makeIntegrationLayer(dispatchedCommands), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const issuedToken = yield* issueMcpToken();
      const initialize = yield* initializeMcpSession(issuedToken);
      const response = yield* callMcpTool(initialize.sessionId, issuedToken, "create_thread", {
        placement: "child_of_thread",
        parentThreadId: currentThreadId,
        title: "Investigate bootstrap checkout",
        message: "Start this in a prepared worktree",
        checkoutMode: "new_worktree",
        baseBranch: "main",
        branch: "t3code/mcp-http-bootstrap",
      });

      expect(response.structuredContent).toMatchObject({
        status: "accepted",
        thread: {
          parentThreadId: currentThreadId,
          branch: "t3code/mcp-http-bootstrap",
          worktreePath: "/work/mcp-test/.worktrees/http-bootstrap",
        },
      });
      expect(dispatchedCommands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.meta.update",
        "thread.turn.start",
      ]);
      expect(dispatchedCommands[0]).toMatchObject({
        type: "thread.create",
        branch: "t3code/mcp-http-bootstrap",
        worktreePath: null,
      });
      expect(dispatchedCommands[1]).toMatchObject({
        type: "thread.meta.update",
        branch: "t3code/mcp-http-bootstrap",
        worktreePath: "/work/mcp-test/.worktrees/http-bootstrap",
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("resolves an approval-required child deadlock through MCP tools", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const childTurnId = TurnId.make("turn-child-approval");
      const approvalRequestId = "approval-child-1";
      const threadsRef = yield* Ref.make(
        new Map<string, OrchestrationThread>([
          [
            String(currentThreadId),
            {
              ...currentThread,
              createdVia: "user",
              createdByThreadId: null,
            },
          ],
        ]),
      );
      const integrationLayer = makeIntegrationLayer(dispatchedCommands, {
        getThreadDetailById: (threadId) =>
          Ref.get(threadsRef).pipe(
            Effect.map((threads) => {
              const found = threads.get(String(threadId));
              return found ? Option.some(found) : Option.none();
            }),
          ),
        getThreadCreatorById: (threadId) =>
          Ref.get(threadsRef).pipe(
            Effect.map((threads) => {
              const found = threads.get(String(threadId));
              return found
                ? Option.some({
                    createdVia: found.createdVia ?? "user",
                    createdByThreadId: found.createdByThreadId ?? null,
                  })
                : Option.none();
            }),
          ),
        onBootstrapDispatch: ({ command, createdThread }) =>
          Effect.gen(function* () {
            if (command.type !== "thread.turn.start" || createdThread === undefined) {
              return;
            }
            const blockedChild: OrchestrationThread = {
              id: createdThread.id,
              projectId: createdThread.projectId,
              parentThreadId: createdThread.parentThreadId,
              title: createdThread.title,
              modelSelection: createdThread.modelSelection,
              runtimeMode: createdThread.runtimeMode,
              interactionMode: createdThread.interactionMode,
              branch: createdThread.branch,
              worktreePath: createdThread.worktreePath,
              latestTurn: {
                turnId: childTurnId,
                state: "running",
                requestedAt: createdThread.createdAt,
                startedAt: createdThread.createdAt,
                completedAt: null,
                assistantMessageId: null,
              },
              createdAt: createdThread.createdAt,
              updatedAt: createdThread.updatedAt,
              archivedAt: null,
              createdVia: "mcp",
              createdByThreadId: currentThreadId,
              deletedAt: null,
              messages: [],
              proposedPlans: [],
              activities: [
                {
                  id: "evt-child-approval-requested" as never,
                  tone: "approval",
                  kind: "approval.requested",
                  summary: "Approval requested",
                  payload: {
                    requestId: approvalRequestId,
                    requestKind: "command",
                    requestType: "command_execution_approval",
                    detail: "bun test",
                  },
                  turnId: childTurnId,
                  createdAt: "2026-01-01T00:00:01.000Z",
                },
              ],
              checkpoints: [],
              session: {
                threadId: createdThread.id,
                status: "running",
                providerName: "codex",
                providerInstanceId,
                runtimeMode: createdThread.runtimeMode,
                activeTurnId: childTurnId,
                lastError: null,
                updatedAt: "2026-01-01T00:00:01.000Z",
              },
            };
            yield* Ref.update(threadsRef, (threads) =>
              new Map(threads).set(String(blockedChild.id), blockedChild),
            );
          }),
        onDispatch: (command) =>
          Effect.gen(function* () {
            if (command.type !== "thread.approval.respond") {
              return;
            }
            yield* Ref.update(threadsRef, (threads) => {
              const current = threads.get(String(command.threadId));
              if (!current) {
                return threads;
              }
              return new Map(threads).set(String(command.threadId), {
                ...current,
                latestTurn:
                  current.latestTurn === null
                    ? null
                    : {
                        ...current.latestTurn,
                        state: "completed" as const,
                        completedAt: "2026-01-01T00:00:02.000Z",
                      },
                activities: [
                  ...current.activities,
                  {
                    id: "evt-child-approval-resolved" as never,
                    tone: "approval" as const,
                    kind: "approval.resolved",
                    summary: "Approval resolved",
                    payload: {
                      requestId: command.requestId,
                      decision: command.decision,
                    },
                    turnId: childTurnId,
                    createdAt: "2026-01-01T00:00:02.000Z",
                  },
                ],
                session:
                  current.session === null
                    ? null
                    : {
                        ...current.session,
                        status: "ready" as const,
                        activeTurnId: null,
                        updatedAt: "2026-01-01T00:00:02.000Z",
                      },
              });
            });
          }),
      });
      yield* HttpRouter.serve(integrationLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const issuedToken = yield* issueMcpToken();
      const initialize = yield* initializeMcpSession(issuedToken);

      const create = yield* callMcpTool(initialize.sessionId, issuedToken, "create_thread", {
        placement: "child_of_thread",
        parentThreadId: currentThreadId,
        title: "Approval deadlock child",
        runtimeMode: "approval-required",
        message: "Run the test suite",
      });
      const childThreadId = (create.structuredContent as { readonly threadId: ThreadId }).threadId;

      const settings = yield* callMcpTool(
        initialize.sessionId,
        issuedToken,
        "get_thread_settings",
        { threadId: childThreadId },
      );
      expect(settings.structuredContent).toMatchObject({
        threadId: childThreadId,
        runtimeMode: "approval-required",
        hasPendingApprovals: true,
        pendingRequests: [
          {
            kind: "approval",
            requestId: approvalRequestId,
            requestKind: "command",
          },
        ],
      });

      const approval = yield* callMcpTool(
        initialize.sessionId,
        issuedToken,
        "respond_to_approval",
        {
          threadId: childThreadId,
          requestId: approvalRequestId,
          decision: "accept",
        },
      );
      expect(approval.structuredContent).toMatchObject({
        status: "approval_recorded",
        threadId: childThreadId,
        requestId: approvalRequestId,
      });

      const after = yield* callMcpTool(initialize.sessionId, issuedToken, "get_thread_settings", {
        threadId: childThreadId,
      });
      expect(after.structuredContent).toMatchObject({
        threadId: childThreadId,
        hasPendingApprovals: false,
        pendingRequests: [],
        session: {
          status: "ready",
          activeTurnId: null,
        },
      });
      expect(dispatchedCommands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
        "thread.approval.respond",
      ]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
