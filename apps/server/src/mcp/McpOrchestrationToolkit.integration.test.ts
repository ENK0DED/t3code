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
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadTurnStartBootstrapDispatcher } from "../orchestration/Services/ThreadTurnStartBootstrapDispatcher.ts";
import { ProjectionThreadMessageSearchRepository } from "../persistence/Services/ProjectionThreadMessageSearch.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../provider/providerMaintenance.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const currentThreadId = ThreadId.make("thread-mcp-test");
const currentProjectId = ProjectId.make("project-mcp-test");
const providerInstanceId = ProviderInstanceId.make("codex");

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

const fakeEnvironment = ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const unsupportedProviderOperation = (operation: string) =>
  Effect.die(new Error(`${operation} unused`)) as never;
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const makeIntegrationLayer = (dispatchedCommands: Array<OrchestrationCommand>) =>
  McpHttpServer.layer.pipe(
    Layer.provideMerge(McpSessionRegistry.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Layer.succeed(
        ProjectionSnapshotQuery,
        ProjectionSnapshotQuery.of({
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
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
          getThreadDetailById: (threadId) =>
            Effect.succeed(
              threadId === currentThreadId ? Option.some(currentThread) : Option.none(),
            ),
          searchThreadMessagesByProject: () => Effect.succeed([]),
        }),
      ),
    ),
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
        ThreadTurnStartBootstrapDispatcher,
        ThreadTurnStartBootstrapDispatcher.of({
          dispatch: (command) =>
            Effect.sync(() => {
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

function callMcpTool(sessionId: string, issuedToken: string, name: string, args: unknown) {
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
    expect(payload.result?.isError).toBe(false);
    return payload.result!;
  });
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

it.effect("prepares a worktree for first send_thread_message through the MCP transport", () =>
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
        "send_thread_message",
        {
          threadId: currentThreadId,
          message: "Start this in a prepared worktree",
          checkoutMode: "new_worktree",
          baseBranch: "main",
          branch: "t3code/mcp-http-bootstrap",
        },
      );

      expect(response.structuredContent).toMatchObject({
        status: "accepted",
        threadId: currentThreadId,
        messageId: expect.any(String),
        sequence: 1,
      });
      expect(dispatchedCommands.map((command) => command.type)).toEqual(["thread.turn.start"]);
      expect(dispatchedCommands[0]).toMatchObject({
        type: "thread.turn.start",
        threadId: currentThreadId,
        message: {
          role: "user",
          text: "Start this in a prepared worktree",
          attachments: [],
        },
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
