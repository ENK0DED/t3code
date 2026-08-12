// Run upstream's real projections.verify against a DB copy and, for each
// unreadable thread, print the full getThreadProjection failure cause.
//   cd apps/server && bun verify-probe.ts /path/to/copy.sqlite
import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layer as eventStoreLayer } from "./src/orchestration-v2/EventStore.ts";
import {
  layer as projectionMaintenanceLayer,
  ProjectionMaintenanceV2,
} from "./src/orchestration-v2/ProjectionMaintenance.ts";
import {
  layer as projectionStoreLayer,
  ProjectionStoreV2,
} from "./src/orchestration-v2/ProjectionStore.ts";
import { makeSqlitePersistenceLive } from "./src/persistence/Layers/Sqlite.ts";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("usage: bun verify-probe.ts <db-copy-path>");

const persistence = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(BunServicesLayer));

const appLayer = Layer.mergeAll(projectionMaintenanceLayer, projectionStoreLayer).pipe(
  Layer.provideMerge(eventStoreLayer),
  Layer.provideMerge(projectionStoreLayer),
  Layer.provideMerge(persistence),
);

const program = Effect.gen(function* () {
  const maintenance = yield* ProjectionMaintenanceV2;
  const store = yield* ProjectionStoreV2;
  const verification = yield* maintenance.verify;
  console.log(
    JSON.stringify(
      {
        valid: verification.valid,
        expectedSequence: verification.expectedSequence,
        projectionSequence: verification.projectionSequence,
        schemaVersion: verification.schemaVersion,
        missing: verification.missingThreadIds.length,
        unexpected: verification.unexpectedThreadIds.length,
        unreadable: verification.unreadableThreadIds,
      },
      null,
      2,
    ),
  );
  for (const threadId of verification.unreadableThreadIds) {
    const result = yield* store.getThreadProjection(threadId).pipe(Effect.exit);
    if (result._tag === "Failure") {
      console.log(`\n=== ${threadId} FULL CAUSE:\n${String(result.cause).slice(0, 3000)}`);
    } else {
      console.log(`\n=== ${threadId}: readable on direct read?!`);
    }
  }
});

await Effect.runPromise(program.pipe(Effect.provide(appLayer), Effect.scoped) as never);
