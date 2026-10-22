import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", p), "utf-8"));

describe("release metadata", () => {
  // plugin.json's version pins installed copies: users only get changes after it is bumped.
  it("uses one version everywhere", () => {
    const version = read(".claude-plugin/plugin.json").version;
    expect(read("package.json").version).toBe(version);
    expect(read(".claude-plugin/marketplace.json").plugins[0].version).toBe(version);
  });

  // Claude Code runs hooks from a shell whose PATH may hold no node at all (the macOS
  // app gives /usr/bin:/bin:...), so a bare `node` in a hook command fails silently.
  // Every hook must go through hooks/run-hook.sh, which resolves an interpreter.
  it("starts every hook through the interpreter-resolving launcher", () => {
    const { hooks } = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "hooks", "hooks.json"), "utf-8"),
    ) as { hooks: Record<string, { hooks: { command: string }[] }[]> };

    const commands = Object.values(hooks).flatMap((groups) =>
      groups.flatMap((g) => g.hooks.map((h) => h.command)),
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain("${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh");
      expect(command.trimStart().startsWith("node ")).toBe(false);
    }
  });
});
