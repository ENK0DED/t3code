import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { OrchestrationToolkit } from "./tools.ts";

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
  const schema = Tool.getJsonSchema(OrchestrationToolkit.tools.list_mcp_models) as {
    readonly type?: unknown;
  };
  expect(schema.type).toBe("object");
});

it("exposes project settings tools separately from project selectors", () => {
  expect(OrchestrationToolkit.tools.list_projects).toBeDefined();
  expect(OrchestrationToolkit.tools.get_project_details).toBeDefined();
  expect(OrchestrationToolkit.tools.get_project_settings).toBeDefined();
  expect(OrchestrationToolkit.tools.update_project_settings).toBeDefined();
});

it("keeps send_thread_message scoped to message delivery", () => {
  const schema = Tool.getJsonSchema(OrchestrationToolkit.tools.send_thread_message) as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };

  expect(schema.properties?.threadId).toBeDefined();
  expect(schema.properties?.message).toBeDefined();
  expect(schema.properties?.modelSelection).toBeDefined();
  expect(schema.properties?.checkoutMode).toBeUndefined();
  expect(schema.properties?.branch).toBeUndefined();
  expect(schema.properties?.baseBranch).toBeUndefined();
});

it("retains baseBranch on update_thread_settings", () => {
  const schema = Tool.getJsonSchema(OrchestrationToolkit.tools.update_thread_settings) as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };

  expect(schema.properties?.threadId).toBeDefined();
  expect(schema.properties?.modelSelection).toBeDefined();
  expect(schema.properties?.runtimeMode).toBeDefined();
  expect(schema.properties?.interactionMode).toBeDefined();
  expect(schema.properties?.checkoutMode).toBeDefined();
  expect(schema.properties?.branch).toBeDefined();
  expect(schema.properties?.worktreePath).toBeDefined();
  expect(schema.properties?.baseBranch).toBeDefined();
});

it("retains create_thread child_of_current placement support", () => {
  const createSchema = Tool.getJsonSchema(OrchestrationToolkit.tools.create_thread);
  const serialized = JSON.stringify(createSchema);

  expect(serialized).toContain("child_of_current");
  expect(serialized).toContain("child_of_thread");
  expect(serialized).toContain("top_level");
});
