import {
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProviderOptionSelection,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { derivePendingRequestsForTurn } from "../pendingRequests.ts";
import {
  CLAUDE_HIGH_REASONING_STALE_AFTER_MS,
  DEFAULT_STALE_AFTER_MS,
  DEFAULT_THREAD_UPDATE_WAIT_TIMEOUT_MS,
  MAX_THREAD_UPDATE_WAIT_TIMEOUT_MS,
  PROVIDER_SIGNAL_COALESCE_MS,
  decodeThreadUpdateCursor,
  encodeThreadUpdateCursor,
  type ThreadUpdateCursor,
} from "../threadTurnLiveness.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  type ProjectionThreadTurnLivenessRow,
  ProjectionSnapshotQuery,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadTurnLivenessQuery,
  ThreadTurnLivenessQueryError,
  type ThreadTurnLiveness,
  type WaitForThreadUpdateInput,
  type WaitForThreadUpdateResult,
} from "../Services/ThreadTurnLivenessQuery.ts";
import { ThreadTurnSignalTracker } from "../Services/ThreadTurnSignalTracker.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";

const terminalStates = new Set(["completed", "interrupted", "error"]);
const highReasoningValues = new Set(["high", "xhigh", "max", "ultra", "super-high"]);
const isThreadTurnLivenessQueryError = Schema.is(ThreadTurnLivenessQueryError);

function maxIso(...values: ReadonlyArray<string | null | undefined>): string | null {
  let max: string | null = null;
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }
    if (max === null || value > max) {
      max = value;
    }
  }
  return max;
}

function isoToMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSameId(left: unknown, right: unknown): boolean {
  return String(left) === String(right);
}

function latestMessageAt(
  messages: ReadonlyArray<OrchestrationMessage>,
  row: ProjectionThreadTurnLivenessRow,
): string | null {
  return maxIso(
    ...messages
      .filter(
        (message) =>
          isSameId(message.turnId, row.turnId) ||
          (row.pendingMessageId !== null && isSameId(message.id, row.pendingMessageId)),
      )
      .flatMap((message) => [message.createdAt, message.updatedAt]),
  );
}

function latestActivityAt(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId,
): string | null {
  return maxIso(
    ...activities
      .filter((activity) => isSameId(activity.turnId, turnId))
      .map((activity) => activity.createdAt),
  );
}

function optionValueHighReasoning(selection: ProviderOptionSelection): boolean {
  const id = selection.id.toLowerCase();
  if (id.includes("thinking") && selection.value === true) {
    return true;
  }
  if (
    (id.includes("reasoning") || id.includes("effort") || id.includes("thinking")) &&
    typeof selection.value === "string"
  ) {
    return highReasoningValues.has(selection.value.toLowerCase());
  }
  return false;
}

function selectionHasHighReasoning(modelSelection: ModelSelection): boolean {
  return (modelSelection.options ?? []).some(optionValueHighReasoning);
}

function eventTurnId(event: OrchestrationEvent): unknown {
  if (typeof event.payload !== "object" || event.payload === null) {
    return undefined;
  }
  return (event.payload as { readonly turnId?: unknown }).turnId;
}

function eventSequence(event: OrchestrationEvent): number | null {
  const sequence = (event as { readonly sequence?: unknown }).sequence;
  return typeof sequence === "number" && Number.isFinite(sequence) ? sequence : null;
}

function eventMatchesScope(event: OrchestrationEvent, input: WaitForThreadUpdateInput): boolean {
  if (!isSameId(event.aggregateId, input.threadId)) {
    return false;
  }
  if (input.turnId === undefined) {
    return true;
  }
  const turnId = eventTurnId(event);
  return turnId !== undefined && isSameId(turnId, input.turnId);
}

function eventCanRepresentProgress(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.turn-provider-signaled":
    case "thread.message-sent":
    case "thread.activity-appended":
    case "thread.session-set":
    case "thread.turn-start-requested":
    case "thread.turn-diff-completed":
    case "thread.proposed-plan-upserted":
      return true;
    default:
      return false;
  }
}

function terminalRowIsMaskedByRunningSession(input: {
  readonly thread: OrchestrationThread;
  readonly row: ProjectionThreadTurnLivenessRow;
}): boolean {
  if (!terminalStates.has(input.row.state)) {
    return false;
  }
  const session = input.thread.session;
  if (session === null) {
    return false;
  }
  if (session.status !== "starting" && session.status !== "running") {
    return false;
  }
  return (session.activeTurnId ?? null) === null;
}

function makeUnknownThread(threadId: ThreadId): ThreadTurnLivenessQueryError {
  return new ThreadTurnLivenessQueryError({
    code: "unknown_thread",
    message: `Unknown thread: ${threadId}`,
  });
}

function makeUnknownTurn(turnId: TurnId): ThreadTurnLivenessQueryError {
  return new ThreadTurnLivenessQueryError({
    code: "unknown_turn",
    message: `Unknown turn: ${turnId}`,
  });
}

function toQueryError(message: string) {
  return (error: unknown): ThreadTurnLivenessQueryError =>
    isThreadTurnLivenessQueryError(error)
      ? error
      : new ThreadTurnLivenessQueryError({
          code: "unknown_thread",
          message,
        });
}

const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const threadTurnSignalTracker = yield* ThreadTurnSignalTracker;
  const providerRegistry = yield* ProviderRegistry;

  const getCurrentCursor: ThreadTurnLivenessQuery["Service"]["getCurrentCursor"] = (input) =>
    projectionSnapshotQuery.getSnapshotSequence().pipe(
      Effect.map((sequence) =>
        encodeThreadUpdateCursor({
          sequence: sequence.snapshotSequence,
          observedAt: input?.observedAt ?? null,
        }),
      ),
      Effect.mapError(
        () =>
          new ThreadTurnLivenessQueryError({
            code: "invalid_cursor",
            message: "Unable to read the current projection cursor.",
          }),
      ),
    );

  const staleAfterForThread = Effect.fn("ThreadTurnLivenessQuery.staleAfterForThread")(function* (
    thread: OrchestrationThread,
    hasLiveTrackerSignal: boolean,
    hasProjectedProviderSignal: boolean,
  ) {
    const providers = yield* providerRegistry.getProviders;
    const provider = providers.find((candidate) =>
      isSameId(candidate.instanceId, thread.modelSelection.instanceId),
    );
    const driver = String(provider?.driver ?? "").toLowerCase();
    const base =
      driver.includes("claude") || selectionHasHighReasoning(thread.modelSelection)
        ? CLAUDE_HIGH_REASONING_STALE_AFTER_MS
        : DEFAULT_STALE_AFTER_MS;
    return (
      base + (!hasLiveTrackerSignal && hasProjectedProviderSignal ? PROVIDER_SIGNAL_COALESCE_MS : 0)
    );
  });

  const resolveRow = Effect.fn("ThreadTurnLivenessQuery.resolveRow")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly turnId?: TurnId | undefined;
  }) {
    if (input.turnId !== undefined) {
      const row = yield* projectionSnapshotQuery.getThreadTurnLivenessRowById({
        threadId: input.thread.id,
        turnId: input.turnId,
      });
      return yield* Option.match(row, {
        onNone: () => Effect.fail(makeUnknownTurn(input.turnId!)),
        onSome: Effect.succeed,
      });
    }

    const activeTurnId = input.thread.session?.activeTurnId ?? null;
    if (
      input.thread.pendingTurnStart !== null &&
      input.thread.pendingTurnStart !== undefined &&
      activeTurnId === null
    ) {
      return null;
    }

    const resolvedTurnId = activeTurnId ?? input.thread.latestTurn?.turnId ?? null;
    if (resolvedTurnId === null) {
      return null;
    }

    const row = yield* projectionSnapshotQuery.getThreadTurnLivenessRowById({
      threadId: input.thread.id,
      turnId: resolvedTurnId,
    });
    return Option.isSome(row) ? row.value : null;
  });

  const livenessForRow = Effect.fn("ThreadTurnLivenessQuery.livenessForRow")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly row: ProjectionThreadTurnLivenessRow;
  }) {
    const nowMs = yield* Clock.currentTimeMillis;
    const trackerSignal = yield* threadTurnSignalTracker.getLatest({
      threadId: input.row.threadId,
      turnId: input.row.turnId,
    });
    const liveProviderSignalAt = Option.isSome(trackerSignal)
      ? trackerSignal.value.signaledAt
      : null;
    const lastProviderSignalAt = maxIso(input.row.lastProviderSignalAt, liveProviderSignalAt);
    const lastMessageAt = latestMessageAt(input.thread.messages, input.row);
    const lastActivityAt = latestActivityAt(input.thread.activities, input.row.turnId);
    const observableWithoutStart = maxIso(
      input.row.lastObservableProgressAt,
      lastMessageAt,
      lastActivityAt,
      lastProviderSignalAt,
    );
    const lastObservableProgressAt = maxIso(observableWithoutStart, input.row.startedAt);
    const pendingRequests = derivePendingRequestsForTurn(input.thread, String(input.row.turnId));
    const staleAfterMs = yield* staleAfterForThread(
      input.thread,
      liveProviderSignalAt !== null,
      input.row.lastProviderSignalAt !== null,
    );
    const maskedByRunningSession = terminalRowIsMaskedByRunningSession(input);
    const state = maskedByRunningSession ? "running" : input.row.state;
    const startedOrRequestedAt = input.row.startedAt ?? input.row.requestedAt;
    const startedOrRequestedAtMs = isoToMs(startedOrRequestedAt);
    const lastObservableProgressAtMs = isoToMs(lastObservableProgressAt);
    const lastProviderSignalAtMs = isoToMs(lastProviderSignalAt);
    const terminal = terminalStates.has(state);
    const runningForMs =
      state === "running" && startedOrRequestedAtMs !== null
        ? Math.max(0, nowMs - startedOrRequestedAtMs)
        : null;
    const staleDecision = (() => {
      if (terminal || pendingRequests.length > 0 || state !== "running") {
        return { stale: false, staleReason: "none" as const };
      }
      if (observableWithoutStart === null) {
        return startedOrRequestedAtMs !== null && nowMs - startedOrRequestedAtMs > staleAfterMs
          ? { stale: true, staleReason: "no_observable_progress" as const }
          : { stale: false, staleReason: "none" as const };
      }
      if (
        lastProviderSignalAt === null &&
        startedOrRequestedAtMs !== null &&
        nowMs - startedOrRequestedAtMs > staleAfterMs
      ) {
        return { stale: true, staleReason: "no_provider_signal" as const };
      }
      if (
        lastObservableProgressAtMs !== null &&
        nowMs - lastObservableProgressAtMs > staleAfterMs
      ) {
        return {
          stale: true,
          staleReason:
            lastProviderSignalAtMs === null
              ? ("no_provider_signal" as const)
              : ("no_observable_progress" as const),
        };
      }
      return { stale: false, staleReason: "none" as const };
    })();

    const hasPendingApprovals = pendingRequests.some((request) => request.kind === "approval");
    const hasPendingUserInput = pendingRequests.some((request) => request.kind === "user-input");

    return {
      threadId: input.row.threadId,
      turnId: input.row.turnId,
      state,
      startedAt: input.row.startedAt,
      completedAt: maskedByRunningSession ? null : input.row.completedAt,
      runningForMs,
      lastMessageAt,
      lastActivityAt,
      lastProviderSignalAt,
      lastObservableProgressAt,
      pendingRequests,
      hasPendingApprovals,
      hasPendingUserInput,
      stale: staleDecision.stale,
      staleReason: staleDecision.staleReason,
      staleAfterMs,
      safeToInterrupt:
        state === "running" &&
        staleDecision.stale &&
        pendingRequests.length === 0 &&
        !maskedByRunningSession,
    } satisfies ThreadTurnLiveness;
  });

  const getThreadTurnStatus: ThreadTurnLivenessQuery["Service"]["getThreadTurnStatus"] = (input) =>
    Effect.gen(function* () {
      const thread = yield* projectionSnapshotQuery.getThreadDetailById(input.threadId).pipe(
        Effect.mapError(
          () =>
            new ThreadTurnLivenessQueryError({
              code: "unknown_thread",
              message: `Unable to read thread: ${input.threadId}`,
            }),
        ),
        Effect.flatMap((option) =>
          Option.isSome(option)
            ? Effect.succeed(option.value)
            : Effect.fail(makeUnknownThread(input.threadId)),
        ),
      );

      const row = yield* resolveRow({ thread, turnId: input.turnId });
      if (row === null) {
        if (input.turnId !== undefined) {
          return yield* makeUnknownTurn(input.turnId);
        }
        const activeTurnId = thread.session?.activeTurnId ?? null;
        const state =
          thread.pendingTurnStart !== null &&
          thread.pendingTurnStart !== undefined &&
          activeTurnId === null
            ? "pending_start"
            : "idle";
        return {
          threadId: thread.id,
          turnId: null,
          state,
          startedAt: null,
          completedAt: null,
          runningForMs: null,
          lastMessageAt: null,
          lastActivityAt: null,
          lastProviderSignalAt: null,
          lastObservableProgressAt: null,
          pendingRequests: [],
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          stale: false,
          staleReason: "none",
          staleAfterMs: DEFAULT_STALE_AFTER_MS,
          safeToInterrupt: false,
        } satisfies ThreadTurnLiveness;
      }

      return yield* livenessForRow({ thread, row });
    }).pipe(
      Effect.mapError(toQueryError(`Unable to compute turn liveness for ${input.threadId}.`)),
    );

  const cursorForLiveness = (liveness: ThreadTurnLiveness) =>
    getCurrentCursor({ observedAt: liveness.lastObservableProgressAt });

  const resultFor = Effect.fn("ThreadTurnLivenessQuery.resultFor")(function* (
    reason: WaitForThreadUpdateResult["reason"],
    input: WaitForThreadUpdateInput,
  ) {
    const liveness = yield* getThreadTurnStatus({
      threadId: input.threadId,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    });
    const cursor = yield* cursorForLiveness(liveness);
    return {
      threadId: input.threadId,
      turnId: liveness.turnId,
      reason,
      cursor,
      ...(input.includeStatus === true ? { liveness } : {}),
    } satisfies WaitForThreadUpdateResult;
  });

  const waitForThreadUpdate: ThreadTurnLivenessQuery["Service"]["waitForThreadUpdate"] = (input) =>
    Effect.gen(function* () {
      const timeoutMs = input.timeoutMs ?? DEFAULT_THREAD_UPDATE_WAIT_TIMEOUT_MS;
      if (timeoutMs < 1 || timeoutMs > MAX_THREAD_UPDATE_WAIT_TIMEOUT_MS) {
        return yield* new ThreadTurnLivenessQueryError({
          code: "invalid_timeout",
          message: `timeoutMs must be between 1 and ${MAX_THREAD_UPDATE_WAIT_TIMEOUT_MS}.`,
        });
      }

      const cursor: ThreadUpdateCursor =
        input.since === undefined
          ? {
              sequence: (yield* projectionSnapshotQuery.getSnapshotSequence()).snapshotSequence,
              observedAt: null,
            }
          : (decodeThreadUpdateCursor(input.since) ??
            (yield* new ThreadTurnLivenessQueryError({
              code: "invalid_cursor",
              message: "Invalid thread update cursor.",
            })));

      const probe = Effect.fn("ThreadTurnLivenessQuery.waitForThreadUpdate.probe")(function* (
        event: OrchestrationEvent | null,
      ) {
        const liveness = yield* getThreadTurnStatus({
          threadId: input.threadId,
          ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
        });
        if (
          liveness.state === "completed" ||
          liveness.state === "interrupted" ||
          liveness.state === "error"
        ) {
          return Option.some(yield* resultFor("terminal", input));
        }
        if (liveness.pendingRequests.length > 0) {
          return Option.some(yield* resultFor("pending_request", input));
        }
        const eventProgress =
          event !== null &&
          eventCanRepresentProgress(event) &&
          (eventSequence(event) ?? 0) > cursor.sequence;
        const timestampProgress =
          cursor.observedAt !== null &&
          liveness.lastObservableProgressAt !== null &&
          liveness.lastObservableProgressAt > cursor.observedAt;
        if (eventProgress || timestampProgress) {
          return Option.some(yield* resultFor("progress", input));
        }
        if (liveness.stale) {
          return Option.some(yield* resultFor("stale", input));
        }
        return Option.none<WaitForThreadUpdateResult>();
      });

      const waitForEvent: Effect.Effect<WaitForThreadUpdateResult, ThreadTurnLivenessQueryError> =
        Effect.suspend(() =>
          orchestrationEngine.streamDomainEvents.pipe(
            Stream.filter((event) => eventMatchesScope(event, input)),
            Stream.runHead,
            Effect.flatMap((event) =>
              Option.match(event, {
                onNone: () => Effect.never,
                onSome: (nextEvent) =>
                  probe(nextEvent).pipe(
                    Effect.flatMap((result) =>
                      Option.isSome(result) ? Effect.succeed(result.value) : waitForEvent,
                    ),
                  ),
              }),
            ),
          ),
        );

      const staleDeadline = Effect.gen(function* () {
        const liveness = yield* getThreadTurnStatus({
          threadId: input.threadId,
          ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
        });
        if (liveness.state !== "running" || liveness.pendingRequests.length > 0 || liveness.stale) {
          return yield* Effect.never;
        }
        const referenceAtMs = isoToMs(liveness.lastObservableProgressAt ?? liveness.startedAt);
        if (referenceAtMs === null) {
          return yield* Effect.never;
        }
        const nowMs = yield* Clock.currentTimeMillis;
        const sleepMs = Math.max(0, referenceAtMs + liveness.staleAfterMs - nowMs + 1);
        yield* Effect.sleep(Duration.millis(sleepMs));
        return yield* resultFor("stale", input);
      });

      const initialProbe = Effect.yieldNow.pipe(
        Effect.flatMap(() => probe(null)),
        Effect.flatMap((result) =>
          Option.isSome(result) ? Effect.succeed(result.value) : Effect.never,
        ),
      );

      return yield* Effect.raceFirst(
        Effect.raceFirst(Effect.raceFirst(waitForEvent, initialProbe), staleDeadline),
        Effect.sleep(Duration.millis(timeoutMs)).pipe(
          Effect.flatMap(() => resultFor("timeout", input)),
        ),
      );
    }).pipe(
      Effect.mapError(toQueryError(`Unable to wait for thread updates for ${input.threadId}.`)),
    );

  return ThreadTurnLivenessQuery.of({
    getThreadTurnStatus,
    getCurrentCursor,
    waitForThreadUpdate,
  });
});

export const ThreadTurnLivenessQueryLive = Layer.effect(ThreadTurnLivenessQuery, make);
