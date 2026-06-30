import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ThreadTurnLivenessQueryLive } from "./ThreadTurnLivenessQuery.ts";
import { DEFAULT_STALE_AFTER_MS, PROVIDER_SIGNAL_COALESCE_MS } from "../threadTurnLiveness.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionThreadTurnLivenessRow,
} from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadTurnLivenessQuery } from "../Services/ThreadTurnLivenessQuery.ts";
import { ThreadTurnSignalTracker } from "../Services/ThreadTurnSignalTracker.ts";
import { ThreadTurnSignalTrackerLive } from "./ThreadTurnSignalTracker.ts";
import { ProjectionThreadMessageSearchRepository } from "../../persistence/Services/ProjectionThreadMessageSearch.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../../provider/providerMaintenance.ts";

const THREAD = ThreadId.make("thread-liveness");
const PROJECT = ProjectId.make("project-liveness");
const TURN = TurnId.make("turn-liveness");
const OTHER_TURN = TurnId.make("turn-other");

const isoAt = (minutes: number, seconds = 0) =>
  `1970-01-01T00:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.000Z`;

const modelSelection = (instanceId = "codex", options: ModelSelection["options"] = []) => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model: "model-1",
  options,
});

const provider = (input?: {
  readonly instanceId?: string;
  readonly driver?: string;
  readonly options?: ModelSelection["options"];
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input?.instanceId ?? "codex"),
  driver: ProviderDriverKind.make(input?.driver ?? "codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: isoAt(0),
  availability: "available",
  continuation: { groupKey: "provider-group" },
  models: [
    {
      slug: "model-1",
      name: "Model 1",
      isCustom: false,
      capabilities: createModelCapabilities({ optionDescriptors: [] }),
    },
  ],
  slashCommands: [],
  skills: [],
});

const activeLatestTurn = () => ({
  turnId: TURN,
  state: "running" as const,
  requestedAt: isoAt(0),
  startedAt: isoAt(0),
  completedAt: null,
  assistantMessageId: null,
});

const activity = (input: {
  readonly id: string;
  readonly kind: string;
  readonly turnId: TurnId | null;
  readonly createdAt: string;
  readonly payload?: unknown;
}): OrchestrationThreadActivity => ({
  id: EventId.make(input.id),
  tone: input.kind.includes("approval") ? "approval" : "info",
  kind: input.kind,
  summary: input.kind,
  payload: input.payload ?? {},
  turnId: input.turnId,
  sequence: 1,
  createdAt: input.createdAt,
});

const thread = (input?: Partial<OrchestrationThread>): OrchestrationThread => ({
  id: THREAD,
  projectId: PROJECT,
  parentThreadId: null,
  title: "Liveness thread",
  modelSelection: modelSelection(),
  runtimeMode: "auto-accept-edits",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: activeLatestTurn(),
  pendingTurnStart: null,
  createdAt: isoAt(0),
  updatedAt: isoAt(0),
  archivedAt: null,
  createdVia: "mcp",
  createdByThreadId: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId: THREAD,
    status: "running",
    providerName: "codex",
    runtimeMode: "auto-accept-edits",
    activeTurnId: TURN,
    lastError: null,
    updatedAt: isoAt(0),
  },
  ...input,
});

const livenessRow = (
  input?: Partial<ProjectionThreadTurnLivenessRow>,
): ProjectionThreadTurnLivenessRow => ({
  threadId: THREAD,
  turnId: TURN,
  pendingMessageId: null,
  state: "running",
  requestedAt: isoAt(0),
  startedAt: isoAt(0),
  completedAt: null,
  lastProviderSignalAt: null,
  lastObservableProgressAt: null,
  lastSignalKind: null,
  ...input,
});

const threadEvent = (input?: { readonly threadId?: ThreadId; readonly turnId?: TurnId }) =>
  ({
    sequence: 2,
    aggregateId: input?.threadId ?? THREAD,
    type: "thread.turn-provider-signaled",
    payload: {
      threadId: input?.threadId ?? THREAD,
      turnId: input?.turnId ?? TURN,
      signalKind: "reasoning",
      signaledAt: isoAt(1),
    },
  }) as OrchestrationEvent;

type Harness = {
  readonly layer: Layer.Layer<ThreadTurnLivenessQuery | ThreadTurnSignalTracker>;
  readonly updateRow: (row: ProjectionThreadTurnLivenessRow) => Effect.Effect<void>;
  readonly updateThread: (next: OrchestrationThread) => Effect.Effect<void>;
  readonly updateSequence: (sequence: number) => Effect.Effect<void>;
  readonly emit: (event: OrchestrationEvent) => Effect.Effect<void>;
  readonly dispatched: ReadonlyArray<OrchestrationCommand>;
};

const makeHarness = (input?: {
  readonly thread?: OrchestrationThread;
  readonly rows?: ReadonlyArray<ProjectionThreadTurnLivenessRow>;
  readonly providers?: ReadonlyArray<ServerProvider>;
}): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    const threadRef = yield* Ref.make(input?.thread ?? thread());
    const rowsRef = yield* Ref.make(
      new Map(
        (input?.rows ?? [livenessRow()]).map((row) => [`${row.threadId}:${row.turnId}`, row]),
      ),
    );
    const sequenceRef = yield* Ref.make(1);
    const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
    const dispatched: Array<OrchestrationCommand> = [];
    const unsupported = (operation: string) =>
      Effect.die(new Error(`${operation} unused`)) as never;

    const projectionQuery = ProjectionSnapshotQuery.of({
      getCommandReadModel: () => unsupported("getCommandReadModel"),
      getSnapshot: () => unsupported("getSnapshot"),
      getShellSnapshot: () => unsupported("getShellSnapshot"),
      getArchivedShellSnapshot: () => unsupported("getArchivedShellSnapshot"),
      getSnapshotSequence: () =>
        Ref.get(sequenceRef).pipe(Effect.map((snapshotSequence) => ({ snapshotSequence }))),
      getCounts: () => unsupported("getCounts"),
      getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      listProjectShells: () => Effect.succeed([]),
      getProjectShellById: () => Effect.succeed(Option.none()),
      getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
      listThreadShellsByProject: () => Effect.succeed([]),
      getThreadCheckpointContext: () => Effect.succeed(Option.none()),
      getFullThreadDiffContext: () => Effect.succeed(Option.none()),
      getThreadShellById: () => Effect.succeed(Option.none()),
      getThreadCreatorById: () => Effect.succeed(Option.none()),
      getThreadDetailById: (threadId) =>
        Ref.get(threadRef).pipe(
          Effect.map((current) =>
            current.id === threadId ? Option.some(current) : Option.none<OrchestrationThread>(),
          ),
        ),
      getThreadTurnStateById: () => unsupported("getThreadTurnStateById"),
      getThreadTurnStateByPendingMessageId: () =>
        unsupported("getThreadTurnStateByPendingMessageId"),
      getThreadTurnLivenessRowById: ({ threadId, turnId }) =>
        Ref.get(rowsRef).pipe(
          Effect.map((rows) => Option.fromNullishOr(rows.get(`${threadId}:${turnId}`))),
        ),
      searchThreadMessagesByProject: () => Effect.succeed([]),
    });

    const layer = ThreadTurnLivenessQueryLive.pipe(
      Layer.provideMerge(ThreadTurnSignalTrackerLive),
      Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projectionQuery)),
      Layer.provideMerge(
        Layer.succeed(
          OrchestrationEngineService,
          OrchestrationEngineService.of({
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                return { sequence: dispatched.length };
              }),
            readEvents: () => Stream.empty,
            streamDomainEvents: Stream.fromPubSub(eventPubSub),
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(
          ProviderRegistry,
          ProviderRegistry.of({
            getProviders: Effect.succeed(input?.providers ?? [provider()]),
            refresh: () => Effect.succeed(input?.providers ?? [provider()]),
            refreshInstance: () => Effect.succeed(input?.providers ?? [provider()]),
            getProviderMaintenanceCapabilitiesForInstance: (_instanceId, serverProvider) =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: serverProvider,
                  packageName: null,
                }),
              ),
            setProviderMaintenanceActionState: () =>
              Effect.succeed(input?.providers ?? [provider()]),
            streamChanges: Stream.empty,
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionThreadMessageSearchRepository,
          ProjectionThreadMessageSearchRepository.of({ searchByProject: () => Effect.succeed([]) }),
        ),
      ),
    );

    return {
      layer,
      updateRow: (row) =>
        Ref.update(rowsRef, (rows) => new Map(rows).set(`${row.threadId}:${row.turnId}`, row)),
      updateThread: (next) => Ref.set(threadRef, next),
      updateSequence: (sequence) => Ref.set(sequenceRef, sequence),
      emit: (event) => PubSub.publish(eventPubSub, event).pipe(Effect.asVoid),
      dispatched,
    };
  });

it.effect("running turn with recent in-memory reasoning provider signal is not stale", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      rows: [livenessRow({ lastProviderSignalAt: null })],
    });

    const result = yield* Effect.gen(function* () {
      yield* TestClock.adjust(Duration.minutes(9));
      const tracker = yield* ThreadTurnSignalTracker;
      yield* tracker.record({
        threadId: THREAD,
        turnId: TURN,
        signalKind: "reasoning",
        signaledAt: isoAt(8, 59),
      });

      const query = yield* ThreadTurnLivenessQuery;
      return yield* query.getThreadTurnStatus({ threadId: THREAD });
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, TestClock.layer())));

    expect(result.state).toBe("running");
    expect(result.lastProviderSignalAt).toBe(isoAt(8, 59));
    expect(result.lastObservableProgressAt).toBe(isoAt(8, 59));
    expect(result.stale).toBe(false);
    expect(result.safeToInterrupt).toBe(false);
  }),
);

it.effect(
  "running turn prefers a newer in-memory signal over older projected coalesced signal",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        rows: [livenessRow({ lastProviderSignalAt: isoAt(0, 1) })],
      });

      const result = yield* Effect.gen(function* () {
        yield* TestClock.adjust(Duration.minutes(11));
        const tracker = yield* ThreadTurnSignalTracker;
        yield* tracker.record({
          threadId: THREAD,
          turnId: TURN,
          signalKind: "reasoning",
          signaledAt: isoAt(10, 45),
        });

        const query = yield* ThreadTurnLivenessQuery;
        return yield* query.getThreadTurnStatus({ threadId: THREAD, turnId: TURN });
      }).pipe(Effect.provide(Layer.mergeAll(harness.layer, TestClock.layer())));

      expect(result.lastProviderSignalAt).toBe(isoAt(10, 45));
      expect(result.stale).toBe(false);
    }),
);

it.effect("claude or high-reasoning turns use the longer stale threshold", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      thread: thread({
        modelSelection: modelSelection("claude", [{ id: "thinking", value: true }]),
      }),
      providers: [provider({ instanceId: "claude", driver: "claudeAgent" })],
    });

    const result = yield* Effect.gen(function* () {
      yield* TestClock.adjust(Duration.minutes(11));
      const query = yield* ThreadTurnLivenessQuery;
      return yield* query.getThreadTurnStatus({ threadId: THREAD });
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, TestClock.layer())));

    expect(result.staleAfterMs).toBe(20 * 60_000);
    expect(result.stale).toBe(false);
  }),
);

it.effect("running turn with old provider signal and no pending requests is stale and safe", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      rows: [livenessRow({ lastProviderSignalAt: isoAt(0, 1) })],
    });

    const result = yield* Effect.gen(function* () {
      yield* TestClock.adjust(Duration.minutes(11));
      const query = yield* ThreadTurnLivenessQuery;
      return yield* query.getThreadTurnStatus({ threadId: THREAD });
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, TestClock.layer())));

    expect(result.staleAfterMs).toBe(DEFAULT_STALE_AFTER_MS + PROVIDER_SIGNAL_COALESCE_MS);
    expect(result.stale).toBe(true);
    expect(result.safeToInterrupt).toBe(true);
  }),
);

it.effect("pending approval or user input blocks stale interruption", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      thread: thread({
        activities: [
          activity({
            id: "activity-approval",
            kind: "approval.requested",
            turnId: TURN,
            createdAt: isoAt(0, 10),
            payload: { requestId: "approval-1", requestKind: "command" },
          }),
        ],
      }),
      rows: [livenessRow({ lastProviderSignalAt: isoAt(0, 1) })],
    });

    const result = yield* Effect.gen(function* () {
      yield* TestClock.adjust(Duration.minutes(11));
      const query = yield* ThreadTurnLivenessQuery;
      return yield* query.getThreadTurnStatus({ threadId: THREAD });
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, TestClock.layer())));

    expect(result.pendingRequests).toEqual([
      { kind: "approval", requestId: "approval-1", requestKind: "command" },
    ]);
    expect(result.hasPendingApprovals).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.safeToInterrupt).toBe(false);
  }),
);

it.effect("completed interrupted and error states are never stale or safe to interrupt", () =>
  Effect.gen(function* () {
    for (const state of ["completed", "interrupted", "error"] as const) {
      const harness = yield* makeHarness({
        rows: [livenessRow({ state, completedAt: isoAt(1) })],
      });

      const result = yield* Effect.gen(function* () {
        yield* TestClock.adjust(Duration.minutes(30));
        const query = yield* ThreadTurnLivenessQuery;
        return yield* query.getThreadTurnStatus({ threadId: THREAD, turnId: TURN });
      }).pipe(Effect.provide(Layer.mergeAll(harness.layer, TestClock.layer())));

      expect(result.state).toBe(state);
      expect(result.stale).toBe(false);
      expect(result.safeToInterrupt).toBe(false);
    }
  }),
);

it.effect("idle means no pending start and no active scoped turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      thread: thread({
        session: {
          threadId: THREAD,
          status: "ready",
          activeTurnId: null,
          providerName: null,
          runtimeMode: "auto-accept-edits",
          lastError: null,
          updatedAt: isoAt(0),
        },
      }),
      rows: [],
    });

    const result = yield* Effect.gen(function* () {
      const query = yield* ThreadTurnLivenessQuery;
      return yield* query.getThreadTurnStatus({ threadId: THREAD });
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, TestClock.layer())));

    expect(result.state).toBe("idle");
    expect(result.turnId).toBe(null);
    expect(result.stale).toBe(false);
    expect(result.safeToInterrupt).toBe(false);
  }),
);

it.effect("waitForThreadUpdate returns progress for a reasoning-only provider signal", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();

    const result = yield* Effect.gen(function* () {
      const query = yield* ThreadTurnLivenessQuery;
      const cursor = yield* query.getCurrentCursor();
      const waiter = yield* query
        .waitForThreadUpdate({
          threadId: THREAD,
          since: cursor,
          timeoutMs: 1_000,
          includeStatus: true,
        })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* harness.updateRow(livenessRow({ lastProviderSignalAt: isoAt(1) }));
      yield* harness.updateSequence(2);
      yield* harness.emit(threadEvent());
      yield* TestClock.adjust(Duration.millis(1_000));
      return yield* Fiber.join(waiter);
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, TestClock.layer())));

    expect(result.reason).toBe("progress");
    expect(result.turnId).toBe(TURN);
    expect(result.liveness?.lastProviderSignalAt).toBe(isoAt(1));
  }),
);

it.effect("waitForThreadUpdate returns timeout without dispatching interrupts", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();

    const result = yield* Effect.gen(function* () {
      const query = yield* ThreadTurnLivenessQuery;
      const cursor = yield* query.getCurrentCursor();
      const waiter = yield* query
        .waitForThreadUpdate({ threadId: THREAD, since: cursor, timeoutMs: 10 })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust(Duration.millis(10));
      return yield* Fiber.join(waiter);
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, TestClock.layer())));

    expect(result.reason).toBe("timeout");
    expect(harness.dispatched).toEqual([]);
  }),
);

it.effect("waitForThreadUpdate returns stale after provider progress stops past threshold", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      rows: [livenessRow({ lastProviderSignalAt: isoAt(0, 1) })],
    });

    const result = yield* Effect.gen(function* () {
      yield* TestClock.adjust(Duration.minutes(11));
      const query = yield* ThreadTurnLivenessQuery;
      const cursor = yield* query.getCurrentCursor();
      return yield* query.waitForThreadUpdate({
        threadId: THREAD,
        turnId: TURN,
        since: cursor,
        timeoutMs: 1_000,
        includeStatus: true,
      });
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, TestClock.layer())));

    expect(result.reason).toBe("stale");
    expect(result.turnId).toBe(TURN);
    expect(result.liveness?.stale).toBe(true);
    expect(result.liveness?.safeToInterrupt).toBe(true);
    expect(harness.dispatched).toEqual([]);
  }),
);

it.effect("scoped wait ignores updates for a newer or different turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      rows: [livenessRow(), livenessRow({ turnId: OTHER_TURN })],
    });

    const result = yield* Effect.gen(function* () {
      const query = yield* ThreadTurnLivenessQuery;
      const cursor = yield* query.getCurrentCursor();
      const waiter = yield* query
        .waitForThreadUpdate({ threadId: THREAD, turnId: TURN, since: cursor, timeoutMs: 10 })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* harness.updateRow(livenessRow({ turnId: OTHER_TURN, lastProviderSignalAt: isoAt(1) }));
      yield* harness.updateSequence(2);
      yield* harness.emit(threadEvent({ turnId: OTHER_TURN }));
      yield* TestClock.adjust(Duration.millis(10));
      return yield* Fiber.join(waiter);
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, TestClock.layer())));

    expect(result.reason).toBe("timeout");
  }),
);
