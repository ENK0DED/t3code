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
}) => {
  const unsupported = (operation: string) => Effect.die(new Error(`${operation} unused`)) as never;
  const thread = makeThreadDetail({
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
          generateThreadSummary: () =>
            Effect.succeed(input?.generatedSummary ?? "summary stub not configured"),
        }),
      ),
    ),
  );
};

it.effect("complete history returns projected thread detail by default", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const result = yield* service.getThreadHistory({
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
    const result = yield* service.getThreadHistory({
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

it.effect("complete history fails for a malformed cursor", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.getThreadHistory({
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
      service.getThreadHistory({
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
      service.getThreadHistory({
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
    const result = yield* service.getThreadHistory({
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
      service.getThreadHistory({
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

it.effect("complete history default budget is enforced using UTF-8 bytes", () =>
  Effect.gen(function* () {
    const service = yield* McpOrchestrationService;
    const exit = yield* Effect.exit(
      service.getThreadHistory({
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
