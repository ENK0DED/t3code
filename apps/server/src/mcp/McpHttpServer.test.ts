import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpServer } from "@effect/platform-node";
import { EnvironmentId, PreviewTabId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";
import {
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/unstable/http";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadTurnStartBootstrapDispatcher } from "../orchestration/Services/ThreadTurnStartBootstrapDispatcher.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../provider/providerMaintenance.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { McpOrchestrationServiceLive } from "./Layers/McpOrchestrationService.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview", "orchestration.read", "orchestration.write"] as const),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const fakeHttpServer = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const fakeEnvironment = ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});
const unsupportedProviderOperation = (operation: string) =>
  Effect.die(new Error(`${operation} unused`)) as never;
const TestLayer = McpHttpServer.McpToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provide(
    McpOrchestrationServiceLive.pipe(
      Layer.provideMerge(
        Layer.succeed(
          ThreadTurnStartBootstrapDispatcher,
          ThreadTurnStartBootstrapDispatcher.of({
            dispatch: () => Effect.die("unused"),
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getCounts: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
          listProjectShells: () => Effect.succeed([]),
          getProjectShellById: () => Effect.die("unused"),
          getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
          listThreadShellsByProject: () => Effect.succeed([]),
          getThreadCheckpointContext: () => Effect.die("unused"),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.die("unused"),
          getThreadDetailById: () => Effect.die("unused"),
          searchThreadMessagesByProject: () => Effect.succeed([]),
        }),
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
      Layer.provideMerge(
        Layer.succeed(
          ProviderRegistry,
          ProviderRegistry.of({
            getProviders: Effect.succeed([]),
            refresh: () => Effect.succeed([]),
            refreshInstance: () => Effect.succeed([]),
            getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null }),
              ),
            setProviderMaintenanceActionState: () => Effect.succeed([]),
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
    ),
  ),
);
const RegistryTestLayer = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing
    .make()
    .pipe(
      Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
      Effect.provideService(ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    ),
);

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const requests = yield* broker.connect("mcp-test-client");
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          requestId: request.requestId,
          ok: true,
          result:
            request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* broker.reportOwner({
        clientId: "mcp-test-client",
        environmentId,
        threadId,
        tabId,
        visible: true,
        supportsAutomation: true,
        focusedAt: "2026-06-11T00:00:00.000Z",
      });

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const listModelsTool = server.tools.find(({ tool }) => tool.name === "list_mcp_models");
      expect(listModelsTool?.tool.description).toBe(
        "Return provider instances and MCP-enabled models available to MCP tools.",
      );

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(malformed.isError).toBe(true);

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });

      const press = yield* server
        .callTool({ name: "preview_press", arguments: { key: "Enter" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(press.isError).toBe(false);
      expect(press.structuredContent).toBeNull();
      expect(press.content).toEqual([{ type: "text", text: "null" }]);

      const orchestration = yield* server
        .callTool({ name: "list_mcp_models", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(orchestration.isError).toBe(false);
      expect(orchestration.structuredContent).toMatchObject({
        providers: {},
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("issues provider MCP credentials with orchestration capabilities", () =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });

    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);

    expect(resolved?.capabilities.has("preview")).toBe(true);
    expect(resolved?.capabilities.has("orchestration.read")).toBe(true);
    expect(resolved?.capabilities.has("orchestration.write")).toBe(true);
  }).pipe(Effect.provide(RegistryTestLayer)),
);

it.effect("denies orchestration read tools without read capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const denied = yield* server.callTool({ name: "list_mcp_models", arguments: {} }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation,
          capabilities: new Set(["preview"] as const),
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

      expect(denied.isError).toBe(true);
      expect(denied.content[0]?.type).toBe("text");
      expect(denied.content[0]?.type === "text" ? denied.content[0].text : "").toContain(
        "does not grant the orchestration.read capability",
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("denies orchestration write tools without write capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const denied = yield* server
        .callTool({
          name: "add_project",
          arguments: { path: "/srv/dev/projects/t3code-mcp-orchestration" },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            ...invocation,
            capabilities: new Set(["preview", "orchestration.read"] as const),
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(denied.isError).toBe(true);
      expect(denied.content[0]?.type).toBe("text");
      expect(denied.content[0]?.type === "text" ? denied.content[0].text : "").toContain(
        "does not grant the orchestration.write capability",
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);
