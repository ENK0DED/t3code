import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpProviderSession from "./McpProviderSession.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

const markIssuedCredentialLive = (issued: McpSessionRegistry.McpIssuedCredential) =>
  Effect.sync(() => {
    McpProviderSession.setMcpProviderSession(issued.config);
  });

afterEach(() => {
  McpProviderSession.clearAllMcpProviderSessions();
});

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    yield* Effect.sync(McpProviderSession.clearAllMcpProviderSessions);
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    yield* markIssuedCredentialLive(issued);
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    yield* Effect.sync(McpProviderSession.clearAllMcpProviderSessions);
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("keeps provider credentials valid across idle time and long runtimes", () =>
  Effect.gen(function* () {
    yield* Effect.sync(McpProviderSession.clearAllMcpProviderSessions);
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-2");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    yield* markIssuedCredentialLive(issued);
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 10_000;
    expect((yield* registry.resolve(token))?.threadId).toBe(threadId);
  }),
);

it.effect("rejects credentials after their provider session is no longer live", () =>
  Effect.gen(function* () {
    yield* Effect.sync(McpProviderSession.clearAllMcpProviderSessions);
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-stopped");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    yield* markIssuedCredentialLive(issued);
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    expect((yield* registry.beginRequest(token))?.threadId).toBe(threadId);
    yield* registry.finishRequest(token);

    yield* Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId));
    timestamp += 1;
    expect(yield* registry.resolve(token)).toBeUndefined();
    expect(yield* registry.beginRequest(token)).toBeUndefined();
  }),
);

it.effect("keeps credentials alive while an MCP request is in flight", () =>
  Effect.gen(function* () {
    yield* Effect.sync(McpProviderSession.clearAllMcpProviderSessions);
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-long-wait");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    yield* markIssuedCredentialLive(issued);
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    const invocation = yield* registry.beginRequest(token);
    expect(invocation?.threadId).toBe(threadId);

    timestamp += 101;
    expect(yield* registry.hasActiveThreadRequest(threadId)).toBe(true);

    yield* registry.finishRequest(token);
    expect(yield* registry.hasActiveThreadRequest(threadId)).toBe(false);
    expect((yield* registry.resolve(token))?.threadId).toBe(threadId);

    timestamp += 101;
    expect((yield* registry.resolve(token))?.threadId).toBe(threadId);
  }),
);
