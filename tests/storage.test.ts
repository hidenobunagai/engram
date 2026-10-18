import { describe, expect, it } from "bun:test";
import { LocalStorage } from "../src/core/storage";

describe("LocalStorage", () => {
  it("initializes tables and saves entries and observations", () => {
    const storage = new LocalStorage(":memory:");

    // Save an entry
    const entry = storage.saveEntry({
      id: "ent-1",
      project: "analytics-prod",
      kind: "metric",
      title: "Active Users Definition",
      content: "Users with at least 1 login in past 30 days. Excludes internal QA accounts.",
      targetTables: ["dim_users", "fct_logins"],
      tags: ["kpi", "dau"],
    });

    expect(entry.id).toBe("ent-1");
    expect(entry.createdAt).toBeGreaterThan(0);

    // Save an observation
    const obs = storage.saveObservation({
      id: "obs-1",
      sessionId: "sess-100",
      project: "analytics-prod",
      toolName: "run_sql",
      title: "SQL Execution Error: Syntax near WHERE",
      content: "Fixed by adding missing comma before WHERE in subquery.",
      isError: true,
    });

    expect(obs.id).toBe("obs-1");
    expect(obs.isError).toBe(true);

    // Session management
    const session = storage.startSession({
      id: "sess-100",
      project: "analytics-prod",
      cwd: "/Users/analyst/analytics",
    });
    expect(session.id).toBe("sess-100");

    storage.endSession("sess-100", "Resolved user cohort discrepancy and documented logic.");
    const recent = storage.getRecentSession("analytics-prod");
    expect(recent?.summary).toBe("Resolved user cohort discrepancy and documented logic.");

    // FTS search
    const results = storage.search("Active Users");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain("Active Users");

    // Short query search fallback
    const shortResults = storage.search("QA");
    expect(shortResults.length).toBeGreaterThan(0);

    storage.close();
  });
});
