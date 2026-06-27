import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationCheckpointSummary,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  ProjectId,
  type ProjectScript,
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProvider,
  type ServerProviderModel,
  ApprovalRequestId,
  ThreadCreatedVia,
  ThreadId,
} from "@t3tools/contracts";
import { buildProjectCreateCommand, resolveAddProjectPath } from "@t3tools/shared/addProject";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isModelEnabledForMcp } from "@t3tools/shared/mcpModels";
import { getProviderOptionCurrentLabel, getProviderOptionDescriptors } from "@t3tools/shared/model";
import {
  canThreadCreateChild,
  getThreadTreeDepth,
  MAX_THREAD_TREE_DEPTH,
} from "@t3tools/shared/threadTree";
import {
  createProjectScript,
  removeProjectScript,
  upsertProjectScript,
} from "@t3tools/shared/projectScripts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  type RankedSearchResult,
} from "@t3tools/shared/searchRanking";
import { normalizeProjectPathForComparison } from "@t3tools/shared/projectPaths";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { randomUUID } from "node:crypto";

import * as McpInvocationContext from "../McpInvocationContext.ts";
import { CheckpointDiffQuery } from "../../checkpointing/Services/CheckpointDiffQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadTurnStartBootstrapDispatcher } from "../../orchestration/Services/ThreadTurnStartBootstrapDispatcher.ts";
import {
  resolveCurrentSessionModelSelectionForCompatibility,
  validateProviderSessionModelSelectionCompatibility,
} from "../../orchestration/providerSessionCompatibility.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { sanitizeThreadTitle } from "../../textGeneration/TextGenerationUtils.ts";
import {
  McpOrchestrationError,
  McpOrchestrationService,
  type GetThreadDiffInput,
  type GetThreadDiffResult,
  type PendingRequest,
  type ProjectActionSummary,
  type ThreadDiffFileSummary,
} from "../Services/McpOrchestrationService.ts";

const MCP_STRUCTURED_RESPONSE_MAX_BYTES = 1_000_000;
/**
 * Summary mode sends transcript text to a model instead of returning encoded JSON.
 * Keep its input cap aligned with the complete-history response ceiling so summary
 * mode cannot process more transcript text than complete mode can return at once.
 */
const MCP_THREAD_SUMMARY_INPUT_MAX_CHARACTERS = MCP_STRUCTURED_RESPONSE_MAX_BYTES;
const MCP_THREAD_SUMMARY_OMITTED_MARKER = "[earlier messages omitted]";
// Upper bound on MCP ownership creator-chain traversal. The chain is acyclic in valid
// data (a creator always predates its creation) and the visited set already guarantees
// termination; this cap additionally bounds the work and denies pathologically deep chains.
const MAX_MCP_CREATOR_CHAIN_DEPTH = 64;
// Lower bound on a per-turn timeout. Below this, a watcher would race the turn's own
// dispatch latency and risk cancelling work that never had a chance to start. Callers
// pass milliseconds; values at/below zero disable the knob (treated as omitted).
const MIN_PER_TURN_TIMEOUT_MS = 1;
// Fallback wait ceiling for wait_for_response when neither timeout_ms nor turn_timeout_ms
// is supplied — wait must always be bounded so the MCP call cannot hang indefinitely.
const DEFAULT_WAIT_FOR_RESPONSE_TIMEOUT_MS = 120_000;
const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);

const requireRead = Effect.fn("McpOrchestrationService.requireRead")(function* () {
  return yield* McpInvocationContext.requireMcpOrchestrationRead().pipe(
    Effect.mapError(
      (error) =>
        new McpOrchestrationError({
          code: "forbidden",
          message: error.message,
        }),
    ),
  );
});

function parseHistoryCursor(
  cursor: string | undefined,
): Effect.Effect<number, McpOrchestrationError> {
  if (cursor === undefined) {
    return Effect.succeed(0);
  }

  const parsed = Number.parseInt(cursor, 10);
  if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed.toString() === cursor) {
    return Effect.succeed(parsed);
  }

  return Effect.fail(
    new McpOrchestrationError({
      code: "invalid_cursor",
      message: `Cursor '${cursor}' is invalid. Expected a non-negative integer.`,
    }),
  );
}

function applyHistoryWindow(
  thread: OrchestrationThread,
  input: {
    readonly limit?: number | undefined;
    readonly cursor?: string | undefined;
  },
): Effect.Effect<OrchestrationThread, McpOrchestrationError> {
  return Effect.gen(function* () {
    const start = yield* parseHistoryCursor(input.cursor);
    const end = input.limit !== undefined ? start + input.limit : undefined;

    if (start === 0 && end === undefined) {
      return thread;
    }

    return {
      ...thread,
      messages: thread.messages.slice(start, end),
    };
  });
}

// `messages` arrives ordered by (createdAt ASC, messageId ASC) from the projection
// query, so the LAST matching entry is the most recent message for a turn/role. A turn
// may emit several assistant messages (text -> tool -> text); per Decision 9 we return
// the turn's *last* assistant message — that is the final answer, with reasoning/tool
// calls already excluded at ingestion (only `assistant_text` deltas become message text).
function lastMessageOfTurn(
  thread: OrchestrationThread,
  turnId: string,
  role: OrchestrationMessage["role"],
): OrchestrationMessage | null {
  let found: OrchestrationMessage | null = null;
  for (const message of thread.messages) {
    if (message.turnId === turnId && message.role === role) {
      found = message;
    }
  }
  return found;
}

function firstMessageOfTurn(
  thread: OrchestrationThread,
  turnId: string,
  role: OrchestrationMessage["role"],
): OrchestrationMessage | null {
  for (const message of thread.messages) {
    if (message.turnId === turnId && message.role === role) {
      return message;
    }
  }
  return null;
}

// Checkpoints are recorded only when a turn completes and arrive ordered by
// checkpointTurnCount ASC, so the last checkpoint is the latest completed turn.
function latestCompletedCheckpoint(
  thread: OrchestrationThread,
): OrchestrationCheckpointSummary | null {
  return thread.checkpoints.length > 0 ? thread.checkpoints[thread.checkpoints.length - 1]! : null;
}

function activityRequestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : null;
}

function activityDetailLower(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const detail = (payload as Record<string, unknown>).detail;
  return typeof detail === "string" ? detail.toLowerCase() : null;
}

// Mirrors the server-side stale-request handling that
// `derivePendingUserInputCountFromActivities` / the pending-approval projection use:
// a failed respond whose detail says the request was already gone closes the request.
function isStaleApprovalFailure(detail: string | null): boolean {
  return (
    detail !== null &&
    (detail.includes("stale pending approval request") ||
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request"))
  );
}

function isStaleUserInputFailure(detail: string | null): boolean {
  return (
    detail !== null &&
    (detail.includes("stale pending user-input request") ||
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request"))
  );
}

type PendingUserInputFields = Extract<PendingRequest, { kind: "user-input" }>["fields"];

function userInputFieldsFromPayload(payload: unknown): PendingUserInputFields {
  const questions =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).questions
      : undefined;
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions.flatMap((question) => {
    if (typeof question !== "object" || question === null) {
      return [];
    }
    const record = question as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    if (id === null) {
      return [];
    }
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          if (typeof option !== "object" || option === null) {
            return [];
          }
          const optionRecord = option as Record<string, unknown>;
          const label = typeof optionRecord.label === "string" ? optionRecord.label : null;
          if (label === null) {
            return [];
          }
          return [
            {
              label,
              ...(typeof optionRecord.description === "string"
                ? { description: optionRecord.description }
                : {}),
            },
          ];
        })
      : undefined;
    return [
      {
        id,
        ...(typeof record.header === "string" ? { header: record.header } : {}),
        ...(typeof record.question === "string" ? { question: record.question } : {}),
        ...(options ? { options } : {}),
        ...(typeof record.multiSelect === "boolean" ? { multiSelect: record.multiSelect } : {}),
      },
    ];
  });
}

// Derive the set of currently-open requests directly from the thread's activities at
// read time. A `*.requested` activity opens a request; a later matching `*.resolved`
// (or a stale-request respond failure) closes it. This unifies approval and user-input
// tracking in a single ordered pass and matches the authoritative server-side accounting
// (ProjectionPipeline: pending-approval projection + derivePendingUserInputCountFromActivities).
// `detail` is already bounded by `truncateDetail` at ingestion, so no further capping here.
function derivePendingRequestsFromActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<PendingRequest> {
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );

  // Insertion-ordered map keyed by requestId so the output preserves request order.
  const open = new Map<string, PendingRequest>();

  for (const activity of ordered) {
    const requestId = activityRequestId(activity.payload);
    if (requestId === null) {
      continue;
    }
    const payload = activity.payload as Record<string, unknown>;
    const detail = activityDetailLower(activity.payload);

    switch (activity.kind) {
      case "approval.requested": {
        open.set(requestId, {
          kind: "approval",
          requestId,
          ...(payload.requestKind === "command" ||
          payload.requestKind === "file-read" ||
          payload.requestKind === "file-change"
            ? { requestKind: payload.requestKind }
            : {}),
          ...(typeof payload.requestType === "string" ? { requestType: payload.requestType } : {}),
          ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}),
        });
        break;
      }
      case "approval.resolved": {
        open.delete(requestId);
        break;
      }
      case "user-input.requested": {
        open.set(requestId, {
          kind: "user-input",
          requestId,
          ...(typeof payload.prompt === "string" ? { prompt: payload.prompt } : {}),
          fields: userInputFieldsFromPayload(activity.payload),
        });
        break;
      }
      case "user-input.resolved": {
        open.delete(requestId);
        break;
      }
      case "provider.approval.respond.failed": {
        if (isStaleApprovalFailure(detail)) {
          open.delete(requestId);
        }
        break;
      }
      case "provider.user-input.respond.failed": {
        if (isStaleUserInputFailure(detail)) {
          open.delete(requestId);
        }
        break;
      }
      default:
        break;
    }
  }

  return [...open.values()];
}

function serializeMessage(message: OrchestrationMessage) {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    turnId: message.turnId,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

type LatestResponseExtraction = {
  readonly inProgress: boolean;
  readonly turnId: string | null;
  readonly turnState: "completed" | null;
  readonly completedAt: string | null;
  readonly answer: ReturnType<typeof serializeMessage> | null;
};

// A newly-dispatched turn that has reached a terminal state: the ACTUAL terminal state
// plus the final-answer extraction (which only resolves text for completed turns).
type TurnTerminalObservation = {
  readonly state: "completed" | "interrupted" | "error";
  readonly extraction: LatestResponseExtraction;
};

// Inline `wait` fragment returned on send_thread_message / create_thread when
// wait_for_response is set. `state` is the terminal turn state (or "running" on wait
// timeout); `answer` is the verbatim final assistant message (maxCharacters-bounded) or
// null for error/interrupted/edits-only/timed-out turns.
type WaitResult = {
  readonly threadId: ThreadId;
  readonly state: string;
  readonly turnId: string | null;
  readonly answer: ReturnType<typeof serializeMessage> | null;
  readonly truncated?: true;
  readonly truncatedNote?: string;
  readonly timedOut?: true;
};

// Shared extraction of a thread's latest completed-turn final answer, used by both
// `get_thread_messages` mode=latest_response and the `wait_for_response` send paths
// (Decision 9/10, DRY per AGENTS.md). The text is already the clean answer: only
// `assistant_text` deltas become message text, so reasoning/tool calls are excluded by
// construction at ingestion. A turn that is currently running surfaces the *previous*
// completed answer with `inProgress: true`.
function extractLatestResponse(thread: OrchestrationThread): LatestResponseExtraction {
  const inProgress = thread.latestTurn?.state === "running";
  // The latest completed turn: prefer latestTurn when it has settled as completed, else
  // the last checkpoint (checkpoints exist only for completed turns). This also covers
  // the in-progress case, where latestTurn is the running turn and the checkpoint is the
  // prior completed one.
  const completedTurn =
    thread.latestTurn !== null && thread.latestTurn.state === "completed"
      ? {
          turnId: thread.latestTurn.turnId,
          completedAt: thread.latestTurn.completedAt,
          assistantMessageId: thread.latestTurn.assistantMessageId,
        }
      : (() => {
          const checkpoint = latestCompletedCheckpoint(thread);
          return checkpoint === null
            ? null
            : {
                turnId: checkpoint.turnId,
                completedAt: checkpoint.completedAt,
                assistantMessageId: checkpoint.assistantMessageId,
              };
        })();

  if (completedTurn === null) {
    return {
      inProgress,
      turnId: null,
      turnState: null,
      completedAt: null,
      answer: null,
    };
  }

  // Resolve the turn's final assistant message: the last assistant message tagged with
  // the turn id, falling back to the turn's recorded assistantMessageId when
  // message<->turn tags are absent.
  const assistantMessage =
    lastMessageOfTurn(thread, completedTurn.turnId, "assistant") ??
    (completedTurn.assistantMessageId === null
      ? null
      : (thread.messages.find((message) => message.id === completedTurn.assistantMessageId) ??
        null));

  return {
    inProgress,
    turnId: completedTurn.turnId,
    turnState: "completed",
    completedAt: completedTurn.completedAt,
    answer: assistantMessage === null ? null : serializeMessage(assistantMessage),
  };
}

function toInternalError(message: string, detail?: unknown): McpOrchestrationError {
  return new McpOrchestrationError({
    code: "internal_error",
    message,
    ...(detail !== undefined
      ? {
          detail: detail instanceof Error ? detail.message : String(detail),
        }
      : {}),
  });
}

function toNotFoundError(message: string): McpOrchestrationError {
  return new McpOrchestrationError({
    code: "not_found",
    message,
  });
}

function invalidProjectPath(message: string): McpOrchestrationError {
  return new McpOrchestrationError({
    code: "invalid_project_path",
    message,
  });
}

const requireExistingMcpProjectDirectory = Effect.fn(
  "McpOrchestrationService.requireExistingMcpProjectDirectory",
)(function* (fileSystem: FileSystem.FileSystem, path: string) {
  const stats = yield* fileSystem
    .stat(path)
    .pipe(
      Effect.mapError(() =>
        invalidProjectPath(
          `Project path '${path}' must already exist for MCP add_project; MCP cannot create directories.`,
        ),
      ),
    );
  if (stats.type !== "Directory") {
    return yield* invalidProjectPath(`Project path '${path}' must be an existing directory.`);
  }
});

function modelOptionDescriptors(
  model: ServerProviderModel,
): ReadonlyArray<ProviderOptionDescriptor> {
  return model.capabilities?.optionDescriptors ?? [];
}

type ThreadSummaryMessage = {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt: string;
};

function applyThreadSummaryInputBudget(
  messages: ReadonlyArray<ThreadSummaryMessage>,
): ReadonlyArray<ThreadSummaryMessage> {
  const totalCharacters = messages.reduce((sum, message) => sum + message.text.length, 0);
  if (totalCharacters <= MCP_THREAD_SUMMARY_INPUT_MAX_CHARACTERS) {
    return messages;
  }

  const retainedReversed: Array<ThreadSummaryMessage> = [];
  let remaining =
    MCP_THREAD_SUMMARY_INPUT_MAX_CHARACTERS - MCP_THREAD_SUMMARY_OMITTED_MARKER.length;

  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = messages[index]!;
    if (message.text.length <= remaining) {
      retainedReversed.push(message);
      remaining -= message.text.length;
      continue;
    }

    retainedReversed.push({
      ...message,
      text: message.text.slice(message.text.length - remaining),
    });
    remaining = 0;
  }

  const retained = retainedReversed.toReversed();
  return [
    {
      role: "system",
      text: MCP_THREAD_SUMMARY_OMITTED_MARKER,
      createdAt: retained[0]?.createdAt ?? messages[0]?.createdAt ?? "",
    },
    ...retained,
  ];
}

function isThreadIdleReady(thread: {
  readonly latestTurn?: { readonly state?: string | null } | null;
  readonly session?: {
    readonly activeTurnId?: string | null;
    readonly status?: string | null;
  } | null;
}): boolean {
  const latestRunning = thread.latestTurn?.state === "running";
  const hasActiveTurn =
    thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined;
  const sessionStatus = thread.session?.status ?? "idle";
  const sessionReady =
    thread.session === null || sessionStatus === "idle" || sessionStatus === "ready";
  return !latestRunning && !hasActiveTurn && sessionReady;
}

function makeCommandId(tag: string): CommandId {
  return CommandId.make(`mcp:${tag}:${randomUUID()}`);
}

function makeThreadId(): ThreadId {
  return ThreadId.make(`thread-${randomUUID()}`);
}

function makeProjectId(): ProjectId {
  return ProjectId.make(`project-${randomUUID()}`);
}

function makeMessageId(): MessageId {
  return MessageId.make(`message-${randomUUID()}`);
}

function randomHex(byteLength: number): string {
  return randomUUID()
    .replaceAll("-", "")
    .slice(0, byteLength * 2);
}

function providerDisplayName(provider: ServerProvider): string {
  return provider.displayName ?? PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
}

const explicitUndefined = <T>(value: T | undefined): T | undefined => value;

function hasProvidedKey<T extends object>(input: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function sanitizeProjectSelector(project: {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}) {
  return {
    id: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
  };
}

function sanitizeProjectAction(script: ProjectScript): ProjectActionSummary {
  return {
    id: script.id,
    name: script.name,
    icon: script.icon,
    runOnWorktreeCreate: script.runOnWorktreeCreate,
    ...(script.previewUrl ? { previewUrl: script.previewUrl } : {}),
    ...(script.autoOpenPreview ? { autoOpenPreview: script.autoOpenPreview } : {}),
  };
}

function sanitizeThreadSelector(thread: {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly parentThreadId: ThreadId | null;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly latestUserMessageAt: string | null;
  readonly latestTurn: unknown;
  readonly session: unknown;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
}) {
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    title: thread.title,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    threadDepth: getThreadTreeDepth(thread),
    maxThreadDepth: MAX_THREAD_TREE_DEPTH,
    canCreateChildThread: canThreadCreateChild(thread),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    latestUserMessageAt: thread.latestUserMessageAt,
    latestTurn: thread.latestTurn,
    session: thread.session,
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
  };
}

function repositorySummary(
  repositoryIdentity:
    | {
        readonly displayName?: string | undefined;
        readonly provider?: string | undefined;
        readonly owner?: string | undefined;
        readonly name?: string | undefined;
      }
    | null
    | undefined,
) {
  if (!repositoryIdentity) return null;
  const summary = {
    ...(repositoryIdentity.displayName ? { displayName: repositoryIdentity.displayName } : {}),
    ...(repositoryIdentity.provider ? { provider: repositoryIdentity.provider } : {}),
    ...(repositoryIdentity.owner ? { owner: repositoryIdentity.owner } : {}),
    ...(repositoryIdentity.name ? { name: repositoryIdentity.name } : {}),
  };
  return Object.keys(summary).length === 0 ? null : summary;
}

function validateProjectActionPreview(input: {
  readonly previewUrl?: string | null | undefined;
  readonly autoOpenPreview?: boolean | undefined;
  readonly resultingPreviewUrl?: string | undefined;
}): Effect.Effect<void, McpOrchestrationError> {
  const providedPreviewUrl =
    typeof input.previewUrl === "string" ? input.previewUrl.trim() : input.previewUrl;
  if (typeof input.previewUrl === "string" && input.previewUrl.trim().length === 0) {
    return Effect.fail(
      new McpOrchestrationError({
        code: "project_action_invalid_preview",
        message: "previewUrl must be non-empty after trimming.",
      }),
    );
  }
  if (input.autoOpenPreview === true && !providedPreviewUrl && !input.resultingPreviewUrl) {
    return Effect.fail(
      new McpOrchestrationError({
        code: "project_action_invalid_preview",
        message: "autoOpenPreview requires a previewUrl.",
      }),
    );
  }
  return Effect.void;
}

function trimProjectActionName(name: string): Effect.Effect<string, McpOrchestrationError> {
  const trimmed = name.trim();
  if (trimmed.length > 0) {
    return Effect.succeed(trimmed);
  }

  return Effect.fail(
    new McpOrchestrationError({
      code: "project_action_invalid_name",
      message: "Project Action name must be non-empty after trimming.",
    }),
  );
}

function trimProjectActionCommand(command: string): Effect.Effect<string, McpOrchestrationError> {
  const trimmed = command.trim();
  if (trimmed.length > 0) {
    return Effect.succeed(trimmed);
  }

  return Effect.fail(
    new McpOrchestrationError({
      code: "project_action_invalid_command",
      message: "Project Action command must be non-empty after trimming.",
    }),
  );
}

function trimSettingsTitle(input: {
  readonly title: string;
  readonly code: string;
  readonly subject: "Project" | "Thread";
}): Effect.Effect<string, McpOrchestrationError> {
  const trimmed = input.title.trim();
  if (trimmed.length > 0) {
    return Effect.succeed(trimmed);
  }

  return Effect.fail(
    new McpOrchestrationError({
      code: input.code,
      message: `${input.subject} title must be non-empty after trimming.`,
    }),
  );
}

function searchTerms(query: string | undefined): ReadonlyArray<string> {
  const normalized = normalizeSearchQuery(query ?? "");
  if (!normalized) {
    return [];
  }
  return normalized.split(/\s+/).filter((term) => term.length > 0);
}

function scoreTermsAgainstValues(
  terms: ReadonlyArray<string>,
  values: ReadonlyArray<string>,
): number | null {
  if (terms.length === 0) {
    return 0;
  }

  let total = 0;
  for (const term of terms) {
    let bestScore: number | null = null;
    for (const value of values) {
      const score = scoreQueryMatch({
        value: normalizeSearchQuery(value),
        query: term,
        exactBase: 0,
        prefixBase: 10,
        boundaryBase: 20,
        includesBase: 35,
        fuzzyBase: 60,
      });
      if (score === null) continue;
      if (bestScore === null || score < bestScore) {
        bestScore = score;
      }
    }

    if (bestScore === null) {
      return null;
    }
    total += bestScore;
  }

  return total;
}

export const McpOrchestrationServiceLive = Layer.effect(
  McpOrchestrationService,
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const bootstrapDispatcher = yield* ThreadTurnStartBootstrapDispatcher;
    const providerRegistry = yield* ProviderRegistry;
    const providerService = yield* ProviderService;
    const serverSettings = yield* ServerSettingsService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const checkpointDiffQuery = yield* CheckpointDiffQuery;
    const textGeneration = yield* TextGeneration;
    const fileSystem = yield* FileSystem.FileSystem;

    const currentIsoTimestamp = () =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => DateTime.formatIso(DateTime.makeUnsafe(now))),
      );

    // Service-lifetime scope for forked per-turn timeout watchers (Decision 3/8). A
    // watcher must outlive the MCP request that armed it (the request returns immediately
    // after dispatching the turn) yet must not leak: each watcher is self-limiting — it
    // sleeps its timeout, re-checks the condition against current projection state ONCE,
    // conditionally dispatches an interrupt, then exits. Tying it to this scope (closed
    // when the MCP service layer is torn down on shutdown) bounds its lifetime without
    // requiring turn-completion bookkeeping to interrupt it. Mirrors the watcher-scope
    // pattern in serverSettings.ts / keybindings.ts.
    const turnTimeoutWatcherScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(turnTimeoutWatcherScope, Exit.void));

    // Non-failing snapshot read used by wait/watcher loops: a transient projection read
    // error must not crash a watcher (which would then never dispatch) nor the wait loop.
    // Treats read failure and a missing thread identically as "no detail available".
    const readThreadDetailOption = (
      threadId: ThreadId,
    ): Effect.Effect<Option.Option<OrchestrationThread>, never> =>
      projectionSnapshotQuery
        .getThreadDetailById(threadId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none<OrchestrationThread>())));

    // True while the thread's latest turn is the *new* turn and still running. Used by the
    // turn_timeout watcher to confirm there is still live work to cancel.
    const isNewTurnRunning = (thread: OrchestrationThread, priorTurnId: string | null): boolean => {
      const turn = thread.latestTurn;
      return turn !== null && turn.state === "running" && turn.turnId !== priorTurnId;
    };

    const dispatchTurnInterrupt = (threadId: ThreadId, tag: string) =>
      Effect.gen(function* () {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: makeCommandId(tag),
            threadId,
            createdAt: yield* currentIsoTimestamp(),
          })
          .pipe(Effect.ignoreCause({ log: true }));
      });

    // Block until the thread's newly-dispatched turn reaches a terminal state, or until
    // `timeoutMs` elapses (Decision 10). Returns the terminal answer extraction, or null on
    // timeout (caller reports state: "running", answer: null and does NOT cancel the turn).
    // Mechanism: subscribe to the engine's hot domain-event stream FIRST, then probe the
    // current snapshot (covers a turn that already settled), then fold over events for this
    // thread re-reading the snapshot each time. The projection is committed before an event
    // is published, so a snapshot read on any event for the thread reflects that event.
    const waitForTurnTerminal = (input: {
      readonly threadId: ThreadId;
      readonly priorTurnId: string | null;
      readonly timeoutMs: number;
    }): Effect.Effect<TurnTerminalObservation | null, never> => {
      // The new turn's terminal observation, carrying the ACTUAL terminal state
      // (completed/interrupted/error) plus the answer extraction, or null if not yet
      // terminal. The actual state matters: error/interrupted turns must report their real
      // state, not the "completed" the answer-extraction would default to.
      const observeTerminal = (thread: OrchestrationThread): TurnTerminalObservation | null => {
        const turn = thread.latestTurn;
        if (turn === null || turn.turnId === input.priorTurnId) {
          return null;
        }
        if (turn.state !== "completed" && turn.state !== "interrupted" && turn.state !== "error") {
          return null;
        }
        return { state: turn.state, extraction: extractLatestResponse(thread) };
      };

      // Probe the current snapshot for a terminal observation of the new turn, or null.
      const probe: Effect.Effect<TurnTerminalObservation | null, never> = readThreadDetailOption(
        input.threadId,
      ).pipe(
        Effect.map((option): TurnTerminalObservation | null =>
          Option.match(option, { onNone: () => null, onSome: observeTerminal }),
        ),
      );

      return Effect.gen(function* () {
        const settle: Effect.Effect<TurnTerminalObservation | null, never, never> =
          orchestrationEngine.streamDomainEvents.pipe(
            // Re-read on EVERY event for this thread (aggregateId carries the ThreadId for
            // thread events); the terminal turn state is derived in the projection from
            // session-set events, so we check derived state rather than guess the event type.
            Stream.filter((event) => event.aggregateId === input.threadId),
            Stream.mapEffect(() => probe),
            // Keep the first event whose snapshot shows the new turn terminal.
            Stream.filter(
              (observation): observation is TurnTerminalObservation => observation !== null,
            ),
            Stream.runHead,
            Effect.map((head): TurnTerminalObservation | null => Option.getOrNull(head)),
            // streamDomainEvents has no failure channel in practice; defend the loop anyway.
            Effect.catch(() => Effect.succeed<TurnTerminalObservation | null>(null)),
          );

        const initial = yield* probe;
        if (initial !== null) {
          return initial;
        }

        // Race the settle stream against the wait timeout. On timeout the stream fiber is
        // interrupted (it only holds a PubSub subscription) and we return null. We do NOT
        // cancel the turn here — that is the distinct turn_timeout_ms/response_timeout_ms
        // behavior. A second probe right before giving up closes the gap where the turn
        // settled between the initial probe and the timeout firing.
        const raced = yield* Effect.race(
          settle,
          Effect.sleep(Duration.millis(input.timeoutMs)).pipe(
            Effect.as<TurnTerminalObservation | null>(null),
          ),
        );
        if (raced !== null) {
          return raced;
        }
        return yield* probe;
      });
    };

    // Arm a self-limiting watcher that cancels the turn if it is still running after
    // `turnTimeoutMs` (Decision 8). Forked into the service-lifetime scope so it survives
    // the MCP request return; it sleeps once, re-checks, conditionally interrupts, exits.
    const armTurnTimeoutWatcher = (input: {
      readonly threadId: ThreadId;
      readonly priorTurnId: string | null;
      readonly turnTimeoutMs: number;
    }) =>
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(input.turnTimeoutMs));
        const option = yield* readThreadDetailOption(input.threadId);
        if (Option.isNone(option)) {
          return;
        }
        // Only cancel if the *new* turn is still running; if it already completed (or a
        // newer turn replaced it), do nothing — never cancel unrelated work.
        if (isNewTurnRunning(option.value, input.priorTurnId)) {
          yield* dispatchTurnInterrupt(input.threadId, "thread-turn-timeout-interrupt");
        }
      }).pipe(
        Effect.ignoreCause({ log: true }),
        Effect.forkIn(turnTimeoutWatcherScope),
        Effect.asVoid,
      );

    // Arm a self-limiting watcher that cancels the turn if it is STILL blocked on the same
    // pending request after `responseTimeoutMs` (Decision 3). It cancels — never approves.
    // "Blocked on a pending request" is derived from the thread's activities exactly as
    // get_thread_settings derives pendingRequests. Forked into the service-lifetime scope.
    const armResponseTimeoutWatcher = (input: {
      readonly threadId: ThreadId;
      readonly priorTurnId: string | null;
      readonly responseTimeoutMs: number;
    }) =>
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(input.responseTimeoutMs));
        const option = yield* readThreadDetailOption(input.threadId);
        if (Option.isNone(option)) {
          return;
        }
        const thread = option.value;
        // Cancel only when the new turn is still running AND still has an open request.
        // If the request was answered (or the turn finished) within the window, do nothing.
        const stillRunning = isNewTurnRunning(thread, input.priorTurnId);
        const stillBlocked = derivePendingRequestsFromActivities(thread.activities).length > 0;
        if (stillRunning && stillBlocked) {
          yield* dispatchTurnInterrupt(input.threadId, "thread-response-timeout-interrupt");
        }
      }).pipe(
        Effect.ignoreCause({ log: true }),
        Effect.forkIn(turnTimeoutWatcherScope),
        Effect.asVoid,
      );

    // Normalize a caller-supplied timeout: undefined/<=0 means the knob is OFF.
    const normalizeTimeoutMs = (value: number | undefined): number | null =>
      value !== undefined && value >= MIN_PER_TURN_TIMEOUT_MS ? value : null;

    // Build the inline `wait` result fragment from a terminal observation, applying the
    // `maxCharacters` answer-text bound (mirrors get_thread_messages truncation semantics).
    // `error`/`interrupted`/edits-only turns carry their real state and a null answer.
    const buildWaitResult = (input: {
      readonly threadId: ThreadId;
      readonly observation: TurnTerminalObservation;
      readonly maxCharacters: number | undefined;
    }): WaitResult => {
      const answer = input.observation.extraction.answer;
      const text = answer?.text ?? null;
      const maxChars = input.maxCharacters;
      const truncated =
        text !== null && maxChars !== undefined && maxChars >= 0 && text.length > maxChars;
      const boundedAnswer =
        answer === null
          ? null
          : {
              ...answer,
              ...(truncated ? { text: text!.slice(0, maxChars) } : {}),
            };
      return {
        threadId: input.threadId,
        // The ACTUAL terminal turn state — "completed" only for completed turns; an
        // error/interrupted turn reports "error"/"interrupted" with a null answer.
        state: input.observation.state,
        turnId: input.observation.extraction.turnId,
        answer: boundedAnswer,
        ...(truncated
          ? {
              truncated: true as const,
              truncatedNote:
                "Answer text was truncated to maxCharacters. Use get_thread_messages mode=latest_response (or mode=message) for the full text.",
            }
          : {}),
      };
    };

    // Shared post-dispatch control loop for the per-turn options on send_thread_message and
    // create_thread (Decisions 3, 8, 10). It (1) arms the auto-cancel watchers when
    // turn_timeout_ms / response_timeout_ms are set, then (2) optionally blocks for
    // wait_for_response. The three compose: watchers can cancel the turn while the wait
    // blocks; whichever terminal/timeout condition fires first wins. Returns the `wait`
    // fragment (or undefined when wait_for_response is off) to merge into the tool response.
    const applyTurnControlOptions = (input: {
      readonly threadId: ThreadId;
      readonly priorTurnId: string | null;
      readonly options: {
        readonly turnTimeoutMs?: number | undefined;
        readonly responseTimeoutMs?: number | undefined;
        readonly waitForResponse?: boolean | undefined;
        readonly waitTimeoutMs?: number | undefined;
        readonly maxCharacters?: number | undefined;
      };
    }): Effect.Effect<WaitResult | undefined, never> =>
      Effect.gen(function* () {
        const turnTimeoutMs = normalizeTimeoutMs(input.options.turnTimeoutMs);
        const responseTimeoutMs = normalizeTimeoutMs(input.options.responseTimeoutMs);
        if (turnTimeoutMs !== null) {
          yield* armTurnTimeoutWatcher({
            threadId: input.threadId,
            priorTurnId: input.priorTurnId,
            turnTimeoutMs,
          });
        }
        if (responseTimeoutMs !== null) {
          yield* armResponseTimeoutWatcher({
            threadId: input.threadId,
            priorTurnId: input.priorTurnId,
            responseTimeoutMs,
          });
        }

        if (input.options.waitForResponse !== true) {
          return undefined;
        }

        const waitTimeoutMs = normalizeTimeoutMs(input.options.waitTimeoutMs);
        // wait_for_response requires a bound so the MCP call cannot hang indefinitely. When
        // timeout_ms is omitted, fall back to turn_timeout_ms if set, else a conservative
        // default ceiling, so the call always returns.
        const effectiveWaitMs =
          waitTimeoutMs ?? turnTimeoutMs ?? DEFAULT_WAIT_FOR_RESPONSE_TIMEOUT_MS;
        const terminal = yield* waitForTurnTerminal({
          threadId: input.threadId,
          priorTurnId: input.priorTurnId,
          timeoutMs: effectiveWaitMs,
        });
        if (terminal === null) {
          // Wait timed out: stop waiting, leave the turn running, return null answer. This
          // is distinct from turn_timeout_ms/response_timeout_ms, which CANCEL the turn.
          return {
            threadId: input.threadId,
            state: "running",
            turnId: null,
            answer: null,
            timedOut: true as const,
          };
        }
        return buildWaitResult({
          threadId: input.threadId,
          observation: terminal,
          maxCharacters: input.options.maxCharacters,
        });
      });

    const requireWrite = () =>
      McpInvocationContext.requireMcpOrchestrationWrite().pipe(
        Effect.mapError(
          (error) =>
            new McpOrchestrationError({
              code: "forbidden",
              message: error.message,
            }),
        ),
      );

    const requireProject = Effect.fn("McpOrchestrationService.requireProject")(function* (
      projectId: ProjectId,
    ) {
      const project = yield* projectionSnapshotQuery
        .getProjectShellById(projectId)
        .pipe(
          Effect.mapError((error) =>
            toInternalError("Failed to read orchestration project.", error),
          ),
        );
      return yield* Option.match(project, {
        onNone: () =>
          Effect.fail(
            new McpOrchestrationError({
              code: "unknown_project",
              message: `Project '${projectId}' does not exist.`,
            }),
          ),
        onSome: Effect.succeed,
      });
    });

    const requireThreadDetail = Effect.fn("McpOrchestrationService.requireThreadDetail")(function* (
      threadId: ThreadId,
    ) {
      const thread = yield* projectionSnapshotQuery
        .getThreadDetailById(threadId)
        .pipe(
          Effect.mapError((error) =>
            toInternalError("Failed to read orchestration thread.", error),
          ),
        );
      return yield* Option.match(thread, {
        onNone: () =>
          Effect.fail(
            new McpOrchestrationError({
              code: "unknown_thread",
              message: `Thread '${threadId}' does not exist.`,
            }),
          ),
        onSome: (value) =>
          value.deletedAt === null
            ? Effect.succeed(value)
            : Effect.fail(
                new McpOrchestrationError({
                  code: "unknown_thread",
                  message: `Thread '${threadId}' does not exist.`,
                }),
              ),
      });
    });

    // MCP management authorization: a credential may manage its own credential thread
    // and any thread inside its MCP creation-subtree (threads it spawned, transitively).
    // User-created threads — and threads owned by a different orchestrator — are never
    // MCP-manageable. Returns the thread on success; fails with a diagnosable `forbidden`.
    const requireThreadManageableByMcp = Effect.fn(
      "McpOrchestrationService.requireThreadManageableByMcp",
    )(function* (thread: {
      readonly id: ThreadId;
      readonly createdVia?: ThreadCreatedVia | undefined;
      readonly createdByThreadId?: ThreadId | null | undefined;
    }) {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      // The orchestrator may always act on its own credential thread, even though that
      // thread is itself user-created (a human started the orchestrator).
      if (thread.id === invocation.threadId) {
        return thread;
      }
      // Firewall: only MCP-created threads are ever MCP-manageable.
      if (thread.createdVia !== "mcp") {
        return yield* new McpOrchestrationError({
          code: "forbidden",
          message: `forbidden: Thread '${thread.id}' was created outside MCP and can only be managed by the user, not via MCP.`,
        });
      }
      // Ownership: the credential thread must appear in the target's creator chain.
      // Traverse `createdByThreadId` via a provenance-only lookup (no active/archive
      // filter) so an archived or deleted intermediate ancestor does not strand an
      // otherwise-owned descendant. The visited set guarantees termination; the depth
      // cap bounds the work and denies pathologically deep chains.
      const visited = new Set<string>();
      let cursor: ThreadId | null = thread.createdByThreadId ?? null;
      let depth = 0;
      while (cursor !== null && !visited.has(cursor)) {
        if (cursor === invocation.threadId) {
          return thread;
        }
        if (depth >= MAX_MCP_CREATOR_CHAIN_DEPTH) {
          return yield* new McpOrchestrationError({
            code: "forbidden",
            message: `forbidden: Thread '${thread.id}' ownership could not be resolved within ${MAX_MCP_CREATOR_CHAIN_DEPTH} creator-chain hops.`,
          });
        }
        visited.add(cursor);
        depth += 1;
        const ancestor = yield* projectionSnapshotQuery
          .getThreadCreatorById(cursor)
          .pipe(
            Effect.mapError((error) =>
              toInternalError("Failed to resolve thread ownership.", error),
            ),
          );
        if (Option.isNone(ancestor)) {
          break;
        }
        cursor = ancestor.value.createdByThreadId ?? null;
      }
      return yield* new McpOrchestrationError({
        code: "forbidden",
        message: `forbidden: Thread '${thread.id}' is not within your MCP creation-subtree and cannot be managed via MCP.`,
      });
    });

    // Resolve a thread's provenance regardless of archived/deleted state and verify it is
    // MCP-manageable by this credential. Used by cleanup ops that can target archived
    // threads (which the active-only thread lookups do not return).
    const requireThreadOwnershipByMcp = Effect.fn(
      "McpOrchestrationService.requireThreadOwnershipByMcp",
    )(function* (threadId: ThreadId) {
      const provenance = yield* projectionSnapshotQuery
        .getThreadCreatorById(threadId)
        .pipe(
          Effect.mapError((error) => toInternalError("Failed to resolve thread ownership.", error)),
        );
      if (Option.isNone(provenance)) {
        return yield* new McpOrchestrationError({
          code: "unknown_thread",
          message: `Thread '${threadId}' does not exist.`,
        });
      }
      yield* requireThreadManageableByMcp({
        id: threadId,
        createdVia: provenance.value.createdVia,
        createdByThreadId: provenance.value.createdByThreadId,
      });
    });

    const requireIdleThread = Effect.fn("McpOrchestrationService.requireIdleThread")(function* (
      threadId: ThreadId,
    ) {
      const thread = yield* requireThreadDetail(threadId);
      if (!isThreadIdleReady(thread)) {
        return yield* new McpOrchestrationError({
          code: "non_idle_thread",
          message: `non_idle_thread: Thread '${threadId}' is not idle and cannot accept MCP write actions.`,
        });
      }
      return thread;
    });

    const rejectArchivedThread = (thread: {
      readonly id: ThreadId;
      readonly archivedAt: string | null;
    }) =>
      thread.archivedAt === null
        ? Effect.void
        : Effect.fail(
            new McpOrchestrationError({
              code: "thread_archived",
              message: `Tool did not execute because thread '${thread.id}' is archived.`,
            }),
          );

    const requireWritableThread = Effect.fn("McpOrchestrationService.requireWritableThread")(
      function* (threadId: ThreadId) {
        const thread = yield* requireIdleThread(threadId);
        yield* rejectArchivedThread(thread);
        return thread;
      },
    );

    const requireCurrentThread = Effect.fn("McpOrchestrationService.requireCurrentThread")(
      function* () {
        const invocation = yield* McpInvocationContext.McpInvocationContext;
        return yield* projectionSnapshotQuery.getThreadDetailById(invocation.threadId).pipe(
          Effect.mapError((error) => toInternalError("Failed to read the current thread.", error)),
          Effect.flatMap((option) =>
            Option.match(option, {
              onNone: () => Effect.fail(toNotFoundError("Current MCP thread was not found.")),
              onSome: Effect.succeed,
            }),
          ),
        );
      },
    );

    const requireProjectForInput = Effect.fn("McpOrchestrationService.requireProjectForInput")(
      function* (input: { readonly projectId?: ProjectId | undefined }) {
        if (input.projectId !== undefined) {
          return yield* requireProject(input.projectId);
        }
        const thread = yield* requireCurrentThread();
        return yield* requireProject(thread.projectId);
      },
    );

    const loadProvidersAndSettings = () =>
      Effect.all({
        providers: providerRegistry.getProviders.pipe(
          Effect.mapError((error) =>
            toInternalError("Failed to load provider registry snapshots.", error),
          ),
        ),
        settings: serverSettings.getSettings.pipe(
          Effect.mapError((error) => toInternalError("Failed to load server settings.", error)),
        ),
      });

    const validateCreateThreadCheckout = (
      input: {
        readonly checkoutMode: "current_checkout" | "new_worktree" | undefined;
        readonly branch: string | null | undefined;
        readonly worktreePath: string | null | undefined;
        readonly baseBranch: string | undefined;
      },
      hasMessage: boolean,
    ) =>
      Effect.gen(function* () {
        if (input.worktreePath !== undefined) {
          return yield* new McpOrchestrationError({
            code: "invalid_checkout_fields",
            message:
              "create_thread does not accept worktreePath. Worktree paths are produced by first-turn bootstrap.",
          });
        }
        if (
          (input.branch !== undefined || input.baseBranch !== undefined) &&
          input.checkoutMode !== "new_worktree"
        ) {
          return yield* new McpOrchestrationError({
            code: "checkout_mode_required",
            message: "branch and baseBranch require checkoutMode 'new_worktree'.",
          });
        }
        if (!hasMessage && input.baseBranch !== undefined) {
          return yield* new McpOrchestrationError({
            code: "base_branch_without_first_turn_worktree",
            message: "baseBranch is only valid when a first message prepares a new worktree.",
          });
        }
        if (hasMessage && input.checkoutMode === "new_worktree" && !input.baseBranch) {
          return yield* new McpOrchestrationError({
            code: "missing_base_branch",
            message: "baseBranch is required when the first turn prepares a new worktree.",
          });
        }
      });

    const validateSendThreadMessageCheckout = (input: {
      readonly thread: OrchestrationThread;
      readonly checkoutMode: "current_checkout" | "new_worktree" | undefined;
      readonly branch: string | null | undefined;
      readonly worktreePath: string | null | undefined;
      readonly baseBranch: string | undefined;
    }) =>
      Effect.gen(function* () {
        if (input.worktreePath !== undefined) {
          return yield* new McpOrchestrationError({
            code: "invalid_checkout_fields",
            message:
              "send_thread_message does not accept worktreePath. Worktree paths are produced by first-turn bootstrap.",
          });
        }
        if (
          (input.branch !== undefined || input.baseBranch !== undefined) &&
          input.checkoutMode !== "new_worktree"
        ) {
          return yield* new McpOrchestrationError({
            code: "checkout_mode_required",
            message: "branch and baseBranch require checkoutMode 'new_worktree'.",
          });
        }

        const hasBootstrapFields =
          input.checkoutMode !== undefined ||
          input.branch !== undefined ||
          input.baseBranch !== undefined ||
          input.worktreePath !== undefined;
        if (
          hasBootstrapFields &&
          (input.thread.messages.length > 0 || input.thread.worktreePath !== null)
        ) {
          return yield* new McpOrchestrationError({
            code: "checkout_bootstrap_not_allowed",
            message:
              "checkout bootstrap fields are only valid for the first message in an empty thread.",
          });
        }

        if (input.checkoutMode === "new_worktree" && input.baseBranch === undefined) {
          return yield* new McpOrchestrationError({
            code: "missing_base_branch",
            message: "baseBranch is required when the first turn prepares a new worktree.",
          });
        }
      });

    const mapOrchestrationProjectsReadError = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((error) =>
          toInternalError("Failed to read orchestration projects.", error),
        ),
      );

    const findExistingProjectByWorkspaceRoot = Effect.fn(
      "McpOrchestrationService.findExistingProjectByWorkspaceRoot",
    )(function* (workspaceRoot: string) {
      const existing = yield* mapOrchestrationProjectsReadError(
        projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(workspaceRoot),
      );
      if (Option.isSome(existing)) {
        return existing.value;
      }

      const normalizedWorkspaceRoot = normalizeProjectPathForComparison(workspaceRoot);
      const projects = yield* mapOrchestrationProjectsReadError(
        projectionSnapshotQuery.listProjectShells(),
      );
      return (
        projects.find(
          (project) =>
            normalizeProjectPathForComparison(project.workspaceRoot) === normalizedWorkspaceRoot,
        ) ?? null
      );
    });

    const validateOptionSelections = (input: {
      readonly model: ServerProviderModel;
      readonly selection: {
        readonly instanceId: ProviderInstanceId;
        readonly model: string;
        readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
      };
    }): Effect.Effect<void, McpOrchestrationError> =>
      Effect.gen(function* () {
        const descriptorById = new Map(
          modelOptionDescriptors(input.model).map(
            (descriptor) => [descriptor.id, descriptor] as const,
          ),
        );
        for (const option of input.selection.options ?? []) {
          const descriptor = descriptorById.get(option.id);
          if (!descriptor) {
            return yield* new McpOrchestrationError({
              code: "invalid_model_option",
              message: `invalid_model_option: Option '${option.id}' is not supported by model '${input.selection.model}' on '${input.selection.instanceId}'.`,
            });
          }
          if (descriptor.type === "boolean") {
            if (typeof option.value !== "boolean") {
              return yield* new McpOrchestrationError({
                code: "invalid_model_option",
                message: `invalid_model_option: Option '${option.id}' requires a boolean value for model '${input.selection.model}'.`,
              });
            }
            continue;
          }
          if (
            typeof option.value !== "string" ||
            !descriptor.options.some((candidate) => candidate.id === option.value)
          ) {
            return yield* new McpOrchestrationError({
              code: "invalid_model_option",
              message: `invalid_model_option: Option '${option.id}' value '${String(option.value)}' is invalid for model '${input.selection.model}'.`,
            });
          }
        }
      });

    const validateMcpModelSelection = (selection: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
    }) =>
      loadProvidersAndSettings().pipe(
        Effect.flatMap(({ providers, settings }) =>
          Effect.gen(function* () {
            const provider = providers.find(
              (candidate) => candidate.instanceId === selection.instanceId,
            );
            if (!provider || provider.enabled !== true || provider.installed === false) {
              return yield* new McpOrchestrationError({
                code: "unknown_provider_instance",
                message: `Provider instance '${selection.instanceId}' is not available.`,
              });
            }
            const model = provider.models.find((candidate) => candidate.slug === selection.model);
            if (!model) {
              return yield* new McpOrchestrationError({
                code: "unknown_model",
                message: `Model '${selection.model}' is not available on '${selection.instanceId}'.`,
              });
            }
            if (
              !isModelEnabledForMcp({
                mcpDisabledModelsByProvider: settings.mcpDisabledModelsByProvider,
                instanceId: selection.instanceId,
                model: selection.model,
              })
            ) {
              return yield* new McpOrchestrationError({
                code: "mcp_disabled_model",
                message: `mcp_disabled_model: Model '${selection.model}' is disabled for MCP on '${selection.instanceId}'.`,
              });
            }
            yield* validateOptionSelections({ model, selection });
            return {
              provider,
              model,
            };
          }),
        ),
      );

    const resolveMcpModelSelection = Effect.fn("McpOrchestrationService.resolveMcpModelSelection")(
      function* (selection: ModelSelection) {
        const { providers } = yield* loadProvidersAndSettings();
        const provider = providers.find(
          (candidate) => candidate.instanceId === selection.instanceId,
        );
        if (!provider) {
          return {
            resolved: null,
            warning: `Provider instance '${selection.instanceId}' is not available.`,
          };
        }
        const model = provider.models.find((candidate) => candidate.slug === selection.model);
        if (!model) {
          return {
            resolved: null,
            warning: `Model '${selection.model}' is not available on '${selection.instanceId}'.`,
          };
        }
        const hydratedDescriptors = getProviderOptionDescriptors({
          caps: model.capabilities ?? { optionDescriptors: [] },
          selections: selection.options,
        });
        return {
          resolved: {
            provider: {
              instanceId: provider.instanceId,
              driver: provider.driver,
              name: providerDisplayName(provider),
            },
            model: {
              slug: model.slug,
              name: model.name,
            },
            options: (selection.options ?? []).map((option) => {
              const descriptor = hydratedDescriptors.find(
                (candidate) => candidate.id === option.id,
              );
              return {
                id: option.id,
                value: option.value,
                label: descriptor?.label ?? option.id,
                ...(descriptor ? { valueLabel: getProviderOptionCurrentLabel(descriptor) } : {}),
              };
            }),
          },
        };
      },
    );

    const resolveParentThreadId = (input: {
      readonly placement?: "top_level" | "child_of_thread" | undefined;
      readonly explicitParentThreadId?: ThreadId | undefined;
    }): Effect.Effect<ThreadId | null, McpOrchestrationError> =>
      Effect.gen(function* () {
        const placement = input.placement ?? "top_level";
        switch (placement) {
          case "top_level":
            return null;
          case "child_of_thread":
            if (!input.explicitParentThreadId) {
              return yield* new McpOrchestrationError({
                code: "missing_parent_thread",
                message: "parentThreadId is required for child_of_thread placement.",
              });
            }
            return input.explicitParentThreadId;
        }
      });

    const validateParentThreadProject = Effect.fn(
      "McpOrchestrationService.validateParentThreadProject",
    )(function* (input: {
      readonly parentThreadId: ThreadId | null;
      readonly targetProjectId: ProjectId;
    }) {
      if (input.parentThreadId === null) {
        return null;
      }
      const parentThread = yield* requireThreadDetail(input.parentThreadId);
      yield* requireThreadManageableByMcp(parentThread);
      yield* rejectArchivedThread(parentThread);
      if (parentThread.projectId !== input.targetProjectId) {
        return yield* new McpOrchestrationError({
          code: "cross_project_parent",
          message: `cross_project_parent: Thread '${input.parentThreadId}' belongs to project '${parentThread.projectId}' and cannot parent a thread in project '${input.targetProjectId}'.`,
        });
      }
      if (!canThreadCreateChild(parentThread)) {
        return yield* new McpOrchestrationError({
          code: "max_thread_depth_exceeded",
          message: `max_thread_depth_exceeded: Thread '${input.parentThreadId}' is already at the maximum thread depth of ${MAX_THREAD_TREE_DEPTH}.`,
        });
      }
      return parentThread;
    });

    const validateSessionCompatibility = Effect.fn(
      "McpOrchestrationService.validateSessionCompatibility",
    )(function* (input: {
      readonly thread: OrchestrationThread;
      readonly desiredModelSelection: ModelSelection;
      readonly requestedModelSelection?: ModelSelection | undefined;
    }) {
      if (input.thread.session === null) {
        return;
      }
      const activeSession = yield* providerService
        .listSessions()
        .pipe(
          Effect.map((sessions) =>
            sessions.find((session) => session.threadId === input.thread.id),
          ),
        );
      const currentInstanceId =
        activeSession?.providerInstanceId ??
        input.thread.session.providerInstanceId ??
        input.thread.modelSelection.instanceId;
      const currentModelSelection = resolveCurrentSessionModelSelectionForCompatibility({
        threadModelSelection: input.thread.modelSelection,
        currentInstanceId,
        activeSessionModel: activeSession?.model,
      });
      const providers = yield* providerRegistry.getProviders.pipe(
        Effect.mapError((error) =>
          toInternalError("Failed to load provider registry snapshots.", error),
        ),
      );
      const currentProvider = providers.find(
        (candidate) => candidate.instanceId === currentInstanceId,
      );
      const desiredProvider = providers.find(
        (candidate) => candidate.instanceId === input.desiredModelSelection.instanceId,
      );
      if (!currentProvider) {
        return yield* new McpOrchestrationError({
          code: "unknown_provider_instance",
          message: `Provider instance '${currentInstanceId}' is not available.`,
        });
      }
      if (!desiredProvider) {
        return yield* new McpOrchestrationError({
          code: "unknown_provider_instance",
          message: `Provider instance '${input.desiredModelSelection.instanceId}' is not available.`,
        });
      }
      const compatibilityDetail = validateProviderSessionModelSelectionCompatibility({
        threadId: input.thread.id,
        hasStartedSession: true,
        currentModelSelection,
        requestedModelSelection: input.requestedModelSelection,
        currentIdentity: {
          instanceId: currentInstanceId,
          driverKind: currentProvider.driver,
          continuationKey: currentProvider.continuation?.groupKey,
          requiresNewThreadForModelChange: currentProvider.requiresNewThreadForModelChange,
        },
        desiredIdentity: {
          instanceId: input.desiredModelSelection.instanceId,
          driverKind: desiredProvider.driver,
          continuationKey: desiredProvider.continuation?.groupKey,
          requiresNewThreadForModelChange: desiredProvider.requiresNewThreadForModelChange,
        },
      });
      if (compatibilityDetail !== null) {
        return yield* new McpOrchestrationError({
          code: "incompatible_model_session_switch",
          message: `incompatible_model_session_switch: ${compatibilityDetail}`,
        });
      }
    });

    return McpOrchestrationService.of({
      listMcpModels: () =>
        requireRead().pipe(
          Effect.flatMap(() =>
            Effect.all([
              providerRegistry.getProviders.pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to load provider registry snapshots.", error),
                ),
              ),
              serverSettings.getSettings.pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to load server settings.", error),
                ),
              ),
            ]),
          ),
          Effect.map(([providers, settings]) => ({
            providers: Object.fromEntries(
              providers
                .filter((provider) => provider.enabled)
                .map((provider) => [
                  provider.instanceId,
                  {
                    instanceId: provider.instanceId,
                    driver: provider.driver,
                    name: providerDisplayName(provider),
                    models: Object.fromEntries(
                      provider.models
                        .filter((model) =>
                          isModelEnabledForMcp({
                            mcpDisabledModelsByProvider: settings.mcpDisabledModelsByProvider,
                            instanceId: provider.instanceId,
                            model: model.slug,
                          }),
                        )
                        .map((model) => [
                          model.slug,
                          {
                            slug: model.slug,
                            name: model.name,
                            isCustom: model.isCustom,
                            optionDescriptors: modelOptionDescriptors(model),
                          },
                        ]),
                    ),
                  },
                ]),
            ),
          })),
        ),
      listProjects: (input) =>
        requireRead().pipe(
          Effect.flatMap(() =>
            projectionSnapshotQuery
              .listProjectShells()
              .pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to read orchestration projects.", error),
                ),
              ),
          ),
          Effect.map((projects) => {
            const terms = searchTerms(input.search);
            if (terms.length === 0) {
              return {
                projects: projects.map(sanitizeProjectSelector),
              };
            }

            const ranked: Array<RankedSearchResult<ReturnType<typeof sanitizeProjectSelector>>> =
              [];

            for (const project of projects) {
              const score = scoreTermsAgainstValues(terms, [project.title, project.workspaceRoot]);
              if (score === null) continue;
              insertRankedSearchResult(
                ranked,
                {
                  item: sanitizeProjectSelector(project),
                  score,
                  tieBreaker: `${project.createdAt}:${project.id}`,
                },
                projects.length,
              );
            }

            return {
              projects: ranked.map((entry) => entry.item),
            };
          }),
        ),
      getProjectDetails: (input) =>
        requireRead().pipe(
          Effect.flatMap(() => requireProjectForInput(input)),
          Effect.map((project) => ({
            projectId: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            repositorySummary: repositorySummary(project.repositoryIdentity),
          })),
        ),
      getProjectSettings: (input) =>
        requireRead().pipe(
          Effect.flatMap(() => requireProjectForInput(input)),
          Effect.flatMap((project) =>
            project.defaultModelSelection === null
              ? Effect.succeed({
                  projectId: project.id,
                  title: project.title,
                  defaultModelSelection: null,
                  resolvedDefaultModel: null,
                  defaultModelResolutionWarning: explicitUndefined(undefined),
                })
              : resolveMcpModelSelection(project.defaultModelSelection).pipe(
                  Effect.map(({ resolved, warning }) => ({
                    projectId: project.id,
                    title: project.title,
                    defaultModelSelection: project.defaultModelSelection,
                    resolvedDefaultModel: resolved,
                    defaultModelResolutionWarning: explicitUndefined(warning),
                  })),
                ),
          ),
        ),
      listProjectActions: (input) =>
        requireRead().pipe(
          Effect.flatMap(() => requireProjectForInput(input)),
          Effect.map((project) => ({
            projectId: project.id,
            actions: project.scripts.map(sanitizeProjectAction),
          })),
        ),
      updateProjectSettings: (input) =>
        Effect.gen(function* () {
          yield* requireWrite();

          if (input.title === undefined && input.defaultModelSelection === undefined) {
            return yield* new McpOrchestrationError({
              code: "project_settings_empty_update",
              message: "Provide at least one project setting to update.",
            });
          }

          const project = yield* requireProject(input.projectId);
          if (input.defaultModelSelection !== undefined && input.defaultModelSelection !== null) {
            yield* validateMcpModelSelection(input.defaultModelSelection);
          }
          const nextTitle =
            input.title === undefined
              ? undefined
              : yield* trimSettingsTitle({
                  title: input.title,
                  code: "project_settings_invalid_title",
                  subject: "Project",
                });

          const accepted = yield* orchestrationEngine
            .dispatch({
              type: "project.meta.update",
              commandId: makeCommandId("project-meta-update"),
              projectId: project.id,
              ...(nextTitle !== undefined ? { title: nextTitle } : {}),
              ...(input.defaultModelSelection !== undefined
                ? { defaultModelSelection: input.defaultModelSelection }
                : {}),
            })
            .pipe(
              Effect.mapError((error) =>
                toInternalError("Failed to dispatch orchestration command.", error),
              ),
            );

          return {
            status: "updated" as const,
            projectId: project.id,
            sequence: accepted.sequence,
          };
        }),
      createProjectAction: (input) =>
        Effect.gen(function* () {
          yield* requireWrite();
          const project = yield* requireProject(input.projectId);
          const name = yield* trimProjectActionName(input.name);
          const command = yield* trimProjectActionCommand(input.command);
          yield* validateProjectActionPreview(input);

          const nextScript = createProjectScript({
            name,
            command,
            existingIds: project.scripts.map((script) => script.id),
            icon: input.icon,
            runOnWorktreeCreate: input.runOnWorktreeCreate,
            previewUrl: input.previewUrl,
            autoOpenPreview: input.autoOpenPreview,
          });
          const nextScripts = upsertProjectScript(project.scripts, nextScript).scripts;
          const accepted = yield* orchestrationEngine
            .dispatch({
              type: "project.meta.update",
              commandId: makeCommandId("project-action-create"),
              projectId: project.id,
              scripts: nextScripts,
            })
            .pipe(
              Effect.mapError((error) =>
                toInternalError("Failed to dispatch orchestration command.", error),
              ),
            );

          return {
            createdAction: sanitizeProjectAction(nextScript),
            actionsAfterChange: nextScripts.map(sanitizeProjectAction),
            sequence: accepted.sequence,
          };
        }),
      updateProjectAction: (input) =>
        Effect.gen(function* () {
          yield* requireWrite();
          if (
            input.name === undefined &&
            input.command === undefined &&
            input.icon === undefined &&
            input.runOnWorktreeCreate === undefined &&
            input.previewUrl === undefined &&
            input.autoOpenPreview === undefined
          ) {
            return yield* new McpOrchestrationError({
              code: "project_action_empty_update",
              message: "Provide at least one action field to update.",
            });
          }

          const project = yield* requireProject(input.projectId);
          const currentScript = project.scripts.find((script) => script.id === input.actionId);
          if (!currentScript) {
            return yield* new McpOrchestrationError({
              code: "project_action_not_found",
              message: `Action '${input.actionId}' does not exist in project '${project.id}'.`,
            });
          }

          const nextPreviewUrl =
            input.previewUrl === undefined
              ? currentScript.previewUrl
              : input.previewUrl === null
                ? undefined
                : input.previewUrl.trim() || undefined;
          const nextAutoOpenPreview =
            nextPreviewUrl === undefined
              ? false
              : (input.autoOpenPreview ?? currentScript.autoOpenPreview ?? false);

          yield* validateProjectActionPreview({
            previewUrl: input.previewUrl,
            autoOpenPreview: input.autoOpenPreview,
            resultingPreviewUrl: nextPreviewUrl,
          });

          const {
            previewUrl: _currentPreviewUrl,
            autoOpenPreview: _currentAutoOpenPreview,
            ...currentScriptBase
          } = currentScript;
          const nextName =
            input.name === undefined ? undefined : yield* trimProjectActionName(input.name);
          const nextCommand =
            input.command === undefined
              ? undefined
              : yield* trimProjectActionCommand(input.command);
          const nextScript: ProjectScript = {
            ...currentScriptBase,
            ...(nextName !== undefined ? { name: nextName } : {}),
            command: nextCommand ?? currentScript.command,
            icon: input.icon ?? currentScript.icon,
            runOnWorktreeCreate: input.runOnWorktreeCreate ?? currentScript.runOnWorktreeCreate,
            ...(nextPreviewUrl ? { previewUrl: nextPreviewUrl } : {}),
            ...(nextAutoOpenPreview ? { autoOpenPreview: true } : {}),
          };
          const nextScripts = upsertProjectScript(project.scripts, nextScript).scripts;
          const accepted = yield* orchestrationEngine
            .dispatch({
              type: "project.meta.update",
              commandId: makeCommandId("project-action-update"),
              projectId: project.id,
              scripts: nextScripts,
            })
            .pipe(
              Effect.mapError((error) =>
                toInternalError("Failed to dispatch orchestration command.", error),
              ),
            );

          return {
            updatedAction: sanitizeProjectAction(nextScript),
            actionsAfterChange: nextScripts.map(sanitizeProjectAction),
            sequence: accepted.sequence,
          };
        }),
      deleteProjectAction: (input) =>
        Effect.gen(function* () {
          yield* requireWrite();
          const project = yield* requireProject(input.projectId);
          const removed = removeProjectScript(project.scripts, input.actionId);
          if (!removed.removed) {
            return yield* new McpOrchestrationError({
              code: "project_action_not_found",
              message: `Action '${input.actionId}' does not exist in project '${project.id}'.`,
            });
          }

          const accepted = yield* orchestrationEngine
            .dispatch({
              type: "project.meta.update",
              commandId: makeCommandId("project-action-delete"),
              projectId: project.id,
              scripts: removed.scripts,
            })
            .pipe(
              Effect.mapError((error) =>
                toInternalError("Failed to dispatch orchestration command.", error),
              ),
            );

          return {
            deletedAction: sanitizeProjectAction(removed.script),
            actionsAfterChange: removed.scripts.map(sanitizeProjectAction),
            sequence: accepted.sequence,
          };
        }),
      listThreads: (input) =>
        requireRead().pipe(
          Effect.flatMap(() => {
            const archived = input.archived ?? "exclude";
            return projectionSnapshotQuery
              .listThreadShellsByProject({
                projectId: input.projectId,
                archived,
              })
              .pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to read orchestration threads.", error),
                ),
                Effect.flatMap((threads) => {
                  const terms = searchTerms(input.search);
                  if (terms.length === 0) {
                    return Effect.succeed({ threads: threads.map(sanitizeThreadSelector) });
                  }

                  const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));

                  return projectionSnapshotQuery
                    .searchThreadMessagesByProject({
                      projectId: input.projectId,
                      query: normalizeSearchQuery(input.search ?? ""),
                      archived,
                      limit: Math.max(threads.length, 1),
                    })
                    .pipe(
                      Effect.mapError((error) =>
                        toInternalError("Failed to search projected thread messages.", error),
                      ),
                      Effect.map((messageHits) => {
                        const rankedById = new Map<
                          string,
                          RankedSearchResult<(typeof threads)[number]>
                        >();

                        for (const thread of threads) {
                          const score = scoreTermsAgainstValues(terms, [thread.title]);
                          if (score === null) continue;
                          rankedById.set(thread.id, {
                            item: thread,
                            score,
                            tieBreaker: `${thread.createdAt}:${thread.id}`,
                          });
                        }

                        for (let index = 0; index < messageHits.length; index += 1) {
                          const hit = messageHits[index];
                          if (!hit) continue;
                          const thread = threadById.get(hit.threadId);
                          if (!thread) continue;

                          const candidate: RankedSearchResult<(typeof threads)[number]> = {
                            item: thread,
                            score: 500 + index,
                            tieBreaker: `${thread.createdAt}:${thread.id}`,
                          };
                          const existing = rankedById.get(thread.id);
                          if (!existing || candidate.score < existing.score) {
                            rankedById.set(thread.id, candidate);
                          }
                        }

                        const ranked = Array.from(rankedById.values());
                        ranked.sort((left, right) =>
                          left.score === right.score
                            ? left.tieBreaker.localeCompare(right.tieBreaker)
                            : left.score - right.score,
                        );

                        return {
                          threads: ranked.map((entry) => sanitizeThreadSelector(entry.item)),
                        };
                      }),
                    );
                }),
              );
          }),
        ),
      getThreadMessages: (input) =>
        requireRead().pipe(
          Effect.flatMap(() =>
            requireThreadDetail(input.threadId).pipe(
              Effect.flatMap(
                (thread): Effect.Effect<unknown, McpOrchestrationError> =>
                  Effect.gen(function* () {
                    // Shared maxCharacters -> payload_too_large guard (mirrors the
                    // complete-mode budget). A single message/turn is normally small, but
                    // an oversized assistant answer must not exceed one MCP response.
                    const guardPayloadSize = <P>(payload: P) =>
                      Effect.gen(function* () {
                        const encoded = yield* encodeJsonString(payload).pipe(
                          Effect.mapError((error) =>
                            toInternalError("Failed to encode MCP thread messages payload.", error),
                          ),
                        );
                        const budget = input.maxCharacters ?? MCP_STRUCTURED_RESPONSE_MAX_BYTES;
                        if (Buffer.byteLength(encoded, "utf8") > budget) {
                          return yield* new McpOrchestrationError({
                            code: "payload_too_large",
                            message: `Thread '${input.threadId}' messages payload is too large for one MCP response.`,
                            detail: "Retry with a different mode or a larger maxCharacters.",
                          });
                        }
                        return payload;
                      });

                    if (input.mode === "complete") {
                      const history = yield* applyHistoryWindow(thread, input);
                      const payload = {
                        mode: "complete" as const,
                        thread: history,
                      };
                      const encoded = yield* encodeJsonString(payload).pipe(
                        Effect.mapError((error) =>
                          toInternalError("Failed to encode MCP thread history payload.", error),
                        ),
                      );
                      const budget = input.maxCharacters ?? MCP_STRUCTURED_RESPONSE_MAX_BYTES;
                      if (Buffer.byteLength(encoded, "utf8") > budget) {
                        return yield* new McpOrchestrationError({
                          code: "payload_too_large",
                          message: `Thread '${input.threadId}' history is too large for one MCP response.`,
                          detail: "Retry with limit, cursor, or maxCharacters.",
                        });
                      }
                      return payload;
                    }

                    if (input.mode === "latest_response") {
                      const extracted = extractLatestResponse(thread);
                      return yield* guardPayloadSize({
                        mode: "latest_response" as const,
                        threadId: thread.id,
                        inProgress: extracted.inProgress,
                        turnId: extracted.turnId,
                        turnState: extracted.turnState,
                        completedAt: extracted.completedAt,
                        answer: extracted.answer,
                      });
                    }

                    if (input.mode === "turn") {
                      if (input.turnCount === undefined) {
                        return yield* new McpOrchestrationError({
                          code: "invalid_input",
                          message: "turn mode requires turnCount.",
                        });
                      }
                      // turnCount is the per-turn ordinal carried by checkpoints as
                      // checkpointTurnCount; resolve it to the turn id, then collect that
                      // turn's user message + final assistant response.
                      const checkpoint =
                        thread.checkpoints.find(
                          (entry) => entry.checkpointTurnCount === input.turnCount,
                        ) ?? null;
                      if (checkpoint === null) {
                        return yield* new McpOrchestrationError({
                          code: "unknown_turn",
                          message: `Thread '${input.threadId}' has no turn with turnCount ${input.turnCount}.`,
                        });
                      }
                      const isLatestTurn = thread.latestTurn?.turnId === checkpoint.turnId;
                      const turnState = isLatestTurn
                        ? (thread.latestTurn?.state ?? "completed")
                        : ("completed" as const);
                      const userMessage = firstMessageOfTurn(thread, checkpoint.turnId, "user");
                      const assistantMessage = lastMessageOfTurn(
                        thread,
                        checkpoint.turnId,
                        "assistant",
                      );

                      return yield* guardPayloadSize({
                        mode: "turn" as const,
                        threadId: thread.id,
                        turnCount: checkpoint.checkpointTurnCount,
                        turnId: checkpoint.turnId,
                        turnState,
                        completedAt: checkpoint.completedAt,
                        userMessage: userMessage === null ? null : serializeMessage(userMessage),
                        assistantMessage:
                          assistantMessage === null ? null : serializeMessage(assistantMessage),
                      });
                    }

                    if (input.mode === "message") {
                      if (input.messageId === undefined) {
                        return yield* new McpOrchestrationError({
                          code: "invalid_input",
                          message: "message mode requires messageId.",
                        });
                      }
                      const message =
                        thread.messages.find((entry) => entry.id === input.messageId) ?? null;
                      if (message === null) {
                        return yield* new McpOrchestrationError({
                          code: "unknown_message",
                          message: `Thread '${input.threadId}' has no message '${input.messageId}'.`,
                        });
                      }
                      return yield* guardPayloadSize({
                        mode: "message" as const,
                        threadId: thread.id,
                        message: serializeMessage(message),
                      });
                    }

                    const settings = yield* serverSettings.getSettings.pipe(
                      Effect.mapError((error) =>
                        toInternalError("Failed to load server settings.", error),
                      ),
                    );
                    const summary = yield* textGeneration
                      .generateThreadSummary({
                        threadTitle: thread.title,
                        messages: applyThreadSummaryInputBudget(
                          thread.messages.map((message) => ({
                            role: message.role,
                            text: message.text,
                            createdAt: message.createdAt,
                          })),
                        ),
                        maxOutputCharacters: 12_000,
                        modelSelection: settings.textGenerationModelSelection,
                      })
                      .pipe(
                        Effect.mapError((error) =>
                          toInternalError("Failed to generate thread history summary.", error),
                        ),
                      );
                    const now = yield* Clock.currentTimeMillis;

                    return {
                      mode: "summary" as const,
                      threadId: thread.id,
                      summary,
                      modelSelection: settings.textGenerationModelSelection,
                      generatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
                    };
                  }),
              ),
            ),
          ),
        ),
      getThreadDiff: (input: GetThreadDiffInput) =>
        requireRead().pipe(
          Effect.flatMap(
            (): Effect.Effect<GetThreadDiffResult, McpOrchestrationError> =>
              Effect.gen(function* () {
                // A range is either fully specified or fully omitted: a half-open range
                // (only one bound) is ambiguous, so reject it rather than guess the other.
                const hasFrom = input.fromTurnCount !== undefined;
                const hasTo = input.toTurnCount !== undefined;
                if (hasFrom !== hasTo) {
                  return yield* new McpOrchestrationError({
                    code: "invalid_input",
                    message:
                      "Provide both fromTurnCount and toTurnCount for a range, or omit both to diff the whole thread to its latest turn.",
                  });
                }
                if (
                  input.fromTurnCount !== undefined &&
                  input.toTurnCount !== undefined &&
                  input.fromTurnCount > input.toTurnCount
                ) {
                  return yield* new McpOrchestrationError({
                    code: "invalid_input",
                    message: "fromTurnCount must be less than or equal to toTurnCount.",
                  });
                }

                // Resolve checkpoint context for the thread: it carries each completed
                // turn's checkpointTurnCount and per-file change summary. This is the same
                // read the RPC diff path uses, and it lets us resolve "latest" server-side.
                const context = yield* projectionSnapshotQuery
                  .getThreadCheckpointContext(input.threadId)
                  .pipe(
                    Effect.mapError((error) =>
                      toInternalError("Failed to read thread checkpoint context.", error),
                    ),
                  );
                if (Option.isNone(context)) {
                  return yield* new McpOrchestrationError({
                    code: "unknown_thread",
                    message: `Thread '${input.threadId}' does not exist.`,
                  });
                }
                const checkpoints = context.value.checkpoints;
                // Checkpoints exist only for completed turns; the latest completed turn is
                // the maximum checkpointTurnCount (rows arrive ASC, so this is the last one).
                const latestTurnCount = checkpoints.reduce(
                  (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
                  0,
                );
                if (checkpoints.length === 0) {
                  return yield* new McpOrchestrationError({
                    code: "no_thread_checkpoints",
                    message: `Thread '${input.threadId}' has no completed turns to diff yet.`,
                  });
                }

                const ignoreWhitespace = input.ignoreWhitespace ?? true;
                // Omitted range => full diff from the first checkpoint (turn 0) to the
                // latest completed turn. Explicit range => turn-range diff.
                const fromTurnCount = input.fromTurnCount ?? 0;
                const toTurnCount = input.toTurnCount ?? latestTurnCount;

                const diffResult = yield* (
                  hasFrom
                    ? checkpointDiffQuery.getTurnDiff({
                        threadId: input.threadId,
                        fromTurnCount,
                        toTurnCount,
                        ignoreWhitespace,
                      })
                    : checkpointDiffQuery.getFullThreadDiff({
                        threadId: input.threadId,
                        toTurnCount,
                        ignoreWhitespace,
                      })
                ).pipe(
                  Effect.mapError((error) =>
                    toInternalError("Failed to compute thread diff.", error),
                  ),
                );

                // Triage summary from the destination turn's checkpoint files, so the agent
                // can see what changed even when the unified patch is truncated/omitted.
                const destinationCheckpoint =
                  checkpoints.find(
                    (checkpoint) => checkpoint.checkpointTurnCount === diffResult.toTurnCount,
                  ) ?? null;
                const files: ReadonlyArray<ThreadDiffFileSummary> =
                  destinationCheckpoint === null
                    ? []
                    : destinationCheckpoint.files.map((file) => ({
                        path: file.path,
                        kind: file.kind,
                        additions: file.additions,
                        deletions: file.deletions,
                      }));

                const payload: GetThreadDiffResult = {
                  threadId: diffResult.threadId,
                  fromTurnCount: diffResult.fromTurnCount,
                  toTurnCount: diffResult.toTurnCount,
                  diff: diffResult.diff,
                  files,
                };

                // Shared maxCharacters -> payload_too_large guard (mirrors get_thread_messages):
                // a large diff must not exceed one MCP response. The per-file summary still
                // tells the agent what changed, so it can re-request with a tighter range.
                const encoded = yield* encodeJsonString(payload).pipe(
                  Effect.mapError((error) =>
                    toInternalError("Failed to encode MCP thread diff payload.", error),
                  ),
                );
                const budget = input.maxCharacters ?? MCP_STRUCTURED_RESPONSE_MAX_BYTES;
                if (Buffer.byteLength(encoded, "utf8") > budget) {
                  return yield* new McpOrchestrationError({
                    code: "payload_too_large",
                    message: `Thread '${input.threadId}' diff is too large for one MCP response.`,
                    detail:
                      "Retry with a narrower turn range or a larger maxCharacters; the file summary lists what changed.",
                  });
                }
                return payload;
              }),
          ),
        ),
      getThreadSettings: (input) =>
        requireRead().pipe(
          Effect.flatMap(() =>
            Effect.gen(function* () {
              const invocation = yield* McpInvocationContext.McpInvocationContext;
              const targetThreadId = input.threadId ?? invocation.threadId;
              const thread = yield* requireThreadDetail(targetThreadId);
              const resolved = yield* resolveMcpModelSelection(thread.modelSelection);
              const pendingRequests = derivePendingRequestsFromActivities(thread.activities);
              const hasPendingApprovals = pendingRequests.some(
                (request) => request.kind === "approval",
              );
              const hasPendingUserInput = pendingRequests.some(
                (request) => request.kind === "user-input",
              );

              return {
                threadId: thread.id,
                projectId: thread.projectId,
                title: thread.title,
                parentThreadId: thread.parentThreadId,
                createdAt: thread.createdAt,
                updatedAt: thread.updatedAt,
                archivedAt: thread.archivedAt,
                modelSelection: thread.modelSelection,
                resolvedModel: resolved.resolved,
                ...(resolved.warning ? { modelResolutionWarning: resolved.warning } : {}),
                runtimeMode: thread.runtimeMode,
                interactionMode: thread.interactionMode,
                checkoutMode:
                  thread.branch !== null || thread.worktreePath !== null
                    ? "new_worktree"
                    : "current_checkout",
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                threadDepth: getThreadTreeDepth(thread),
                maxThreadDepth: MAX_THREAD_TREE_DEPTH,
                canCreateChildThread: canThreadCreateChild(thread),
                session: thread.session,
                hasPendingApprovals,
                hasPendingUserInput,
                pendingRequests,
              };
            }),
          ),
        ),
      addProject: (rawInput) =>
        Effect.gen(function* () {
          const input = rawInput as { readonly path: string };
          const invocation = yield* McpInvocationContext.McpInvocationContext;
          const currentThread = yield* requireThreadDetail(invocation.threadId);
          const currentProject = yield* requireProject(currentThread.projectId);
          const platform = yield* HostProcessPlatform;
          const resolved = resolveAddProjectPath({
            rawPath: input.path,
            currentProjectCwd: currentProject.workspaceRoot,
            platform,
          });
          if (!resolved.ok) {
            return yield* invalidProjectPath(resolved.error);
          }

          const existing = yield* findExistingProjectByWorkspaceRoot(resolved.path);
          if (existing !== null) {
            return {
              status: "already_exists" as const,
              project: sanitizeProjectSelector(existing),
            };
          }

          yield* requireExistingMcpProjectDirectory(fileSystem, resolved.path);

          const createdAt = yield* currentIsoTimestamp();
          const projectId = makeProjectId();
          const createCommand = buildProjectCreateCommand({
            commandId: makeCommandId("project-create"),
            projectId,
            workspaceRoot: resolved.path,
            createdAt,
            createWorkspaceRootIfMissing: false,
          });
          const accepted = yield* orchestrationEngine
            .dispatch(createCommand)
            .pipe(
              Effect.mapError((error) =>
                toInternalError("Failed to dispatch orchestration command.", error),
              ),
            );

          return {
            status: "created" as const,
            project: sanitizeProjectSelector({
              id: projectId,
              title: createCommand.title,
              workspaceRoot: createCommand.workspaceRoot,
            }),
            sequence: accepted.sequence,
          };
        }),
      createThread: (rawInput) =>
        Effect.gen(function* () {
          const input = rawInput as {
            readonly projectId?: ProjectId;
            readonly placement?: "top_level" | "child_of_thread";
            readonly parentThreadId?: ThreadId;
            readonly title?: string;
            readonly message?: string;
            readonly modelSelection?: ModelSelection;
            readonly runtimeMode?: RuntimeMode;
            readonly interactionMode?: "default" | "plan";
            readonly checkoutMode?: "current_checkout" | "new_worktree";
            readonly branch?: string | null;
            readonly worktreePath?: string | null;
            readonly baseBranch?: string;
            readonly responseTimeoutMs?: number;
            readonly turnTimeoutMs?: number;
            readonly waitForResponse?: boolean;
            readonly timeoutMs?: number;
            readonly maxCharacters?: number;
          };
          const invocation = yield* McpInvocationContext.McpInvocationContext;
          const currentThread = yield* requireThreadDetail(invocation.threadId);
          const targetProjectId = input.projectId ?? currentThread.projectId;
          const targetProject = yield* requireProject(targetProjectId);
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError((error) => toInternalError("Failed to load server settings.", error)),
          );
          const desiredModelSelection =
            input.modelSelection ??
            targetProject.defaultModelSelection ??
            currentThread.modelSelection ??
            settings.textGenerationModelSelection;
          yield* validateMcpModelSelection(desiredModelSelection);
          yield* validateCreateThreadCheckout(
            {
              checkoutMode: input.checkoutMode,
              branch: input.branch,
              worktreePath: input.worktreePath,
              baseBranch: input.baseBranch,
            },
            input.message !== undefined,
          );

          const parentThreadId = yield* resolveParentThreadId({
            placement: input.placement,
            explicitParentThreadId: input.parentThreadId,
          });
          const parentThread = yield* validateParentThreadProject({
            parentThreadId,
            targetProjectId,
          });

          // MCP-layer safe spawn default (Decision 4): when the caller omits runtimeMode,
          // a spawned thread runs sandboxed (`auto-accept-edits` = workspace-write sandbox,
          // escalations gated) rather than inheriting the orchestrator's mode (which could be
          // `full-access` = no sandbox). An explicit runtimeMode is always respected. Scoped to
          // this MCP create path only; the global DEFAULT_RUNTIME_MODE / human UI is unchanged.
          const desiredRuntimeMode = input.runtimeMode ?? "auto-accept-edits";
          const desiredInteractionMode = input.interactionMode ?? currentThread.interactionMode;
          const checkoutInheritanceThread = parentThread ?? currentThread;
          const isSameProjectTarget = targetProjectId === checkoutInheritanceThread.projectId;
          const hasExplicitCheckoutMetadata =
            (input.branch ?? undefined) !== undefined ||
            (input.worktreePath ?? undefined) !== undefined;
          // MCP-layer safe spawn default (Decision 4): when checkout is fully omitted, a
          // `top_level` spawn (no parent) defaults to an isolated `new_worktree`, while a
          // `child_of_thread` spawn keeps inheriting the parent's checkout. An explicit
          // checkoutMode or explicit branch/worktree metadata is always respected.
          const desiredCheckoutMode =
            input.checkoutMode ??
            (hasExplicitCheckoutMetadata
              ? "new_worktree"
              : parentThread === null
                ? "new_worktree"
                : isSameProjectTarget &&
                    (checkoutInheritanceThread.branch !== null ||
                      checkoutInheritanceThread.worktreePath !== null)
                  ? "new_worktree"
                  : "current_checkout");
          const hasDeferredEmptyNewWorktree =
            !input.message &&
            input.checkoutMode === "new_worktree" &&
            input.baseBranch === undefined;
          const shouldPrepareWorktree =
            input.message !== undefined &&
            (input.checkoutMode === "new_worktree" || input.baseBranch !== undefined);
          const bootstrapBranch = shouldPrepareWorktree
            ? (input.branch ?? buildTemporaryWorktreeBranchName(randomHex))
            : null;
          const desiredBranch =
            desiredCheckoutMode === "current_checkout"
              ? null
              : hasDeferredEmptyNewWorktree
                ? (input.branch ?? null)
                : shouldPrepareWorktree
                  ? bootstrapBranch
                  : (input.branch ??
                    (isSameProjectTarget ? checkoutInheritanceThread.branch : null) ??
                    null);
          const desiredWorktreePath =
            desiredCheckoutMode === "current_checkout"
              ? null
              : hasDeferredEmptyNewWorktree
                ? null
                : shouldPrepareWorktree
                  ? null
                  : (input.worktreePath ??
                    (isSameProjectTarget ? checkoutInheritanceThread.worktreePath : null) ??
                    null);
          const title = sanitizeThreadTitle(input.title ?? input.message ?? "New thread");
          const createdAt = yield* currentIsoTimestamp();
          const threadId = makeThreadId();
          const bootstrapBaseBranch = input.baseBranch;
          const createdThread = {
            id: threadId,
            projectId: targetProjectId,
            parentThreadId,
            title,
            modelSelection: desiredModelSelection,
            runtimeMode: desiredRuntimeMode,
            interactionMode: desiredInteractionMode,
            branch: desiredBranch,
            worktreePath: desiredWorktreePath,
            createdVia: "mcp" as const,
            createdByThreadId: invocation.threadId,
            createdAt,
            updatedAt: createdAt,
            archivedAt: null,
            latestTurn: null,
            session: null,
            latestUserMessageAt: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
          };

          if (!input.message) {
            const accepted = yield* orchestrationEngine
              .dispatch({
                type: "thread.create",
                commandId: makeCommandId("thread-create"),
                threadId,
                projectId: targetProjectId,
                parentThreadId,
                title,
                modelSelection: desiredModelSelection,
                runtimeMode: desiredRuntimeMode,
                interactionMode: desiredInteractionMode,
                branch: desiredBranch,
                worktreePath: desiredWorktreePath,
                createdVia: "mcp" as const,
                createdByThreadId: invocation.threadId,
                createdAt,
              })
              .pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to dispatch orchestration command.", error),
                ),
              );
            return {
              status: "created" as const,
              threadId,
              thread: createdThread,
              sequence: accepted.sequence,
            };
          }

          const messageId = makeMessageId();
          const accepted = yield* bootstrapDispatcher
            .dispatch({
              type: "thread.turn.start",
              commandId: makeCommandId("thread-create-turn-start"),
              threadId,
              message: {
                messageId,
                role: "user",
                text: input.message,
                attachments: [],
              },
              modelSelection: desiredModelSelection,
              ...(input.title === undefined ? { titleSeed: title } : {}),
              runtimeMode: desiredRuntimeMode,
              interactionMode: desiredInteractionMode,
              bootstrap: {
                createThread: {
                  projectId: targetProjectId,
                  parentThreadId,
                  title,
                  modelSelection: desiredModelSelection,
                  runtimeMode: desiredRuntimeMode,
                  interactionMode: desiredInteractionMode,
                  branch: desiredBranch,
                  worktreePath: desiredWorktreePath,
                  createdVia: "mcp" as const,
                  createdByThreadId: invocation.threadId,
                  createdAt,
                },
                ...(shouldPrepareWorktree
                  ? {
                      prepareWorktree: {
                        projectCwd: targetProject.workspaceRoot,
                        baseBranch: bootstrapBaseBranch!,
                        branch: bootstrapBranch!,
                      },
                      runSetupScript: true,
                    }
                  : {}),
              },
              createdAt,
            })
            .pipe(
              Effect.mapError((error) =>
                toInternalError("Failed to dispatch orchestration command.", error),
              ),
            );

          // Per-turn control options (Decisions 3, 8, 10) on the first turn of the new
          // thread. priorTurnId is null — the thread was just created, so any terminal
          // latest turn is the turn this call started. All knobs default OFF.
          const wait = yield* applyTurnControlOptions({
            threadId,
            priorTurnId: null,
            options: {
              responseTimeoutMs: input.responseTimeoutMs,
              turnTimeoutMs: input.turnTimeoutMs,
              waitForResponse: input.waitForResponse,
              waitTimeoutMs: input.timeoutMs,
              maxCharacters: input.maxCharacters,
            },
          });

          return {
            status: "accepted" as const,
            threadId,
            thread: accepted.createdThread ?? createdThread,
            messageId,
            sequence: accepted.sequence,
            ...(wait !== undefined ? { wait } : {}),
          };
        }),
      sendThreadMessage: (rawInput) =>
        Effect.gen(function* () {
          const input = rawInput as {
            readonly threadId: ThreadId;
            readonly message: string;
            readonly modelSelection?: ModelSelection;
            readonly checkoutMode?: "current_checkout" | "new_worktree";
            readonly branch?: string | null;
            readonly worktreePath?: string | null;
            readonly baseBranch?: string;
            readonly responseTimeoutMs?: number;
            readonly turnTimeoutMs?: number;
            readonly waitForResponse?: boolean;
            readonly timeoutMs?: number;
            readonly maxCharacters?: number;
          };
          const thread = yield* requireWritableThread(input.threadId);
          yield* requireThreadManageableByMcp(thread);
          // Capture the turn observed before dispatch so the wait/watchers act only on the
          // *new* turn this call starts. requireWritableThread already enforced idle, so
          // latestTurn is null or a prior terminal turn here.
          const priorTurnId = thread.latestTurn?.turnId ?? null;
          const desiredModelSelection = input.modelSelection ?? thread.modelSelection;
          yield* validateMcpModelSelection(desiredModelSelection);
          yield* validateSessionCompatibility({
            thread,
            desiredModelSelection,
            requestedModelSelection: input.modelSelection,
          });
          yield* validateSendThreadMessageCheckout({
            thread,
            checkoutMode: input.checkoutMode,
            branch: input.branch,
            worktreePath: input.worktreePath,
            baseBranch: input.baseBranch,
          });

          const messageId = makeMessageId();
          const createdAt = yield* currentIsoTimestamp();
          if (
            input.modelSelection !== undefined &&
            !Equal.equals(thread.modelSelection, desiredModelSelection)
          ) {
            yield* orchestrationEngine
              .dispatch({
                type: "thread.meta.update",
                commandId: makeCommandId("thread-meta-model"),
                threadId: input.threadId,
                modelSelection: desiredModelSelection,
              })
              .pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to dispatch orchestration command.", error),
                ),
              );
          }
          const accepted =
            input.checkoutMode === "new_worktree"
              ? yield* requireProject(thread.projectId).pipe(
                  Effect.flatMap((project) =>
                    bootstrapDispatcher.dispatch({
                      type: "thread.turn.start",
                      commandId: makeCommandId("thread-turn-start"),
                      threadId: input.threadId,
                      message: {
                        messageId,
                        role: "user",
                        text: input.message,
                        attachments: [],
                      },
                      modelSelection: desiredModelSelection,
                      runtimeMode: thread.runtimeMode,
                      interactionMode: thread.interactionMode,
                      bootstrap: {
                        prepareWorktree: {
                          projectCwd: project.workspaceRoot,
                          baseBranch: input.baseBranch!,
                          branch:
                            input.branch ??
                            thread.branch ??
                            buildTemporaryWorktreeBranchName(randomHex),
                        },
                        runSetupScript: true,
                      },
                      createdAt,
                    }),
                  ),
                  Effect.mapError((error) =>
                    toInternalError("Failed to dispatch orchestration command.", error),
                  ),
                )
              : yield* orchestrationEngine
                  .dispatch({
                    type: "thread.turn.start",
                    commandId: makeCommandId("thread-turn-start"),
                    threadId: input.threadId,
                    message: {
                      messageId,
                      role: "user",
                      text: input.message,
                      attachments: [],
                    },
                    modelSelection: desiredModelSelection,
                    runtimeMode: thread.runtimeMode,
                    interactionMode: thread.interactionMode,
                    createdAt,
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      toInternalError("Failed to dispatch orchestration command.", error),
                    ),
                  );

          // Per-turn control options (Decisions 3, 8, 10): arm auto-cancel watchers and/or
          // block for the answer. All default OFF, so an omitting caller gets the exact
          // prior fire-and-forget behavior (no `wait` field).
          const wait = yield* applyTurnControlOptions({
            threadId: input.threadId,
            priorTurnId,
            options: {
              responseTimeoutMs: input.responseTimeoutMs,
              turnTimeoutMs: input.turnTimeoutMs,
              waitForResponse: input.waitForResponse,
              waitTimeoutMs: input.timeoutMs,
              maxCharacters: input.maxCharacters,
            },
          });

          return {
            status: "accepted" as const,
            threadId: input.threadId,
            messageId,
            sequence: accepted.sequence,
            ...(wait !== undefined ? { wait } : {}),
          };
        }),
      updateThreadSettings: (rawInput) =>
        Effect.gen(function* () {
          const input = rawInput as {
            readonly threadId: ThreadId;
            readonly title?: string;
            readonly modelSelection?: ModelSelection;
            readonly runtimeMode?: RuntimeMode;
            readonly interactionMode?: "default" | "plan";
            readonly checkoutMode?: "current_checkout" | "new_worktree";
            readonly branch?: string | null;
            readonly worktreePath?: string | null;
          };
          const thread = yield* requireWritableThread(input.threadId);
          yield* requireThreadManageableByMcp(thread);
          const hasUpdate =
            input.title !== undefined ||
            input.modelSelection !== undefined ||
            input.runtimeMode !== undefined ||
            input.interactionMode !== undefined ||
            input.checkoutMode !== undefined ||
            hasProvidedKey(input, "branch") ||
            hasProvidedKey(input, "worktreePath");
          if (!hasUpdate) {
            return yield* new McpOrchestrationError({
              code: "thread_settings_empty_update",
              message: "At least one thread setting field is required.",
            });
          }
          const desiredModelSelection = input.modelSelection ?? thread.modelSelection;
          yield* validateMcpModelSelection(desiredModelSelection);
          yield* validateSessionCompatibility({
            thread,
            desiredModelSelection,
            requestedModelSelection: input.modelSelection,
          });

          const desiredTitle =
            input.title === undefined
              ? thread.title
              : yield* trimSettingsTitle({
                  title: input.title,
                  code: "thread_settings_invalid_title",
                  subject: "Thread",
                });
          const desiredRuntimeMode = input.runtimeMode ?? thread.runtimeMode;
          const hasBranchInput = hasProvidedKey(input, "branch");
          const hasWorktreePathInput = hasProvidedKey(input, "worktreePath");
          const desiredInteractionMode = input.interactionMode ?? thread.interactionMode;
          const desiredCheckoutMode =
            input.checkoutMode ??
            (hasBranchInput || hasWorktreePathInput
              ? "new_worktree"
              : thread.branch !== null || thread.worktreePath !== null
                ? "new_worktree"
                : "current_checkout");
          const desiredBranch = (() => {
            if (desiredCheckoutMode === "current_checkout") {
              return null;
            }
            if (hasBranchInput) {
              return input.branch ?? null;
            }
            return thread.branch ?? null;
          })();
          const desiredWorktreePath = (() => {
            if (desiredCheckoutMode === "current_checkout") {
              return null;
            }
            if (hasWorktreePathInput) {
              return input.worktreePath ?? null;
            }
            return thread.worktreePath ?? null;
          })();
          if (
            input.checkoutMode === "current_checkout" &&
            ((input.branch !== undefined && input.branch !== null) ||
              (input.worktreePath !== undefined && input.worktreePath !== null))
          ) {
            return yield* new McpOrchestrationError({
              code: "invalid_checkout_fields",
              message:
                "current_checkout rejects non-null branch and worktreePath values because it clears checkout metadata.",
            });
          }
          if (
            desiredCheckoutMode === "new_worktree" &&
            desiredWorktreePath === null &&
            thread.messages.length > 0
          ) {
            return yield* new McpOrchestrationError({
              code: "missing_worktree_path",
              message: "new_worktree thread settings require a resulting worktreePath.",
            });
          }

          let lastSequence = 0;
          if (thread.title !== desiredTitle) {
            lastSequence = (yield* orchestrationEngine
              .dispatch({
                type: "thread.meta.update",
                commandId: makeCommandId("thread-meta-title"),
                threadId: input.threadId,
                title: desiredTitle,
              })
              .pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to dispatch orchestration command.", error),
                ),
              )).sequence;
          }
          if (!Equal.equals(thread.modelSelection, desiredModelSelection)) {
            lastSequence = (yield* orchestrationEngine
              .dispatch({
                type: "thread.meta.update",
                commandId: makeCommandId("thread-meta-model"),
                threadId: input.threadId,
                modelSelection: desiredModelSelection,
              })
              .pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to dispatch orchestration command.", error),
                ),
              )).sequence;
          }
          if (thread.runtimeMode !== desiredRuntimeMode) {
            lastSequence = (yield* orchestrationEngine
              .dispatch({
                type: "thread.runtime-mode.set",
                commandId: makeCommandId("thread-runtime-mode"),
                threadId: input.threadId,
                runtimeMode: desiredRuntimeMode,
                createdAt: yield* currentIsoTimestamp(),
              })
              .pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to dispatch orchestration command.", error),
                ),
              )).sequence;
          }
          if (thread.interactionMode !== desiredInteractionMode) {
            lastSequence = (yield* orchestrationEngine
              .dispatch({
                type: "thread.interaction-mode.set",
                commandId: makeCommandId("thread-interaction-mode"),
                threadId: input.threadId,
                interactionMode: desiredInteractionMode,
                createdAt: yield* currentIsoTimestamp(),
              })
              .pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to dispatch orchestration command.", error),
                ),
              )).sequence;
          }
          if (thread.branch !== desiredBranch || thread.worktreePath !== desiredWorktreePath) {
            lastSequence = (yield* orchestrationEngine
              .dispatch({
                type: "thread.meta.update",
                commandId: makeCommandId("thread-meta-workspace"),
                threadId: input.threadId,
                branch: desiredBranch,
                worktreePath: desiredWorktreePath,
              })
              .pipe(
                Effect.mapError((error) =>
                  toInternalError("Failed to dispatch orchestration command.", error),
                ),
              )).sequence;
          }

          return {
            status: "updated" as const,
            threadId: input.threadId,
            sequence: lastSequence,
          };
        }),
      interruptThreadTurn: (rawInput) =>
        Effect.gen(function* () {
          const input = rawInput as { readonly threadId: ThreadId };
          // Control tools act on a running/blocked thread, so they are exempt from the
          // idle gate; they still require the thread to be MCP-manageable by this credential.
          const thread = yield* requireThreadDetail(input.threadId);
          yield* requireThreadManageableByMcp(thread);
          const accepted = yield* orchestrationEngine
            .dispatch({
              type: "thread.turn.interrupt",
              commandId: makeCommandId("thread-turn-interrupt"),
              threadId: input.threadId,
              createdAt: yield* currentIsoTimestamp(),
            })
            .pipe(
              Effect.mapError((error) =>
                toInternalError("Failed to dispatch orchestration command.", error),
              ),
            );
          return {
            status: "interrupt_requested" as const,
            threadId: input.threadId,
            sequence: accepted.sequence,
          };
        }),
      respondToApproval: (rawInput) =>
        Effect.gen(function* () {
          const input = rawInput as {
            readonly threadId: ThreadId;
            readonly requestId: ApprovalRequestId;
            readonly decision: "accept" | "decline" | "acceptForSession";
          };
          const thread = yield* requireThreadDetail(input.threadId);
          yield* requireThreadManageableByMcp(thread);
          const accepted = yield* orchestrationEngine
            .dispatch({
              type: "thread.approval.respond",
              commandId: makeCommandId("thread-approval-respond"),
              threadId: input.threadId,
              requestId: input.requestId,
              decision: input.decision,
              createdAt: yield* currentIsoTimestamp(),
            })
            .pipe(
              Effect.mapError((error) =>
                toInternalError("Failed to dispatch orchestration command.", error),
              ),
            );
          return {
            status: "approval_recorded" as const,
            threadId: input.threadId,
            requestId: input.requestId,
            sequence: accepted.sequence,
          };
        }),
      respondToUserInput: (rawInput) =>
        Effect.gen(function* () {
          const input = rawInput as {
            readonly threadId: ThreadId;
            readonly requestId: ApprovalRequestId;
            readonly answers: Record<string, unknown>;
          };
          const thread = yield* requireThreadDetail(input.threadId);
          yield* requireThreadManageableByMcp(thread);
          const accepted = yield* orchestrationEngine
            .dispatch({
              type: "thread.user-input.respond",
              commandId: makeCommandId("thread-user-input-respond"),
              threadId: input.threadId,
              requestId: input.requestId,
              answers: input.answers,
              createdAt: yield* currentIsoTimestamp(),
            })
            .pipe(
              Effect.mapError((error) =>
                toInternalError("Failed to dispatch orchestration command.", error),
              ),
            );
          return {
            status: "user_input_recorded" as const,
            threadId: input.threadId,
            requestId: input.requestId,
            sequence: accepted.sequence,
          };
        }),
      deleteThread: (rawInput) =>
        Effect.gen(function* () {
          const input = rawInput as { readonly threadId: ThreadId };
          yield* requireThreadOwnershipByMcp(input.threadId);
          const accepted = yield* orchestrationEngine
            .dispatch({
              type: "thread.delete",
              commandId: makeCommandId("thread-delete"),
              threadId: input.threadId,
            })
            .pipe(
              Effect.mapError((error) =>
                toInternalError("Failed to dispatch orchestration command.", error),
              ),
            );
          return {
            status: "deleted" as const,
            threadId: input.threadId,
            sequence: accepted.sequence,
          };
        }),
      archiveThread: (rawInput) =>
        Effect.gen(function* () {
          const input = rawInput as { readonly threadId: ThreadId };
          yield* requireThreadOwnershipByMcp(input.threadId);
          const accepted = yield* orchestrationEngine
            .dispatch({
              type: "thread.archive",
              commandId: makeCommandId("thread-archive"),
              threadId: input.threadId,
            })
            .pipe(
              Effect.mapError((error) =>
                toInternalError("Failed to dispatch orchestration command.", error),
              ),
            );
          return {
            status: "archived" as const,
            threadId: input.threadId,
            sequence: accepted.sequence,
          };
        }),
      unarchiveThread: (rawInput) =>
        Effect.gen(function* () {
          const input = rawInput as { readonly threadId: ThreadId };
          yield* requireThreadOwnershipByMcp(input.threadId);
          const accepted = yield* orchestrationEngine
            .dispatch({
              type: "thread.unarchive",
              commandId: makeCommandId("thread-unarchive"),
              threadId: input.threadId,
            })
            .pipe(
              Effect.mapError((error) =>
                toInternalError("Failed to dispatch orchestration command.", error),
              ),
            );
          return {
            status: "unarchived" as const,
            threadId: input.threadId,
            sequence: accepted.sequence,
          };
        }),
    });
  }),
);
