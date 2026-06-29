import {
  type ProviderRuntimeEvent,
  type ThreadId,
  type ThreadTurnProviderSignalKind,
  type TurnId,
} from "@t3tools/contracts";

export const DEFAULT_STALE_AFTER_MS = 10 * 60_000;
export const CLAUDE_HIGH_REASONING_STALE_AFTER_MS = 20 * 60_000;
export const PROVIDER_SIGNAL_COALESCE_MS = 30_000;
export const DEFAULT_THREAD_UPDATE_WAIT_TIMEOUT_MS = 30_000;
export const MAX_THREAD_UPDATE_WAIT_TIMEOUT_MS = 120_000;

export type ThreadTurnLivenessState =
  | "pending_start"
  | "running"
  | "completed"
  | "interrupted"
  | "error"
  | "idle";

export type ThreadTurnStaleReason = "no_provider_signal" | "no_observable_progress" | "none";

export interface ThreadTurnProviderSignal {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly signalKind: ThreadTurnProviderSignalKind;
  readonly signaledAt: string;
  readonly bypassCoalescing?: boolean;
}

export function runtimeEventSignalKind(
  event: ProviderRuntimeEvent,
): ThreadTurnProviderSignalKind | null {
  if (event.turnId === undefined) {
    return null;
  }

  switch (event.type) {
    case "content.delta":
      switch (event.payload.streamKind) {
        case "assistant_text":
          return "assistant_text";
        case "reasoning_text":
        case "reasoning_summary_text":
          return "reasoning";
        default:
          return null;
      }
    case "task.started":
    case "task.progress":
    case "task.completed":
    case "turn.plan.updated":
    case "turn.proposed.delta":
    case "turn.proposed.completed":
    case "turn.diff.updated":
      return "task";
    case "item.started":
    case "item.updated":
    case "item.completed":
    case "tool.progress":
    case "tool.summary":
      return "tool";
    case "thread.token-usage.updated":
      return "token_usage";
    case "request.opened":
    case "request.resolved":
    case "user-input.requested":
    case "user-input.resolved":
      return "request";
    case "turn.started":
    case "turn.completed":
    case "turn.aborted":
    case "session.state.changed":
    case "session.exited":
    case "runtime.warning":
    case "runtime.error":
      return "lifecycle";
    default:
      return null;
  }
}

export function isTurnBoundaryRuntimeEvent(event: ProviderRuntimeEvent): boolean {
  switch (event.type) {
    case "turn.started":
    case "turn.completed":
    case "turn.aborted":
      return true;
    default:
      return false;
  }
}
