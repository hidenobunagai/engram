import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { refreshSnapshot, setSelected } from "../src/team";

/** Points engram at throwaway dirs so tests never touch real memory. */
export function sandbox(): { home: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), "engram-test-"));
  process.env.ENGRAM_HOME = join(root, "home");
  process.env.ENGRAM_TEAM_DIR = join(root, "team");
  return { home: process.env.ENGRAM_HOME, work: root };
}

/** Selects `cwd` for team sharing and snapshots the team folder, as the async hook would. */
export function joinTeam(cwd: string): void {
  setSelected(cwd, true);
  refreshSnapshot(0);
}
