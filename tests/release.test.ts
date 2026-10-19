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
});
