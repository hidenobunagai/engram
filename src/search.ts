/**
 * Small in-process BM25 over notes, observations and team knowledge.
 * ponytail: rebuilt on every call; fine for tens of thousands of records, add a cached index if it gets slow.
 */

export interface Doc {
  id: string;
  source: "team" | "note" | "obs";
  kind: string;
  title: string;
  text: string;
  ts: number;
  /** Multiplier on the BM25 score: team and curated notes outrank raw observations. */
  weight: number;
  /** Text shown when the doc is injected or listed; defaults to `text`. */
  display?: string;
  /** Docs sharing a group collapse to the best hit (e.g. all edits of one file). */
  group?: string;
  ref?: string;
}

export interface Hit {
  doc: Doc;
  score: number;
}

const STOP = new Set(
  (
    "a an the and or of to in on for is are was be it this that with as at by from not no " +
    "can do does did done how why what who which when where you your me my we our i any some each " +
    "please could would should will just also there here get got make use using want need " +
    "select where join left right inner outer full cross group order limit having union all distinct " +
    "case when then else end null true false asc desc with into values insert update delete " +
    "count sum avg min max cast like between exists over partition"
  ).split(" "),
);

/** Warehouse layer prefixes carry no meaning on their own (dim_users -> users, not dim). */
const PREFIXES = new Set("dim fct fact stg int mart raw src tmp tbl vw".split(" "));

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f]+/g;
/** Any bigram with hiragana is a particle or verb ending (して, 見た, トが is kept out via が). */
const HAS_HIRAGANA = /[\u3040-\u309f]/;
const WORD = /[a-z0-9_$][a-z0-9_$.]*/g;

/**
 * ASCII identifiers stay whole (dim_users, schema.table) and also contribute their `.`/`_` parts
 * (users, mau); CJK runs become character bigrams so Japanese works without a dictionary.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const m of lower.match(WORD) || []) {
    const w = m.replace(/\.+$/, "");
    if (w.length < 2 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.push(w);
    if (/[._]/.test(w)) {
      const dotted = w.split(".").filter((p) => p.length > 1);
      const parts = new Set([...dotted, ...w.split(/[._]+/)]);
      for (const part of parts) {
        if (
          part.length > 2 &&
          part !== w &&
          !STOP.has(part) &&
          !PREFIXES.has(part) &&
          !/^\d+$/.test(part)
        )
          out.push(part);
      }
    }
  }
  for (const run of lower.match(CJK) || []) {
    if (run.length === 1 && !HAS_HIRAGANA.test(run)) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) {
      const bi = run.slice(i, i + 2);
      if (!HAS_HIRAGANA.test(bi)) out.push(bi);
    }
  }
  return out;
}

const K1 = 1.2;
const B = 0.75;

/**
 * Returns docs whose matched query terms carry enough IDF, ranked by weighted BM25.
 * The floor (minIdf, relaxed to half the IDF of query terms present in the corpus) keeps a single
 * common word from pulling in unrelated memories.
 */
export function search(docs: Doc[], query: string, limit = 5, minIdf = 3): Hit[] {
  const qTerms = [...new Set(tokenize(query))];
  if (!qTerms.length || !docs.length) return [];

  // A token can only occur in a doc whose lowercased text contains it, so a cheap substring
  // pass skips tokenizing most docs. Document lengths are averaged over candidates only.
  const texts = docs.map((d) => `${d.title} ${d.title} ${d.text}`);
  const cand = docs
    .map((_, i) => i)
    .filter((i) => {
      const lower = texts[i].toLowerCase();
      return qTerms.some((q) => lower.includes(q));
    });
  const tfs = new Map<number, Map<string, number>>();
  for (const i of cand) {
    const tf = new Map<string, number>();
    for (const t of tokenize(texts[i])) tf.set(t, (tf.get(t) || 0) + 1);
    tfs.set(i, tf);
  }
  const lens = new Map(cand.map((i) => [i, [...tfs.get(i)!.values()].reduce((a, b) => a + b, 0)]));
  const avgLen = [...lens.values()].reduce((a, b) => a + b, 0) / (cand.length || 1) || 1;

  const idf = new Map<string, number>();
  let presentIdf = 0;
  for (const q of qTerms) {
    const n = cand.filter((i) => tfs.get(i)!.has(q)).length;
    const w = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
    idf.set(q, w);
    if (n) presentIdf += w;
  }
  const floor = Math.min(minIdf, presentIdf / 2);

  const hits: Hit[] = [];
  for (const i of cand) {
    const doc = docs[i];
    let score = 0;
    let matchedIdf = 0;
    for (const q of qTerms) {
      const f = tfs.get(i)!.get(q);
      if (!f) continue;
      const w = idf.get(q)!;
      matchedIdf += w;
      score += (w * f * (K1 + 1)) / (f + K1 * (1 - B + (B * lens.get(i)!) / avgLen));
    }
    if (matchedIdf > 0 && matchedIdf >= floor) hits.push({ doc, score: score * doc.weight });
  }

  return hits.sort((a, b) => b.score - a.score || b.doc.ts - a.doc.ts).slice(0, limit);
}
