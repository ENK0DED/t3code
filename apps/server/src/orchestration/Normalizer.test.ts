import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type ClientOrchestrationCommand,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

// The normalizer acquires FileSystem/Path/ServerConfig/WorkspacePaths up front; the
// thread.create / bootstrap branches do not use them, but they must be in context.
const NormalizerTestLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "normalizer-spoof-test" }),
  WorkspacePathsLive,
).pipe(Layer.provideMerge(NodeServices.layer));

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

it.effect("forces user provenance on a spoofed thread.create command", () =>
  Effect.gen(function* () {
    const normalized = yield* normalizeDispatchCommand({
      type: "thread.create",
      commandId: CommandId.make("cmd-spoof-create"),
      threadId: ThreadId.make("thread-spoof"),
      projectId: ProjectId.make("project-spoof"),
      parentThreadId: null,
      title: "Spoof attempt",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      // A WS/UI client must not be able to forge MCP provenance.
      createdVia: "mcp",
      createdByThreadId: ThreadId.make("victim-thread"),
      createdAt: "2026-01-01T00:00:00.000Z",
    } as ClientOrchestrationCommand);

    assert.strictEqual(normalized.type, "thread.create");
    if (normalized.type === "thread.create") {
      assert.strictEqual(normalized.createdVia, "user");
      assert.strictEqual(normalized.createdByThreadId, null);
    }
  }).pipe(Effect.provide(NormalizerTestLayer)),
);

it.effect("forces user provenance on a spoofed thread.turn.start bootstrap create", () =>
  Effect.gen(function* () {
    const normalized = yield* normalizeDispatchCommand({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-spoof-turn"),
      threadId: ThreadId.make("thread-spoof-turn"),
      message: {
        messageId: MessageId.make("msg-spoof"),
        role: "user",
        text: "spoof",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-spoof"),
          parentThreadId: null,
          title: "Bootstrap spoof",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          // A WS/UI bootstrap create must not be able to forge MCP provenance either.
          createdVia: "mcp",
          createdByThreadId: ThreadId.make("victim-thread"),
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    } as ClientOrchestrationCommand);

    assert.strictEqual(normalized.type, "thread.turn.start");
    if (normalized.type === "thread.turn.start") {
      assert.strictEqual(normalized.bootstrap?.createThread?.createdVia, "user");
      assert.strictEqual(normalized.bootstrap?.createThread?.createdByThreadId, null);
    }
  }).pipe(Effect.provide(NormalizerTestLayer)),
);
