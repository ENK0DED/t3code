import { describe, expect, it } from "vite-plus/test";
import { expect as effectExpect, it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  findThreadById,
  listThreadsByProjectId,
  requireNonNegativeInteger,
  requireThread,
  requireThreadAbsent,
} from "./commandInvariants.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.make("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: ProjectId.make("project-b"),
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-a"),
      parentThreadId: null,
      title: "Thread A",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
    {
      id: ThreadId.make("thread-2"),
      projectId: ProjectId.make("project-b"),
      parentThreadId: null,
      title: "Thread B",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
  ],
};

const messageSendCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-1"),
  threadId: ThreadId.make("thread-1"),
  message: {
    messageId: MessageId.make("msg-1"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  createdAt: now,
};

describe("commandInvariants", () => {
  it("finds threads by id and project", () => {
    expect(findThreadById(readModel, ThreadId.make("thread-1"))?.projectId).toBe("project-a");
    expect(findThreadById(readModel, ThreadId.make("missing"))).toBeUndefined();
    expect(
      listThreadsByProjectId(readModel, ProjectId.make("project-b")).map((thread) => thread.id),
    ).toEqual([ThreadId.make("thread-2")]);
  });

  it("requires existing thread", async () => {
    const thread = await Effect.runPromise(
      requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.make("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.make("thread-1"));

    await expect(
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.make("missing"),
        }),
      ),
    ).rejects.toThrow("does not exist");
  });

  it("requires missing thread for create flows", async () => {
    await Effect.runPromise(
      requireThreadAbsent({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-2"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-a"),
          parentThreadId: null,
          title: "new",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        threadId: ThreadId.make("thread-3"),
      }),
    );

    await expect(
      Effect.runPromise(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-3"),
            threadId: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            parentThreadId: null,
            title: "dup",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          threadId: ThreadId.make("thread-1"),
        }),
      ),
    ).rejects.toThrow("already exists");
  });

  it("requires non-negative integers", async () => {
    await Effect.runPromise(
      requireNonNegativeInteger({
        commandType: "thread.checkpoint.revert",
        field: "turnCount",
        value: 0,
      }),
    );

    await expect(
      Effect.runPromise(
        requireNonNegativeInteger({
          commandType: "thread.checkpoint.revert",
          field: "turnCount",
          value: -1,
        }),
      ),
    ).rejects.toThrow("greater than or equal to 0");
  });
});

const deciderLayer = effectIt.layer(NodeServices.layer);

deciderLayer("commandInvariants decider checks", (it) => {
  it.effect("rejects a parent thread in a different project", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-cross-project-parent"),
            threadId: ThreadId.make("thread-child"),
            projectId: ProjectId.make("project-b"),
            parentThreadId: ThreadId.make("thread-1"),
            title: "Child",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.5",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      );

      effectExpect(error.message).toContain("belongs to a different project");
    }),
  );

  it.effect("rejects starting a turn when a turn-start request is already pending", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel: {
            ...readModel,
            threads: readModel.threads.map((thread) =>
              thread.id === ThreadId.make("thread-1")
                ? {
                    ...thread,
                    pendingTurnStart: {
                      messageId: MessageId.make("msg-pending"),
                      requestedAt: now,
                    },
                  }
                : thread,
            ),
          },
          command: {
            ...messageSendCommand,
            commandId: CommandId.make("cmd-second-turn"),
            message: {
              ...messageSendCommand.message,
              messageId: MessageId.make("msg-second"),
            },
          },
        }),
      );

      effectExpect(error.message).toContain("already has an active or pending turn");
    }),
  );

  it.effect("accepts starting a turn after a pending start is settled by session failure", () =>
    Effect.gen(function* () {
      const firstDecided = yield* decideOrchestrationCommand({
        readModel,
        command: messageSendCommand,
      });
      const firstEvents = Array.isArray(firstDecided) ? firstDecided : [firstDecided];
      let projected = readModel;
      let sequence = readModel.snapshotSequence;
      for (const event of firstEvents) {
        sequence += 1;
        projected = yield* projectEvent(projected, {
          ...event,
          sequence,
        }).pipe(Effect.orDie);
      }

      projected = yield* projectEvent(projected, {
        sequence: sequence + 1,
        eventId: EventId.make("evt-session-start-failed"),
        type: "thread.session-set",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-session-start-failed"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-session-start-failed"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "error",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: "Provider turn start failed.",
            updatedAt: now,
          },
        },
      } satisfies OrchestrationEvent).pipe(Effect.orDie);

      const retry = yield* decideOrchestrationCommand({
        readModel: projected,
        command: {
          ...messageSendCommand,
          commandId: CommandId.make("cmd-retry-after-start-failure"),
          message: {
            ...messageSendCommand.message,
            messageId: MessageId.make("msg-retry-after-start-failure"),
          },
        },
      });
      const retryEvents = Array.isArray(retry) ? retry : [retry];

      effectExpect(projected.threads[0]?.pendingTurnStart).toBeNull();
      effectExpect(retryEvents.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );

  it.effect("rejects creating a thread below the maximum thread depth", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel: {
            ...readModel,
            threads: [
              ...readModel.threads,
              {
                ...readModel.threads[0]!,
                id: ThreadId.make("thread-sub"),
                parentThreadId: ThreadId.make("thread-1"),
                title: "Sub-thread",
              },
            ],
          },
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-too-deep-parent"),
            threadId: ThreadId.make("thread-child"),
            projectId: ProjectId.make("project-a"),
            parentThreadId: ThreadId.make("thread-sub"),
            title: "Too deep",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.5",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      );

      effectExpect(error.message).toContain("maximum thread depth");
    }),
  );
});
