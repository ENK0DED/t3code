import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CheckpointRef,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationCheckpointSummary,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import { McpOrchestrationServiceLive } from "./Layers/McpOrchestrationService.ts";
import { McpOrchestrationService } from "./Services/McpOrchestrationService.ts";
import { CheckpointDiffQuery } from "../checkpointing/CheckpointDiffQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionThreadTurnLivenessRow,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadTurnStartBootstrapDispatcherLive } from "../orchestration/Services/ThreadTurnStartBootstrapDispatcher.ts";
import { ThreadTurnLivenessQueryLive } from "../orchestration/Layers/ThreadTurnLivenessQuery.ts";
import { ThreadTurnSignalTrackerLive } from "../orchestration/Layers/ThreadTurnSignalTracker.ts";
import { ProjectionThreadMessageSearchRepository } from "../persistence/Services/ProjectionThreadMessageSearch.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../provider/providerMaintenance.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";

const CURRENT = ThreadId.make("thread-current");
const TARGET = ThreadId.make("thread-target");
const STALE_SIGNAL_AT = "1970-01-01T00:00:00.000Z";
const FRESH_SIGNAL_AT = "2999-01-01T00:00:00.000Z";
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

const freshIso = () => FRESH_SIGNAL_AT;
const futureIso = (offsetMs: number) =>
  `2999-01-01T00:00:${String(Math.max(1, Math.ceil(offsetMs / 1_000))).padStart(2, "0")}.000Z`;

const modelSelection = (): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.5",
});

const makeProvider = (): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  availability: "available",
  continuation: { groupKey: "codex:instance:codex" },
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

const projectShell = (): OrchestrationProjectShell => ({
  id: ProjectId.make("project-current"),
  title: "Current Project",
  workspaceRoot: "/work/current",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const thread = (input: Partial<OrchestrationThread> & Pick<OrchestrationThread, "id">) =>
  ({
    id: input.id,
    projectId: input.projectId ?? ProjectId.make("project-current"),
    parentThreadId: input.parentThreadId ?? null,
    title: input.title ?? "Thread",
    modelSelection: input.modelSelection ?? modelSelection(),
    runtimeMode: input.runtimeMode ?? "auto-accept-edits",
    interactionMode: input.interactionMode ?? "default",
    branch: input.branch ?? null,
    worktreePath: input.worktreePath ?? null,
    latestTurn: input.latestTurn ?? null,
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
    createdVia: input.createdVia ?? "mcp",
    createdByThreadId: input.createdByThreadId ?? CURRENT,
    deletedAt: input.deletedAt ?? null,
    messages: input.messages ?? [],
    proposedPlans: input.proposedPlans ?? [],
    activities: input.activities ?? [],
    checkpoints: input.checkpoints ?? [],
    session: input.session ?? null,
  }) satisfies OrchestrationThread;

const runningTurn = (turnId: string): OrchestrationLatestTurn => ({
  turnId: TurnId.make(turnId),
  state: "running",
  requestedAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
  assistantMessageId: null,
});

const expectForbiddenExit = (name: string, exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit), name).toBe(true);
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause) as { readonly code: string };
    expect(error.code, name).toBe("forbidden");
  }
};

const expectMcpErrorCode = (name: string, exit: Exit.Exit<unknown, unknown>, code: string) => {
  expect(Exit.isFailure(exit), name).toBe(true);
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause) as { readonly code: string };
    expect(error.code, name).toBe(code);
  }
};

const completedTurn = (turnId: string, assistantMessageId: string): OrchestrationLatestTurn => ({
  turnId: TurnId.make(turnId),
  state: "completed",
  requestedAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  assistantMessageId: MessageId.make(assistantMessageId),
});

const assistantMessage = (id: string, turnId: string, text: string): OrchestrationMessage => ({
  id: MessageId.make(id),
  role: "assistant",
  text,
  turnId: TurnId.make(turnId),
  streaming: false,
  createdAt: "2026-01-01T00:00:01.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
});

const managedRunningThread = (
  turnId: string,
  input?: Partial<OrchestrationThread>,
): OrchestrationThread =>
  thread({
    id: TARGET,
    latestTurn: runningTurn(turnId),
    session: {
      threadId: TARGET,
      status: "running",
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "auto-accept-edits",
      activeTurnId: TurnId.make(turnId),
      lastError: null,
      updatedAt: freshIso(),
    },
    ...input,
  });

const livenessRow = (
  input: Partial<ProjectionThreadTurnLivenessRow> & Pick<ProjectionThreadTurnLivenessRow, "turnId">,
): ProjectionThreadTurnLivenessRow => {
  const requestedAt = input.requestedAt ?? freshIso();
  const startedAt = input.startedAt ?? requestedAt;
  const lastProviderSignalAt = input.lastProviderSignalAt ?? null;
  return {
    threadId: input.threadId ?? TARGET,
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

// A completed turn's checkpoint, as the projection records for EVERY completed turn (even
// answer-only ones — CheckpointReactor captures on turn.completed). Used to model a turn that
// finished while latestTurn moved on / was nulled, so it is observable only by turn id.
const checkpoint = (
  turnId: string,
  assistantMessageId: string | null,
  turnCount = 0,
): OrchestrationCheckpointSummary => ({
  turnId: TurnId.make(turnId),
  checkpointTurnCount: turnCount,
  checkpointRef: CheckpointRef.make(`ref-${turnId}`),
  status: "ready",
  files: [],
  assistantMessageId: assistantMessageId === null ? null : MessageId.make(assistantMessageId),
  completedAt: "2026-01-01T00:00:01.000Z",
});

// Minimal stand-in for a thread-aggregate domain event: the wait loop only reads
// `aggregateId` to filter, then re-reads the snapshot. Cast keeps the test focused.
const threadEvent = (threadId: ThreadId): OrchestrationEvent =>
  ({ aggregateId: threadId, type: "thread.activity-appended" }) as unknown as OrchestrationEvent;

const providerSignalEvent = (input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly signaledAt: string;
  readonly sequence: number;
}): OrchestrationEvent =>
  ({
    aggregateId: input.threadId,
    sequence: input.sequence,
    type: "thread.turn-provider-signaled",
    payload: {
      threadId: input.threadId,
      turnId: input.turnId,
      signalKind: "reasoning",
      signaledAt: input.signaledAt,
    },
  }) as OrchestrationEvent;

type Harness = {
  readonly layer: Layer.Layer<
    McpOrchestrationService | McpInvocationContext.McpInvocationContext | FileSystem.FileSystem
  >;
  readonly setThread: (next: OrchestrationThread) => Effect.Effect<void>;
  readonly updateLivenessRow: (row: ProjectionThreadTurnLivenessRow) => Effect.Effect<void>;
  readonly setSnapshotSequence: (sequence: number) => Effect.Effect<void>;
  readonly emit: (event: OrchestrationEvent) => Effect.Effect<void>;
  readonly dispatched: Array<OrchestrationCommand>;
};

// `onDispatch` models the real engine's side effect: dispatching a command updates the
// projection (and would publish a domain event). Tests use it so that starting a turn
// makes a NEW turn observable in the snapshot — exactly as production does — instead of
// reusing the pre-dispatch turn id.
const makeHarness = (
  initial: ReadonlyArray<OrchestrationThread>,
  onDispatch?: (
    command: OrchestrationCommand,
    api: {
      readonly setThread: (next: OrchestrationThread) => Effect.Effect<void>;
      readonly emit: (event: OrchestrationEvent) => Effect.Effect<void>;
    },
  ) => Effect.Effect<void>,
  hooks?: {
    readonly livenessRows?: ReadonlyArray<ProjectionThreadTurnLivenessRow>;
    readonly onReadTurnStateById?: (
      input: {
        readonly threadId: ThreadId;
        readonly turnId: TurnId;
        readonly observed: Option.Option<OrchestrationLatestTurn>;
      },
      api: {
        readonly setThread: (next: OrchestrationThread) => Effect.Effect<void>;
        readonly emit: (event: OrchestrationEvent) => Effect.Effect<void>;
      },
    ) => Effect.Effect<void>;
  },
): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    const threadsRef = yield* Ref.make(
      new Map(initial.map((entry) => [String(entry.id), entry] as const)),
    );
    const pendingMessageIdsRef = yield* Ref.make(new Map<string, MessageId>());
    const turnIdsByMessageIdRef = yield* Ref.make(new Map<string, TurnId>());
    const snapshotSequenceRef = yield* Ref.make(1);
    const livenessRowsRef = yield* Ref.make(
      new Map(
        (hooks?.livenessRows ?? []).map((row) => [`${row.threadId}:${row.turnId}`, row] as const),
      ),
    );
    const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
    const dispatched: Array<OrchestrationCommand> = [];

    const setThread = (next: OrchestrationThread) =>
      Effect.gen(function* () {
        const pendingMessageIds = yield* Ref.get(pendingMessageIdsRef);
        const pendingMessageId = pendingMessageIds.get(String(next.id));
        if (pendingMessageId !== undefined && next.latestTurn !== null) {
          const turnIdsByMessageId = yield* Ref.get(turnIdsByMessageIdRef);
          const key = `${next.id}:${pendingMessageId}`;
          if (!turnIdsByMessageId.has(key)) {
            yield* Ref.update(turnIdsByMessageIdRef, (map) =>
              new Map(map).set(key, next.latestTurn!.turnId),
            );
            yield* Ref.update(pendingMessageIdsRef, (map) => {
              const updated = new Map(map);
              updated.delete(String(next.id));
              return updated;
            });
          }
        }
        yield* Ref.update(threadsRef, (map) => new Map(map).set(String(next.id), next));
      });
    const emit = (event: OrchestrationEvent) =>
      PubSub.publish(eventPubSub, event).pipe(Effect.asVoid);

    const unsupported = (operation: string) =>
      Effect.die(new Error(`${operation} unused`)) as never;

    const readTurnStateById = ({ threadId, turnId }: { threadId: ThreadId; turnId: TurnId }) =>
      Effect.gen(function* () {
        const observed = yield* Ref.get(threadsRef).pipe(
          Effect.map((map): Option.Option<OrchestrationLatestTurn> => {
            const found = map.get(String(threadId));
            if (!found) {
              return Option.none();
            }
            if (found.latestTurn !== null && found.latestTurn.turnId === turnId) {
              return Option.some(found.latestTurn);
            }
            const checkpoint = found.checkpoints.find((entry) => entry.turnId === turnId);
            return checkpoint
              ? Option.some({
                  turnId: checkpoint.turnId,
                  state: "completed",
                  requestedAt: checkpoint.completedAt,
                  startedAt: checkpoint.completedAt,
                  completedAt: checkpoint.completedAt,
                  assistantMessageId: checkpoint.assistantMessageId,
                })
              : Option.none();
          }),
        );
        if (hooks?.onReadTurnStateById) {
          yield* hooks.onReadTurnStateById({ threadId, turnId, observed }, { setThread, emit });
        }
        return observed;
      });

    const readTurnStateByIdSnapshot = ({
      threadId,
      turnId,
    }: {
      threadId: ThreadId;
      turnId: TurnId;
    }) =>
      Ref.get(threadsRef).pipe(
        Effect.map((map): Option.Option<OrchestrationLatestTurn> => {
          const found = map.get(String(threadId));
          if (!found) {
            return Option.none();
          }
          if (found.latestTurn !== null && found.latestTurn.turnId === turnId) {
            return Option.some(found.latestTurn);
          }
          const checkpoint = found.checkpoints.find((entry) => entry.turnId === turnId);
          return checkpoint
            ? Option.some({
                turnId: checkpoint.turnId,
                state: "completed",
                requestedAt: checkpoint.completedAt,
                startedAt: checkpoint.completedAt,
                completedAt: checkpoint.completedAt,
                assistantMessageId: checkpoint.assistantMessageId,
              })
            : Option.none();
        }),
      );

    const livenessRowById = ({ threadId, turnId }: { threadId: ThreadId; turnId: TurnId }) =>
      Effect.gen(function* () {
        const rows = yield* Ref.get(livenessRowsRef);
        const explicit = rows.get(`${threadId}:${turnId}`);
        if (explicit !== undefined) {
          return Option.some(explicit);
        }
        const turnState = yield* readTurnStateByIdSnapshot({ threadId, turnId });
        return Option.map(
          turnState,
          (turn): ProjectionThreadTurnLivenessRow => ({
            threadId,
            turnId: turn.turnId,
            pendingMessageId: null,
            state: turn.state,
            requestedAt: turn.requestedAt,
            startedAt: turn.startedAt,
            completedAt: turn.completedAt,
            lastProviderSignalAt: null,
            lastObservableProgressAt: null,
            lastSignalKind: null,
          }),
        );
      });

    const projectionQuery = ProjectionSnapshotQuery.of({
      getCommandReadModel: () => Effect.die("unused"),
      getSnapshot: () => Effect.die("unused"),
      getShellSnapshot: () => Effect.die("unused"),
      getArchivedShellSnapshot: () => Effect.die("unused"),
      getSnapshotSequence: () =>
        Ref.get(snapshotSequenceRef).pipe(Effect.map((snapshotSequence) => ({ snapshotSequence }))),
      getCounts: () => Effect.die("unused"),
      getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      getProjectShellById: (projectId) =>
        Effect.succeed(
          projectId === ProjectId.make("project-current")
            ? Option.some(projectShell())
            : Option.none(),
        ),
      getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
      getThreadCheckpointContext: () => Effect.die("unused"),
      getFullThreadDiffContext: () => Effect.die("unused"),
      listProjectShells: () => Effect.succeed([projectShell()]),
      listThreadShellsByProject: () => Effect.succeed([]),
      getThreadShellById: () => Effect.succeed(Option.none()),
      getThreadCreatorById: (threadId) =>
        Ref.get(threadsRef).pipe(
          Effect.map((map) => {
            const found = map.get(String(threadId));
            return found
              ? Option.some({
                  createdVia: found.createdVia ?? "user",
                  createdByThreadId: found.createdByThreadId ?? null,
                })
              : Option.none();
          }),
        ),
      getThreadDetailById: (threadId) =>
        Ref.get(threadsRef).pipe(
          Effect.map((map) => {
            const found = map.get(String(threadId));
            return found ? Option.some(found) : Option.none();
          }),
        ),
      // Read a concrete turn's state by exact id, modeling the production query that reads
      // the projection_turns row DIRECTLY (so it resolves a turn even when latest_turn_id was
      // nulled). Resolve from the stored thread's latestTurn when it matches, else from a
      // checkpoint for that turn id (checkpoints exist only for completed turns).
      getThreadTurnStateById: readTurnStateById,
      getThreadTurnLivenessRowById: livenessRowById,
      getThreadTurnStateByPendingMessageId: ({ threadId, messageId }) =>
        Effect.gen(function* () {
          const turnIdsByMessageId = yield* Ref.get(turnIdsByMessageIdRef);
          const turnId = turnIdsByMessageId.get(`${threadId}:${messageId}`);
          if (turnId === undefined) {
            return Option.none<OrchestrationLatestTurn>();
          }
          return yield* readTurnStateByIdSnapshot({ threadId, turnId });
        }),
      searchThreadMessagesByProject: () => Effect.succeed([]),
    });

    const layer = McpOrchestrationServiceLive.pipe(
      Layer.provideMerge(ThreadTurnStartBootstrapDispatcherLive),
      Layer.provideMerge(ThreadTurnLivenessQueryLive),
      Layer.provideMerge(ThreadTurnSignalTrackerLive),
      Layer.provideMerge(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: "environment-1" as never,
          threadId: CURRENT,
          providerSessionId: "provider-session-1",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["orchestration.write", "orchestration.read"] as const),
          issuedAt: 0,
          expiresAt: 60_000,
        }),
      ),
      Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projectionQuery)),
      Layer.provideMerge(
        Layer.succeed(
          CheckpointDiffQuery,
          CheckpointDiffQuery.of({
            getTurnDiff: () => unsupported("getTurnDiff"),
            getFullThreadDiff: () => unsupported("getFullThreadDiff"),
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
      Layer.provideMerge(ServerSettingsService.layerTest({})),
      Layer.provideMerge(
        Layer.succeed(
          OrchestrationEngineService,
          OrchestrationEngineService.of({
            dispatch: (command) =>
              Effect.gen(function* () {
                dispatched.push(command);
                if (command.type === "thread.turn.start") {
                  yield* Ref.update(pendingMessageIdsRef, (map) =>
                    new Map(map).set(String(command.threadId), command.message.messageId),
                  );
                }
                if (onDispatch !== undefined) {
                  yield* onDispatch(command, { setThread, emit });
                }
                return { sequence: dispatched.length };
              }),
            readEvents: () => Stream.empty,
            streamDomainEvents: Stream.fromPubSub(eventPubSub),
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionThreadMessageSearchRepository,
          ProjectionThreadMessageSearchRepository.of({ searchByProject: () => Effect.succeed([]) }),
        ),
      ),
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
      Layer.provideMerge(
        Layer.succeed(
          GitWorkflowService,
          GitWorkflowService.of({
            status: () => unsupported("status"),
            localStatus: () => unsupported("localStatus"),
            remoteStatus: () => unsupported("remoteStatus"),
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            fetchRemote: () => unsupported("fetchRemote"),
            resolveRemoteTrackingCommit: () => unsupported("resolveRemoteTrackingCommit"),
            pullCurrentBranch: () => unsupported("pullCurrentBranch"),
            runStackedAction: () => unsupported("runStackedAction"),
            resolvePullRequest: () => unsupported("resolvePullRequest"),
            preparePullRequestThread: () => unsupported("preparePullRequestThread"),
            listRefs: () => unsupported("listRefs"),
            createWorktree: () => unsupported("createWorktree"),
            removeWorktree: () => unsupported("removeWorktree"),
            createRef: () => unsupported("createRef"),
            switchRef: () => unsupported("switchRef"),
            renameBranch: () => unsupported("renameBranch"),
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(
          ProjectSetupScriptRunner,
          ProjectSetupScriptRunner.of({ runForThread: () => unsupported("runForThread") }),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(
          VcsStatusBroadcaster,
          VcsStatusBroadcaster.of({
            getStatus: () => unsupported("getStatus"),
            refreshLocalStatus: () => unsupported("refreshLocalStatus"),
            refreshStatus: () => unsupported("refreshStatus"),
            streamStatus: () => Stream.empty,
          }),
        ),
      ),
      Layer.provideMerge(NodeServices.layer),
      // Construction errors (e.g. ServerSettings) are not under test; treat as defects so
      // the harness layer's error channel is `never` and the struct type stays clean.
      Layer.orDie,
    );

    return {
      layer,
      setThread,
      updateLivenessRow: (row) =>
        Ref.update(livenessRowsRef, (rows) =>
          new Map(rows).set(`${row.threadId}:${row.turnId}`, row),
        ),
      setSnapshotSequence: (sequence) => Ref.set(snapshotSequenceRef, sequence),
      emit,
      dispatched,
    };
  });

// --- wait_for_response: turn settles (completed) by the time the probe runs ---
it.live("send_thread_message wait_for_response returns completed answer inline", () =>
  Effect.gen(function* () {
    // Thread starts idle with a PRIOR completed turn. Dispatching the new turn flips the
    // snapshot to a NEW completed turn (modeling the engine's projection update), so the
    // wait's initial probe observes the new terminal turn and returns immediately.
    const harness = yield* makeHarness(
      [thread({ id: TARGET, latestTurn: completedTurn("turn-prev", "msg-prev") })],
      (command, api) =>
        command.type === "thread.turn.start"
          ? api.setThread(
              thread({
                id: TARGET,
                latestTurn: completedTurn("turn-new", "msg-answer"),
                messages: [assistantMessage("msg-answer", "turn-new", "the final answer")],
              }),
            )
          : Effect.void,
    );
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = (yield* service.sendThreadMessage({
        threadId: TARGET,
        message: "do the thing",
        waitForResponse: true,
        timeoutMs: 1_000,
      })) as {
        readonly wait?: {
          readonly state: string;
          readonly answer: { readonly text: string } | null;
        };
      };
      expect(result.wait?.state).toBe("completed");
      expect(result.wait?.answer?.text).toBe("the final answer");
    }).pipe(Effect.provide(harness.layer));
  }),
);

// --- wait_for_response: turn becomes terminal later, woken by a domain event ---
it.live("send_thread_message wait_for_response settles when an event drives completion", () =>
  Effect.gen(function* () {
    // Dispatch sets a RUNNING new turn (work started). A concurrent emitter forked from the
    // test then flips the snapshot to completed and publishes an event for the thread,
    // which wakes the wait loop's stream subscription. Exercises the event-driven path
    // (not just the initial probe).
    const harness = yield* makeHarness([thread({ id: TARGET, latestTurn: null })], (command, api) =>
      command.type === "thread.turn.start"
        ? api.setThread(thread({ id: TARGET, latestTurn: runningTurn("turn-new") }))
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      // Fork the delayed completion+event so it runs while the wait blocks. The 60ms delay
      // is comfortably after the call dispatches and arms its stream subscription.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* Effect.sleep("60 millis");
          yield* harness.setThread(
            thread({
              id: TARGET,
              latestTurn: completedTurn("turn-new", "msg-late"),
              messages: [assistantMessage("msg-late", "turn-new", "late answer")],
            }),
          );
          yield* harness.emit(threadEvent(TARGET));
        }),
      );
      const result = (yield* service.sendThreadMessage({
        threadId: TARGET,
        message: "do the thing",
        waitForResponse: true,
        timeoutMs: 5_000,
      })) as {
        readonly wait?: {
          readonly state: string;
          readonly answer: { readonly text: string } | null;
        };
      };
      expect(result.wait?.state).toBe("completed");
      expect(result.wait?.answer?.text).toBe("late answer");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  }),
);

// --- wait_for_response: subscribe before probe so a completion event emitted during probing is not missed ---
it.live("send_thread_message wait_for_response catches completion during initial probe", () =>
  Effect.gen(function* () {
    let emittedCompletion = false;
    const harness = yield* makeHarness(
      [thread({ id: TARGET, latestTurn: null })],
      (command, api) =>
        command.type === "thread.turn.start"
          ? api.setThread(thread({ id: TARGET, latestTurn: runningTurn("turn-race") }))
          : Effect.void,
      {
        onReadTurnStateById: ({ turnId, observed }, api) =>
          Effect.gen(function* () {
            if (
              emittedCompletion ||
              turnId !== TurnId.make("turn-race") ||
              Option.isNone(observed) ||
              observed.value.state !== "running"
            ) {
              return;
            }
            emittedCompletion = true;
            yield* api.setThread(
              thread({
                id: TARGET,
                latestTurn: completedTurn("turn-race", "msg-race"),
                messages: [assistantMessage("msg-race", "turn-race", "race answer")],
              }),
            );
            yield* api.emit(threadEvent(TARGET));
          }),
      },
    );
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const startedAt = yield* Clock.currentTimeMillis;
      const result = (yield* service.sendThreadMessage({
        threadId: TARGET,
        message: "race the wait",
        waitForResponse: true,
        timeoutMs: 1_000,
      })) as {
        readonly wait?: {
          readonly state: string;
          readonly answer: { readonly text: string } | null;
        };
      };
      const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
      expect(result.wait?.state).toBe("completed");
      expect(result.wait?.answer?.text).toBe("race answer");
      expect(elapsedMs).toBeLessThan(500);
    }).pipe(Effect.provide(harness.layer));
  }),
);

// --- wait_for_response: timeout stops waiting, turn keeps running, no interrupt ---
it.live("send_thread_message wait_for_response timeout returns running and does NOT cancel", () =>
  Effect.gen(function* () {
    // Dispatch sets a running turn that never completes, so the wait must time out.
    const harness = yield* makeHarness([thread({ id: TARGET, latestTurn: null })], (command, api) =>
      command.type === "thread.turn.start"
        ? api.setThread(thread({ id: TARGET, latestTurn: runningTurn("turn-stuck") }))
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = (yield* service.sendThreadMessage({
        threadId: TARGET,
        message: "do the thing",
        waitForResponse: true,
        timeoutMs: 40,
      })) as {
        readonly wait?: {
          readonly state: string;
          readonly answer: unknown;
          readonly timedOut?: boolean;
        };
      };
      expect(result.wait?.state).toBe("running");
      expect(result.wait?.answer).toBeNull();
      expect(result.wait?.timedOut).toBe(true);
      // Wait timeout must NOT dispatch an interrupt (only the turn start command ran).
      const interrupts = harness.dispatched.filter((c) => c.type === "thread.turn.interrupt");
      expect(interrupts).toHaveLength(0);
    }).pipe(Effect.provide(harness.layer));
  }),
);

// --- wait_for_response: provider turn-start failure before a turn id exists is reported as error ---
it.live("send_thread_message wait_for_response reports provider start failure", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([thread({ id: TARGET, latestTurn: null })], (command, api) =>
      command.type === "thread.turn.start"
        ? Effect.gen(function* () {
            yield* api.setThread(
              thread({
                id: TARGET,
                latestTurn: null,
                activities: [
                  {
                    id: "evt-start-failed" as never,
                    tone: "error",
                    kind: "provider.turn.start.failed",
                    summary: "Provider turn start failed",
                    payload: { detail: "No provider session could be started." },
                    turnId: null,
                    createdAt: command.createdAt,
                  },
                ],
              }),
            );
            yield* api.emit(threadEvent(TARGET));
          })
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = (yield* service.sendThreadMessage({
        threadId: TARGET,
        message: "start should fail",
        waitForResponse: true,
        timeoutMs: 200,
      })) as {
        readonly wait?: {
          readonly state: string;
          readonly turnId: string | null;
          readonly answer: unknown;
          readonly detail?: string;
          readonly timedOut?: boolean;
        };
      };
      expect(result.wait?.state).toBe("error");
      expect(result.wait?.turnId).toBeNull();
      expect(result.wait?.answer).toBeNull();
      expect(result.wait?.detail).toContain("No provider session could be started.");
      expect(result.wait?.timedOut).toBeUndefined();
    }).pipe(Effect.provide(harness.layer));
  }),
);

// --- wait_for_response: error turn returns its real state + null answer ---
it.live("send_thread_message wait_for_response surfaces error state with null answer", () =>
  Effect.gen(function* () {
    // Dispatch produces a NEW turn that ends in error (no checkpoint / answer).
    const harness = yield* makeHarness([thread({ id: TARGET, latestTurn: null })], (command, api) =>
      command.type === "thread.turn.start"
        ? api.setThread(
            thread({
              id: TARGET,
              latestTurn: {
                turnId: TurnId.make("turn-err"),
                state: "error",
                requestedAt: "2026-01-01T00:00:00.000Z",
                startedAt: "2026-01-01T00:00:00.000Z",
                completedAt: "2026-01-01T00:00:01.000Z",
                assistantMessageId: null,
              },
            }),
          )
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = (yield* service.sendThreadMessage({
        threadId: TARGET,
        message: "do the thing",
        waitForResponse: true,
        timeoutMs: 1_000,
      })) as { readonly wait?: { readonly state: string; readonly answer: unknown } };
      expect(result.wait?.state).toBe("error");
      expect(result.wait?.answer).toBeNull();
    }).pipe(Effect.provide(harness.layer));
  }),
);

// --- omitted options: exact prior fire-and-forget behavior (no wait field) ---
it.live("send_thread_message without control options returns no wait field", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([thread({ id: TARGET, latestTurn: null })]);
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = (yield* service.sendThreadMessage({
        threadId: TARGET,
        message: "do the thing",
      })) as { readonly status: string; readonly wait?: unknown };
      expect(result.status).toBe("accepted");
      expect("wait" in result).toBe(false);
    }).pipe(Effect.provide(harness.layer));
  }),
);

// --- turn_timeout_ms watcher: dispatches interrupt when the turn is still running ---
it.live("turn_timeout_ms cancels the turn when it is still running after the timeout", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([thread({ id: TARGET, latestTurn: null })]);
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      yield* service.sendThreadMessage({
        threadId: TARGET,
        message: "long task",
        turnTimeoutMs: 30,
      });
      // After dispatch the watcher is armed against a still-running NEW turn. Make the
      // snapshot reflect that running turn so the watcher's re-check sees live work.
      yield* harness.setThread(thread({ id: TARGET, latestTurn: runningTurn("turn-live") }));
      // Wait past the watcher's timeout so it fires.
      yield* Effect.sleep("120 millis");
      const interrupts = harness.dispatched.filter((c) => c.type === "thread.turn.interrupt");
      expect(interrupts).toHaveLength(1);
    }).pipe(Effect.provide(harness.layer));
  }),
);

// --- turn_timeout_ms watcher: does NOT interrupt when the turn already completed ---
it.live("turn_timeout_ms does NOT cancel when the turn completed first", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([thread({ id: TARGET, latestTurn: null })]);
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      yield* service.sendThreadMessage({
        threadId: TARGET,
        message: "quick task",
        turnTimeoutMs: 30,
      });
      // The turn completes (new terminal turn) before the watcher's re-check.
      yield* harness.setThread(
        thread({
          id: TARGET,
          latestTurn: completedTurn("turn-quick", "msg-q"),
          messages: [assistantMessage("msg-q", "turn-quick", "done")],
        }),
      );
      yield* Effect.sleep("120 millis");
      const interrupts = harness.dispatched.filter((c) => c.type === "thread.turn.interrupt");
      expect(interrupts).toHaveLength(0);
    }).pipe(Effect.provide(harness.layer));
  }),
);

// --- response_timeout_ms watcher: cancels only when still blocked on an open request ---
it.live("response_timeout_ms cancels when the turn is still blocked on a pending request", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([thread({ id: TARGET, latestTurn: null })]);
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      yield* service.sendThreadMessage({
        threadId: TARGET,
        message: "needs approval",
        responseTimeoutMs: 30,
      });
      // Still-running NEW turn with an OPEN approval request (a requested activity with no
      // matching resolved): the watcher must cancel.
      yield* harness.setThread(
        thread({
          id: TARGET,
          latestTurn: runningTurn("turn-blocked"),
          activities: [
            {
              id: "evt-req-1" as never,
              tone: "approval",
              kind: "approval.requested",
              summary: "approval requested",
              payload: { requestId: "req-1", requestKind: "command", detail: "rm -rf /tmp/x" },
              turnId: TurnId.make("turn-blocked"),
              createdAt: "2026-01-01T00:00:00.500Z",
            },
          ],
        }),
      );
      yield* Effect.sleep("120 millis");
      const interrupts = harness.dispatched.filter((c) => c.type === "thread.turn.interrupt");
      expect(interrupts).toHaveLength(1);
    }).pipe(Effect.provide(harness.layer));
  }),
);

// --- response_timeout_ms watcher: does NOT cancel when the request was answered ---
it.live("response_timeout_ms does NOT cancel when the pending request was resolved", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([thread({ id: TARGET, latestTurn: null })]);
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      yield* service.sendThreadMessage({
        threadId: TARGET,
        message: "needs approval",
        responseTimeoutMs: 30,
      });
      // The request was opened AND resolved before the watcher re-checks: no open request,
      // so even though the turn is still running, the watcher must NOT cancel.
      yield* harness.setThread(
        thread({
          id: TARGET,
          latestTurn: runningTurn("turn-answered"),
          activities: [
            {
              id: "evt-req-1" as never,
              tone: "approval",
              kind: "approval.requested",
              summary: "approval requested",
              payload: { requestId: "req-1", requestKind: "command" },
              turnId: TurnId.make("turn-answered"),
              createdAt: "2026-01-01T00:00:00.500Z",
            },
            {
              id: "evt-res-1" as never,
              tone: "info",
              kind: "approval.resolved",
              summary: "approval resolved",
              payload: { requestId: "req-1" },
              turnId: TurnId.make("turn-answered"),
              createdAt: "2026-01-01T00:00:00.900Z",
            },
          ],
        }),
      );
      yield* Effect.sleep("120 millis");
      const interrupts = harness.dispatched.filter((c) => c.type === "thread.turn.interrupt");
      expect(interrupts).toHaveLength(0);
    }).pipe(Effect.provide(harness.layer));
  }),
);

// --- response_timeout_ms watcher: ignores stale pending requests from older turns ---
it.live("response_timeout_ms does NOT cancel for a pending request from another turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([thread({ id: TARGET, latestTurn: null })], (command, api) =>
      command.type === "thread.turn.start"
        ? api.setThread(
            thread({
              id: TARGET,
              latestTurn: runningTurn("turn-current"),
              activities: [
                {
                  id: "evt-old-req" as never,
                  tone: "approval",
                  kind: "approval.requested",
                  summary: "old approval requested",
                  payload: {
                    requestId: "req-old",
                    requestKind: "command",
                    detail: "stale approval",
                  },
                  turnId: TurnId.make("turn-old"),
                  createdAt: "2026-01-01T00:00:00.100Z",
                },
              ],
            }),
          )
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      yield* service.sendThreadMessage({
        threadId: TARGET,
        message: "new turn",
        responseTimeoutMs: 30,
      });
      yield* Effect.sleep("120 millis");
      const interrupts = harness.dispatched.filter((c) => c.type === "thread.turn.interrupt");
      expect(interrupts).toHaveLength(0);
    }).pipe(Effect.provide(harness.layer));
  }),
);

// --- #1 turn_timeout_ms watcher: does NOT interrupt a NEWER turn after the armed turn ended ---
// CRITICAL regression: the armed turn completes and a brand-new turn starts before the timer
// fires. The watcher is bound to the EXACT armed turn id, so it must read that turn's state
// (now completed, observable via its checkpoint even though latestTurn moved to the new turn)
// and NOT interrupt the unrelated new turn.
it.live("turn_timeout_ms does NOT interrupt a newer turn that replaced the armed turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([thread({ id: TARGET, latestTurn: null })], (command, api) =>
      command.type === "thread.turn.start"
        ? api.setThread(thread({ id: TARGET, latestTurn: runningTurn("turn-armed") }))
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      yield* service.sendThreadMessage({
        threadId: TARGET,
        message: "first task",
        turnTimeoutMs: 80,
      });
      // Let the watcher observe and bind to the armed turn (turn-armed) first.
      yield* Effect.sleep("25 millis");
      // Then the armed turn completes (now only observable by id via its checkpoint) AND a NEW
      // turn starts and becomes the current latestTurn. The watcher armed for turn-armed must
      // see it is no longer running and leave turn-new alone.
      yield* harness.setThread(
        thread({
          id: TARGET,
          latestTurn: runningTurn("turn-new"),
          checkpoints: [checkpoint("turn-armed", "msg-armed")],
          messages: [assistantMessage("msg-armed", "turn-armed", "armed answer")],
        }),
      );
      yield* Effect.sleep("160 millis");
      const interrupts = harness.dispatched.filter((c) => c.type === "thread.turn.interrupt");
      expect(interrupts).toHaveLength(0);
    }).pipe(Effect.provide(harness.layer));
  }),
);

// --- #1/#8 turn_timeout_ms interrupt carries the EXACT armed turn id ---
// When the armed turn IS still running at the deadline, the dispatched interrupt must carry
// that turn's id so the projection settles the right turn (a late timer can never settle a
// newer turn).
it.live("turn_timeout_ms interrupt carries the armed turnId", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([thread({ id: TARGET, latestTurn: null })], (command, api) =>
      command.type === "thread.turn.start"
        ? api.setThread(thread({ id: TARGET, latestTurn: runningTurn("turn-armed") }))
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      yield* service.sendThreadMessage({
        threadId: TARGET,
        message: "long task",
        turnTimeoutMs: 30,
      });
      yield* Effect.sleep("120 millis");
      const interrupts = harness.dispatched.filter((c) => c.type === "thread.turn.interrupt");
      expect(interrupts).toHaveLength(1);
      expect(
        interrupts[0]?.type === "thread.turn.interrupt" ? interrupts[0].turnId : undefined,
      ).toBe("turn-armed");
    }).pipe(Effect.provide(harness.layer));
  }),
);

// --- #5 wait_for_response observes a completed answer-only turn even when latestTurn is nulled ---
// The projection nulls latest_turn_id when the session goes ready, so a completed answer-only
// turn is invisible via latestTurn. Binding the wait to the turn id (read via
// getThreadTurnStateById, modeled here by the turn's checkpoint) keeps it observable.
it.live("wait_for_response sees a completed answer-only turn after latestTurn is nulled", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([thread({ id: TARGET, latestTurn: null })], (command, api) =>
      command.type === "thread.turn.start"
        ? // Dispatch makes the new turn briefly observable as latestTurn so the wait can
          // capture its id, then a later event nulls latestTurn while the turn's checkpoint
          // records completion (answer-only turn).
          api.setThread(thread({ id: TARGET, latestTurn: runningTurn("turn-answer") }))
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* Effect.sleep("40 millis");
          yield* harness.setThread(
            thread({
              id: TARGET,
              // latestTurn nulled (session ready), but the completed turn lives in checkpoints.
              latestTurn: null,
              checkpoints: [checkpoint("turn-answer", "msg-answer")],
              messages: [assistantMessage("msg-answer", "turn-answer", "the only answer")],
            }),
          );
          yield* harness.emit(threadEvent(TARGET));
        }),
      );
      const result = (yield* service.sendThreadMessage({
        threadId: TARGET,
        message: "answer me",
        waitForResponse: true,
        timeoutMs: 5_000,
      })) as {
        readonly wait?: {
          readonly state: string;
          readonly turnId: string | null;
          readonly answer: { readonly text: string } | null;
        };
      };
      expect(result.wait?.state).toBe("completed");
      expect(result.wait?.turnId).toBe("turn-answer");
      expect(result.wait?.answer?.text).toBe("the only answer");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  }),
);

// --- #4 wait_for_response binds the answer to the EXACT turn (no prior-turn stale answer) ---
// The new turn ends interrupted while a PRIOR completed turn (with an answer) is present. The
// result must report the new turn's real state with a null answer — never the prior answer.
it.live(
  "wait_for_response returns null answer for an interrupted turn despite a prior answer",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [
          thread({
            id: TARGET,
            // A prior COMPLETED turn with a real answer is already present.
            latestTurn: completedTurn("turn-prev", "msg-prev"),
            checkpoints: [checkpoint("turn-prev", "msg-prev")],
            messages: [assistantMessage("msg-prev", "turn-prev", "previous answer")],
          }),
        ],
        (command, api) =>
          command.type === "thread.turn.start"
            ? // The new turn becomes the latestTurn and ends INTERRUPTED (no answer/checkpoint).
              api.setThread(
                thread({
                  id: TARGET,
                  latestTurn: {
                    turnId: TurnId.make("turn-new"),
                    state: "interrupted",
                    requestedAt: "2026-01-01T00:00:00.000Z",
                    startedAt: "2026-01-01T00:00:00.000Z",
                    completedAt: "2026-01-01T00:00:01.000Z",
                    assistantMessageId: null,
                  },
                  checkpoints: [checkpoint("turn-prev", "msg-prev")],
                  messages: [assistantMessage("msg-prev", "turn-prev", "previous answer")],
                }),
              )
            : Effect.void,
      );
      yield* Effect.gen(function* () {
        const service = yield* McpOrchestrationService;
        const result = (yield* service.sendThreadMessage({
          threadId: TARGET,
          message: "do the thing",
          waitForResponse: true,
          timeoutMs: 1_000,
        })) as {
          readonly wait?: {
            readonly state: string;
            readonly turnId: string | null;
            readonly answer: { readonly text: string } | null;
          };
        };
        expect(result.wait?.state).toBe("interrupted");
        expect(result.wait?.turnId).toBe("turn-new");
        // Crucially NOT "previous answer" — the answer is bound to the interrupted new turn.
        expect(result.wait?.answer).toBeNull();
      }).pipe(Effect.provide(harness.layer));
    }),
);

// --- #3 response_timeout_ms cancels a request that opens LATE (mid-turn), past the budget ---
// A request need not be open at dispatch: the model can ask mid-turn. The per-request watcher
// must arm for a request that appears later (via a domain event) and cancel if it stays open
// past the budget.
it.live("response_timeout_ms cancels a request that opens after dispatch", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(
      // Dispatch starts a running turn with NO open request yet.
      [thread({ id: TARGET, latestTurn: null })],
      (command, api) =>
        command.type === "thread.turn.start"
          ? api.setThread(thread({ id: TARGET, latestTurn: runningTurn("turn-late") }))
          : Effect.void,
    );
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      yield* service.sendThreadMessage({
        threadId: TARGET,
        message: "may ask later",
        responseTimeoutMs: 40,
      });
      // No request open initially. After a delay the model raises a request mid-turn, surfaced
      // as a requested activity with no matching resolved, and an event wakes the watcher.
      yield* Effect.sleep("20 millis");
      yield* harness.setThread(
        thread({
          id: TARGET,
          latestTurn: runningTurn("turn-late"),
          activities: [
            {
              id: "evt-late-req" as never,
              tone: "approval",
              kind: "approval.requested",
              summary: "approval requested",
              payload: { requestId: "req-late", requestKind: "command", detail: "ship it" },
              turnId: TurnId.make("turn-late"),
              createdAt: "2026-01-01T00:00:00.700Z",
            },
          ],
        }),
      );
      yield* harness.emit(threadEvent(TARGET));
      // Wait past the per-request budget measured from when it was first observed.
      yield* Effect.sleep("160 millis");
      const interrupts = harness.dispatched.filter((c) => c.type === "thread.turn.interrupt");
      expect(interrupts).toHaveLength(1);
      expect(
        interrupts[0]?.type === "thread.turn.interrupt" ? interrupts[0].turnId : undefined,
      ).toBe("turn-late");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  }),
);

// --- #6 respond_to_approval rejects a requestId that is not open ---
it.live("respond_to_approval rejects an unknown/resolved requestId before dispatch", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([
      thread({
        id: TARGET,
        latestTurn: runningTurn("turn-x"),
        // The request was opened AND already resolved, so it is no longer open.
        activities: [
          {
            id: "evt-req" as never,
            tone: "approval",
            kind: "approval.requested",
            summary: "approval requested",
            payload: { requestId: "req-gone", requestKind: "command" },
            turnId: TurnId.make("turn-x"),
            createdAt: "2026-01-01T00:00:00.500Z",
          },
          {
            id: "evt-res" as never,
            tone: "info",
            kind: "approval.resolved",
            summary: "approval resolved",
            payload: { requestId: "req-gone" },
            turnId: TurnId.make("turn-x"),
            createdAt: "2026-01-01T00:00:00.900Z",
          },
        ],
      }),
    ]);
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const exit = yield* Effect.exit(
        service.respondToApproval({
          threadId: TARGET,
          requestId: "req-gone" as never,
          decision: "accept",
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as { readonly code: string };
        expect(error.code).toBe("stale_request");
      }
      // It must NOT have dispatched an approval response for a resolved request.
      const responds = harness.dispatched.filter((c) => c.type === "thread.approval.respond");
      expect(responds).toHaveLength(0);
    }).pipe(Effect.provide(harness.layer));
  }),
);

// --- #6 respond_to_approval reaches the dispatch path for an OPEN requestId ---
it.live("respond_to_approval dispatches for an open requestId", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([
      thread({
        id: TARGET,
        latestTurn: runningTurn("turn-x"),
        // An open approval request (requested, not resolved).
        activities: [
          {
            id: "evt-req" as never,
            tone: "approval",
            kind: "approval.requested",
            summary: "approval requested",
            payload: { requestId: "req-open", requestKind: "command", detail: "ls" },
            turnId: TurnId.make("turn-x"),
            createdAt: "2026-01-01T00:00:00.500Z",
          },
        ],
      }),
    ]);
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = (yield* service.respondToApproval({
        threadId: TARGET,
        requestId: "req-open" as never,
        decision: "accept",
      })) as { readonly status: string; readonly requestId: string };
      expect(result.status).toBe("approval_recorded");
      expect(result.requestId).toBe("req-open");
      const responds = harness.dispatched.filter((c) => c.type === "thread.approval.respond");
      expect(responds).toHaveLength(1);
    }).pipe(Effect.provide(harness.layer));
  }),
);

// --- #6 respond_to_user_input rejects an unknown/resolved requestId ---
it.live("respond_to_user_input rejects an unknown requestId before dispatch", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([
      thread({ id: TARGET, latestTurn: runningTurn("turn-x"), activities: [] }),
    ]);
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const exit = yield* Effect.exit(
        service.respondToUserInput({
          threadId: TARGET,
          requestId: "req-missing" as never,
          answers: { answer: "yes" },
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as { readonly code: string };
        expect(error.code).toBe("stale_request");
      }
      const responds = harness.dispatched.filter((c) => c.type === "thread.user-input.respond");
      expect(responds).toHaveLength(0);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.live("getThreadTurnStatus returns running liveness for an active turn", () =>
  Effect.gen(function* () {
    const turnId = TurnId.make("turn-status");
    const harness = yield* makeHarness([managedRunningThread("turn-status")], undefined, {
      livenessRows: [
        livenessRow({
          turnId,
          lastProviderSignalAt: freshIso(),
          lastSignalKind: "reasoning",
        }),
      ],
    });

    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = yield* service.getThreadTurnStatus({ threadId: TARGET, turnId });

      expect(result.threadId).toBe(TARGET);
      expect(typeof result.cursor).toBe("string");
      expect(result.liveness).toMatchObject({
        threadId: TARGET,
        turnId,
        state: "running",
        stale: false,
        safeToInterrupt: false,
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.live("waitForThreadUpdate returns progress for reasoning-only provider signal", () =>
  Effect.gen(function* () {
    const turnId = TurnId.make("turn-reasoning");
    const harness = yield* makeHarness([managedRunningThread("turn-reasoning")], undefined, {
      livenessRows: [
        livenessRow({
          turnId,
          lastProviderSignalAt: freshIso(),
          lastSignalKind: "reasoning",
        }),
      ],
    });

    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const status = yield* service.getThreadTurnStatus({ threadId: TARGET, turnId });
      const signaledAt = futureIso(1_000);
      const waiter = yield* service
        .waitForThreadUpdate({
          threadId: TARGET,
          turnId,
          since: status.cursor,
          timeoutMs: 1_000,
          includeStatus: true,
        })
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* harness.updateLivenessRow(
        livenessRow({
          turnId,
          lastProviderSignalAt: signaledAt,
          lastObservableProgressAt: signaledAt,
          lastSignalKind: "reasoning",
        }),
      );
      yield* harness.setSnapshotSequence(2);
      yield* harness.emit(
        providerSignalEvent({
          threadId: TARGET,
          turnId,
          signaledAt,
          sequence: 2,
        }),
      );

      const result = yield* Fiber.join(waiter);
      expect(result.reason).toBe("progress");
      expect(result.turnId).toBe(turnId);
      expect(result.liveness?.lastProviderSignalAt).toBe(signaledAt);
      const encodedResult = yield* encodeUnknownJsonString(result);
      expect(encodedResult).not.toContain("private reasoning");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  }),
);

it.live("waitForThreadUpdate returns pending_request when approval opens", () =>
  Effect.gen(function* () {
    const turnId = TurnId.make("turn-pending-request");
    const harness = yield* makeHarness(
      [
        managedRunningThread("turn-pending-request", {
          activities: [
            {
              id: "evt-approval-requested" as never,
              tone: "approval",
              kind: "approval.requested",
              summary: "approval requested",
              payload: { requestId: "approval-1", requestKind: "command", detail: "bun test" },
              turnId,
              createdAt: freshIso(),
            },
          ],
        }),
      ],
      undefined,
      {
        livenessRows: [
          livenessRow({
            turnId,
            lastProviderSignalAt: freshIso(),
            lastSignalKind: "request",
          }),
        ],
      },
    );

    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = yield* service.waitForThreadUpdate({
        threadId: TARGET,
        turnId,
        timeoutMs: 1_000,
        includeStatus: true,
      });

      expect(result.reason).toBe("pending_request");
      expect(result.liveness?.pendingRequests).toEqual([
        {
          kind: "approval",
          requestId: "approval-1",
          requestKind: "command",
          detail: "bun test",
        },
      ]);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.live("waitForThreadUpdate returns timeout and dispatches no interrupts", () =>
  Effect.gen(function* () {
    const turnId = TurnId.make("turn-timeout");
    const harness = yield* makeHarness([managedRunningThread("turn-timeout")], undefined, {
      livenessRows: [
        livenessRow({
          turnId,
          lastProviderSignalAt: freshIso(),
          lastSignalKind: "reasoning",
        }),
      ],
    });

    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const status = yield* service.getThreadTurnStatus({ threadId: TARGET, turnId });
      const result = yield* service.waitForThreadUpdate({
        threadId: TARGET,
        turnId,
        since: status.cursor,
        timeoutMs: 20,
      });

      expect(result.reason).toBe("timeout");
      expect(
        harness.dispatched.filter((command) => command.type === "thread.turn.interrupt"),
      ).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.live("cancelStaleThreadTurn rejects a non-stale active turn", () =>
  Effect.gen(function* () {
    const turnId = TurnId.make("turn-not-stale");
    const harness = yield* makeHarness([managedRunningThread("turn-not-stale")], undefined, {
      livenessRows: [
        livenessRow({
          turnId,
          lastProviderSignalAt: freshIso(),
          lastSignalKind: "reasoning",
        }),
      ],
    });

    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const status = yield* service.getThreadTurnStatus({ threadId: TARGET, turnId });
      const exit = yield* Effect.exit(
        service.cancelStaleThreadTurn({
          threadId: TARGET,
          turnId,
          ifNoProgressSince: status.cursor,
        }),
      );

      expectMcpErrorCode("cancelStaleThreadTurn", exit, "not_stale");
      expect(harness.dispatched).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.live("cancelStaleThreadTurn rejects when progress occurred after the cursor", () =>
  Effect.gen(function* () {
    const turnId = TurnId.make("turn-progress-race");
    const harness = yield* makeHarness([managedRunningThread("turn-progress-race")], undefined, {
      livenessRows: [
        livenessRow({
          turnId,
          requestedAt: STALE_SIGNAL_AT,
          startedAt: STALE_SIGNAL_AT,
          lastProviderSignalAt: STALE_SIGNAL_AT,
          lastObservableProgressAt: STALE_SIGNAL_AT,
          lastSignalKind: "reasoning",
        }),
      ],
    });

    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const status = yield* service.getThreadTurnStatus({ threadId: TARGET, turnId });
      const progressedAt = freshIso();
      yield* harness.updateLivenessRow(
        livenessRow({
          turnId,
          lastProviderSignalAt: progressedAt,
          lastObservableProgressAt: progressedAt,
          lastSignalKind: "reasoning",
        }),
      );
      yield* harness.setSnapshotSequence(2);
      const exit = yield* Effect.exit(
        service.cancelStaleThreadTurn({
          threadId: TARGET,
          turnId,
          ifNoProgressSince: status.cursor,
        }),
      );

      expectMcpErrorCode("cancelStaleThreadTurn", exit, "progress_observed");
      expect(harness.dispatched).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.live("cancelStaleThreadTurn interrupts the exact stale active turn", () =>
  Effect.gen(function* () {
    const turnId = TurnId.make("turn-stale");
    const harness = yield* makeHarness([managedRunningThread("turn-stale")], undefined, {
      livenessRows: [
        livenessRow({
          turnId,
          requestedAt: STALE_SIGNAL_AT,
          startedAt: STALE_SIGNAL_AT,
          lastProviderSignalAt: STALE_SIGNAL_AT,
          lastObservableProgressAt: STALE_SIGNAL_AT,
          lastSignalKind: "reasoning",
        }),
      ],
    });

    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const status = yield* service.getThreadTurnStatus({ threadId: TARGET, turnId });
      const result = yield* service.cancelStaleThreadTurn({
        threadId: TARGET,
        turnId,
        ifNoProgressSince: status.cursor,
      });

      expect(result).toMatchObject({
        status: "interrupt_requested",
        threadId: TARGET,
        turnId,
        sequence: 2,
        forced: false,
      });
      expect(harness.dispatched.map((command) => command.type)).toEqual([
        "thread.activity.append",
        "thread.turn.interrupt",
      ]);
      expect(harness.dispatched[1]).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: TARGET,
        turnId,
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.live(
  "cancelStaleThreadTurn cannot interrupt a newer turn after the requested turn completed",
  () =>
    Effect.gen(function* () {
      const oldTurnId = TurnId.make("turn-old");
      const harness = yield* makeHarness([managedRunningThread("turn-new")], undefined, {
        livenessRows: [
          livenessRow({
            turnId: oldTurnId,
            state: "completed",
            requestedAt: STALE_SIGNAL_AT,
            startedAt: STALE_SIGNAL_AT,
            completedAt: "1970-01-01T00:00:01.000Z",
            lastProviderSignalAt: STALE_SIGNAL_AT,
            lastObservableProgressAt: STALE_SIGNAL_AT,
            lastSignalKind: "lifecycle",
          }),
        ],
      });

      yield* Effect.gen(function* () {
        const service = yield* McpOrchestrationService;
        const status = yield* service.getThreadTurnStatus({ threadId: TARGET, turnId: oldTurnId });
        const exit = yield* Effect.exit(
          service.cancelStaleThreadTurn({
            threadId: TARGET,
            turnId: oldTurnId,
            ifNoProgressSince: status.cursor,
            force: true,
          }),
        );

        expectMcpErrorCode("cancelStaleThreadTurn", exit, "turn_not_active");
        expect(harness.dispatched).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.live("cancelStaleThreadTurn force records an override activity and targets active turn", () =>
  Effect.gen(function* () {
    const turnId = TurnId.make("turn-force");
    const harness = yield* makeHarness([managedRunningThread("turn-force")], undefined, {
      livenessRows: [
        livenessRow({
          turnId,
          lastProviderSignalAt: freshIso(),
          lastSignalKind: "reasoning",
        }),
      ],
    });

    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const status = yield* service.getThreadTurnStatus({ threadId: TARGET, turnId });
      const result = yield* service.cancelStaleThreadTurn({
        threadId: TARGET,
        turnId,
        ifNoProgressSince: status.cursor,
        force: true,
      });

      expect(result).toMatchObject({
        status: "interrupt_requested",
        threadId: TARGET,
        turnId,
        sequence: 2,
        forced: true,
      });
      expect(harness.dispatched[0]).toMatchObject({
        type: "thread.activity.append",
        activity: {
          tone: "error",
          kind: "thread.turn.stale-cancel.requested",
          summary: "Forced stale turn cancellation requested",
          turnId,
          payload: {
            turnId,
            ifNoProgressSince: status.cursor,
            forced: true,
          },
        },
      });
      expect(harness.dispatched[1]).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: TARGET,
        turnId,
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.live("interrupt_thread_turn dispatches against the current active provider turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([
      thread({
        id: TARGET,
        latestTurn: runningTurn("turn-latest"),
        session: {
          threadId: TARGET,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "auto-accept-edits",
          activeTurnId: TurnId.make("turn-active"),
          lastError: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    ]);
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = yield* service.interruptThreadTurn({ threadId: TARGET });

      expect(result).toMatchObject({
        status: "interrupt_requested",
        threadId: TARGET,
        sequence: 1,
      });
      expect(harness.dispatched).toHaveLength(1);
      expect(harness.dispatched[0]).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: TARGET,
        turnId: TurnId.make("turn-active"),
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.live("control tools reject targets outside the invocation ownership chain", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([
      thread({
        id: TARGET,
        createdVia: "mcp",
        createdByThreadId: ThreadId.make("thread-other-root"),
        latestTurn: runningTurn("turn-x"),
        activities: [
          {
            id: "evt-approval" as never,
            tone: "approval",
            kind: "approval.requested",
            summary: "approval requested",
            payload: { requestId: "req-approval", requestKind: "command" },
            turnId: TurnId.make("turn-x"),
            createdAt: "2026-01-01T00:00:00.500Z",
          },
          {
            id: "evt-user-input" as never,
            tone: "info",
            kind: "user-input.requested",
            summary: "input requested",
            payload: { requestId: "req-input", questions: [] },
            turnId: TurnId.make("turn-x"),
            createdAt: "2026-01-01T00:00:00.600Z",
          },
        ],
      }),
    ]);
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;

      const interruptExit = yield* Effect.exit(service.interruptThreadTurn({ threadId: TARGET }));
      expectForbiddenExit("interruptThreadTurn", interruptExit);

      const approvalExit = yield* Effect.exit(
        service.respondToApproval({
          threadId: TARGET,
          requestId: "req-approval" as never,
          decision: "accept",
        }),
      );
      expectForbiddenExit("respondToApproval", approvalExit);

      const userInputExit = yield* Effect.exit(
        service.respondToUserInput({
          threadId: TARGET,
          requestId: "req-input" as never,
          answers: { answer: "yes" },
        }),
      );
      expectForbiddenExit("respondToUserInput", userInputExit);
      expect(harness.dispatched).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.live("respond_to_approval dispatches decline and acceptForSession decisions", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([
      thread({
        id: TARGET,
        latestTurn: runningTurn("turn-x"),
        activities: [
          {
            id: "evt-req-decline" as never,
            tone: "approval",
            kind: "approval.requested",
            summary: "approval requested",
            payload: { requestId: "req-decline", requestKind: "command", detail: "rm tmp" },
            turnId: TurnId.make("turn-x"),
            createdAt: "2026-01-01T00:00:00.500Z",
          },
          {
            id: "evt-req-session" as never,
            tone: "approval",
            kind: "approval.requested",
            summary: "approval requested",
            payload: { requestId: "req-session", requestKind: "command", detail: "bun test" },
            turnId: TurnId.make("turn-x"),
            createdAt: "2026-01-01T00:00:00.600Z",
          },
        ],
      }),
    ]);
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;

      yield* service.respondToApproval({
        threadId: TARGET,
        requestId: "req-decline" as never,
        decision: "decline",
      });
      yield* service.respondToApproval({
        threadId: TARGET,
        requestId: "req-session" as never,
        decision: "acceptForSession",
      });

      expect(
        harness.dispatched
          .filter((command) => command.type === "thread.approval.respond")
          .map((command) =>
            command.type === "thread.approval.respond"
              ? { requestId: command.requestId, decision: command.decision }
              : null,
          ),
      ).toEqual([
        { requestId: "req-decline", decision: "decline" },
        { requestId: "req-session", decision: "acceptForSession" },
      ]);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.live("respond_to_user_input dispatches answers for an open request", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([
      thread({
        id: TARGET,
        latestTurn: runningTurn("turn-x"),
        activities: [
          {
            id: "evt-user-input" as never,
            tone: "info",
            kind: "user-input.requested",
            summary: "input requested",
            payload: {
              requestId: "req-input",
              questions: [
                {
                  id: "choice",
                  header: "Choice",
                  question: "Pick one",
                  options: [{ label: "Yes", description: "Continue" }],
                  multiSelect: false,
                },
              ],
            },
            turnId: TurnId.make("turn-x"),
            createdAt: "2026-01-01T00:00:00.500Z",
          },
        ],
      }),
    ]);
    yield* Effect.gen(function* () {
      const service = yield* McpOrchestrationService;
      const result = yield* service.respondToUserInput({
        threadId: TARGET,
        requestId: "req-input" as never,
        answers: { choice: "Yes" },
      });

      expect(result).toMatchObject({
        status: "user_input_recorded",
        threadId: TARGET,
        requestId: "req-input",
        sequence: 1,
      });
      expect(harness.dispatched).toHaveLength(1);
      expect(harness.dispatched[0]).toMatchObject({
        type: "thread.user-input.respond",
        threadId: TARGET,
        requestId: "req-input",
        answers: { choice: "Yes" },
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);
