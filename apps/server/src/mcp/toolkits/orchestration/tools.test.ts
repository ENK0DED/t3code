import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { OrchestrationToolkit } from "./tools.ts";

const legacyThreadSettingsToolName = ["get", "current", "thread", "settings"].join("_");
const legacyPlacement = ["child", "of", "current"].join("_");

const expectedToolNames = [
  "list_mcp_models",
  "list_projects",
  "get_project_details",
  "get_project_settings",
  "update_project_settings",
  "list_threads",
  "get_thread_settings",
  "get_thread_history",
  "list_project_actions",
  "create_project_action",
  "update_project_action",
  "delete_project_action",
  "add_project",
  "create_thread",
  "send_thread_message",
  "update_thread_settings",
  "interrupt_thread_turn",
  "respond_to_approval",
  "respond_to_user_input",
  "delete_thread",
  "archive_thread",
  "unarchive_thread",
] as const;

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

it("exports provider-compatible object schemas with described parameters", () => {
  for (const tool of Object.values(OrchestrationToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what data the agent must pass`,
      ).toBe(true);
    }
  }
});

it("uses explicit object schemas for no-input orchestration tools", () => {
  for (const toolName of ["list_mcp_models", "get_thread_settings"] as const) {
    const schema = Tool.getJsonSchema(OrchestrationToolkit.tools[toolName]) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };

    expect(schema.type, `${toolName} must use an object-shaped parameter schema`).toBe("object");
    expect(schema.anyOf, `${toolName} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${toolName} must not export a root oneOf`).toBeUndefined();
    expect(schema.properties ?? {}, `${toolName} should serialize to an object schema`).toEqual(
      expect.any(Object),
    );
  }
});

it("exports the orchestration MCP toolkit in the planned HTTP surface order", () => {
  expect(Object.keys(OrchestrationToolkit.tools)).toEqual(expectedToolNames);
});

it("renames current thread settings reads to get_thread_settings", () => {
  expect(OrchestrationToolkit.tools.get_thread_settings).toBeDefined();
  expect(
    legacyThreadSettingsToolName in (OrchestrationToolkit.tools as Record<string, unknown>),
  ).toBe(false);
});

it("exposes project settings tools separately from project selectors", () => {
  expect(OrchestrationToolkit.tools.list_projects).toBeDefined();
  expect(OrchestrationToolkit.tools.get_project_details).toBeDefined();
  expect(OrchestrationToolkit.tools.get_project_settings).toBeDefined();
  expect(OrchestrationToolkit.tools.update_project_settings).toBeDefined();
  expect(OrchestrationToolkit.tools.list_project_actions).toBeDefined();
  expect(OrchestrationToolkit.tools.create_project_action).toBeDefined();
  expect(OrchestrationToolkit.tools.update_project_action).toBeDefined();
  expect(OrchestrationToolkit.tools.delete_project_action).toBeDefined();
  expect(
    JSON.stringify(Tool.getJsonSchema(OrchestrationToolkit.tools.list_project_actions)),
  ).not.toContain("command");
  expect(
    JSON.stringify(Tool.getJsonSchema(OrchestrationToolkit.tools.get_project_details)),
  ).not.toContain("command");
  expect(
    JSON.stringify(Tool.getJsonSchema(OrchestrationToolkit.tools.get_project_settings)),
  ).not.toContain("command");
  expect(
    JSON.stringify(Tool.getJsonSchema(OrchestrationToolkit.tools.delete_project_action)),
  ).not.toContain("command");
  expect(
    JSON.stringify(Tool.getJsonSchema(OrchestrationToolkit.tools.create_project_action)),
  ).toContain("command");
  expect(
    JSON.stringify(Tool.getJsonSchema(OrchestrationToolkit.tools.update_project_action)),
  ).toContain("command");
});

it("exposes first-turn worktree bootstrap fields on send_thread_message", () => {
  const schema = Tool.getJsonSchema(OrchestrationToolkit.tools.send_thread_message) as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };

  expect(schema.properties?.threadId).toBeDefined();
  expect(schema.properties?.message).toBeDefined();
  expect(schema.properties?.modelSelection).toBeDefined();
  expect(schema.properties?.checkoutMode).toBeDefined();
  expect(schema.properties?.branch).toBeDefined();
  expect(schema.properties?.baseBranch).toBeDefined();
  expect(schema.properties?.worktreePath).toBeUndefined();
});

it("retains title and checkout metadata fields on update_thread_settings", () => {
  const schema = Tool.getJsonSchema(OrchestrationToolkit.tools.update_thread_settings) as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };

  expect(schema.properties?.threadId).toBeDefined();
  expect(schema.properties?.title).toBeDefined();
  expect(schema.properties?.modelSelection).toBeDefined();
  expect(schema.properties?.runtimeMode).toBeDefined();
  expect(schema.properties?.interactionMode).toBeDefined();
  expect(schema.properties?.checkoutMode).toBeDefined();
  expect(schema.properties?.branch).toBeDefined();
  expect(schema.properties?.worktreePath).toBeDefined();
  expect(schema.properties?.baseBranch).toBeUndefined();
});

it("omits worktreePath from create_thread bootstrap inputs", () => {
  const schema = Tool.getJsonSchema(OrchestrationToolkit.tools.create_thread) as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };

  expect(schema.properties?.checkoutMode).toBeDefined();
  expect(schema.properties?.branch).toBeDefined();
  expect(schema.properties?.baseBranch).toBeDefined();
  expect(schema.properties?.worktreePath).toBeUndefined();
});

it("exposes only top_level and child_of_thread create_thread placements", () => {
  const createSchema = Tool.getJsonSchema(OrchestrationToolkit.tools.create_thread);
  const serialized = JSON.stringify(createSchema);

  expect(serialized).not.toContain(legacyPlacement);
  expect(serialized).toContain("child_of_thread");
  expect(serialized).toContain("top_level");
});
