import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import { McpOrchestrationServiceLive } from "./Layers/McpOrchestrationService.ts";
import { McpOrchestrationService } from "./Services/McpOrchestrationService.ts";
import { CheckpointDiffQuery } from "../checkpointing/Services/CheckpointDiffQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadTurnStartBootstrapDispatcherLive } from "../orchestration/Services/ThreadTurnStartBootstrapDispatcher.ts";
import { ProjectionThreadMessageSearchRepository } from "../persistence/Services/ProjectionThreadMessageSearch.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../provider/providerMaintenance.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";

const CURRENT = ThreadId.make("thread-current");
const TARGET = ThreadId.make("thread-target");

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

// Minimal stand-in for a thread-aggregate domain event: the wait loop only reads
// `aggregateId` to filter, then re-reads the snapshot. Cast keeps the test focused.
const threadEvent = (threadId: ThreadId): OrchestrationEvent =>
  ({ aggregateId: threadId, type: "thread.activity-appended" }) as unknown as OrchestrationEvent;

type Harness = {
  readonly layer: Layer.Layer<
    McpOrchestrationService | McpInvocationContext.McpInvocationContext | FileSystem.FileSystem
  >;
  readonly setThread: (next: OrchestrationThread) => Effect.Effect<void>;
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
): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    const threadsRef = yield* Ref.make(
      new Map(initial.map((entry) => [String(entry.id), entry] as const)),
    );
    const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
    const dispatched: Array<OrchestrationCommand> = [];

    const setThread = (next: OrchestrationThread) =>
      Ref.update(threadsRef, (map) => new Map(map).set(String(next.id), next));
    const emit = (event: OrchestrationEvent) =>
      PubSub.publish(eventPubSub, event).pipe(Effect.asVoid);

    const unsupported = (operation: string) =>
      Effect.die(new Error(`${operation} unused`)) as never;

    const projectionQuery = ProjectionSnapshotQuery.of({
      getCommandReadModel: () => Effect.die("unused"),
      getSnapshot: () => Effect.die("unused"),
      getShellSnapshot: () => Effect.die("unused"),
      getArchivedShellSnapshot: () => Effect.die("unused"),
      getSnapshotSequence: () => Effect.die("unused"),
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
      searchThreadMessagesByProject: () => Effect.succeed([]),
    });

    const layer = McpOrchestrationServiceLive.pipe(
      Layer.provideMerge(ThreadTurnStartBootstrapDispatcherLive),
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

    return { layer, setThread, emit, dispatched };
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
