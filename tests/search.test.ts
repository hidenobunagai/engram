import { describe, expect, it } from "bun:test";
import { type Doc, search, tokenize } from "../src/search";

const doc = (id: string, title: string, text: string, weight = 1): Doc => ({
  id,
  source: "note",
  kind: "caveat",
  title,
  text,
  ts: 0,
  weight,
});

describe("tokenize", () => {
  it("keeps identifiers whole and splits dotted names", () => {
    expect(tokenize("SELECT * FROM analytics.dim_users")).toEqual([
      "analytics.dim_users",
      "analytics",
      "dim_users",
      "users",
    ]);
    expect(tokenize("mart_mau")).toEqual(["mart_mau", "mau"]);
  });
  it("makes CJK bigrams", () => {
    expect(tokenize("売上計上")).toEqual(["売上", "上計", "計上"]);
    expect(tokenize("集計して")).toEqual(["集計"]);
    expect(tokenize("見たい")).toEqual([]);
  });
});

describe("search", () => {
  const docs = [
    doc("a", "Soft deletes in dim_users", "filter deleted_at IS NULL"),
    doc("b", "MAU definition", "count distinct user_id over 28 days"),
    doc("c", "返品の計上タイミング", "返品は翌月に計上する"),
    doc("d", "Unrelated", "pipeline schedule for marketing"),
  ];
  it("finds by table name", () =>
    expect(search(docs, "join dim_users to orders")[0]?.doc.id).toBe("a"));
  it("finds Japanese text", () => expect(search(docs, "返品はいつ計上？")[0]?.doc.id).toBe("c"));
  it("returns nothing for unrelated prompts", () =>
    expect(search(docs, "fix the CSS of the button")).toEqual([]));
  it("applies weights", () => {
    const hits = search(
      [doc("x", "dim_users", "a", 1), doc("y", "dim_users", "a", 2), doc("z", "other", "b")],
      "dim_users",
    );
    expect(hits[0].doc.id).toBe("y");
  });
});
