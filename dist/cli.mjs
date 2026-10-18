// src/cli.ts
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync3 } from "fs";
import { join as join3 } from "path";

// src/memory.ts
import { createHash, randomUUID } from "crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";

// src/sanitizer.ts
var DB_SCHEMES = "postgresql|postgres|mysql|mariadb|snowflake|redshift|bigquery|mongodb|mongodb\\+srv|sqlserver|mssql|oracle|jdbc:[a-z]+|clickhouse|databricks|trino|presto|redis|rediss|amqps?|sftp|ftps?|smtps?|https?";
var KV_KEYS = "password|passwd|pwd|pass|pgpassword|passphrase|secret|api[_-]?key|access[_-]?key|account[_-]?key|shared[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|private[_-]?key|credentials?|sig|signature|x-amz-signature|x-amz-credential";
var SECRET_NAME = '"[^"]*(?:secret|token|passw|pwd|pass|key|credential)[^"]*"';
var JSON_STR = '"(?:[^"\\\\]|\\\\.)*"';
var VALUE = `${JSON_STR}|'[^']*'|\\{[^}]*\\}|[^\\s"',;}]+`;
var NOT_LITERAL = "(?!(?:-?\\d+(?:\\.\\d+)?|true|false|null)(?![\\w.-]))";
function luhn(digits) {
  let sum = 0;
  for (let i = 0;i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1)
      d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}
var RULES = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]"
  ],
  [
    new RegExp(`((?:${DB_SCHEMES})(?:\\+\\w+)?:\\/\\/[^\\s:/@]*:)\\S*(@[\\w.-]+(?::\\d+)?)`, "gi"),
    "$1[REDACTED_SECRET]$2"
  ],
  [
    new RegExp(`("(?:key|name)"\\s*:\\s*${SECRET_NAME}\\s*,\\s*"value"\\s*:\\s*)${JSON_STR}`, "gi"),
    '$1"[REDACTED_SECRET]"'
  ],
  [
    new RegExp(`("value"\\s*:\\s*)${JSON_STR}(\\s*,\\s*"(?:key|name)"\\s*:\\s*${SECRET_NAME})`, "gi"),
    '$1"[REDACTED_SECRET]"$2'
  ],
  [
    new RegExp(`(\\b(?:[A-Za-z0-9]+_)*(?:${KV_KEYS})(?:_(?:prod|dev|test|stg|staging|\\d+))?["']?\\]?\\s*[:=]\\s*)${NOT_LITERAL}(?:${VALUE})`, "gi"),
    "$1[REDACTED_SECRET]"
  ],
  [/(\b(?:password|identified\s+by)\s+)(?:'[^']*'|"[^"]*")/gi, "$1[REDACTED_SECRET]"],
  [/(\b(?:mysql|mariadb|mysqldump|mysqladmin)\b[^\n|;&]*?\s-p)[^\s-]\S*/g, "$1[REDACTED_SECRET]"],
  [/(\s(?:-u|--user)\s+[^\s:]+:)\S+/g, "$1[REDACTED_SECRET]"],
  [/(Authorization:\s*(?:Token|Key|ApiKey))\s+\S+/gi, "$1 [REDACTED_TOKEN]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9_\-.~+/]{8,}=*/gi, "$1 [REDACTED_TOKEN]"],
  [/(\s--?(?:password|passwd|pwd|token|secret)(?:=|\s+))(\S+)/gi, "$1[REDACTED_SECRET]"],
  [
    /(\b(?:password|passwd|secret|token|api ?key)\s+(?:is|was|=|:)\s+["']?)[^\s"']{6,}/gi,
    "$1[REDACTED_SECRET]"
  ],
  [
    /((?:パスワード|シークレット|トークン|APIキー)\s*(?:は|が|:|：|=)\s*["'「]?)[^\s"'」、。]{6,}/gi,
    "$1[REDACTED_SECRET]"
  ],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [
    /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g,
    "[REDACTED_AWS_KEY]"
  ],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{30,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED_API_KEY]"],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, "[REDACTED_API_KEY]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, "[REDACTED_GOOGLE_KEY]"],
  [/\bdapi[a-f0-9]{32}\b/g, "[REDACTED_DATABRICKS_TOKEN]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[REDACTED_GITLAB_TOKEN]"],
  [
    /(?<![A-Za-z0-9._%+\-\]])[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    "[REDACTED_EMAIL]"
  ],
  [
    /(?<![\d-])(?:0\d{1,4}-\d{1,4}-\d{3,4}|0[789]0\d{8}|\+\d{1,3}[ -]?\d{1,4}[ -]\d{2,4}[ -]\d{3,4})(?![\d-])/g,
    "[REDACTED_PHONE]"
  ],
  [
    /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
    (m) => luhn(m.replace(/\D/g, "")) ? "[REDACTED_CARD]" : m
  ]
];
function sanitize(text) {
  if (!text)
    return "";
  let out = text;
  for (const [re, rep] of RULES)
    out = out.replace(re, rep);
  return out;
}

// src/memory.ts
var KINDS = ["caveat", "metric", "query", "decision", "fact", "fix", "note"];
var MAX_INPUT = 2000;
var MAX_ERROR = 1000;
var MAX_BODY = 4000;
var MAX_REPLY = 800;
function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
function clipMiddle(text, max) {
  if (text.length <= max)
    return text;
  const head = Math.floor(max * 0.4);
  return `${text.slice(0, head)}
…
${text.slice(text.length - (max - head))}`;
}
var pad = (n) => String(n).padStart(2, "0");
function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localTime(ts) {
  const d = new Date(ts);
  return `${localDay(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function newId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
function dataDir() {
  return process.env.ENGRAM_HOME || join(homedir(), ".claude", "engram-memory");
}
function projectRoot(cwd) {
  let dir = resolve(cwd);
  for (;; ) {
    if (existsSync(join(dir, ".git")))
      return dir;
    const parent = dirname(dir);
    if (parent === dir)
      return resolve(cwd);
    dir = parent;
  }
}
function projectId(cwd) {
  const root = projectRoot(cwd);
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 8);
  const name = (basename(root) || "root").replace(/[^\w.-]/g, "_");
  return `${name}-${hash}`;
}
function ensureDir(dir) {
  if (!existsSync(dir))
    mkdirSync(dir, { recursive: true });
  return dir;
}
var obsDir = (project) => join(dataDir(), "obs", project);
var notesFile = () => join(dataDir(), "notes.jsonl");
var recapFile = (project) => join(dataDir(), "recaps", `${project}.json`);
function safeName(session) {
  return session.replace(/[^\w-]/g, "_");
}
function appendLine(file, record) {
  ensureDir(dirname(file));
  appendFileSync(file, `${endsTorn(file) ? `
` : ""}${JSON.stringify(record)}
`, "utf-8");
}
function endsTorn(file) {
  try {
    const size = statSync(file).size;
    if (!size)
      return false;
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    closeSync(fd);
    return buf[0] !== 10;
  } catch {
    return false;
  }
}
function readLines(file, skip) {
  if (!existsSync(file))
    return [];
  const out = [];
  for (const line of readFileSync(file, "utf-8").split(`
`)) {
    if (!line || skip && line.includes(skip))
      continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}
function saveObservation(o) {
  const obs = {
    t: "obs",
    id: newId("obs"),
    ts: Date.now(),
    session: o.session,
    project: o.project,
    tool: o.tool,
    input: clip(sanitize(o.input), MAX_INPUT)
  };
  if (o.error)
    obs.error = clipMiddle(sanitize(o.error), MAX_ERROR);
  appendLine(join(obsDir(o.project), `${safeName(o.session)}.jsonl`), obs);
  return obs;
}
function sessionObservations(project, session) {
  return readLines(join(obsDir(project), `${safeName(session)}.jsonl`));
}
function projectObservations(project, opts = {}) {
  const dir = obsDir(project);
  if (!existsSync(dir))
    return [];
  const skip = opts.skipPrompts ? '"tool":"prompt"' : undefined;
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readLines(join(dir, f), skip));
}
function saveNote(n) {
  const title = clip(sanitize(n.title).replace(/\s+/g, " ").trim(), 200);
  const body = clip(sanitize(n.body), MAX_BODY);
  const same = n.id ? undefined : allNotes().find((x) => x.project === n.project && x.kind === n.kind && x.title === title && x.body === body);
  const note = {
    t: "note",
    id: n.id || same?.id || newId(n.kind),
    ts: Date.now(),
    project: n.project,
    kind: n.kind,
    title,
    body
  };
  if (n.session)
    note.session = n.session;
  if (n.tables?.length)
    note.tables = n.tables.map((t) => sanitize(t));
  if (n.tags?.length)
    note.tags = n.tags.map((t) => sanitize(t));
  if (n.root)
    note.root = n.root;
  appendLine(notesFile(), note);
  return note;
}
function forget(id) {
  if (!allNotes().some((n) => n.id === id))
    return false;
  const file = notesFile();
  const kept = readLines(file).filter((r) => r.id !== id);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, kept.map((r) => `${JSON.stringify(r)}
`).join(""), "utf-8");
  renameSync(tmp, file);
  return true;
}
function allNotes() {
  const byId = new Map;
  for (const r of readLines(notesFile())) {
    if (r.t === "del")
      byId.delete(r.id);
    else if (r.t === "note")
      byId.set(r.id, r);
  }
  return [...byId.values()];
}
function listSessions(project) {
  const root = join(dataDir(), "obs");
  if (!existsSync(root))
    return [];
  const out = [];
  for (const p of project ? [project] : readdirSync(root)) {
    const dir = join(root, p);
    if (!existsSync(dir) || !statSync(dir).isDirectory())
      continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl"))
        continue;
      const recs = readLines(join(dir, f));
      if (!recs.length)
        continue;
      out.push({
        project: p,
        session: recs[0].session,
        start: recs[0].ts,
        end: recs[recs.length - 1].ts,
        records: recs.length,
        errors: recs.filter((r) => r.error).length,
        firstPrompt: recs.find((r) => r.tool === "prompt")?.input
      });
    }
  }
  return out.sort((a, b) => b.end - a.end);
}
function readRecap(project) {
  try {
    return JSON.parse(readFileSync(recapFile(project), "utf-8"));
  } catch {
    return null;
  }
}
function updateRecap(project, session, patch) {
  const prev = readRecap(project);
  const base = prev && prev.session === session ? prev : { session, project, ts: 0 };
  const next = { ...base, ...patch, session, project, ts: Date.now() };
  if (next.firstPrompt)
    next.firstPrompt = clip(sanitize(next.firstPrompt), 300);
  if (next.lastPrompt)
    next.lastPrompt = clip(sanitize(next.lastPrompt), 300);
  if (next.lastReply)
    next.lastReply = clip(sanitize(next.lastReply), MAX_REPLY);
  ensureDir(dirname(recapFile(project)));
  writeFileSync(recapFile(project), JSON.stringify(next), "utf-8");
}
function pruneObservations(days, keepSession) {
  const root = join(dataDir(), "obs");
  if (!(days > 0) || !existsSync(root))
    return 0;
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  for (const project of readdirSync(root)) {
    try {
      const dir = join(root, project);
      if (!statSync(dir).isDirectory())
        continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl") || keepSession && f === `${safeName(keepSession)}.jsonl`)
          continue;
        const file = join(dir, f);
        if (statSync(file).mtimeMs < cutoff) {
          unlinkSync(file);
          removed++;
        }
      }
    } catch {}
  }
  return removed;
}

// src/search.ts
var STOP = new Set(("a an the and or of to in on for is are was be it this that with as at by from not no " + "can do does did done how why what who which when where you your me my we our i any some each " + "please could would should will just also there here get got make use using want need " + "select where join left right inner outer full cross group order limit having union all distinct " + "case when then else end null true false asc desc with into values insert update delete " + "count sum avg min max cast like between exists over partition").split(" "));
var PREFIXES = new Set("dim fct fact stg int mart raw src tmp tbl vw".split(" "));
var CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f]+/g;
var HAS_HIRAGANA = /[\u3040-\u309f]/;
var WORD = /[a-z0-9_$][a-z0-9_$.]*/g;
function tokenize(text) {
  const lower = text.toLowerCase();
  const out = [];
  for (const m of lower.match(WORD) || []) {
    const w = m.replace(/\.+$/, "");
    if (w.length < 2 || STOP.has(w) || /^\d+$/.test(w))
      continue;
    out.push(w);
    if (/[._]/.test(w)) {
      const dotted = w.split(".").filter((p) => p.length > 1);
      const parts = new Set([...dotted, ...w.split(/[._]+/)]);
      for (const part of parts) {
        if (part.length > 2 && part !== w && !STOP.has(part) && !PREFIXES.has(part) && !/^\d+$/.test(part))
          out.push(part);
      }
    }
  }
  for (const run of lower.match(CJK) || []) {
    if (run.length === 1 && !HAS_HIRAGANA.test(run))
      out.push(run);
    for (let i = 0;i + 1 < run.length; i++) {
      const bi = run.slice(i, i + 2);
      if (!HAS_HIRAGANA.test(bi))
        out.push(bi);
    }
  }
  return out;
}
var K1 = 1.2;
var B = 0.75;
function search(docs, query, limit = 5, minIdf = 3) {
  const qTerms = [...new Set(tokenize(query))];
  if (!qTerms.length || !docs.length)
    return [];
  const texts = docs.map((d) => `${d.title} ${d.title} ${d.text}`);
  const cand = docs.map((_, i) => i).filter((i) => {
    const lower = texts[i].toLowerCase();
    return qTerms.some((q) => lower.includes(q));
  });
  const tfs = new Map;
  for (const i of cand) {
    const tf = new Map;
    for (const t of tokenize(texts[i]))
      tf.set(t, (tf.get(t) || 0) + 1);
    tfs.set(i, tf);
  }
  const lens = new Map(cand.map((i) => [i, [...tfs.get(i).values()].reduce((a, b) => a + b, 0)]));
  const avgLen = [...lens.values()].reduce((a, b) => a + b, 0) / (cand.length || 1) || 1;
  const idf = new Map;
  let presentIdf = 0;
  for (const q of qTerms) {
    const n = cand.filter((i) => tfs.get(i).has(q)).length;
    const w = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
    idf.set(q, w);
    if (n)
      presentIdf += w;
  }
  const floor = Math.min(minIdf, presentIdf / 2);
  const hits = [];
  for (const i of cand) {
    const doc = docs[i];
    let score = 0;
    let matchedIdf = 0;
    for (const q of qTerms) {
      const f = tfs.get(i).get(q);
      if (!f)
        continue;
      const w = idf.get(q);
      matchedIdf += w;
      score += w * f * (K1 + 1) / (f + K1 * (1 - B + B * lens.get(i) / avgLen));
    }
    if (matchedIdf > 0 && matchedIdf >= floor)
      hits.push({ doc, score: score * doc.weight });
  }
  return hits.sort((a, b) => b.score - a.score || b.doc.ts - a.doc.ts).slice(0, limit);
}

// src/team.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, readdirSync as readdirSync2, statSync as statSync2, writeFileSync as writeFileSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { dirname as dirname2, join as join2, resolve as resolve2 } from "path";
var TEAM_KINDS = ["caveat", "metric", "query", "decision", "fact", "fix", "note"];
var FOLDER = {
  caveat: "caveats",
  metric: "metrics",
  query: "queries",
  decision: "decisions",
  fact: "facts",
  fix: "fixes",
  note: "notes"
};
function teamDirs(cwd) {
  if (process.env.ENGRAM_TEAM_DIR)
    return [resolve2(process.env.ENGRAM_TEAM_DIR)];
  const dirs = [];
  const local = projectStore(cwd);
  if (local)
    dirs.push(local);
  if (existsSync2(sharedStore()))
    dirs.push(sharedStore());
  return dirs;
}
function sharedStore() {
  return resolve2(process.env.ENGRAM_TEAM_DIR || join2(homedir2(), ".claude", "engram-team"));
}
function projectStore(cwd) {
  const root = projectRoot(cwd);
  let dir = resolve2(cwd);
  for (;; ) {
    if (existsSync2(join2(dir, ".engram")))
      return join2(dir, ".engram");
    if (dir === root || dirname2(dir) === dir)
      return;
    dir = dirname2(dir);
  }
}
function gitRemote(root) {
  try {
    let gitDir = join2(root, ".git");
    if (statSync2(gitDir).isFile()) {
      gitDir = resolve2(root, readFileSync2(gitDir, "utf-8").replace(/^gitdir:\s*/, "").trim());
      const common = join2(gitDir, "commondir");
      if (existsSync2(common))
        gitDir = resolve2(gitDir, readFileSync2(common, "utf-8").trim());
    }
    const config = readFileSync2(join2(gitDir, "config"), "utf-8");
    const remotes = [...config.matchAll(/\[remote "([^"]+)"\]([^[]*)/g)].map((m) => ({
      name: m[1],
      url: m[2].match(/^\s*url\s*=\s*(.+)$/m)?.[1].trim()
    }));
    return (remotes.find((r) => r.name === "origin") || remotes[0])?.url;
  } catch {
    return;
  }
}
function normalizeRemote(url) {
  return url.trim().replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "").replace(/^([^/:]+):(?!\d+\/)/, "$1/").replace(/^([^/:]+):\d+\//, "$1/").replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}
function globMatch(pattern, text) {
  const re = pattern.trim().toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${re}$`).test(text.toLowerCase());
}
function teamScope(cwd) {
  if (projectStore(cwd))
    return { inScope: true, reason: "project has a .engram/ folder" };
  const file = join2(sharedStore(), "scope.json");
  if (!existsSync2(file))
    return { inScope: true, reason: "no scope.json in the team store (all projects)" };
  let cfg;
  try {
    const raw = JSON.parse(readFileSync2(file, "utf-8"));
    const strings = (v) => v === undefined || Array.isArray(v) && v.every((x) => typeof x === "string");
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !strings(raw.projects) || !strings(raw.paths))
      throw new Error('expected {"projects": [strings], "paths": [strings]}');
    cfg = { projects: raw.projects || [], paths: raw.paths || [] };
  } catch (e) {
    return { inScope: false, reason: `scope.json is invalid: ${e.message}` };
  }
  const root = projectRoot(cwd);
  const remote = gitRemote(root);
  const norm = remote ? normalizeRemote(remote) : "";
  const hitProject = norm ? cfg.projects.find((p) => globMatch(normalizeRemote(p), norm)) : undefined;
  if (hitProject)
    return { inScope: true, reason: `remote ${norm} matches "${hitProject}"` };
  const path = root.replace(/\\/g, "/");
  const home = homedir2().replace(/\\/g, "/");
  const hitPath = cfg.paths.find((p) => globMatch(p.replace(/\\/g, "/").replace(/^~(?=\/|$)/, home), path));
  if (hitPath)
    return { inScope: true, reason: `path ${path} matches "${hitPath}"` };
  return {
    inScope: false,
    reason: `not listed in scope.json (remote: ${norm || "none"}, path: ${path})`
  };
}
function parseFrontmatter(content) {
  const text = content.replace(/^﻿/, "").replace(/\r\n/g, `
`);
  const m = text.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/);
  if (!m)
    return { meta: {}, body: text.trim() };
  const meta = {};
  let listKey = null;
  for (const raw of m[1].split(`
`)) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trim().startsWith("#"))
      continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey) {
      meta[listKey].push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv)
      continue;
    const [, key, val] = kv;
    listKey = null;
    if (val === "") {
      meta[key] = [];
      listKey = key;
    } else if (val.startsWith("[") && val.endsWith("]")) {
      meta[key] = splitInline(val.slice(1, -1));
    } else {
      meta[key] = unquote(val);
    }
  }
  return { meta, body: m[2].trim() };
}
function unquote(v) {
  const s = v.trim();
  const dq = s.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/);
  if (dq) {
    try {
      return JSON.parse(dq[1]);
    } catch {
      return dq[1].slice(1, -1);
    }
  }
  const sq = s.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
  if (sq)
    return sq[1].replace(/''/g, "'");
  return s.replace(/\s+#.*$/, "");
}
function splitInline(inner) {
  const out = [];
  for (const m of inner.matchAll(/\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+)\s*(?:,|$)/g)) {
    const v = unquote(m[1]);
    if (v)
      out.push(v);
  }
  return out;
}
var asList = (v) => v === undefined || v === "" ? [] : Array.isArray(v) ? v : [v];
var asText = (v) => Array.isArray(v) ? v.join(", ") || undefined : v || undefined;
function loadTeam(cwd) {
  const byId = new Map;
  const skipped = [];
  if (!teamScope(cwd).inScope)
    return { items: [], skipped };
  for (const base of [...teamDirs(cwd)].reverse()) {
    for (const kind of TEAM_KINDS) {
      const dir = join2(base, FOLDER[kind]);
      if (!existsSync2(dir))
        continue;
      for (const f of readdirSync2(dir)) {
        if (!f.endsWith(".md"))
          continue;
        const path = join2(dir, f);
        try {
          const { meta, body } = parseFrontmatter(readFileSync2(path, "utf-8"));
          const id = asText(meta.id);
          const title = asText(meta.title);
          if (!id || !title) {
            skipped.push({ path, reason: "missing id or title in frontmatter" });
            continue;
          }
          byId.set(id, {
            id,
            kind: TEAM_KINDS.includes(asText(meta.kind) || "") ? asText(meta.kind) : kind,
            title,
            summary: asText(meta.summary),
            tables: asList(meta.target_tables ?? meta.tables),
            tags: asList(meta.tags),
            author: asText(meta.author),
            status: asText(meta.status),
            created_at: asText(meta.created_at),
            body,
            path
          });
        } catch (e) {
          skipped.push({ path, reason: e.message });
        }
      }
    }
  }
  return { items: [...byId.values()].filter((i) => i.status !== "deprecated"), skipped };
}
function summaryOf(item) {
  if (item.summary)
    return item.summary;
  const line = item.body.split(`
`).map((l) => l.trim()).find((l) => l && !l.startsWith("#") && !l.startsWith("```") && !/^[-*_]{3,}$/.test(l));
  return line ? line.replace(/^[-*>]\s+/, "") : "";
}
function slugify(text) {
  return text.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
var q = (s) => JSON.stringify(s.replace(/[\r\n]+/g, " ").trim());
function serialize(item) {
  const lines = ["---", `id: ${q(item.id)}`, `kind: ${q(item.kind)}`, `title: ${q(item.title)}`];
  if (item.summary)
    lines.push(`summary: ${q(item.summary)}`);
  if (item.tables.length)
    lines.push(`target_tables: [${item.tables.map(q).join(", ")}]`);
  if (item.tags.length)
    lines.push(`tags: [${item.tags.map(q).join(", ")}]`);
  if (item.author)
    lines.push(`author: ${q(item.author)}`);
  if (item.created_at)
    lines.push(`created_at: ${q(item.created_at)}`);
  lines.push("---", "", item.body.trim(), "");
  return lines.join(`
`);
}
function writeTeamItem(base, item) {
  const clean = {
    ...item,
    title: sanitize(item.title),
    summary: item.summary ? sanitize(item.summary) : undefined,
    body: sanitize(item.body),
    tables: item.tables.map(sanitize),
    tags: item.tags.map(sanitize)
  };
  const dir = join2(base, FOLDER[clean.kind]);
  if (!existsSync2(dir))
    mkdirSync2(dir, { recursive: true });
  const stem = slugify(clean.title) || clean.id;
  let path = join2(dir, `${stem}.md`);
  for (let n = 2;existsSync2(path); n++) {
    if (parseFrontmatter(readFileSync2(path, "utf-8")).meta.id === clean.id)
      break;
    path = join2(dir, `${stem}-${n}.md`);
  }
  writeFileSync2(path, serialize(clean), "utf-8");
  return path;
}

// src/hooks.ts
var RETENTION_DAYS = Number(process.env.ENGRAM_RETENTION_DAYS) > 0 ? Number(process.env.ENGRAM_RETENTION_DAYS) : 90;
var PROMPT_BUDGET = 1500;
var SESSION_BUDGET = 6000;
var TRIVIAL = new Set("ls cd pwd cat head tail less more echo printf which whoami date clear true sleep wc file tree".split(" "));
var oneLine = (s, max) => clip(s.replace(/\s+/g, " ").trim(), max);
function extractTables(sql) {
  const out = new Set;
  for (const m of sql.matchAll(/\b(?:from|join|into|update|table)\s+([`"[]?[\w$-]+(?:[`"\]]?\.[`"[]?[\w$-]+){0,2}[`"\]]?)/gi)) {
    const name = m[1].replace(/[`"[\]]/g, "");
    if (!/^(select|with|lateral|unnest|the|a)$/i.test(name))
      out.add(name);
  }
  return [...out];
}
var FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
var CODE_FILE = /\.(sql|py|r|ipynb|ya?ml|sh|jinja2?|j2|md|js|ts)$/i;
var SQL_WORD = /\b(select|insert|update|delete|merge|create|alter|drop|grant|with|copy|from)\b/i;
function looksLikeData(text) {
  const lines = text.split(`
`).filter((l) => l.trim());
  if (lines.length < 3)
    return false;
  const delimited = lines.filter((l) => (l.match(/[,\t|;]/g) || []).length >= 3).length;
  return delimited / lines.length >= 0.8 && !SQL_WORD.test(lines.slice(0, 3).join(" "));
}
function notebookSource(content) {
  try {
    const nb = JSON.parse(content);
    return (nb.cells || []).filter((c) => c.cell_type !== "raw").map((c) => Array.isArray(c.source) ? c.source.join("") : c.source || "").join(`
`);
  } catch {
    return "";
  }
}
function fileText(tool, ti) {
  const path = typeof ti.file_path === "string" ? ti.file_path : ti.notebook_path;
  if (typeof path !== "string")
    return null;
  const head = `${tool.toLowerCase()} ${path}`;
  if (!CODE_FILE.test(path))
    return head;
  const edits = Array.isArray(ti.edits) ? ti.edits.map((e) => e.new_string) : [];
  const content = typeof ti.content === "string" && /\.ipynb$/i.test(path) ? notebookSource(ti.content) : ti.content;
  const text = [content, ti.new_string, ti.new_source, ...edits].filter((v) => typeof v === "string").join(`
`);
  if (!text || looksLikeData(text) || /\.sql$/i.test(path) && !SQL_WORD.test(text))
    return head;
  return `${head}
${text}`;
}
function toolText(input) {
  const ti = input.tool_input || {};
  if (input.tool_name === "Bash")
    return typeof ti.command === "string" ? ti.command : null;
  if (FILE_TOOLS.has(input.tool_name || ""))
    return fileText(input.tool_name, ti);
  const fields = [];
  const visit = (obj, depth) => {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && /^(sql|query|statement|command)$/i.test(k))
        fields.push(v);
      else if (depth < 1 && v && typeof v === "object" && !Array.isArray(v))
        visit(v, depth + 1);
    }
  };
  visit(ti, 0);
  return fields.length ? fields.join(`
`) : null;
}
function firstWord(cmd) {
  return cmd.trim().replace(/^(?:\w+=\S*\s+)+/, "").split(/\s+/)[0] || "";
}
function isTrivial(input, text) {
  if (input.tool_name !== "Bash")
    return false;
  if (/engram[\\/].*cli\.mjs|dist[\\/]cli\.mjs/.test(text))
    return true;
  return text.split(/&&|\|\||[;|\n]/).every((seg) => {
    const s = seg.trim();
    return !s || TRIVIAL.has(firstWord(s)) || /^git\s+(status|diff|log|show|branch)\b/.test(s);
  });
}
function similar(a, b) {
  if (a.tool !== b.tool)
    return false;
  if (a.tool === "Bash" && firstWord(a.input) === firstWord(b.input))
    return true;
  const ta = new Set(tokenize(a.input));
  const tb = new Set(tokenize(b.input));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter / (ta.size + tb.size - inter || 1) >= 0.3;
}
function errorHeadline(error) {
  const lines = error.split(`
`).map((l) => l.trim()).filter((l) => l && l !== "…" && !/^exit code \d+$/i.test(l));
  if (!lines.length)
    return error.trim();
  return /traceback|^\s*at\s|stack trace/i.test(error) ? lines[lines.length - 1] : lines[0];
}
function detectFix(history, success, root) {
  if (FILE_TOOLS.has(success.tool))
    return null;
  const isRun = (o) => o.id !== success.id && o.tool !== "prompt" && !FILE_TOOLS.has(o.tool);
  for (let i = history.length - 1;i >= 0 && i >= history.length - 15; i--) {
    const prev = history[i];
    if (!isRun(prev) || !similar(prev, success))
      continue;
    if (!prev.error)
      return null;
    if (history.slice(i + 1).some((o) => isRun(o) && !o.error && similar(o, prev)))
      return null;
    const errLine = errorHeadline(prev.error);
    return saveNote({
      project: success.project,
      session: success.session,
      kind: "fix",
      title: `Fix: ${oneLine(errLine, 120)}`,
      body: `Failed:
\`\`\`
${prev.input}
\`\`\`
Error:
\`\`\`
${prev.error}
\`\`\`
Worked:
\`\`\`
${success.input}
\`\`\``,
      tables: [...new Set([...extractTables(prev.input), ...extractTables(success.input)])],
      root
    });
  }
  return null;
}
function onToolUse(input) {
  if (process.env.ENGRAM_DISABLE_CAPTURE === "1" || !input.tool_name)
    return;
  const text = toolText(input);
  if (!text || isTrivial(input, text))
    return;
  const project = projectId(input.cwd);
  const obs = saveObservation({
    session: input.session_id,
    project,
    tool: input.tool_name,
    input: text,
    error: input.hook_event_name === "PostToolUseFailure" ? input.error || "failed" : undefined
  });
  if (!obs.error)
    detectFix(sessionObservations(project, input.session_id), obs, projectRoot(input.cwd));
}
function onStop(input) {
  if (!input.last_assistant_message)
    return;
  updateRecap(projectId(input.cwd), input.session_id, { lastReply: input.last_assistant_message });
}
function buildDocs(cwd, opts = {}) {
  const project = projectId(cwd);
  const docs = [];
  const team = loadTeam(cwd).items;
  const teamIds = new Set(team.map((t) => t.id));
  for (const t of team) {
    docs.push({
      id: t.id,
      source: "team",
      kind: t.kind,
      title: t.title,
      text: `${t.tables.join(" ")} ${t.tags.join(" ")} ${t.summary || ""} ${t.body}`,
      ts: Date.parse(t.created_at || "") || 0,
      weight: 1.5,
      display: summaryOf(t),
      ref: t.path
    });
  }
  for (const n of allNotes()) {
    if (teamIds.has(n.id))
      continue;
    docs.push({
      id: n.id,
      source: "note",
      kind: n.kind,
      title: n.title,
      text: `${(n.tables || []).join(" ")} ${(n.tags || []).join(" ")} ${n.body}`,
      ts: n.ts,
      weight: n.project === project ? 1.3 : 1.1,
      display: n.kind === "fix" ? fixDisplay(n.body) : n.body
    });
  }
  for (const o of projectObservations(project, { skipPrompts: opts.prompts === false })) {
    if (o.session === opts.excludeSession || o.tool === "prompt" && opts.prompts === false)
      continue;
    docs.push({
      id: o.id,
      source: "obs",
      kind: o.tool === "prompt" ? "prompt" : o.error ? "error" : FILE_TOOLS.has(o.tool) ? "file" : "run",
      title: o.tool,
      text: `${o.input} ${o.error || ""}`,
      ts: o.ts,
      weight: o.error ? 1 : o.tool === "prompt" ? 0.5 : 0.6,
      display: o.error ? `error: ${oneLine(o.error, 160)} — from: ${oneLine(o.input, 120)}` : oneLine(o.input, 200),
      group: FILE_TOOLS.has(o.tool) ? `file:${o.input.split(`
`)[0].replace(/^\S+\s+/, "")}` : undefined
    });
  }
  return docs;
}
function fixDisplay(body) {
  const worked = body.match(/Worked:\n```\n([\s\S]*?)\n```/);
  return worked ? `worked: ${worked[1]}` : body;
}
function formatHit(h) {
  const d = h.doc;
  const text = d.display ?? d.text;
  if (d.source === "team")
    return `- [team ${d.kind}] ${d.title}: ${oneLine(text, 160)} (${d.ref})`;
  if (d.source === "note")
    return `- [${d.kind} ${localDay(d.ts)} ${d.id}] ${d.title}: ${oneLine(text, 220)}`;
  return `- [past ${d.kind} ${localDay(d.ts)}] ${oneLine(text, 240)}`;
}
function uniqueLines(hits, max) {
  const seen = new Set;
  const out = [];
  for (const h of hits) {
    const key = h.doc.group ?? h.doc.display ?? h.doc.text;
    if (seen.has(key))
      continue;
    seen.add(key);
    out.push(formatHit(h));
    if (out.length === max)
      break;
  }
  return out;
}
function fitLines(header, lines, budget) {
  const out = [header];
  let size = header.length;
  for (const l of lines) {
    if (size + l.length + 1 > budget)
      break;
    out.push(l);
    size += l.length + 1;
  }
  return out.length > 1 ? out.join(`
`) : "";
}
function onPrompt(input) {
  const prompt = input.prompt || "";
  const project = projectId(input.cwd);
  let context = "";
  if (prompt.trim().length >= 4 && !prompt.trim().startsWith("/")) {
    const hits = search(buildDocs(input.cwd, { excludeSession: input.session_id, prompts: false }), prompt, 20);
    context = fitLines("engram: records from earlier sessions and team knowledge that match this prompt (may be outdated; verify before relying on them):", uniqueLines(hits, 5), PROMPT_BUDGET);
  }
  if (process.env.ENGRAM_DISABLE_CAPTURE !== "1" && prompt.trim()) {
    const saved = saveObservation({
      session: input.session_id,
      project,
      tool: "prompt",
      input: prompt
    });
    const first = sessionObservations(project, input.session_id).find((o) => o.tool === "prompt");
    updateRecap(project, input.session_id, {
      firstPrompt: (first || saved).input,
      lastPrompt: prompt
    });
  }
  return context;
}
function teamIndex(items, skipped, budget) {
  if (!items.length && !skipped)
    return "";
  const order = ["caveat", "metric", "fix", "query", "decision", "fact", "note"];
  const sorted = [...items].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const lines = sorted.map((t) => {
    const tables = t.tables.length ? ` [${t.tables.join(", ")}]` : "";
    const summary = summaryOf(t);
    return `- ${t.kind}: ${t.title}${tables}${summary ? ` — ${oneLine(summary, 140)}` : ""} (${t.path})`;
  });
  const out = [
    fitLines(`engram team knowledge (${items.length} items). Full details are in the listed files:`, lines, budget)
  ].filter(Boolean);
  const shown = out.length ? out[0].split(`
`).length - 1 : 0;
  if (shown < items.length)
    out.push(`engram: ${items.length - shown} more team item(s) not listed; search them with /engram:recall <words>`);
  if (skipped)
    out.push(`engram: ${skipped} team file(s) skipped because of invalid frontmatter; run /engram:status for details`);
  return out.join(`
`);
}
function onSessionStart(input) {
  try {
    pruneObservations(RETENTION_DAYS, input.session_id);
  } catch {}
  const project = projectId(input.cwd);
  const parts = [];
  const recap = readRecap(project);
  if (recap && recap.session !== input.session_id && input.source !== "compact") {
    const lines = [`engram: previous session in this project (${localDay(recap.ts)}):`];
    if (recap.firstPrompt)
      lines.push(`- started with: ${oneLine(recap.firstPrompt, 200)}`);
    if (recap.lastPrompt && recap.lastPrompt !== recap.firstPrompt)
      lines.push(`- last request: ${oneLine(recap.lastPrompt, 200)}`);
    if (recap.lastReply)
      lines.push(`- last reply: ${oneLine(recap.lastReply, 400)}`);
    if (lines.length > 1)
      parts.push(lines.join(`
`));
  }
  const { items, skipped } = loadTeam(input.cwd);
  const index = teamIndex(items, skipped.length, SESSION_BUDGET - parts.join(`
`).length - 300);
  if (index)
    parts.push(index);
  const notes = allNotes();
  const recent = notes.filter((n) => n.project === project).sort((a, b) => b.ts - a.ts).slice(0, 5).map((n) => `- [${n.kind} ${n.id}] ${oneLine(n.title, 140)}`);
  if (recent.length)
    parts.push(["engram: latest notes saved in this project:", ...recent].join(`
`));
  parts.push(`engram: personal memory holds ${notes.length} saved note(s); matching ones are added to prompts automatically. ` + "Durable findings (data caveats, metric definitions, fixes) can be saved with /engram:save; past sessions are listed by /engram:history.");
  return parts.join(`

`);
}

// src/cli.ts
var USAGE = `engram <command>
  recall <words...> [--limit N]        search personal memory and team knowledge
  save --kind K --title T [--tables a,b] [--tags x,y] [--body TEXT | stdin]
                                       kinds: ${KINDS.join(", ")}
  forget <note-id>                     erase a saved note
  share [<note-id>] [--to DIR]         list shareable notes, or write one as a team Markdown file
  history [--all] [--limit N]          list past sessions (this project, or all projects)
  history <session-id|YYYY-MM-DD>      show what happened in a session or on a day
  status                               show what is stored, loaded and in team scope
  hook <session-start|prompt|tool|stop>  used by hooks/hooks.json (reads JSON on stdin)`;
var OPTIONS = new Set(["kind", "title", "tables", "tags", "body", "limit", "to"]);
function parse(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0;i < argv.length; i++) {
    const name = argv[i].startsWith("--") ? argv[i].slice(2) : "";
    if (OPTIONS.has(name))
      opt[name] = argv[++i] ?? "";
    else
      pos.push(argv[i]);
  }
  return { pos, opt };
}
var list = (v) => v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
function readStdin() {
  try {
    return readFileSync3(0, "utf-8");
  } catch {
    return "";
  }
}
function logError(e) {
  try {
    mkdirSync3(dataDir(), { recursive: true });
    appendFileSync2(join3(dataDir(), "error.log"), `${new Date().toISOString()} ${e?.stack || e}
`);
  } catch {}
}
function runHook(event) {
  const raw = readStdin();
  const input = JSON.parse(raw);
  if (!input.cwd)
    input.cwd = process.cwd();
  let out = "";
  if (event === "session-start")
    out = onSessionStart(input);
  else if (event === "prompt")
    out = onPrompt(input);
  else if (event === "tool")
    onToolUse(input);
  else if (event === "stop")
    onStop(input);
  if (out)
    process.stdout.write(`${out}
`);
}
function recall(words, limit) {
  const query = words.join(" ");
  if (!query.trim())
    return "Usage: engram recall <words...>";
  const lines = uniqueLines(search(buildDocs(process.cwd()), query, limit * 4, 0), limit);
  if (!lines.length)
    return `No memory or team knowledge matches "${query}".`;
  return [`engram recall: "${query}"`, ...lines].join(`
`);
}
function save(opt) {
  const kind = opt.kind || "note";
  if (!KINDS.includes(kind))
    throw new Error(`--kind must be one of: ${KINDS.join(", ")}`);
  if (!opt.title?.trim())
    throw new Error("--title is required");
  const body = opt.body || (process.stdin.isTTY ? "" : readStdin());
  const note = saveNote({
    project: projectId(process.cwd()),
    kind,
    title: opt.title,
    body: body.trim() || opt.title,
    tables: list(opt.tables),
    tags: list(opt.tags),
    root: projectRoot(process.cwd())
  });
  const personal = teamScope(process.cwd()).inScope ? "" : " (personal only: outside the team scope)";
  return `Saved ${note.kind} ${note.id}: ${note.title}${personal}`;
}
var shareable = (n) => !!n.root && teamScope(n.root).inScope;
function share(id, opt) {
  if (!id) {
    const shared = new Set(loadTeam(process.cwd()).items.map((t) => t.id));
    const candidates = allNotes().filter((n) => !shared.has(n.id) && shareable(n)).sort((a, b) => b.ts - a.ts).slice(0, 20);
    if (!candidates.length)
      return "No shareable notes. Notes saved inside the team scope appear here.";
    return [
      "Shareable notes (saved inside the team scope, not shared yet):",
      ...candidates.map((n) => `- ${n.id} [${n.kind} ${localDay(n.ts)}] ${n.title}`),
      "Share one with: engram share <note-id>"
    ].join(`
`);
  }
  const note = allNotes().find((n) => n.id === id);
  if (!note)
    throw new Error(`No saved note with id "${id}". Find ids with: engram recall <words>`);
  if (!shareable(note)) {
    throw new Error(`${id} comes from a project outside the team scope (${note.root || "unknown project"}), so it stays personal. ` + "Add that project to scope.json in the team repository, or give it a .engram/ folder.");
  }
  const base = opt.to || teamDirs(process.cwd())[0];
  if (!base) {
    throw new Error("No team store found. Clone the team repo to ~/.claude/engram-team, create .engram/ in the project, or pass --to DIR.");
  }
  const path = writeTeamItem(base, {
    id: note.id,
    kind: note.kind,
    title: note.title,
    tables: note.tables || [],
    tags: note.tags || [],
    author: process.env.ENGRAM_AUTHOR,
    created_at: new Date(note.ts).toISOString().slice(0, 10),
    body: note.body
  });
  return `Wrote ${path}
Review it, then commit and open a PR in that repository to share it with the team.`;
}
function history(pos, opt) {
  const project = projectId(process.cwd());
  const target = pos.find((p) => p !== "--all");
  if (!target) {
    const all = pos.includes("--all");
    const limit = Math.floor(Number(opt.limit));
    const sessions = listSessions(all ? undefined : project).slice(0, limit > 0 ? limit : 15);
    if (!sessions.length)
      return "No recorded sessions.";
    return [
      `Sessions${all ? "" : ` in ${project}`} (newest first):`,
      ...sessions.map((s) => `- ${s.session.slice(0, 8)} ${localTime(s.start)} → ${localTime(s.end).slice(11)} ` + `${s.records} records${s.errors ? `, ${s.errors} errors` : ""}${all ? ` [${s.project}]` : ""}` + (s.firstPrompt ? ` — ${s.firstPrompt.replace(/\s+/g, " ").slice(0, 100)}` : "")),
      "Show one with: engram history <session-id or YYYY-MM-DD>"
    ].join(`
`);
  }
  const byDay = /^\d{4}-\d{2}-\d{2}$/.test(target);
  const recs = projectObservations(project).filter((o) => byDay ? localDay(o.ts) === target : o.session.startsWith(target)).sort((a, b) => a.ts - b.ts).slice(-200);
  if (!recs.length)
    return `Nothing recorded for "${target}" in ${project}.`;
  const ids = [...new Set(recs.map((o) => o.session))];
  if (!byDay && ids.length > 1)
    return [
      `"${target}" matches ${ids.length} sessions; use a longer prefix:`,
      ...ids.map((i) => `- ${i}`)
    ].join(`
`);
  return [
    `Timeline for ${target} in ${project}:`,
    ...recs.map((o) => {
      const what = o.input.replace(/\s+/g, " ").slice(0, 160);
      const err = o.error ? ` ✗ ${o.error.replace(/\s+/g, " ").slice(0, 120)}` : "";
      return `- ${localTime(o.ts).slice(11)} ${byDay ? `${o.session.slice(0, 8)} ` : ""}${o.tool}: ${what}${err}`;
    })
  ].join(`
`);
}
function status() {
  const cwd = process.cwd();
  const project = projectId(cwd);
  const notes = allNotes();
  const byKind = KINDS.map((k) => [k, notes.filter((n) => n.kind === k).length]).filter(([, c]) => c);
  const obs = projectObservations(project);
  const { items, skipped } = loadTeam(cwd);
  const lines = [
    `engram status`,
    `- data dir: ${dataDir()}`,
    `- project: ${project}`,
    `- saved notes: ${notes.length}${byKind.length ? ` (${byKind.map(([k, c]) => `${k} ${c}`).join(", ")})` : ""}`,
    `- captured observations for this project: ${obs.length} (errors: ${obs.filter((o) => o.error).length})`,
    `- team scope: ${teamScope(cwd).inScope ? "in scope" : "out of scope"} (${teamScope(cwd).reason})`,
    `- team stores: ${teamDirs(cwd).join(", ") || "none"}`,
    `- team items loaded: ${items.length}`
  ];
  for (const s of skipped)
    lines.push(`  - skipped ${s.path}: ${s.reason}`);
  return lines.join(`
`);
}
function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "hook") {
    try {
      runHook(rest[0]);
    } catch (e) {
      logError(e);
    }
    return;
  }
  const { pos, opt } = parse(rest);
  try {
    let out;
    if (cmd === "recall")
      out = recall(pos, Number(opt.limit) || 10);
    else if (cmd === "save")
      out = save(opt);
    else if (cmd === "forget")
      out = forget(pos[0] || "") ? `Forgot ${pos[0]}` : `No saved note with id "${pos[0]}"`;
    else if (cmd === "share")
      out = share(pos[0], opt);
    else if (cmd === "history")
      out = history(pos, opt);
    else if (cmd === "status")
      out = status();
    else
      out = USAGE;
    console.log(out);
  } catch (e) {
    console.error(`engram: ${e.message}`);
    process.exitCode = 1;
  }
}
if (Number(process.versions.node.split(".")[0]) < 18) {
  if (process.argv[2] !== "hook")
    console.error("engram needs Node.js 18 or newer.");
} else {
  main();
}
