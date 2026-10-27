/**
 * Small in-process BM25 over notes, observations and team knowledge. Observations can come from the
 * postings index (postings.ts) instead of a full scan; both feed the same rank().
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
  /** Tables a note or team item is about; a prompt naming one surfaces it without BM25. */
  tables?: string[];
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
 * The one text form every token comes from: NFKC folds full-width ASCII typed through a Japanese IME
 * (ｄｉｍ＿ｕｓｅｒｓ) and half-width katakana into the forms stored text uses, then case is dropped.
 */
export function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/**
 * ASCII identifiers stay whole (dim_users, schema.table) and also contribute their `.`/`_` parts
 * (users, mau); CJK runs become character bigrams so Japanese works without a dictionary.
 */
export function tokenize(text: string): string[] {
  const lower = normalize(text);
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

/** A doc that may match, with the frequency of each query term (in query order) and its token count. */
export interface Candidate {
  doc: Doc;
  tf: number[];
  len: number;
}

/** The text a doc is searched by: the title counts twice. */
export const searchText = (d: Doc) => `${d.title} ${d.title} ${d.text}`;

/** Distinct query terms, in query order. */
export const queryTerms = (query: string) => [...new Set(tokenize(query))];

/**
 * A token can only occur in a doc whose normalized text contains it, so a cheap substring pass skips
 * tokenizing most docs. The postings index reproduces this set exactly (see postings.ts), because
 * document lengths are averaged over these candidates.
 */
export function candidates(docs: Doc[], qTerms: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const doc of docs) {
    const text = searchText(doc);
    const lower = normalize(text);
    if (!qTerms.some((q) => lower.includes(q))) continue;
    const tokens = tokenize(text);
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
    out.push({ doc, tf: qTerms.map((q) => counts.get(q) || 0), len: tokens.length });
  }
  return out;
}

/**
 * Returns docs whose matched query terms carry enough IDF, ranked by weighted BM25.
 * The floor (minIdf, relaxed to half the IDF of query terms present in the corpus) keeps a single
 * common word from pulling in unrelated memories.
 */
export function search(docs: Doc[], query: string, limit = 5, minIdf = 3): Hit[] {
  const qTerms = queryTerms(query);
  if (!qTerms.length || !docs.length) return [];
  return rank(docs.length, qTerms, candidates(docs, qTerms), limit, minIdf);
}

/**
 * BM25 over `cand` in a corpus of `total` docs. Ties keep the order of `cand`, so callers pass
 * candidates in corpus order.
 */
export function rank(
  total: number,
  qTerms: string[],
  cand: Candidate[],
  limit: number,
  minIdf: number,
): Hit[] {
  if (!qTerms.length || !total) return [];
  const avgLen = cand.reduce((a, c) => a + c.len, 0) / (cand.length || 1) || 1;

  const idf: number[] = [];
  let presentIdf = 0;
  for (let j = 0; j < qTerms.length; j++) {
    const n = cand.filter((c) => c.tf[j] > 0).length;
    const w = Math.log(1 + (total - n + 0.5) / (n + 0.5));
    idf.push(w);
    if (n) presentIdf += w;
  }
  const floor = Math.min(minIdf, presentIdf / 2);

  const hits: Hit[] = [];
  for (const { doc, tf, len } of cand) {
    let score = 0;
    let matchedIdf = 0;
    for (let j = 0; j < qTerms.length; j++) {
      const f = tf[j];
      if (!f) continue;
      const w = idf[j];
      matchedIdf += w;
      score += (w * f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / avgLen));
    }
    if (matchedIdf > 0 && matchedIdf >= floor) hits.push({ doc, score: score * doc.weight });
  }

  return hits.sort((a, b) => b.score - a.score || b.doc.ts - a.doc.ts).slice(0, limit);
}
