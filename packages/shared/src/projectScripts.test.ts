import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("effect/Effect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect/Effect")>();
  return {
    ...actual,
    runSync: () => 12_345_678_901_234,
  };
});

import {
  commandForProjectScript,
  createProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  projectScriptCwd,
  projectScriptIdFromCommand,
  projectScriptRuntimeEnv,
  removeProjectScript,
  setupProjectScript,
  upsertProjectScript,
} from "./projectScripts.ts";

describe("projectScripts helpers", () => {
  it("builds and parses script run commands", () => {
    const command = commandForProjectScript("lint");
    expect(command).toBe("script.lint.run");
    expect(projectScriptIdFromCommand(command)).toBe("lint");
    expect(projectScriptIdFromCommand("terminal.toggle")).toBeNull();
  });

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("falls back after the bounded collision search is exhausted", () => {
    let hasCalls = 0;
    vi.spyOn(Set.prototype, "has").mockImplementation(() => {
      hasCalls += 1;
      if (hasCalls > 20_000) {
        throw new Error("bounded search exceeded");
      }
      return true;
    });

    try {
      expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests-12345678901234");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("creates scripts with shared defaults", () => {
    expect(
      createProjectScript({
        name: "Test",
        command: "bun test",
        existingIds: [],
      }),
    ).toEqual({
      id: "test",
      name: "Test",
      command: "bun test",
      icon: "play",
      runOnWorktreeCreate: false,
    });
  });

  it("omits auto-open preview unless a preview URL is present", () => {
    expect(
      createProjectScript({
        name: "Dev",
        command: "bun dev",
        existingIds: [],
        autoOpenPreview: true,
      }).autoOpenPreview,
    ).toBeUndefined();
    expect(
      createProjectScript({
        name: "Dev",
        command: "bun dev",
        existingIds: ["dev"],
        previewUrl: "http://localhost:5173",
        autoOpenPreview: true,
      }),
    ).toMatchObject({
      id: "dev-2",
      previewUrl: "http://localhost:5173",
      autoOpenPreview: true,
    });
  });

  it("upserts scripts while preserving the single setup action invariant", () => {
    const scripts = [
      createProjectScript({
        name: "Setup",
        command: "bun install",
        existingIds: [],
        runOnWorktreeCreate: true,
      }),
      createProjectScript({
        name: "Test",
        command: "bun test",
        existingIds: ["setup"],
      }),
    ];
    const lint = createProjectScript({
      name: "Lint",
      command: "bun lint",
      existingIds: ["setup", "test"],
      icon: "lint",
      runOnWorktreeCreate: true,
    });

    const result = upsertProjectScript(scripts, lint);

    expect(result.action).toBe("created");
    expect(result.scripts.map((script) => [script.id, script.runOnWorktreeCreate])).toEqual([
      ["setup", false],
      ["test", false],
      ["lint", true],
    ]);
  });

  it("updates scripts in place and returns the previous script", () => {
    const scripts = [
      createProjectScript({ name: "Test", command: "bun test", existingIds: [] }),
      createProjectScript({ name: "Lint", command: "bun lint", existingIds: ["test"] }),
    ];

    const result = upsertProjectScript(scripts, {
      ...scripts[0]!,
      command: "bun test --run",
    });

    expect(result.action).toBe("updated");
    if (result.action === "updated") {
      expect(result.previousScript.command).toBe("bun test");
      expect(result.scripts.map((script) => script.command)).toEqual([
        "bun test --run",
        "bun lint",
      ]);
    }
  });

  it("removes scripts with an observable missing case", () => {
    const scripts = [createProjectScript({ name: "Test", command: "bun test", existingIds: [] })];

    expect(removeProjectScript(scripts, "missing")).toEqual({
      removed: false,
      scripts,
    });

    const result = removeProjectScript(scripts, "test");
    expect(result.removed).toBe(true);
    if (result.removed) {
      expect(result.script.id).toBe("test");
      expect(result.scripts).toEqual([]);
    }
  });

  it("resolves primary and setup scripts", () => {
    const scripts = [
      createProjectScript({
        name: "Setup",
        command: "bun install",
        existingIds: [],
        icon: "configure",
        runOnWorktreeCreate: true,
      }),
      createProjectScript({
        name: "Test",
        command: "bun test",
        existingIds: ["setup"],
        icon: "test",
      }),
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("test");
    expect(setupProjectScript(scripts)?.id).toBe("setup");
  });

  it("builds default runtime env for scripts", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      worktreePath: "/repo/worktree-a",
    });

    expect(env).toMatchObject({
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo/worktree-a",
    });
  });

  it("allows overriding runtime env values", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      extraEnv: {
        T3CODE_PROJECT_ROOT: "/custom-root",
        CUSTOM_FLAG: "1",
      },
    });

    expect(env.T3CODE_PROJECT_ROOT).toBe("/custom-root");
    expect(env.CUSTOM_FLAG).toBe("1");
    expect(env.T3CODE_WORKTREE_PATH).toBeUndefined();
  });

  it("prefers the worktree path for script cwd resolution", () => {
    expect(projectScriptCwd({ project: { cwd: "/repo" }, worktreePath: "/repo/worktree-a" })).toBe(
      "/repo/worktree-a",
    );
    expect(projectScriptCwd({ project: { cwd: "/repo" }, worktreePath: null })).toBe("/repo");
  });
});
