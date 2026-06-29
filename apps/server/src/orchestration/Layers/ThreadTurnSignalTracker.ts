import { type ThreadId, type TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ThreadTurnSignalTracker } from "../Services/ThreadTurnSignalTracker.ts";
import {
  PROVIDER_SIGNAL_COALESCE_MS,
  type ThreadTurnProviderSignal,
} from "../threadTurnLiveness.ts";

const trackerKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;

interface ThreadTurnSignalTrackerEntry {
  readonly latest: ThreadTurnProviderSignal;
  readonly lastPersistedAt: string | null;
}

const isLifecycleAdjacentSignal = (
  current: ThreadTurnProviderSignal,
  previous: ThreadTurnSignalTrackerEntry | undefined,
): boolean => current.signalKind === "lifecycle" && previous?.latest.signalKind !== "lifecycle";

export const ThreadTurnSignalTrackerLive = Layer.effect(
  ThreadTurnSignalTracker,
  Effect.sync(() => {
    const signals = new Map<string, ThreadTurnSignalTrackerEntry>();

    const record = Effect.fn("ThreadTurnSignalTracker.record")((input: ThreadTurnProviderSignal) =>
      Effect.sync(() => {
        const key = trackerKey(input.threadId, input.turnId);
        const previous = signals.get(key);
        const lastPersistedAtMs =
          previous?.lastPersistedAt === null || previous?.lastPersistedAt === undefined
            ? null
            : Date.parse(previous.lastPersistedAt);
        const currentSignaledAtMs = Date.parse(input.signaledAt);
        const shouldPersist =
          previous?.lastPersistedAt === null ||
          previous?.lastPersistedAt === undefined ||
          (Number.isFinite(currentSignaledAtMs) &&
            Number.isFinite(lastPersistedAtMs) &&
            currentSignaledAtMs - (lastPersistedAtMs as number) >= PROVIDER_SIGNAL_COALESCE_MS) ||
          isLifecycleAdjacentSignal(input, previous);

        signals.set(key, {
          latest: input,
          lastPersistedAt: shouldPersist ? input.signaledAt : (previous?.lastPersistedAt ?? null),
        });

        return { shouldPersist } as const;
      }),
    );

    const getLatest = Effect.fn("ThreadTurnSignalTracker.getLatest")(
      (input: { readonly threadId: ThreadId; readonly turnId: TurnId }) =>
        Effect.sync(() => {
          const latest = signals.get(trackerKey(input.threadId, input.turnId))?.latest;
          return latest === undefined ? Option.none() : Option.some(latest);
        }),
    );

    const clear = Effect.fn("ThreadTurnSignalTracker.clear")(
      (input: { readonly threadId: ThreadId; readonly turnId: TurnId }) =>
        Effect.sync(() => {
          signals.delete(trackerKey(input.threadId, input.turnId));
        }),
    );

    return ThreadTurnSignalTracker.of({
      record,
      getLatest,
      clear,
    });
  }),
);
