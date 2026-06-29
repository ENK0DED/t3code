import { type ThreadId, type TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ThreadTurnProviderSignal } from "../threadTurnLiveness.ts";

export interface ThreadTurnSignalTrackerShape {
  readonly record: (
    input: ThreadTurnProviderSignal,
  ) => Effect.Effect<{ readonly shouldPersist: boolean }, never>;
  readonly getLatest: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<Option.Option<ThreadTurnProviderSignal>, never>;
  readonly clear: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<void, never>;
}

export class ThreadTurnSignalTracker extends Context.Service<
  ThreadTurnSignalTracker,
  ThreadTurnSignalTrackerShape
>()("t3/orchestration/Services/ThreadTurnSignalTracker") {}
