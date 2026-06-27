import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as Cause from "effect/Cause";

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
import type { ThreadSummaryGenerationInput } from "../textGeneration/TextGeneration.ts";

const defaultModelSelection = (overrides?: Partial<ModelSelection>): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.5",
  ...overrides,
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

const projectionQueryMock = (input: {
  readonly threadDetail: OrchestrationThread | null;
  readonly threadShells?: ReadonlyArray<OrchestrationThreadShell>;
}) =>
  ProjectionSnapshotQuery.of({
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getProjectShellById: () => Effect.die("unused"),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: (threadId) =>
      Effect.succeed(
        (() => {
          const thread = input.threadShells?.find((candidate) => candidate.id === threadId);
          return thread ? Option.some(thread) : Option.none();
        })(),
      ),
    getThreadCreatorById: () => Effect.succeed(Option.none()),
    getThreadDetailById: (threadId) =>
      Effect.succeed(
        input.threadDetail && input.threadDetail.id === threadId
          ? Option.some(input.threadDetail)
          : Option.none(),
      ),
    listProjectShells: () => Effect.succeed([] satisfies ReadonlyArray<OrchestrationProjectShell>),
    listThreadShellsByProject: () => Effect.succeed([]),
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

const makeHistoryHarnessLayer = (input?: {
  readonly generatedSummary?: string;
  readonly textGenerationModelSelection?: ModelSelection;
  readonly largeMessageText?: string;
  readonly threadDetail?: OrchestrationThread;
  readonly summaryInputs?: Array<ThreadSummaryGenerationInput>;
}) => {
  const unsupported = (operation: string) => Effect.die(new Error(`${operation} unused`)) as never;
  const thread =
    input?.threadDetail ??
    makeThreadDetail({
      id: ThreadId.make(input?.largeMessageText ? "thread-large" : "thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Reconnect investigation",
      messages: [
        {
          id: "message-1" as never,
          role: "user",
          text: input?.largeMessageText ?? "Investigate reconnect failures",
          turnId: null,
          streaming: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

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
      Layer.succeed(
        ProjectionSnapshotQuery,
        projectionQueryMock({
          threadDetail: thread,
          threadShells: [
            makeThreadShell({
              id: thread.id,
              projectId: thread.projectId,
              title: thread.title,
              modelSelection: thread.modelSelection,
            }),
          ],
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        ProviderRegistry,
        providerRegistryMock([
          makeProvider({
            instanceId: "codex",
            driver: ProviderDriverKind.make("codex"),
            models: [
              { slug: "gpt-5.5-mini", name: "GPT-5.5 Mini", isCustom: false, capabilities: null },
            ],
          }),
        ]),
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
    Layer.provideMerge(
      Layer.succeed(
        ProjectionThreadMessageSearchRepository,
        ProjectionThreadMessageSearchRepository.of({
          searchByProject: () => Effect.succeed([]),
        }),
      ),
    ),
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        textGenerationModelSelection:
          input?.textGenerationModelSelection ?? defaultModelSelection({ model: "gpt-5.5-mini" }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(
        TextGeneration,
        TextGeneration.of({
          generateCommitMessage: () => Effect.die("unused"),
          generatePrContent: () => Effect.die("unused"),
          generateBranchName: () => Effect.die("unused"),
          generateThreadTitle: () => Effect.die("unused"),
          generateThreadSummary: (summaryInput) =>
            Effect.sync(() => {
              input?.summaryInputs?.push(summaryInput);
              return input?.generatedSummary ?? "summary stub not configured";
            }),
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};

it.effect("complete history returns projected thread detail by default", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.getThreadMessages({
      threadId: ThreadId.make("thread-1"),
      mode: "complete",
    });

    expect(result).toMatchObject({
      mode: "complete",
      thread: {
        id: "thread-1",
        messages: [
          {
            role: "user",
            text: "Investigate reconnect failures",
          },
        ],
      },
    });
  }).pipe(Effect.provide(makeHistoryHarnessLayer())),
);

it.effect("summary history uses the configured text generation model", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.getThreadMessages({
      threadId: ThreadId.make("thread-1"),
      mode: "summary",
    });

    expect(result).toMatchObject({
      mode: "summary",
      threadId: "thread-1",
      summary: "The thread investigated reconnect failures.",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.5-mini",
      },
    });
  }).pipe(
    Effect.provide(
      makeHistoryHarnessLayer({
        generatedSummary: "The thread investigated reconnect failures.",
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5-mini",
        },
      }),
    ),
  ),
);

it.effect("history rejects soft-deleted threads as unknown", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.getThreadMessages({
        threadId: ThreadId.make("thread-deleted"),
        mode: "complete",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as {
        readonly _tag: string;
        readonly code: string;
      };
      expect(error._tag).toBe("McpOrchestrationError");
      expect(error.code).toBe("unknown_thread");
    }
  }).pipe(
    Effect.provide(
      makeHistoryHarnessLayer({
        threadDetail: makeThreadDetail({
          id: ThreadId.make("thread-deleted"),
          projectId: ProjectId.make("project-1"),
          deletedAt: "2026-01-02T00:00:00.000Z",
          messages: [
            {
              id: "message-deleted" as never,
              role: "user",
              text: "deleted secret",
              turnId: null,
              streaming: false,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      }),
    ),
  ),
);

it.effect("summary history caps input before text generation and keeps recent messages", () =>
  (() => {
    const summaryInputs: Array<ThreadSummaryGenerationInput> = [];
    const oldText = "old".repeat(400_000);
    const recentText = "recent context";
    return Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      yield* service.getThreadMessages({
        threadId: ThreadId.make("thread-long"),
        mode: "summary",
      });

      expect(summaryInputs).toHaveLength(1);
      const messages = summaryInputs[0]?.messages ?? [];
      expect(messages[0]).toMatchObject({
        role: "system",
        text: "[earlier messages omitted]",
      });
      expect(messages.some((message) => message.text === recentText)).toBe(true);
      expect(messages.some((message) => message.text === oldText)).toBe(false);
      const totalInputCharacters = messages.reduce((sum, message) => sum + message.text.length, 0);
      expect(totalInputCharacters).toBeLessThanOrEqual(1_000_000);
    }).pipe(
      Effect.provide(
        makeHistoryHarnessLayer({
          generatedSummary: "summary",
          summaryInputs,
          threadDetail: makeThreadDetail({
            id: ThreadId.make("thread-long"),
            projectId: ProjectId.make("project-1"),
            messages: [
              {
                id: "message-old-1" as never,
                role: "user",
                text: oldText,
                turnId: null,
                streaming: false,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
              {
                id: "message-old-2" as never,
                role: "assistant",
                text: oldText,
                turnId: null,
                streaming: false,
                createdAt: "2026-01-01T00:01:00.000Z",
                updatedAt: "2026-01-01T00:01:00.000Z",
              },
              {
                id: "message-old-3" as never,
                role: "user",
                text: oldText,
                turnId: null,
                streaming: false,
                createdAt: "2026-01-01T00:02:00.000Z",
                updatedAt: "2026-01-01T00:02:00.000Z",
              },
              {
                id: "message-recent" as never,
                role: "assistant",
                text: recentText,
                turnId: null,
                streaming: false,
                createdAt: "2026-01-01T00:03:00.000Z",
                updatedAt: "2026-01-01T00:03:00.000Z",
              },
            ],
          }),
        }),
      ),
    );
  })(),
);

it.effect("complete history fails for a malformed cursor", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.getThreadMessages({
        threadId: ThreadId.make("thread-1"),
        mode: "complete",
        cursor: "not-a-number",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as {
        readonly _tag: string;
        readonly code: string;
      };
      expect(error._tag).toBe("McpOrchestrationError");
      expect(error.code).toBe("invalid_cursor");
    }
  }).pipe(Effect.provide(makeHistoryHarnessLayer())),
);

it.effect("complete history fails for an empty cursor", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.getThreadMessages({
        threadId: ThreadId.make("thread-1"),
        mode: "complete",
        cursor: "",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as {
        readonly _tag: string;
        readonly code: string;
      };
      expect(error._tag).toBe("McpOrchestrationError");
      expect(error.code).toBe("invalid_cursor");
    }
  }).pipe(Effect.provide(makeHistoryHarnessLayer())),
);

it.effect("complete history fails for a negative cursor", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.getThreadMessages({
        threadId: ThreadId.make("thread-1"),
        mode: "complete",
        cursor: "-1",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as {
        readonly _tag: string;
        readonly code: string;
      };
      expect(error._tag).toBe("McpOrchestrationError");
      expect(error.code).toBe("invalid_cursor");
    }
  }).pipe(Effect.provide(makeHistoryHarnessLayer())),
);

it.effect("complete history accepts a valid cursor", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.getThreadMessages({
      threadId: ThreadId.make("thread-1"),
      mode: "complete",
      cursor: "0",
    });

    expect(result).toMatchObject({
      mode: "complete",
      thread: {
        id: "thread-1",
        messages: [
          {
            role: "user",
            text: "Investigate reconnect failures",
          },
        ],
      },
    });
  }).pipe(Effect.provide(makeHistoryHarnessLayer())),
);

it.effect("complete history fails instead of truncating when over budget", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.getThreadMessages({
        threadId: ThreadId.make("thread-large"),
        mode: "complete",
        maxCharacters: 20,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  }).pipe(
    Effect.provide(
      makeHistoryHarnessLayer({
        largeMessageText: "x".repeat(10_000),
      }),
    ),
  ),
);

it.effect("complete history caller budget is enforced using UTF-8 bytes", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.getThreadMessages({
        threadId: ThreadId.make("thread-large"),
        mode: "complete",
        maxCharacters: 15_000,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as {
        readonly _tag: string;
        readonly code: string;
      };
      expect(error._tag).toBe("McpOrchestrationError");
      expect(error.code).toBe("payload_too_large");
    }
  }).pipe(
    Effect.provide(
      makeHistoryHarnessLayer({
        largeMessageText: "é".repeat(10_000),
      }),
    ),
  ),
);

it.effect("complete history default budget is enforced using UTF-8 bytes", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.getThreadMessages({
        threadId: ThreadId.make("thread-large"),
        mode: "complete",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as {
        readonly _tag: string;
        readonly code: string;
      };
      expect(error._tag).toBe("McpOrchestrationError");
      expect(error.code).toBe("payload_too_large");
    }
  }).pipe(
    Effect.provide(
      makeHistoryHarnessLayer({
        largeMessageText: "é".repeat(600_000),
      }),
    ),
  ),
);

const makeMultiTurnThread = (overrides?: Partial<OrchestrationThread>): OrchestrationThread =>
  makeThreadDetail({
    id: ThreadId.make("thread-turns"),
    projectId: ProjectId.make("project-1"),
    title: "Multi-turn thread",
    messages: [
      {
        id: "message-u0" as never,
        role: "user",
        text: "First question",
        turnId: "turn-0" as never,
        streaming: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "message-a0" as never,
        role: "assistant",
        text: "First answer",
        turnId: "turn-0" as never,
        streaming: false,
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "message-u1" as never,
        role: "user",
        text: "Second question",
        turnId: "turn-1" as never,
        streaming: false,
        createdAt: "2026-01-01T00:01:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
      },
      {
        id: "message-a1-text" as never,
        role: "assistant",
        text: "Intermediate text before a tool call",
        turnId: "turn-1" as never,
        streaming: false,
        createdAt: "2026-01-01T00:01:01.000Z",
        updatedAt: "2026-01-01T00:01:01.000Z",
      },
      {
        id: "message-a1-final" as never,
        role: "assistant",
        text: "Final answer for turn one",
        turnId: "turn-1" as never,
        streaming: false,
        createdAt: "2026-01-01T00:01:02.000Z",
        updatedAt: "2026-01-01T00:01:02.000Z",
      },
    ],
    checkpoints: [
      {
        turnId: "turn-0" as never,
        checkpointTurnCount: 0 as never,
        checkpointRef: "checkpoint-0" as never,
        status: "ready",
        files: [],
        assistantMessageId: "message-a0" as never,
        completedAt: "2026-01-01T00:00:02.000Z",
      },
      {
        turnId: "turn-1" as never,
        checkpointTurnCount: 1 as never,
        checkpointRef: "checkpoint-1" as never,
        status: "ready",
        files: [],
        assistantMessageId: "message-a1-final" as never,
        completedAt: "2026-01-01T00:01:03.000Z",
      },
    ],
    latestTurn: {
      turnId: "turn-1" as never,
      state: "completed",
      requestedAt: "2026-01-01T00:01:00.000Z",
      startedAt: "2026-01-01T00:01:00.500Z",
      completedAt: "2026-01-01T00:01:03.000Z",
      assistantMessageId: "message-a1-final" as never,
    },
    ...overrides,
  });

it.effect("latest_response returns the final assistant message of the latest completed turn", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.getThreadMessages({
      threadId: ThreadId.make("thread-turns"),
      mode: "latest_response",
    });

    expect(result).toMatchObject({
      mode: "latest_response",
      threadId: "thread-turns",
      inProgress: false,
      turnId: "turn-1",
      turnState: "completed",
      answer: {
        id: "message-a1-final",
        role: "assistant",
        text: "Final answer for turn one",
      },
    });
  }).pipe(Effect.provide(makeHistoryHarnessLayer({ threadDetail: makeMultiTurnThread() }))),
);

it.effect("latest_response flags an in-progress turn and returns the prior completed answer", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = (yield* service.getThreadMessages({
      threadId: ThreadId.make("thread-turns"),
      mode: "latest_response",
    })) as {
      readonly inProgress: boolean;
      readonly turnId: string | null;
      readonly answer: { readonly text: string } | null;
    };

    expect(result.inProgress).toBe(true);
    // The running turn (turn-1) has no checkpoint yet, so the latest completed answer
    // is turn-0's checkpoint answer.
    expect(result.turnId).toBe("turn-0");
    expect(result.answer?.text).toBe("First answer");
  }).pipe(
    Effect.provide(
      makeHistoryHarnessLayer({
        threadDetail: makeMultiTurnThread({
          checkpoints: [
            {
              turnId: "turn-0" as never,
              checkpointTurnCount: 0 as never,
              checkpointRef: "checkpoint-0" as never,
              status: "ready",
              files: [],
              assistantMessageId: "message-a0" as never,
              completedAt: "2026-01-01T00:00:02.000Z",
            },
          ],
          latestTurn: {
            turnId: "turn-1" as never,
            state: "running",
            requestedAt: "2026-01-01T00:01:00.000Z",
            startedAt: "2026-01-01T00:01:00.500Z",
            completedAt: null,
            assistantMessageId: null,
          },
        }),
      }),
    ),
  ),
);

it.effect("latest_response returns a null answer when nothing has completed yet", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = (yield* service.getThreadMessages({
      threadId: ThreadId.make("thread-turns"),
      mode: "latest_response",
    })) as {
      readonly inProgress: boolean;
      readonly turnId: string | null;
      readonly answer: unknown;
    };

    expect(result.inProgress).toBe(true);
    expect(result.turnId).toBe(null);
    expect(result.answer).toBe(null);
  }).pipe(
    Effect.provide(
      makeHistoryHarnessLayer({
        threadDetail: makeMultiTurnThread({
          messages: [
            {
              id: "message-u1" as never,
              role: "user",
              text: "Only question",
              turnId: "turn-1" as never,
              streaming: false,
              createdAt: "2026-01-01T00:01:00.000Z",
              updatedAt: "2026-01-01T00:01:00.000Z",
            },
          ],
          checkpoints: [],
          latestTurn: {
            turnId: "turn-1" as never,
            state: "running",
            requestedAt: "2026-01-01T00:01:00.000Z",
            startedAt: "2026-01-01T00:01:00.500Z",
            completedAt: null,
            assistantMessageId: null,
          },
        }),
      }),
    ),
  ),
);

it.effect("turn mode returns the user message and final assistant response for a turnCount", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.getThreadMessages({
      threadId: ThreadId.make("thread-turns"),
      mode: "turn",
      turnCount: 1,
    });

    expect(result).toMatchObject({
      mode: "turn",
      threadId: "thread-turns",
      turnCount: 1,
      turnId: "turn-1",
      turnState: "completed",
      userMessage: { id: "message-u1", text: "Second question" },
      assistantMessage: { id: "message-a1-final", text: "Final answer for turn one" },
    });
  }).pipe(Effect.provide(makeHistoryHarnessLayer({ threadDetail: makeMultiTurnThread() }))),
);

it.effect("turn mode requires turnCount", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.getThreadMessages({
        threadId: ThreadId.make("thread-turns"),
        mode: "turn",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as { readonly code: string };
      expect(error.code).toBe("invalid_input");
    }
  }).pipe(Effect.provide(makeHistoryHarnessLayer({ threadDetail: makeMultiTurnThread() }))),
);

it.effect("turn mode fails for an unknown turnCount", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.getThreadMessages({
        threadId: ThreadId.make("thread-turns"),
        mode: "turn",
        turnCount: 99,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as { readonly code: string };
      expect(error.code).toBe("unknown_turn");
    }
  }).pipe(Effect.provide(makeHistoryHarnessLayer({ threadDetail: makeMultiTurnThread() }))),
);

it.effect("message mode returns a single message by id", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.getThreadMessages({
      threadId: ThreadId.make("thread-turns"),
      mode: "message",
      messageId: "message-a0" as never,
    });

    expect(result).toMatchObject({
      mode: "message",
      threadId: "thread-turns",
      message: { id: "message-a0", role: "assistant", text: "First answer" },
    });
  }).pipe(Effect.provide(makeHistoryHarnessLayer({ threadDetail: makeMultiTurnThread() }))),
);

it.effect("message mode fails for an unknown messageId", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.getThreadMessages({
        threadId: ThreadId.make("thread-turns"),
        mode: "message",
        messageId: "message-missing" as never,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as { readonly code: string };
      expect(error.code).toBe("unknown_message");
    }
  }).pipe(Effect.provide(makeHistoryHarnessLayer({ threadDetail: makeMultiTurnThread() }))),
);
