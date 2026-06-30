import type { ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PendingTurnRequest } from "../pendingRequests.ts";
import type { ThreadTurnLivenessState, ThreadTurnStaleReason } from "../threadTurnLiveness.ts";

export class ThreadTurnLivenessQueryError extends Schema.TaggedErrorClass<ThreadTurnLivenessQueryError>()(
  "ThreadTurnLivenessQueryError",
  {
    code: Schema.Literals(["unknown_thread", "unknown_turn", "invalid_cursor", "invalid_timeout"]),
    message: Schema.String,
  },
) {}

export interface ThreadTurnLiveness {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly state: ThreadTurnLivenessState;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly runningForMs: number | null;
  readonly lastMessageAt: string | null;
  readonly lastActivityAt: string | null;
  readonly lastProviderSignalAt: string | null;
  readonly lastObservableProgressAt: string | null;
  readonly pendingRequests: ReadonlyArray<PendingTurnRequest>;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly stale: boolean;
  readonly staleReason: ThreadTurnStaleReason;
  readonly staleAfterMs: number;
  readonly safeToInterrupt: boolean;
}

export interface WaitForThreadUpdateInput {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly since?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly includeStatus?: boolean | undefined;
}

export interface WaitForThreadUpdateResult {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly reason: "terminal" | "progress" | "pending_request" | "stale" | "timeout";
  readonly cursor: string;
  readonly liveness?: ThreadTurnLiveness | undefined;
}

export interface ThreadTurnLivenessQueryShape {
  readonly getThreadTurnStatus: (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId | undefined;
  }) => Effect.Effect<ThreadTurnLiveness, ThreadTurnLivenessQueryError>;
  readonly getCurrentCursor: (input?: {
    readonly observedAt?: string | null | undefined;
  }) => Effect.Effect<string, ThreadTurnLivenessQueryError>;
  readonly waitForThreadUpdate: (
    input: WaitForThreadUpdateInput,
  ) => Effect.Effect<WaitForThreadUpdateResult, ThreadTurnLivenessQueryError>;
}

export class ThreadTurnLivenessQuery extends Context.Service<
  ThreadTurnLivenessQuery,
  ThreadTurnLivenessQueryShape
>()("t3/orchestration/Services/ThreadTurnLivenessQuery") {}
