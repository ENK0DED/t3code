// Decode every projection row of one thread with upstream's schemas and report
// the first failure per table. Run from the upstream worktree so imports hit
// upstream contracts:
//   cd /srv/dev/projects/t3code-upstream && bun <this file> <threadId>
import { Database } from "bun:sqlite";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2RunJson,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2TurnItemJson,
  OrchestrationV2ExecutionNodeJson,
  OrchestrationV2RunAttemptJson,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2ProviderSessionJson,
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2RuntimeRequestJson,
  OrchestrationV2SubagentJson,
  OrchestrationV2CheckpointJson,
  OrchestrationV2CheckpointScopeJson,
  OrchestrationV2ContextHandoffJson,
  OrchestrationV2ContextTransferJson,
} from "@t3tools/contracts";

const sweepAll = process.argv[2] === "--all";
const threadId = sweepAll ? null : process.argv[2];
if (!threadId && !sweepAll) throw new Error("usage: bun decode-probe.ts <threadId>|--all");

const TABLES: Array<[table: string, schema: Schema.Top, idCol: string]> = [
  ["orchestration_v2_projection_threads", OrchestrationV2AppThreadJson, "thread_id"],
  ["orchestration_v2_projection_runs", OrchestrationV2RunJson, "run_id"],
  ["orchestration_v2_projection_messages", OrchestrationV2ConversationMessageJson, "message_id"],
  ["orchestration_v2_projection_turn_items", OrchestrationV2TurnItemJson, "turn_item_id"],
  ["orchestration_v2_projection_nodes", OrchestrationV2ExecutionNodeJson, "node_id"],
  ["orchestration_v2_projection_run_attempts", OrchestrationV2RunAttemptJson, "attempt_id"],
  [
    "orchestration_v2_projection_provider_threads",
    OrchestrationV2ProviderThreadJson,
    "provider_thread_id",
  ],
  [
    "orchestration_v2_projection_provider_sessions",
    OrchestrationV2ProviderSessionJson,
    "provider_session_id",
  ],
  [
    "orchestration_v2_projection_provider_turns",
    OrchestrationV2ProviderTurnJson,
    "provider_turn_id",
  ],
  [
    "orchestration_v2_projection_runtime_requests",
    OrchestrationV2RuntimeRequestJson,
    "runtime_request_id",
  ],
  ["orchestration_v2_projection_subagents", OrchestrationV2SubagentJson, "subagent_id"],
  ["orchestration_v2_projection_checkpoints", OrchestrationV2CheckpointJson, "checkpoint_id"],
  ["orchestration_v2_projection_checkpoint_scopes", OrchestrationV2CheckpointScopeJson, "scope_id"],
  [
    "orchestration_v2_projection_context_handoffs",
    OrchestrationV2ContextHandoffJson,
    "context_handoff_id",
  ],
  [
    "orchestration_v2_projection_context_transfers",
    OrchestrationV2ContextTransferJson,
    "context_transfer_id",
  ],
];

const db = new Database(`${process.env.HOME}/.t3/userdata/state.sqlite`, { readonly: true });
db.exec("PRAGMA query_only = ON");

for (const [table, schema, idCol] of TABLES) {
  let rows: Array<{ id: string; payload_json: string; tid: string }>;
  try {
    const tidCol =
      table === "orchestration_v2_projection_context_transfers" ? "source_thread_id" : "thread_id";
    rows = sweepAll
      ? db
          .query<{ id: string; payload_json: string; tid: string }, []>(
            `SELECT ${idCol} AS id, payload_json, ${tidCol} AS tid FROM ${table}`,
          )
          .all()
      : db
          .query<{ id: string; payload_json: string; tid: string }, [string]>(
            `SELECT ${idCol} AS id, payload_json, ${tidCol} AS tid FROM ${table} WHERE ${table === "orchestration_v2_projection_context_transfers" ? "(source_thread_id = ?1 OR target_thread_id = ?1)" : "thread_id = ?1"}`,
          )
          .all(threadId!);
  } catch (e) {
    console.log(`${table}: SKIP (${String(e).slice(0, 80)})`);
    continue;
  }
  let failures = 0;
  for (const row of rows) {
    const result = Effect.runSyncExit(
      Schema.decodeUnknownEffect(schema as never)(JSON.parse(row.payload_json)),
    );
    if (result._tag === "Failure") {
      failures += 1;
      if (failures <= 3) {
        const msg = String(result.cause).slice(0, 900);
        console.log(`\n=== ${table} FAILURE thread=${row.tid} ${idCol}=${row.id}:\n${msg}\n`);
      }
    }
  }
  console.log(`${table}: ${rows.length} rows, ${failures} failures`);
}
