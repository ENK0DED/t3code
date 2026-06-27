import { describe, expect, it } from "vite-plus/test";

import { isModelEnabledForMcp } from "./mcpModels.ts";

describe("MCP model enablement", () => {
  it("treats models as enabled unless explicitly disabled for the provider instance", () => {
    expect(
      isModelEnabledForMcp({
        mcpDisabledModelsByProvider: {},
        instanceId: "codex",
        model: "gpt-5.5",
      }),
    ).toBe(true);

    expect(
      isModelEnabledForMcp({
        mcpDisabledModelsByProvider: {
          codex: ["gpt-5.5"],
          claudeAgent: ["claude-opus-4-6"],
        },
        instanceId: "codex",
        model: "gpt-5.5",
      }),
    ).toBe(false);

    expect(
      isModelEnabledForMcp({
        mcpDisabledModelsByProvider: {
          claudeAgent: ["gpt-5.5"],
        },
        instanceId: "codex",
        model: "gpt-5.5",
      }),
    ).toBe(true);
  });
});
