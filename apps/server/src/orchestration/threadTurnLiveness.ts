import {
  type ProviderRuntimeEvent,
  type ThreadId,
  type ThreadTurnProviderSignalKind,
  type TurnId,
} from "@t3tools/contracts";
import * as NodeBuffer from "node:buffer";

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
}

export interface ThreadUpdateCursor {
  readonly sequence: number;
  readonly observedAt: string | null;
}

interface ThreadUpdateCursorV1 extends ThreadUpdateCursor {
  readonly v: 1;
}

export function encodeThreadUpdateCursor(input: ThreadUpdateCursor): string {
  return NodeBuffer.Buffer.from(
    JSON.stringify({ v: 1, ...input } satisfies ThreadUpdateCursorV1),
  ).toString("base64url");
}

export function decodeThreadUpdateCursor(input: string): ThreadUpdateCursor | null {
  try {
    const decoded = JSON.parse(
      NodeBuffer.Buffer.from(input, "base64url").toString("utf8"),
    ) as unknown;
    if (typeof decoded !== "object" || decoded === null) {
      return null;
    }
    const record = decoded as Record<string, unknown>;
    if (record.v !== 1) {
      return null;
    }
    if (!Number.isInteger(record.sequence) || (record.sequence as number) < 0) {
      return null;
    }
    if (record.observedAt !== null && typeof record.observedAt !== "string") {
      return null;
    }
    return {
      sequence: record.sequence as number,
      observedAt: record.observedAt,
    };
  } catch {
    return null;
  }
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
