// src/cli.ts
import { existsSync as existsSync4, readFileSync as readFileSync4, readdirSync as readdirSync4, statSync as statSync4 } from "fs";
import { dirname as dirname3, join as join4 } from "path";

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
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { homedir } from "os";
import { dirname, join, posix, resolve, win32 } from "path";

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
function myNumberOk(digits) {
  const d = digits.replace(/\D/g, "");
  if (d.length !== 12)
    return false;
  const n = [...d].map(Number);
  let sum = 0;
  for (let i = 1;i <= 11; i++)
    sum += n[11 - i] * (i <= 6 ? i + 1 : i - 5);
  const check = 11 - sum % 11;
  return (check >= 10 ? 0 : check) === n[11];
}
var MY_NUMBER_LABEL = "(?:マイナンバー(?:カード)?|個人番号|my\\s*number)";
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
  [
    /(\s--?[\w-]*(?:password|passwd|passphrase|secret|token|key|pwd)(?:=|\s+))(?!-?\d+(?:\.\d+)?\b)(\S+)/gi,
    "$1[REDACTED_SECRET]"
  ],
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
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, "[REDACTED_GOOGLE_TOKEN]"],
  [/\bGOCSPX-[A-Za-z0-9_-]{20,}/g, "[REDACTED_GOOGLE_SECRET]"],
  [/\bhf_[A-Za-z0-9]{30,}/g, "[REDACTED_HF_TOKEN]"],
  [/\bnpm_[A-Za-z0-9]{30,}/g, "[REDACTED_NPM_TOKEN]"],
  [
    /((?:\/\/[^\s]*|)_authToken["']?\s*[:=]\s*|\b_authToken\s+)["']?[A-Za-z0-9_-]{8,}["']?/gi,
    "$1[REDACTED_SECRET]"
  ],
  [/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, "[REDACTED_SENDGRID_KEY]"],
  [/\b((?:Set-)?Cookie:\s*)(?=[^\n]*=)[^\n]+/gi, "$1[REDACTED_COOKIE]"],
  [/(\bsshpass\b[^\n]*?\s-p\s*)["']?[^\s"']+["']?/g, "$1[REDACTED_SECRET]"],
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
  ],
  [
    new RegExp(`(${MY_NUMBER_LABEL}\\s*(?:は|が|:|：|=|is)?\\s*)(\\d{4}[ -]?\\d{4}[ -]?\\d{4})`, "gi"),
    (m, label, digits) => myNumberOk(digits) ? `${label}[REDACTED_MY_NUMBER]` : m
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
function noteSource(n) {
  return n.source ?? (n.kind === "fix" && n.session ? "auto" : "user");
}
var MAX_INPUT = 2000;
var MAX_ERROR = 1000;
var MAX_BODY = 4000;
var MAX_REPLY = 800;
function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
var SQL_WORD = /\b(select|insert|update|delete|merge|create|alter|drop|grant|with|copy|from)\b/i;
var delimiters = (line) => (line.match(/[,\t|;]/g) || []).length;
function omitDataRows(text) {
  const lines = text.split(`
`);
  const out = [];
  for (let i = 0;i < lines.length; i++) {
    const width = delimiters(lines[i]);
    if (width < 2) {
      out.push(lines[i]);
      continue;
    }
    let end = i;
    while (end < lines.length && delimiters(lines[end]) === width)
      end++;
    const run = lines.slice(i, end);
    if (run.length < 3 || SQL_WORD.test(run.slice(0, 3).join(" ")))
      out.push(...run);
    else
      out.push(run[0], `[${run.length - 1} data rows omitted]`);
    i = end - 1;
  }
  return out.join(`
`);
}
function firstSentence(text) {
  const trimmed = text.trim();
  const m = /^[\s\S]*?[.!?。](?=\s|$)/.exec(trimmed);
  return (m ? m[0] : trimmed).trim();
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
var VCS_MARKERS = [".git", ".jj"];
var FOLDER_MARKERS = [".engram", "dbt_project.yml", "pyproject.toml"];
var isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
var hasMarker = (dir, m) => m === ".git" || m === "dbt_project.yml" || m === "pyproject.toml" ? existsSync(join(dir, m)) : isDir(join(dir, m));
function projectRoot(cwd, home = homedir()) {
  const start = resolve(cwd);
  const homeKey = pathKey(home);
  let folder;
  for (let dir = start;pathKey(dir) !== homeKey; ) {
    if (VCS_MARKERS.some((m) => hasMarker(dir, m)))
      return dir;
    if (!folder && FOLDER_MARKERS.some((m) => hasMarker(dir, m)))
      folder = dir;
    const parent = dirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  return folder ?? start;
}
function pathKey(p, platform = process.platform) {
  const s = (platform === "win32" ? win32 : posix).resolve(p).replace(/\\/g, "/");
  const trimmed = s.length > 1 ? s.replace(/\/+$/, "") : s;
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}
function projectIdOfRoot(root, platform = process.platform) {
  const key = pathKey(root, platform);
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 8);
  const name = (posix.basename(key) || "root").replace(/[^\w.-]/g, "_");
  return `${name}-${hash}`;
}
function projectId(cwd) {
  return projectIdOfRoot(projectRoot(cwd));
}
function ensureDir(dir) {
  if (!existsSync(dir))
    mkdirSync(dir, { recursive: true });
  return dir;
}
var obsDir = (project) => join(dataDir(), "obs", project);
var observationDir = obsDir;
var indexRoot = () => join(dataDir(), "index");
function invalidateIndex() {
  rmSync(indexRoot(), { recursive: true, force: true });
}
var notesFile = () => join(dataDir(), "notes.jsonl");
var recapRoot = () => join(dataDir(), "recaps");
var recapFile = (project, session) => join(recapRoot(), project, `${safeName(session)}.json`);
var legacyRecapFile = (project) => join(recapRoot(), `${project}.json`);
var errorLogFile = () => join(dataDir(), "error.log");
function safeName(session) {
  return session.replace(/[^\w-]/g, "_");
}
var sessionLogName = (session) => `${safeName(session)}.jsonl`;
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
    input: clip(omitDataRows(sanitize(o.input)), MAX_INPUT)
  };
  if (o.error)
    obs.error = clipMiddle(sanitize(o.error), MAX_ERROR);
  appendLine(join(obsDir(o.project), `${safeName(o.session)}.jsonl`), obs);
  return obs;
}
function sessionObservations(project, session) {
  return readLines(join(obsDir(project), `${safeName(session)}.jsonl`));
}
var injectedFile = (project, session) => join(obsDir(project), `${safeName(session)}.injected`);
function injectedDocs(project, session) {
  try {
    const text = readFileSync(injectedFile(project, session), "utf-8");
    return new Set(text.split(`
`).filter(Boolean));
  } catch {
    return new Set;
  }
}
function markInjected(project, session, ids) {
  if (!ids.length)
    return;
  const file = injectedFile(project, session);
  ensureDir(dirname(file));
  appendFileSync(file, `${endsTorn(file) ? `
` : ""}${ids.join(`
`)}
`, "utf-8");
}
function clearInjected(project, session) {
  try {
    unlinkSync(injectedFile(project, session));
  } catch {}
}
function projectObservations(project, opts = {}) {
  const dir = obsDir(project);
  if (!existsSync(dir))
    return [];
  const skip = opts.skipPrompts ? '"tool":"prompt"' : undefined;
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readLines(join(dir, f), skip));
}
function allObservations() {
  const root = join(dataDir(), "obs");
  if (!existsSync(root))
    return [];
  return readdirSync(root).flatMap((p) => {
    try {
      return statSync(join(root, p)).isDirectory() ? projectObservations(p) : [];
    } catch {
      return [];
    }
  });
}
function saveNote(n) {
  const title = clip(sanitize(n.title).replace(/\s+/g, " ").trim(), 200);
  const body = clip(sanitize(n.body), MAX_BODY);
  const same = n.id ? undefined : allNotes().find((x) => x.project === n.project && x.kind === n.kind && x.title === title && x.body === body);
  const now = Date.now();
  const note = {
    t: "note",
    id: n.id || same?.id || newId(n.kind),
    ts: now,
    project: n.project,
    kind: n.kind,
    title,
    body,
    source: n.source ?? "user",
    created: same?.created ?? same?.ts ?? now
  };
  if (n.global || same?.global)
    note.global = true;
  if (n.session)
    note.session = n.session;
  if (n.tables?.length)
    note.tables = n.tables.map((t) => sanitize(t));
  if (n.tags?.length)
    note.tags = n.tags.map((t) => sanitize(t));
  const sources = [...same?.sources || [], ...n.sources || []];
  if (sources.length)
    note.sources = [...new Set(sources)];
  if (n.root)
    note.root = n.root;
  appendLine(notesFile(), note);
  if (note.source === "auto")
    resetHits(allNotes().filter((x) => x.project === note.project && x.kind === note.kind && x.title === note.title && noteSource(x) === "auto").map((x) => x.id), now);
  return note;
}
function forget(id) {
  if (!allNotes().some((n) => n.id === id))
    return false;
  rewriteNotes(id);
  return true;
}
function rewriteNotes(drop) {
  const latest = new Map;
  for (const r of readLines(notesFile())) {
    latest.delete(r.id);
    if (r.t === "note" && r.id !== drop)
      latest.set(r.id, r);
  }
  writeAtomic(notesFile(), [...latest.values()].map((r) => `${JSON.stringify(r)}
`).join(""));
}
function compactNotes(force = false) {
  const file = notesFile();
  if (!existsSync(file))
    return false;
  const lines = readFileSync(file, "utf-8").split(`
`).filter(Boolean).length;
  const live = new Set(readLines(file).map((r) => r.id)).size;
  const dead = lines - live;
  if (!(force ? dead > 0 : dead > live))
    return false;
  rewriteNotes();
  return true;
}
function allNotes() {
  const byId = new Map;
  for (const r of readLines(notesFile())) {
    if (r.t === "del")
      byId.delete(r.id);
    else if (r.t === "note")
      byId.set(r.id, r.root ? { ...r, project: projectIdOfRoot(r.root) } : r);
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
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}
function readRecap(project, exceptSession) {
  const dir = join(recapRoot(), project);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f)) : [];
  let best = null;
  for (const file of [...files, legacyRecapFile(project)]) {
    const r = readJson(file);
    if (!r || typeof r.ts !== "number" || r.session === exceptSession)
      continue;
    if (!best || r.ts > best.ts)
      best = r;
  }
  return best;
}
function updateRecap(project, session, patch) {
  const file = recapFile(project, session);
  const prev = readJson(file);
  const base = prev && prev.session === session ? prev : { session, project, ts: 0 };
  const next = { ...base, ...patch, session, project, ts: Date.now() };
  if (next.firstPrompt)
    next.firstPrompt = clip(omitDataRows(sanitize(next.firstPrompt)), 300);
  if (next.lastPrompt)
    next.lastPrompt = clip(omitDataRows(sanitize(next.lastPrompt)), 300);
  if (next.lastReply)
    next.lastReply = clip(sanitize(firstSentence(next.lastReply)), MAX_REPLY);
  ensureDir(dirname(file));
  writeAtomic(file, JSON.stringify(next));
}
function recapFiles() {
  const root = recapRoot();
  if (!existsSync(root))
    return [];
  const out = [];
  for (const f of readdirSync(root)) {
    const path = join(root, f);
    try {
      if (f.endsWith(".json"))
        out.push(path);
      else if (statSync(path).isDirectory()) {
        for (const g of readdirSync(path))
          if (g.endsWith(".json"))
            out.push(join(path, g));
      }
    } catch {}
  }
  return out;
}
function pruneRecaps(cutoff) {
  const root = recapRoot();
  if (!existsSync(root))
    return 0;
  let removed = 0;
  for (const project of readdirSync(root)) {
    try {
      const dir = join(root, project);
      if (!statSync(dir).isDirectory())
        continue;
      const files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => ({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
      for (const { file, mtime } of files.slice(1)) {
        if (mtime < cutoff) {
          unlinkSync(file);
          removed++;
        }
      }
    } catch {}
  }
  return removed;
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
        if (!/\.(jsonl|injected)$/.test(f))
          continue;
        if (keepSession && f.replace(/\.(jsonl|injected)$/, "") === safeName(keepSession))
          continue;
        const file = join(dir, f);
        if (statSync(file).mtimeMs < cutoff) {
          unlinkSync(file);
          removed++;
        }
      }
    } catch {}
  }
  if (removed)
    invalidateIndex();
  return removed + pruneRecaps(cutoff);
}
var OBS_FIELDS = ["input", "error"];
var NOTE_FIELDS = ["title", "body"];
var RECAP_FIELDS = ["firstPrompt", "lastPrompt", "lastReply"];
function rewriteStores(transform) {
  const report = { observations: 0, notes: 0, recaps: 0 };
  const apply = (fields, record, kind) => {
    let changed = false;
    for (const field of fields) {
      const value = record[field];
      if (typeof value !== "string" || !value)
        continue;
      const next = transform(value, { kind, id: record.id });
      if (next === null)
        return { changed: true, drop: true };
      if (next !== value) {
        record[field] = next;
        changed = true;
      }
    }
    return { changed, drop: false };
  };
  const rewriteJsonl = (file, fields, kind) => {
    const records = readLines(file);
    if (!records.length)
      return;
    let touched = 0;
    const kept = [];
    for (const record of records) {
      const { changed, drop } = apply(fields, record, kind);
      if (drop)
        touched++;
      else {
        if (changed)
          touched++;
        kept.push(record);
      }
    }
    if (!touched)
      return;
    writeAtomic(file, kept.map((r) => `${JSON.stringify(r)}
`).join(""));
    report[kind === "obs" ? "observations" : "notes"] += touched;
  };
  const obsRoot = join(dataDir(), "obs");
  if (existsSync(obsRoot)) {
    for (const project of readdirSync(obsRoot)) {
      const dir = join(obsRoot, project);
      if (!statSync(dir).isDirectory())
        continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".jsonl"))
          rewriteJsonl(join(dir, f), OBS_FIELDS, "obs");
      }
    }
  }
  rewriteJsonl(notesFile(), NOTE_FIELDS, "note");
  if (report.observations)
    invalidateIndex();
  for (const file of recapFiles()) {
    try {
      const record = JSON.parse(readFileSync(file, "utf-8"));
      const { changed, drop } = apply(RECAP_FIELDS, record, "recap");
      if (!changed)
        continue;
      if (drop)
        unlinkSync(file);
      else
        writeAtomic(file, JSON.stringify(record));
      report.recaps++;
    } catch {}
  }
  compactNotes(true);
  return report;
}
function writeAtomic(file, body) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, file);
}
function captureIgnored(cwd) {
  return existsSync(join(projectRoot(cwd), ".engram-ignore"));
}
var ERROR_LOG_CAP = 256 * 1024;
var ENTRY_START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /;
function logHookError(e) {
  const file = errorLogFile();
  ensureDir(dirname(file));
  appendFileSync(file, `${new Date().toISOString()} ${e?.stack || e}
`, "utf-8");
  if (statSync(file).size <= ERROR_LOG_CAP)
    return;
  const lines = readFileSync(file, "utf-8").split(`
`);
  let size = 0;
  let start = lines.length;
  for (let i = lines.length - 1;i >= 0; i--) {
    size += Buffer.byteLength(lines[i]) + 1;
    if (size > ERROR_LOG_CAP / 2)
      break;
    if (ENTRY_START.test(lines[i]))
      start = i;
  }
  writeAtomic(file, lines.slice(start).join(`
`));
}
function hookErrors() {
  let text;
  try {
    text = readFileSync(errorLogFile(), "utf-8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(`
`)) {
    if (!ENTRY_START.test(line))
      continue;
    const at = line.indexOf(" ");
    out.push({ ts: Date.parse(line.slice(0, at)), message: line.slice(at + 1) });
  }
  return out;
}
var hitsFile = () => join(dataDir(), "hits.jsonl");
function recordHits(ids, ts = Date.now()) {
  if (!ids.length)
    return;
  const file = hitsFile();
  ensureDir(dirname(file));
  appendFileSync(file, `${endsTorn(file) ? `
` : ""}${ids.map((id) => JSON.stringify({ id, ts })).join(`
`)}
`, "utf-8");
}
function resetHits(ids, ts) {
  if (!ids.length)
    return;
  const file = hitsFile();
  ensureDir(dirname(file));
  appendFileSync(file, `${endsTorn(file) ? `
` : ""}${ids.map((id) => JSON.stringify({ id, ts, reset: true })).join(`
`)}
`, "utf-8");
}
function noteUsage() {
  const out = new Map;
  for (const r of readLines(hitsFile())) {
    if (typeof r.id !== "string" || typeof r.ts !== "number")
      continue;
    const u = out.get(r.id) || { hits: 0 };
    if (r.reset) {
      u.hits = 0;
      u.confirmed = Math.max(u.confirmed ?? 0, r.ts);
    } else {
      u.hits += r.n ?? 1;
      u.lastInjected = Math.max(u.lastInjected ?? 0, r.ts);
    }
    out.set(r.id, u);
  }
  return out;
}
function compactHits() {
  const file = hitsFile();
  if (!existsSync(file))
    return false;
  const lines = readFileSync(file, "utf-8").split(`
`).filter(Boolean).length;
  const usage = noteUsage();
  if (lines <= Math.max(200, usage.size * 4))
    return false;
  const live = new Set(allNotes().map((n) => n.id));
  const out = [];
  for (const [id, u] of usage) {
    if (!live.has(id))
      continue;
    if (u.confirmed)
      out.push({ id, ts: u.confirmed, reset: true });
    if (u.lastInjected)
      out.push({ id, ts: u.lastInjected, n: u.hits });
  }
  writeAtomic(file, out.map((r) => `${JSON.stringify(r)}
`).join(""));
  return true;
}
var DECAY_IDLE_DAYS = 90;
var DECAY_MAX_HITS = 10;
function lifecycle(n, usage, now = Date.now()) {
  if (noteSource(n) !== "auto")
    return { state: "active" };
  const confirmed = Math.max(n.ts, usage?.confirmed ?? 0);
  const seen = Math.max(confirmed, usage?.lastInjected ?? 0);
  if (now - seen > DECAY_IDLE_DAYS * 86400000)
    return { state: "demoted", reason: "idle" };
  if ((usage?.hits ?? 0) >= DECAY_MAX_HITS)
    return { state: "demoted", reason: "unconfirmed" };
  return { state: "active" };
}
function demotedNotes(notes, now = Date.now()) {
  const usage = noteUsage();
  return new Set(notes.filter((n) => lifecycle(n, usage.get(n.id), now).state === "demoted").map((n) => n.id));
}

// src/postings.ts
import {
  appendFileSync as appendFileSync2,
  closeSync as closeSync2,
  existsSync as existsSync2,
  mkdirSync as mkdirSync2,
  openSync as openSync2,
  readFileSync as readFileSync2,
  readSync as readSync2,
  readdirSync as readdirSync2,
  renameSync as renameSync2,
  statSync as statSync2,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync2
} from "fs";
import { join as join2 } from "path";

// src/search.ts
var STOP = new Set(("a an the and or of to in on for is are was be it this that with as at by from not no " + "can do does did done how why what who which when where you your me my we our i any some each " + "please could would should will just also there here get got make use using want need " + "select where join left right inner outer full cross group order limit having union all distinct " + "case when then else end null true false asc desc with into values insert update delete " + "count sum avg min max cast like between exists over partition").split(" "));
var PREFIXES = new Set("dim fct fact stg int mart raw src tmp tbl vw".split(" "));
var CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f]+/g;
var HAS_HIRAGANA = /[\u3040-\u309f]/;
var WORD = /[a-z0-9_$][a-z0-9_$.]*/g;
function normalize(text) {
  return text.normalize("NFKC").toLowerCase();
}
function tokenize(text) {
  const lower = normalize(text);
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
var searchText = (d) => `${d.title} ${d.title} ${d.text}`;
var queryTerms = (query) => [...new Set(tokenize(query))];
function candidates(docs, qTerms) {
  const out = [];
  for (const doc of docs) {
    const text = searchText(doc);
    const lower = normalize(text);
    if (!qTerms.some((q) => lower.includes(q)))
      continue;
    const tokens = tokenize(text);
    const counts = new Map;
    for (const t of tokens)
      counts.set(t, (counts.get(t) || 0) + 1);
    out.push({ doc, tf: qTerms.map((q) => counts.get(q) || 0), len: tokens.length });
  }
  return out;
}
function search(docs, query, limit = 5, minIdf = 3) {
  const qTerms = queryTerms(query);
  if (!qTerms.length || !docs.length)
    return [];
  return rank(docs.length, qTerms, candidates(docs, qTerms), limit, minIdf);
}
function rank(total, qTerms, cand, limit, minIdf) {
  if (!qTerms.length || !total)
    return [];
  const avgLen = cand.reduce((a, c) => a + c.len, 0) / (cand.length || 1) || 1;
  const idf = [];
  let presentIdf = 0;
  for (let j = 0;j < qTerms.length; j++) {
    const n = cand.filter((c) => c.tf[j] > 0).length;
    const w = Math.log(1 + (total - n + 0.5) / (n + 0.5));
    idf.push(w);
    if (n)
      presentIdf += w;
  }
  const floor = Math.min(minIdf, presentIdf / 2);
  const hits = [];
  for (const { doc, tf, len } of cand) {
    let score = 0;
    let matchedIdf = 0;
    for (let j = 0;j < qTerms.length; j++) {
      const f = tf[j];
      if (!f)
        continue;
      const w = idf[j];
      matchedIdf += w;
      score += w * f * (K1 + 1) / (f + K1 * (1 - B + B * len / avgLen));
    }
    if (matchedIdf > 0 && matchedIdf >= floor)
      hits.push({ doc, score: score * doc.weight });
  }
  return hits.sort((a, b) => b.score - a.score || b.doc.ts - a.doc.ts).slice(0, limit);
}

// src/postings.ts
var VERSION = 3;
var DELTA_FOLD_BYTES = 1e6;
var dirOf = (project) => join2(indexRoot(), project);
var baseFile = (project) => join2(dirOf(project), "base.idx");
var deltaFile = (project) => join2(dirOf(project), "delta.jsonl");
var esc = (s) => s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
var unesc = (s) => s.includes("\\") ? s.replace(/\\([\\tn])/g, (_, c) => c === "t" ? "\t" : c === "n" ? `
` : "\\") : s;
function analyze(doc) {
  const text = searchText(doc);
  const tokens = tokenize(text);
  const tf = new Map;
  for (const t of tokens)
    tf.set(t, (tf.get(t) || 0) + 1);
  const chunks = [...new Set(normalize(text).split(/\s+/))].filter(Boolean);
  return { tf, len: tokens.length, chunks };
}
function sessionLogs(project) {
  const dir = observationDir(project);
  if (!existsSync2(dir))
    return [];
  return readdirSync2(dir).filter((f) => f.endsWith(".jsonl")).map((file) => ({ file, size: statSync2(join2(dir, file)).size }));
}
function indexObservation(project, o, doc, file) {
  if (!existsSync2(baseFile(project)))
    return;
  const { tf, len, chunks } = analyze(doc);
  const bytes = Buffer.byteLength(JSON.stringify(o)) + 1;
  const d = [o.id, o.session, o.tool === "prompt" ? 1 : 0, len, doc.kind, doc.title, doc.ts];
  const line = JSON.stringify({
    f: file,
    b: bytes,
    d: [...d, doc.weight, doc.display ?? "", doc.group ?? null],
    t: Object.fromEntries(tf),
    c: chunks
  });
  appendFileSync2(deltaFile(project), `${line}
`, "utf-8");
}
function rebuildIndex(project, toDoc) {
  const dir = dirOf(project);
  mkdirSync2(dir, { recursive: true });
  const aside = `${deltaFile(project)}.${process.pid}.old`;
  try {
    renameSync2(deltaFile(project), aside);
  } catch {}
  const files = [];
  const docs = [];
  const terms = new Map;
  const chunkRefs = new Map;
  const logDir = observationDir(project);
  if (existsSync2(logDir)) {
    for (const file of readdirSync2(logDir).filter((f) => f.endsWith(".jsonl"))) {
      const raw = readFileSync2(join2(logDir, file));
      files.push(`F	${file}	${raw.length}`);
      for (let start = 0;start < raw.length; ) {
        const nl = raw.indexOf(10, start);
        const end = nl === -1 ? raw.length : nl;
        const offset = start;
        start = end + 1;
        if (end === offset)
          continue;
        let o;
        try {
          o = JSON.parse(raw.toString("utf-8", offset, end));
        } catch {
          continue;
        }
        const doc = toDoc(o);
        const { tf, len, chunks } = analyze(doc);
        const ref = docs.length;
        docs.push([
          "D",
          file,
          esc(o.id),
          esc(o.session),
          o.tool === "prompt" ? 1 : 0,
          offset,
          end - offset,
          len,
          esc(doc.kind),
          esc(doc.title),
          doc.ts,
          doc.weight
        ].join("\t"));
        for (const [t, n] of tf) {
          const posting = n === 1 ? String(ref) : `${ref}:${n}`;
          const list = terms.get(t);
          if (list)
            list.push(posting);
          else
            terms.set(t, [posting]);
        }
        for (const c of chunks) {
          const list = chunkRefs.get(c);
          if (list)
            list.push(ref);
          else
            chunkRefs.set(c, [ref]);
        }
      }
    }
  }
  const out = [`engram-index	${VERSION}	${docs.length}`, ...files, ...docs];
  for (const [t, refs] of terms)
    out.push(`T	${t}	${refs.join(",")}`);
  for (const [c, refs] of chunkRefs)
    out.push(`C	${c}	${refs.join(",")}`);
  out.push("end", "");
  const tmp = `${baseFile(project)}.${process.pid}.tmp`;
  writeFileSync2(tmp, out.join(`
`), "utf-8");
  renameSync2(tmp, baseFile(project));
  try {
    unlinkSync2(aside);
  } catch {}
}
function indexNeedsFold(project) {
  try {
    return statSync2(deltaFile(project)).size > DELTA_FOLD_BYTES;
  } catch {
    return false;
  }
}
function postings(line, from, each) {
  let ref = 0;
  let tf = 0;
  let inTf = false;
  for (let k = from;k <= line.length; k++) {
    const c = k < line.length ? line.charCodeAt(k) : 44;
    if (c === 44) {
      each(ref, inTf ? tf : 1);
      ref = 0;
      tf = 0;
      inTf = false;
    } else if (c === 58)
      inTf = true;
    else if (inTf)
      tf = tf * 10 + c - 48;
    else
      ref = ref * 10 + c - 48;
  }
}
function indexedCandidates(project, qTerms, visible, toDoc) {
  let base;
  try {
    base = readFileSync2(baseFile(project), "utf-8");
  } catch {
    return null;
  }
  const lines = base.split(`
`);
  const head = lines[0].split("\t");
  if (head[0] !== "engram-index" || Number(head[1]) !== VERSION || lines[lines.length - 2] !== "end")
    return null;
  const count = Number(head[2]);
  const indexed = new Map;
  let i = 1;
  for (;lines[i].startsWith("F\t"); i++) {
    const [, file, bytes] = lines[i].split("\t");
    indexed.set(file, Number(bytes));
  }
  const docsAt = i;
  const termsAt = docsAt + count;
  if (count && !lines[termsAt - 1].startsWith("D\t"))
    return null;
  if (lines[termsAt] !== "end" && !/^[TC]\t/.test(lines[termsAt]))
    return null;
  const deltas = [];
  let delta = "";
  try {
    delta = readFileSync2(deltaFile(project), "utf-8");
  } catch {}
  for (const line of delta.split(`
`)) {
    if (line)
      deltas.push(JSON.parse(line));
  }
  for (const r of deltas)
    indexed.set(r.f, (indexed.get(r.f) || 0) + r.b);
  const logs = sessionLogs(project);
  if (logs.some((l) => (indexed.get(l.file) || 0) !== l.size))
    return null;
  const present = new Set(logs.map((l) => l.file));
  for (const [file, bytes] of indexed)
    if (bytes && !present.has(file))
      return null;
  const hit = (text) => qTerms.some((q) => text.includes(q));
  const cand = new Set;
  if (qTerms.length) {
    for (let k = termsAt;lines[k] !== "end"; k++) {
      const line = lines[k];
      if (line.charCodeAt(0) !== 67)
        continue;
      const tab = line.indexOf("\t", 2);
      if (hit(line.slice(2, tab)))
        postings(line, tab + 1, (ref) => cand.add(ref));
    }
    deltas.forEach((r, k) => {
      if (r.c.some(hit))
        cand.add(count + k);
    });
  }
  const tfs = new Map;
  for (const ref of cand)
    tfs.set(ref, new Array(qTerms.length).fill(0));
  qTerms.forEach((q, j) => {
    const at = base.indexOf(`
T	${q}	`);
    if (at !== -1) {
      const line = base.slice(at + 1, base.indexOf(`
`, at + 1));
      postings(line, line.indexOf("\t", 2) + 1, (ref, tf) => {
        const row = tfs.get(ref);
        if (row)
          row[j] = tf;
      });
    }
    deltas.forEach((r, k) => {
      const row = tfs.get(count + k);
      if (row && Object.prototype.hasOwnProperty.call(r.t, q))
        row[j] = r.t[q];
    });
  });
  const entryOf = (k) => {
    if (k >= count) {
      const r = deltas[k - count];
      const d = r.d;
      return {
        file: r.f,
        id: d[0],
        session: d[1],
        prompt: d[2] === 1,
        len: d[3],
        kind: d[4],
        title: d[5],
        ts: d[6],
        weight: d[7],
        offset: -1,
        length: 0,
        shown: [d[8], d[9]]
      };
    }
    const f = lines[docsAt + k].split("\t");
    return {
      file: f[1],
      id: unesc(f[2]),
      session: unesc(f[3]),
      prompt: f[4] === "1",
      offset: Number(f[5]),
      length: Number(f[6]),
      len: Number(f[7]),
      kind: unesc(f[8]),
      title: unesc(f[9]),
      ts: Number(f[10]),
      weight: Number(f[11])
    };
  };
  const byFile = new Map;
  const push = (file, k) => {
    const list = byFile.get(file);
    if (list)
      list.push(k);
    else
      byFile.set(file, [k]);
  };
  for (let k = 0;k < count; k++) {
    const line = lines[docsAt + k];
    push(line.slice(2, line.indexOf("\t", 2)), k);
  }
  deltas.forEach((r, k) => push(r.f, count + k));
  const entries = new Map;
  let total = 0;
  const cands = [];
  for (const { file } of logs) {
    for (const k of byFile.get(file) || []) {
      const e = entryOf(k);
      if (!visible(e))
        continue;
      total++;
      const tf = tfs.get(k);
      if (!tf)
        continue;
      const doc = {
        id: e.id,
        source: "obs",
        kind: e.kind,
        title: e.title,
        text: "",
        ts: e.ts,
        weight: e.weight
      };
      entries.set(doc, e);
      cands.push({ doc, tf, len: e.len });
    }
  }
  const fill = (hits) => {
    for (const h of hits) {
      const e = entries.get(h.doc);
      if (!e)
        continue;
      const shown = e.shown ?? reread(project, e, toDoc);
      h.doc.display = shown[0];
      h.doc.text = shown[0];
      if (shown[1] !== null)
        h.doc.group = shown[1];
    }
    return hits;
  };
  return { total, cands, fill };
}
function reread(project, e, toDoc) {
  const fd = openSync2(join2(observationDir(project), e.file), "r");
  try {
    const buf = Buffer.alloc(e.length);
    readSync2(fd, buf, 0, e.length, e.offset);
    const doc = toDoc(JSON.parse(buf.toString("utf-8")));
    return [doc.display ?? "", doc.group ?? null];
  } finally {
    closeSync2(fd);
  }
}

// src/team.ts
import {
  closeSync as closeSync3,
  existsSync as existsSync3,
  openSync as openSync3,
  mkdirSync as mkdirSync3,
  readFileSync as readFileSync3,
  readdirSync as readdirSync3,
  renameSync as renameSync3,
  statSync as statSync3,
  unlinkSync as unlinkSync3,
  writeFileSync as writeFileSync3
} from "fs";
import { homedir as homedir2 } from "os";
import { dirname as dirname2, join as join3, resolve as resolve2 } from "path";
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
var configFile = () => join3(dataDir(), "config.json");
function readConfig() {
  try {
    const c = JSON.parse(readFileSync3(configFile(), "utf-8"));
    return c && typeof c === "object" && !Array.isArray(c) ? c : {};
  } catch {
    return {};
  }
}
function updateConfig(change) {
  const lock = `${configFile()}.lock`;
  mkdirSync3(dataDir(), { recursive: true });
  const deadline = Date.now() + 3000;
  for (;; ) {
    try {
      closeSync3(openSync3(lock, "wx"));
      break;
    } catch {
      try {
        if (Date.now() - statSync3(lock).mtimeMs > 1e4)
          unlinkSync3(lock);
      } catch {}
      if (Date.now() > deadline)
        throw new Error(`config is locked: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    writeAtomic2(configFile(), `${JSON.stringify(change(readConfig()), null, 2)}
`);
  } finally {
    unlinkSync3(lock);
  }
}
function writeAtomic2(file, text) {
  mkdirSync3(dirname2(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync3(tmp, text, "utf-8");
  renameSync3(tmp, file);
}
var inPluginHook = () => !!process.env.CLAUDE_PLUGIN_ROOT;
function persistPluginOption() {
  if (!inPluginHook())
    return;
  const opt = process.env.CLAUDE_PLUGIN_OPTION_TEAM_DIR?.trim() || undefined;
  if (opt === readConfig().teamDir)
    return;
  updateConfig(({ teamDir, ...rest }) => opt ? { ...rest, teamDir: opt } : rest);
}
function sharedStore() {
  const configured = process.env.ENGRAM_TEAM_DIR?.trim() || (inPluginHook() ? process.env.CLAUDE_PLUGIN_OPTION_TEAM_DIR?.trim() : readConfig().teamDir);
  if (configured)
    return resolve2(configured);
  const fallback = join3(homedir2(), ".claude", "engram-team");
  return existsSync3(fallback) ? fallback : undefined;
}
function teamDirs(cwd) {
  return [projectStore(cwd), sharedStore()].filter((d) => !!d);
}
function projectStore(cwd) {
  const root = projectRoot(cwd);
  if (existsSync3(join3(root, ".engram-ignore")))
    return;
  let dir = resolve2(cwd);
  for (;; ) {
    if (existsSync3(join3(dir, ".engram")))
      return join3(dir, ".engram");
    if (dir === root || dirname2(dir) === dir)
      return;
    dir = dirname2(dir);
  }
}
function gitRemote(root) {
  try {
    let gitDir = join3(root, ".git");
    if (statSync3(gitDir).isFile()) {
      gitDir = resolve2(root, readFileSync3(gitDir, "utf-8").replace(/^gitdir:\s*/, "").trim());
      const common = join3(gitDir, "commondir");
      if (existsSync3(common))
        gitDir = resolve2(gitDir, readFileSync3(common, "utf-8").trim());
    }
    const config = readFileSync3(join3(gitDir, "config"), "utf-8");
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
function samePath(a, b) {
  return pathKey(a) === pathKey(b);
}
function readScopeFile(base) {
  const file = join3(base, "scope.json");
  if (!existsSync3(file))
    return { scope: null };
  try {
    const raw = JSON.parse(readFileSync3(file, "utf-8"));
    const strings = (v) => v === undefined || Array.isArray(v) && v.every((x) => typeof x === "string");
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !strings(raw.projects) || !strings(raw.paths))
      throw new Error('expected {"projects": [strings], "paths": [strings]}');
    return { scope: { projects: raw.projects || [], paths: raw.paths || [] } };
  } catch (e) {
    return { scope: null, error: `scope.json is invalid: ${e.message}` };
  }
}
var snapshotFile = () => join3(dataDir(), "team-snapshot.json");
function readSnapshot() {
  const dir = sharedStore();
  if (!dir)
    return null;
  try {
    const snap = JSON.parse(readFileSync3(snapshotFile(), "utf-8"));
    return samePath(snap.dir, dir) ? snap : null;
  } catch {
    return null;
  }
}
function refreshSnapshot(maxAgeMs = 0) {
  const dir = sharedStore();
  if (!dir)
    return { snap: null };
  const prev = readSnapshot();
  if (prev && Date.now() - prev.at < maxAgeMs)
    return { snap: prev };
  const lock = `${snapshotFile()}.lock`;
  mkdirSync3(dataDir(), { recursive: true });
  const owned = takeLock(lock);
  if (!owned && maxAgeMs > 0)
    return { snap: prev };
  try {
    if (!existsSync3(dir))
      return { snap: prev, error: `team folder not reachable: ${dir}` };
    const { scope, error } = readScopeFile(dir);
    const snap = { dir, at: Date.now(), scope, ...scanStore(dir) };
    if (error)
      snap.scopeError = error;
    writeAtomic2(snapshotFile(), JSON.stringify(snap));
    return { snap };
  } catch (e) {
    return { snap: prev, error: e.message };
  } finally {
    if (owned)
      try {
        unlinkSync3(lock);
      } catch {}
  }
}
var LOCK_STALE_MS = 120000;
function takeLock(lock) {
  for (let attempt = 0;attempt < 2; attempt++) {
    try {
      writeFileSync3(lock, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      try {
        if (Date.now() - statSync3(lock).mtimeMs < LOCK_STALE_MS)
          return false;
        unlinkSync3(lock);
      } catch {}
    }
  }
  return false;
}
function teamScope(cwd) {
  if (projectStore(cwd))
    return { inScope: true, reason: "project has a .engram/ folder" };
  if (!sharedStore())
    return { inScope: true, reason: "no team folder configured" };
  const root = projectRoot(cwd);
  const remote = gitRemote(root);
  const norm = remote ? normalizeRemote(remote) : "";
  const team = sharedStore();
  const picked = (readConfig().projects || []).find((p) => !!p.team && samePath(p.team, team) && (samePath(p.root, root) || !!norm && p.remote === norm));
  if (picked)
    return { inScope: true, reason: "selected with /engram:scope on" };
  const snap = readSnapshot();
  if (snap?.scopeError)
    return { inScope: false, reason: snap.scopeError };
  const cfg = snap?.scope;
  const hitProject = cfg && norm ? cfg.projects.find((p) => globMatch(normalizeRemote(p), norm)) : undefined;
  if (hitProject)
    return { inScope: true, reason: `remote ${norm} matches "${hitProject}" in scope.json` };
  const path = root.replace(/\\/g, "/");
  const home = homedir2().replace(/\\/g, "/");
  const hitPath = cfg?.paths.find((p) => globMatch(p.replace(/\\/g, "/").replace(/^~(?=\/|$)/, home), path));
  if (hitPath)
    return { inScope: true, reason: `path ${path} matches "${hitPath}" in scope.json` };
  return {
    inScope: false,
    reason: `not selected (remote: ${norm || "none"}, path: ${path}); run /engram:scope on here to include it`
  };
}
function setSelected(cwd, on) {
  const team = sharedStore();
  if (!team)
    throw new Error("No team folder configured, so there is nothing to select for.");
  const root = projectRoot(cwd);
  const remote = gitRemote(root);
  const norm = remote ? normalizeRemote(remote) : undefined;
  updateConfig((c) => {
    const rest = (c.projects || []).filter((p) => !(samePath(p.team || "", team) && (samePath(p.root, root) || !!norm && p.remote === norm)));
    const entry = norm ? { root, remote: norm, team } : { root, team };
    return { ...c, projects: on ? [...rest, entry] : rest };
  });
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
function readText(path) {
  const raw = readFileSync3(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    try {
      return new TextDecoder("shift_jis").decode(raw);
    } catch {
      return raw.toString("utf-8");
    }
  }
}
function scanStore(base) {
  const items = [];
  const skipped = [];
  for (const kind of TEAM_KINDS) {
    const dir = join3(base, FOLDER[kind]);
    if (!existsSync3(dir))
      continue;
    for (const f of readdirSync3(dir)) {
      if (!f.endsWith(".md"))
        continue;
      const path = join3(dir, f);
      try {
        const { meta, body } = parseFrontmatter(readText(path));
        const id = asText(meta.id);
        const title = asText(meta.title);
        if (!id || !title) {
          skipped.push({ path, reason: "missing id or title in frontmatter" });
          continue;
        }
        items.push({
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
  return { items, skipped };
}
function loadTeam(cwd) {
  if (!teamScope(cwd).inScope)
    return { items: [], skipped: [] };
  const shared = readSnapshot();
  const local = projectStore(cwd);
  const own = local ? scanStore(local) : { items: [], skipped: [] };
  const byId = new Map;
  for (const i of [...shared?.items || [], ...own.items])
    byId.set(i.id, i);
  return {
    items: [...byId.values()].filter((i) => i.status !== "deprecated"),
    skipped: [...shared?.skipped || [], ...own.skipped]
  };
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
function planTeamWrite(base, item) {
  const clean = {
    ...item,
    title: sanitize(item.title),
    summary: item.summary ? sanitize(item.summary) : undefined,
    body: sanitize(item.body),
    tables: item.tables.map(sanitize),
    tags: item.tags.map(sanitize)
  };
  const dir = join3(base, FOLDER[clean.kind]);
  const text = serialize(clean);
  const files = existsSync3(dir) ? readdirSync3(dir).filter((f) => f.endsWith(".md")) : [];
  for (const f of files) {
    let content;
    try {
      content = readText(join3(dir, f));
    } catch {
      continue;
    }
    if (parseFrontmatter(content).meta.id === clean.id)
      return { path: join3(dir, f), text, existing: content };
  }
  const stem = slugify(clean.title) || clean.id;
  let path = join3(dir, `${stem}.md`);
  for (let n = 2;existsSync3(path); n++)
    path = join3(dir, `${stem}-${n}.md`);
  return { path, text };
}
function writeTeamItem(base, item) {
  const plan = planTeamWrite(base, item);
  mkdirSync3(dirname2(plan.path), { recursive: true });
  if (plan.existing !== undefined) {
    writeAtomic2(plan.path, plan.text);
    return plan.path;
  }
  const stem = join3(dirname2(plan.path), slugify(sanitize(item.title)) || item.id);
  let path = plan.path;
  for (let n = 2;; n++) {
    try {
      writeFileSync3(path, plan.text, { encoding: "utf-8", flag: "wx" });
      return path;
    } catch (e) {
      if (e.code !== "EEXIST" || n > 1000)
        throw e;
      path = `${stem}-${n}.md`;
    }
  }
}

// src/hooks.ts
var RETENTION_DAYS = Number(process.env.ENGRAM_RETENTION_DAYS) > 0 ? Number(process.env.ENGRAM_RETENTION_DAYS) : 90;
var PROMPT_BUDGET = 1500;
var PROMPT_ITEMS = 5;
var TABLE_ITEMS = 3;
var KIND_ORDER = ["caveat", "fix", "metric", "query", "decision", "fact", "note"];
var kindRank = (kind) => {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
};
var SESSION_BUDGET = 6000;
var TRIVIAL = new Set("ls cd pwd cat head tail less more echo printf which whoami date clear true sleep wc file tree".split(" "));
var oneLine = (s, max) => clip(s.replace(/\s+/g, " ").trim(), max);
var NAME = String.raw`[\`"[]?[\w$-]+(?:[\`"\]]?\.[\`"[]?[\w$-]+){0,2}[\`"\]]?`;
var NOT_TABLE = /^(select|with|lateral|unnest|the|a|as|on|using|where|group|order|limit|having|union|join|left|right|inner|outer|full|cross|natural|window|qualify|values)$/i;
var ALIAS = String.raw`(?:\s+(?:as\s+)?(?!(?:where|join|left|right|inner|outer|full|cross|natural|on|using|group|order|limit|having|union|window|qualify|import|select|from|lateral|set|values|and|or)\b)[\w$]+)?`;
var TABLE_REF = new RegExp(String.raw`(?<!\b(?:extract|trim|substring|position|overlay)\s*\([^()]*)\b(?:from|join|into|update|table)\s+(${NAME})(?![\w$.\x60"\]-])(?!\s+import\b)(${ALIAS}(?:\s*,\s*${NAME}${ALIAS})*)`, "gi");
var CTE = /(?:\bwith(?:\s+recursive)?|,)\s*([\w$]+)\s+as\s*(?:(?:not\s+)?materialized\s*)?\(/gi;
function extractTables(sql) {
  const local = new Set([...sql.matchAll(CTE)].map((m) => m[1].toLowerCase()));
  const out = new Set;
  const add = (raw) => {
    const name = raw.replace(/[`"[\]]/g, "");
    if (!NOT_TABLE.test(name) && !local.has(name.toLowerCase()))
      out.add(name);
  };
  for (const m of sql.matchAll(TABLE_REF)) {
    add(m[1]);
    for (const c of m[2].matchAll(new RegExp(String.raw`,\s*(${NAME})`, "g")))
      add(c[1]);
  }
  return [...out];
}
function identifiers(text) {
  const out = new Set;
  for (const m of normalize(text).replace(/[`"[\]]/g, "").match(/[a-z0-9_$][\w$.-]*/g) || []) {
    const parts = m.replace(/[.-]+$/, "").split(".");
    for (let i = 0;i < parts.length; i++)
      out.add(parts.slice(i).join("."));
  }
  return out;
}
function matchedTables(ids, tables) {
  return tables.filter((t) => {
    const parts = normalize(t).replace(/[`"[\]]/g, "").split(".");
    return parts.some((_, i) => {
      const tail = parts.slice(i).join(".");
      return tail.length >= 3 && ids.has(tail);
    });
  });
}
var FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
var CODE_FILE = /\.(sql|py|r|ipynb|ya?ml|sh|jinja2?|j2|js|ts)$/i;
var SQL_WORD2 = /\b(select|insert|update|delete|merge|create|alter|drop|grant|with|copy|from)\b/i;
var SQL_ARG = /\b(?:select|insert|update|delete|merge|create|alter|drop|grant|with|copy)\b|\bfrom\b(?!\s*:)/i;
function looksLikeData(text) {
  const lines = text.split(`
`).filter((l) => l.trim());
  if (lines.length < 3)
    return false;
  const delimited = lines.filter((l) => (l.match(/[,\t|;]/g) || []).length >= 3).length;
  return delimited / lines.length >= 0.8 && !SQL_WORD2.test(lines.slice(0, 3).join(" "));
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
  if (!text || looksLikeData(text) || /\.sql$/i.test(path) && !SQL_WORD2.test(text))
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
      if (typeof v === "string" && /^(sql|statement)$/i.test(k))
        fields.push(v);
      else if (typeof v === "string" && /^(query|command)$/i.test(k) && SQL_ARG.test(v))
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
var SEGMENT = /&&|\|\||[;|\n]/;
function trivialSegment(seg) {
  const s = seg.trim();
  return !s || TRIVIAL.has(firstWord(s)) || /^git\s+(status|diff|log|show|branch)\b/.test(s);
}
function isTrivial(input, text) {
  if (input.tool_name !== "Bash")
    return false;
  if (/engram[\\/].*cli\.mjs|dist[\\/]cli\.mjs|hooks[\\/]run-hook\.sh/.test(text))
    return true;
  return text.split(SEGMENT).every(trivialSegment);
}
function runPart(o) {
  if (o.tool !== "Bash")
    return o.input;
  const segs = o.input.split(SEGMENT);
  const first = segs.findIndex((s) => !trivialSegment(s));
  return first === -1 ? o.input : segs.slice(first).join(" ");
}
function shellCommands(cmd) {
  const cmds = [];
  let cur = { raw: "", words: [], bodies: [] };
  let start = 0;
  let word = null;
  let delimNext = false;
  const delims = [];
  const endWord = () => {
    if (!word)
      return;
    if (delimNext)
      delims.push(word.text);
    else
      cur.words.push(word);
    delimNext = false;
    word = null;
  };
  const endCmd = (end, next) => {
    endWord();
    if (cur.words.length || cur.bodies.length)
      cmds.push({ ...cur, raw: cmd.slice(start, end) });
    cur = { raw: "", words: [], bodies: [] };
    start = next;
  };
  const add = (text, quoted) => {
    word ??= { text: "", quoted: false };
    word.text += text;
    word.quoted ||= quoted;
  };
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "'") {
      const j = cmd.indexOf("'", i + 1);
      const end = j === -1 ? cmd.length : j;
      add(cmd.slice(i + 1, end), true);
      i = end + 1;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '"')
        j += cmd[j] === "\\" ? 2 : 1;
      add(cmd.slice(i + 1, Math.min(j, cmd.length)), true);
      i = j + 1;
    } else if (ch === "\\") {
      if (cmd[i + 1] !== `
`)
        add(cmd[i + 1] ?? "", false);
      i += 2;
    } else if (ch === `
`) {
      endWord();
      i++;
      for (const d of delims) {
        while (i < cmd.length) {
          const nl = cmd.indexOf(`
`, i);
          const line = cmd.slice(i, nl === -1 ? cmd.length : nl);
          i = nl === -1 ? cmd.length : nl + 1;
          if (line.trim() === d)
            break;
          cur.bodies.push(line);
        }
      }
      delims.length = 0;
      endCmd(i, i);
    } else if (/\s/.test(ch)) {
      endWord();
      i++;
    } else if (cmd.startsWith("<<<", i)) {
      endWord();
      i += 3;
    } else if (cmd.startsWith("<<", i)) {
      endWord();
      i += cmd[i + 2] === "-" ? 3 : 2;
      delimNext = true;
    } else if (ch === "<" || ch === ">" || ch === "&" && cmd[i + 1] === ">") {
      endWord();
      i++;
      while (cmd[i] === ">" || cmd[i] === "&")
        i++;
    } else if (ch === "&" || ch === "|" || ch === ";") {
      const next = i + (cmd[i + 1] === ch ? 2 : 1);
      endCmd(i, next);
      i = next;
    } else {
      add(ch, false);
      i++;
    }
  }
  endCmd(cmd.length, cmd.length);
  return cmds;
}
var BARE = /^[a-z][a-z0-9-]*$/i;
var SHELLS = new Set("sh bash zsh dash ksh".split(" "));
function payloadWords(c) {
  const out = [];
  let k = 0;
  while (k < c.words.length && !c.words[k].quoted && /^[A-Za-z_]\w*=/.test(c.words[k].text))
    k++;
  const words = c.words.slice(k);
  let prefix = true;
  let shell = false;
  let inline = false;
  words.forEach((w, n) => {
    if (!w.quoted && w.text.startsWith("-")) {
      const value = w.text.slice(w.text.indexOf("=") + 1);
      if (w.text.includes("=") && value && !BARE.test(value))
        out.push(value);
      if (shell && /^-[a-z]*c[a-z]*$/i.test(w.text))
        inline = true;
      return;
    }
    if (inline) {
      inline = false;
      prefix = false;
      out.push(commandContent(w.text));
      return;
    }
    if (prefix && !w.quoted && (n === 0 || BARE.test(w.text))) {
      if (SHELLS.has(w.text.split("/").pop() || ""))
        shell = true;
      return;
    }
    prefix = false;
    out.push(w.text);
  });
  return [...out, ...c.bodies];
}
function commandContent(cmd) {
  const cmds = shellCommands(cmd);
  const first = cmds.findIndex((c) => !trivialSegment(c.raw));
  return cmds.slice(first === -1 ? 0 : first).flatMap(payloadWords).filter(Boolean).join(`
`);
}
function contentPart(o) {
  return o.tool === "Bash" ? commandContent(o.input) : runPart(o);
}
function tableTokens(part) {
  const out = new Set;
  for (const t of extractTables(part))
    for (const k of tokenize(t))
      out.add(k);
  return out;
}
var BLAMED = [
  /unrecognized name\s*:?\s*["'`]?([\w$.]+)/gi,
  /(?:no such column|unknown column|invalid column name)\s*:?\s*["'`]?([\w$.]+)/gi,
  /column\s+["'`]?([\w$.]+)["'`]?\s+(?:does not exist|not found|cannot be resolved)/gi
];
function blamedIdentifiers(error) {
  return BLAMED.flatMap((re) => [...error.matchAll(re)].map((m) => m[1]));
}
var escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function similar(failed, worked) {
  if (failed.tool !== worked.tool)
    return false;
  if (failed.tool === "Bash" && runPart(failed) === runPart(worked))
    return true;
  const pf = contentPart(failed);
  const pw = contentPart(worked);
  const drop = tableTokens(pf);
  for (const t of tableTokens(pw))
    drop.add(t);
  for (const id of blamedIdentifiers(failed.error || ""))
    drop.add(id.toLowerCase());
  const tf = new Set(tokenize(pf).filter((t) => !drop.has(t)));
  const tw = new Set(tokenize(pw).filter((t) => !drop.has(t)));
  const inter = [...tf].filter((t) => tw.has(t)).length;
  return inter / (tf.size + tw.size - inter || 1) >= 0.3;
}
function blamedGone(failed, worked) {
  const pw = runPart(worked);
  return blamedIdentifiers(failed.error || "").every((id) => {
    const name = id.split(".").pop() || id;
    if (!new RegExp(`\\b${escapeRe(name)}\\b`, "i").test(runPart(failed)))
      return true;
    return !new RegExp(`\\b${escapeRe(name)}\\b`, "i").test(pw);
  });
}
function editedPath(history) {
  for (const o of history) {
    if (!FILE_TOOLS.has(o.tool))
      continue;
    const path = o.input.split(`
`)[0].split(/\s+/).slice(1).join(" ");
    if (path)
      return path;
  }
  return null;
}
function noiseHeadline(line) {
  const s = line.trim();
  return /^exit code \d+$/i.test(s) || /^\d+\s+(?:fail|fails|failed|failure|failures|error|errors)$/i.test(s);
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
    if (!blamedGone(prev, success))
      return null;
    const errLine = errorHeadline(prev.error);
    if (noiseHeadline(errLine))
      return null;
    const unchanged = runPart(prev) === runPart(success);
    const edited = unchanged ? editedPath(history.slice(i + 1)) : null;
    if (unchanged && !edited)
      return null;
    const body = [
      `Failed:
\`\`\`
${prev.input}
\`\`\``,
      `Error:
\`\`\`
${prev.error}
\`\`\``,
      edited ? `Edited:
\`\`\`
${edited}
\`\`\`` : "",
      `Worked:
\`\`\`
${success.input}
\`\`\``
    ].filter(Boolean).join(`
`);
    return saveNote({
      project: success.project,
      session: success.session,
      kind: "fix",
      title: edited ? `Fix: ${oneLine(errLine, 120)} (${edited})` : `Fix: ${oneLine(errLine, 120)}`,
      body,
      tables: [...new Set([...extractTables(prev.input), ...extractTables(success.input)])],
      sources: [prev.id, success.id],
      root,
      source: "auto"
    });
  }
  return null;
}
function captureDisabled(cwd) {
  return process.env.ENGRAM_DISABLE_CAPTURE === "1" || captureIgnored(cwd);
}
function onToolUse(input) {
  if (captureDisabled(input.cwd) || !input.tool_name)
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
  indexCaptured(obs);
  if (!obs.error)
    detectFix(sessionObservations(project, input.session_id), obs, projectRoot(input.cwd));
}
function onStop(input) {
  if (input.last_assistant_message && !captureDisabled(input.cwd))
    updateRecap(projectId(input.cwd), input.session_id, {
      lastReply: input.last_assistant_message
    });
  onRefresh(input);
}
var SNAPSHOT_TTL = 10 * 60000;
function onRefresh(input) {
  try {
    persistPluginOption();
  } catch {}
  try {
    refreshSnapshot(SNAPSHOT_TTL);
  } finally {
    if (input?.cwd)
      maintainIndex(input.cwd);
  }
}
var visibleIn = (project) => (n) => n.project === project || !!n.global;
function memoryDocs(cwd, opts = {}) {
  const project = projectId(cwd);
  const docs = [];
  const team = loadTeam(cwd).items;
  const teamIds = new Set(team.map((t) => t.id));
  const notes = allNotes();
  const visible = opts.allProjects ? () => true : visibleIn(project);
  const demoted = opts.injection ? demotedNotes(notes) : new Set;
  const derived = new Set(notes.flatMap((n) => n.sources || []));
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
      tables: t.tables,
      ref: t.path
    });
  }
  for (const n of notes) {
    if (teamIds.has(n.id) || !visible(n) || demoted.has(n.id))
      continue;
    docs.push({
      id: n.id,
      source: "note",
      kind: n.kind,
      title: n.title,
      text: `${(n.tables || []).join(" ")} ${(n.tags || []).join(" ")} ${n.body}`,
      ts: n.ts,
      weight: n.project === project ? 1.3 : 1.1,
      display: n.kind === "fix" ? fixDisplay(n.body) : n.body,
      tables: n.tables
    });
  }
  return { docs, derived };
}
function obsDoc(o) {
  return {
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
  };
}
var obsVisible = (opts, derived) => (o) => o.session !== opts.excludeSession && !derived.has(o.id) && !(o.prompt && opts.prompts === false);
function recallSearch(cwd, query, opts, limit, minIdf = 3) {
  const project = projectId(cwd);
  const { docs, derived } = memoryDocs(cwd, opts);
  const qTerms = queryTerms(query);
  let indexed = null;
  try {
    indexed = indexedCandidates(project, qTerms, obsVisible(opts, derived), obsDoc);
  } catch {}
  if (!indexed) {
    afterAnswer(`${indexRoot()}\x00${project}`, () => rebuildIndex(project, obsDoc));
    return {
      docs,
      hits: search([...docs, ...scanObservations(project, opts, derived)], query, limit, minIdf)
    };
  }
  const cands = [...candidates(docs, qTerms), ...indexed.cands];
  return {
    docs,
    hits: indexed.fill(rank(docs.length + indexed.total, qTerms, cands, limit, minIdf))
  };
}
var deferred = new Map;
var afterAnswer = (key, task) => {
  if (!deferred.has(key))
    deferred.set(key, task);
};
function runDeferred() {
  const tasks = [...deferred.values()];
  deferred.clear();
  for (const task of tasks) {
    try {
      task();
    } catch {}
  }
}
function indexCaptured(o) {
  try {
    indexObservation(o.project, o, obsDoc(o), sessionLogName(o.session));
  } catch {}
}
function maintainIndex(cwd) {
  const project = projectId(cwd);
  let fresh = false;
  try {
    fresh = indexedCandidates(project, [], () => true, obsDoc) !== null;
  } catch {}
  if (!fresh || indexNeedsFold(project))
    rebuildIndex(project, obsDoc);
}
function scanObservations(project, opts, derived) {
  const visible = obsVisible(opts, derived);
  return projectObservations(project, { skipPrompts: opts.prompts === false }).filter((o) => visible({ id: o.id, session: o.session, prompt: o.tool === "prompt" })).map(obsDoc);
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
var lineKey = (d) => d.group ?? d.display ?? d.text;
function uniqueHits(hits, max) {
  const seen = new Set;
  const out = [];
  for (const h of hits) {
    const key = lineKey(h.doc);
    if (seen.has(key))
      continue;
    seen.add(key);
    out.push(h);
    if (out.length === max)
      break;
  }
  return out;
}
function uniqueLines(hits, max) {
  return uniqueHits(hits, max).map(formatHit);
}
var ledgerKey = (d) => d.group ?? d.id;
var bytes = (s) => Buffer.byteLength(s, "utf-8");
function fitLines(header, lines, budget) {
  const out = [header];
  let size = bytes(header);
  for (const l of lines) {
    if (size + bytes(l) + 1 > budget)
      break;
    out.push(l);
    size += bytes(l) + 1;
  }
  return out.length > 1 ? out.join(`
`) : "";
}
function onPrompt(input) {
  const prompt = input.prompt || "";
  const project = projectId(input.cwd);
  let context = "";
  if (prompt.trim().length >= 4 && !prompt.trim().startsWith("/")) {
    const shown = injectedDocs(project, input.session_id);
    const fresh = (d) => !shown.has(ledgerKey(d)) && !shown.has(d.id);
    const { docs, hits: ranked } = recallSearch(input.cwd, prompt, { excludeSession: input.session_id, prompts: false, injection: true }, 20);
    const ids = identifiers(prompt);
    const byTable = docs.filter((d) => d.tables?.length && fresh(d) && matchedTables(ids, d.tables).length).sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || b.weight - a.weight || b.ts - a.ts).slice(0, TABLE_ITEMS).map((doc) => ({ doc, score: 0 }));
    const tableIds = new Set(byTable.map((h) => h.doc.id));
    const hits = [...byTable, ...ranked.filter((h) => fresh(h.doc) && !tableIds.has(h.doc.id))];
    const picked = uniqueHits(hits, PROMPT_ITEMS);
    context = fitLines("engram: records from earlier sessions and team knowledge that match this prompt (may be outdated; verify before relying on them):", picked.map(formatHit), PROMPT_BUDGET);
    const shownHits = picked.slice(0, context ? context.split(`
`).length - 1 : 0);
    const keys = new Set(shownHits.map((h) => lineKey(h.doc)));
    if (keys.size && !captureDisabled(input.cwd)) {
      markInjected(project, input.session_id, [
        ...new Set(hits.filter((h) => keys.has(lineKey(h.doc))).map((h) => ledgerKey(h.doc)))
      ]);
      recordHits(shownHits.filter((h) => h.doc.source === "note").map((h) => h.doc.id));
    }
  }
  if (!captureDisabled(input.cwd) && prompt.trim()) {
    const saved = saveObservation({
      session: input.session_id,
      project,
      tool: "prompt",
      input: prompt
    });
    indexCaptured(saved);
    const first = sessionObservations(project, input.session_id).find((o) => o.tool === "prompt");
    updateRecap(project, input.session_id, {
      firstPrompt: (first || saved).input,
      lastPrompt: prompt
    });
  }
  return context;
}
var GUARD_ITEMS = 3;
var GUARD_BUDGET = 1200;
function blamedInFix(body) {
  const error = body.match(/Error:\n```\n([\s\S]*?)\n```/);
  return error ? blamedIdentifiers(error[1]).map((id) => (id.split(".").pop() || id).toLowerCase()) : [];
}
function onPreToolUse(input) {
  const tool = input.tool_name || "";
  if (tool !== "Bash" && !tool.startsWith("mcp__"))
    return "";
  const sql = toolText(input);
  if (!sql || !SQL_ARG.test(sql))
    return "";
  const tables = extractTables(sql);
  if (!tables.length)
    return "";
  const named = identifiers(tables.join(" "));
  const words = identifiers(sql);
  const project = projectId(input.cwd);
  const shown = injectedDocs(project, input.session_id);
  const found = new Map;
  const consider = (w) => {
    if (w.kind !== "caveat" && w.kind !== "fix" || found.has(w.id))
      return;
    if (!matchedTables(named, w.tables).length)
      return;
    let bad = [];
    if (w.kind === "fix") {
      const blamed = blamedInFix(w.body);
      bad = blamed.filter((c) => words.has(c));
      if (blamed.length && !bad.length)
        return;
    }
    if (shown.has(w.id) && !bad.length)
      return;
    const line = bad.length ? `${w.line} — this query uses ${bad.join(", ")} again` : w.line;
    found.set(w.id, { id: w.id, kind: w.kind, line, bad, own: w.own, ts: w.ts });
  };
  for (const t of loadTeam(input.cwd).items)
    consider({
      id: t.id,
      kind: t.kind,
      tables: t.tables,
      body: t.body,
      own: true,
      ts: Date.parse(t.created_at || "") || 0,
      line: `- [team ${t.kind}] ${t.title}: ${oneLine(summaryOf(t), 160)} (${t.path})`
    });
  const notes = allNotes().filter(visibleIn(project));
  const demoted = demotedNotes(notes);
  for (const n of notes.filter((n) => !demoted.has(n.id)))
    consider({
      id: n.id,
      kind: n.kind,
      tables: n.tables || [],
      body: n.body,
      own: n.project === project,
      ts: n.ts,
      line: `- [${n.kind} ${localDay(n.ts)} ${n.id}] ${n.title}: ${oneLine(n.kind === "fix" ? fixDisplay(n.body) : n.body, 220)}`
    });
  const picked = [...found.values()].sort((a, b) => Number(!a.bad.length) - Number(!b.bad.length) || kindRank(a.kind) - kindRank(b.kind) || Number(b.own) - Number(a.own) || b.ts - a.ts).slice(0, GUARD_ITEMS);
  const context = fitLines(`engram: known issues with ${tables.join(", ")} from memory, before this query runs (may be outdated; verify):`, picked.map((w) => w.line), GUARD_BUDGET);
  if (!context)
    return "";
  if (!captureDisabled(input.cwd))
    try {
      const ids = picked.slice(0, context.split(`
`).length - 1).map((w) => w.id);
      markInjected(project, input.session_id, ids);
      const noteIds = new Set(notes.map((n) => n.id));
      recordHits(ids.filter((id) => noteIds.has(id)));
    } catch {}
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context }
  });
}
var COMPACT_FIXES = 5;
var COMPACT_ERRORS = 3;
var COMPACT_BUDGET = 2000;
function compactRecall(project, session, fixes) {
  const told = new Set(fixes.flatMap((n) => n.sources || []));
  const errors = sessionObservations(project, session).filter((o) => o.error && !told.has(o.id)).slice(-COMPACT_ERRORS);
  return fitLines("engram: found earlier in this session, before the context was compacted:", [
    ...fixes.map((n) => `- [fix ${n.id}] ${oneLine(n.title, 140)}: ${oneLine(fixDisplay(n.body), 220)}`),
    ...errors.map((o) => `- [error ${localDay(o.ts)}] ${oneLine(errorHeadline(o.error), 160)} — from: ${oneLine(o.input, 120)}`)
  ], COMPACT_BUDGET);
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
    persistPluginOption();
  } catch {}
  try {
    pruneObservations(RETENTION_DAYS, input.session_id);
    compactNotes();
    compactHits();
  } catch {}
  const project = projectId(input.cwd);
  const parts = [];
  const notes = allNotes();
  const sessionFixes = input.source === "compact" ? notes.filter((n) => n.kind === "fix" && n.session === input.session_id).sort((a, b) => a.ts - b.ts).slice(-COMPACT_FIXES) : [];
  if (input.source === "compact") {
    clearInjected(project, input.session_id);
    const recalled = compactRecall(project, input.session_id, sessionFixes);
    if (recalled)
      parts.push(recalled);
  }
  const recap = input.source === "compact" ? null : readRecap(project, input.session_id);
  if (recap) {
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
  if (sharedStore() && !teamScope(input.cwd).inScope)
    parts.push("engram: a team folder is set, but this project is not selected, so it stays personal. /engram:scope on includes it.");
  const index = teamIndex(items, skipped.length, SESSION_BUDGET - bytes(parts.join(`
`)) - 300);
  if (index)
    parts.push(index);
  const own = notes.filter((n) => n.project === project);
  const recalled = new Set(sessionFixes.map((n) => n.id));
  const demoted = demotedNotes(own);
  const recent = own.filter((n) => !recalled.has(n.id) && !demoted.has(n.id)).sort((a, b) => b.ts - a.ts).slice(0, 5).map((n) => `- [${n.kind} ${n.id}] ${oneLine(n.title, 140)}`);
  if (recent.length)
    parts.push(["engram: latest notes saved in this project:", ...recent].join(`
`));
  const global = notes.filter((n) => n.project !== project && n.global).length;
  const elsewhere = notes.length - own.length - global;
  parts.push(`engram: personal memory holds ${own.length} saved note(s) for this project` + (global ? `, plus ${global} global` : "") + "; matching ones are added to prompts automatically" + (elsewhere ? ` (${elsewhere} from other projects stay there; search them with /engram:recall --all)` : "") + ". " + "Durable findings (data caveats, metric definitions, fixes) can be saved with /engram:save; past sessions are listed by /engram:history.");
  return parts.join(`

`);
}

// src/cli.ts
var USAGE = `engram <command>
  recall <words...> [--limit N] [--all]
                                       search this project's and global notes, its past
                                       sessions and team knowledge (--all: notes of every project)
  save --kind K --title T [--tables a,b] [--tags x,y] [--global] [--body TEXT | stdin]
                                       kinds: ${KINDS.join(", ")}
                                       --global: recalled in every project, not only this one
  forget <note-id>                     erase a saved note
  purge <regex|obs-id>                 delete stored observations, notes and recaps that match,
                                       or one observation by id; counts each store
  resanitize                           re-apply the current redaction rules to everything stored
  share [<note-id>] [--yes [--update]] [--to DIR]
                                       list shareable notes, preview one, or publish it with --yes
                                       (--update replaces a team file that differs)
  scope [on|off]                       show, select or unselect this project for team sharing
  history [--all] [--limit N]          list past sessions (this project, or all projects)
  history <session-id|YYYY-MM-DD> [--all]
                                       show what happened in a session or on a day
                                       (this project, or all projects)
  status                               show what is stored, loaded and in team scope
  table <name>                         what engram knows about one table: notes, common
                                       errors, the fixes that resolved them, last use
  stats                                disk use, records by kind and source, top tables
  hook <session-start|prompt|pre-tool|tool|stop|refresh>
                                       used by hooks/hooks.json (reads JSON on stdin)`;
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
    return readFileSync4(0, "utf-8");
  } catch {
    return "";
  }
}
function logError(e) {
  try {
    logHookError(e);
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
  else if (event === "pre-tool")
    out = onPreToolUse(input);
  else if (event === "stop")
    onStop(input);
  else if (event === "refresh")
    onRefresh(input);
  if (out)
    process.stdout.write(`${out}
`);
  runDeferred();
}
function recall(words, limit) {
  const allProjects = words.includes("--all");
  const query = words.filter((w) => w !== "--all").join(" ");
  if (!query.trim())
    return "Usage: engram recall <words...> [--all]";
  const { hits } = recallSearch(process.cwd(), query, { allProjects }, limit * 4, 0);
  const lines = uniqueLines(hits, limit);
  if (!lines.length)
    return `No memory or team knowledge matches "${query}".`;
  return [`engram recall: "${query}"`, ...lines].join(`
`);
}
function save(opt, global) {
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
    root: projectRoot(process.cwd()),
    source: "user",
    global
  });
  const personal = teamScope(process.cwd()).inScope ? "" : " (personal only: outside the team scope)";
  const where = note.global ? " (global: recalled in every project)" : "";
  return `Saved ${note.kind} ${note.id}: ${note.title}${where}${personal}`;
}
var shareable = (n) => !!n.root && teamScope(n.root).inScope;
function share(id, opt, yes, update = false) {
  const { error } = refreshSnapshot(0);
  if (error)
    throw new Error(error);
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
    throw new Error(`${id} comes from a project outside the team scope (${note.root || "unknown project"}), so it stays personal. ` + "Run /engram:scope on in that project (or list it in the team's scope.json), then share it from there.");
  }
  const local = projectStore(process.cwd());
  const base = opt.to || sharedStore() || local;
  if (!base) {
    throw new Error("No team folder configured. Set it with: claude plugin configure engram (team_dir), or pass --to DIR.");
  }
  if (base === local && !opt.to && !samePath(note.root || "", projectRoot(process.cwd())))
    throw new Error(`${id} comes from ${note.root}; share it from that project, or pass --to DIR.`);
  const item = {
    id: note.id,
    kind: note.kind,
    title: note.title,
    tables: note.tables || [],
    tags: note.tags || [],
    author: process.env.ENGRAM_AUTHOR,
    created_at: new Date(note.ts).toISOString().slice(0, 10),
    body: note.body
  };
  const plan = planTeamWrite(base, item);
  const changed = plan.existing !== undefined && plan.existing !== plan.text;
  if (!yes) {
    const action = plan.existing === undefined ? `write ${plan.path}` : changed ? `REPLACE ${plan.path} (it differs from this note; a teammate may have edited it)` : `leave ${plan.path} unchanged`;
    return `Preview (nothing written yet) — would ${action}:

${plan.text}
Run again with --yes to publish it to the team${changed ? " (add --update to replace the existing file)" : ""}.`;
  }
  if (changed && !update)
    throw new Error(`${plan.path} already exists with different content. Check it, then run again with --yes --update to replace it.`);
  const path = writeTeamItem(base, item);
  refreshSnapshot(0);
  return `Wrote ${path}
Teammates see it in their next session (a git-backed folder also needs a commit and push).`;
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
  const all = pos.includes("--all");
  const where = all ? "all projects" : project;
  const recs = (all ? allObservations() : projectObservations(project)).filter((o) => byDay ? localDay(o.ts) === target : o.session.startsWith(target)).sort((a, b) => a.ts - b.ts).slice(-200);
  if (!recs.length)
    return `Nothing recorded for "${target}" in ${where}.`;
  const ids = [...new Set(recs.map((o) => o.session))];
  if (!byDay && ids.length > 1)
    return [
      `"${target}" matches ${ids.length} sessions; use a longer prefix:`,
      ...ids.map((i) => `- ${i}`)
    ].join(`
`);
  return [
    `Timeline for ${target} in ${where}:`,
    ...recs.map((o) => {
      const what = o.input.replace(/\s+/g, " ").slice(0, 160);
      const err = o.error ? ` ✗ ${o.error.replace(/\s+/g, " ").slice(0, 120)}` : "";
      const tag = all ? ` [${o.project}]` : "";
      return `- ${localTime(o.ts).slice(11)} ${byDay ? `${o.session.slice(0, 8)} ` : ""}${o.tool}${tag}: ${what}${err}`;
    })
  ].join(`
`);
}
function scope(action) {
  const cwd = process.cwd();
  if (action === "on" || action === "off")
    setSelected(cwd, action === "on");
  else if (action)
    throw new Error("Usage: engram scope [on|off]");
  const { error } = refreshSnapshot(0);
  const s = teamScope(cwd);
  const note = error ? `
Warning: ${error}; using the last snapshot.` : "";
  return `${projectRoot(cwd)}: ${s.inScope ? "in" : "out of"} team scope (${s.reason})${note}`;
}
function status() {
  const cwd = process.cwd();
  const { snap, error } = refreshSnapshot(0);
  const project = projectId(cwd);
  const notes = allNotes();
  const byKind = KINDS.map((k) => [k, notes.filter((n) => n.kind === k).length]).filter(([, c]) => c);
  const obs = projectObservations(project);
  const { items, skipped } = loadTeam(cwd);
  const lines = [
    `engram status`,
    `- data dir: ${dataDir()}`,
    `- project: ${project} (root ${projectRoot(cwd)})`,
    `- terminal commands: ${terminalCommand()} <command>`,
    `- saved notes: ${notes.length}${byKind.length ? ` (${byKind.map(([k, c]) => `${k} ${c}`).join(", ")})` : ""}`,
    ...lifecycleLines(notes, new Set(items.map((i) => i.id))),
    `- captured observations for this project: ${obs.length} (errors: ${obs.filter((o) => o.error).length})`,
    `- last capture in this project: ${obs.length ? localTime(obs.reduce((a, o) => Math.max(a, o.ts), 0)) : "never"}`,
    ...hookHealth(),
    `- capture: ${captureIgnored(cwd) ? "off (.engram-ignore at the project root)" : process.env.ENGRAM_DISABLE_CAPTURE === "1" ? "off (ENGRAM_DISABLE_CAPTURE)" : "on"}`,
    `- team scope: ${teamScope(cwd).inScope ? "in scope" : "out of scope"} (${teamScope(cwd).reason})`,
    `- team folder: ${sharedStore() || "none"}${error ? ` (${error})` : ""}`,
    `- team snapshot: ${snap ? `${snap.items.length} items, ${localTime(snap.at)}` : "none"}`,
    `- team stores: ${teamDirs(cwd).join(", ") || "none"}`,
    `- team items loaded: ${items.length}`
  ];
  for (const s of skipped)
    lines.push(`  - skipped ${s.path}: ${s.reason}`);
  return lines.join(`
`);
}
var TABLE_NOTES = 10;
var TABLE_ERRORS = 5;
var TABLE_FIXES = 5;
function table(name) {
  if (!name.trim())
    throw new Error("Usage: engram table <name>");
  const cwd = process.cwd();
  const project = projectId(cwd);
  const ids = identifiers(name);
  const names = (tables) => matchedTables(ids, tables).length > 0;
  const mentions = (text) => names([...identifiers(text)].filter((t) => t.length >= 3));
  const notes = allNotes().filter(visibleIn(project)).filter((n) => names(n.tables || []) || mentions(`${n.title} ${n.body}`));
  const team = loadTeam(cwd).items.filter((t) => names(t.tables) || mentions(`${t.title} ${t.summary || ""} ${t.body}`));
  const teamIds = new Set(team.map((t) => t.id));
  const fixes = notes.filter((n) => n.kind === "fix" && !teamIds.has(n.id));
  const others = notes.filter((n) => n.kind !== "fix" && !teamIds.has(n.id));
  const runs = projectObservations(project, { skipPrompts: true }).filter((o) => names(extractTables(o.input)));
  const errors = new Map;
  for (const o of runs) {
    if (!o.error)
      continue;
    const key = errorHeadline(o.error).replace(/\s+/g, " ").slice(0, 160);
    const e = errors.get(key) || { count: 0, last: 0 };
    e.count++;
    e.last = Math.max(e.last, o.ts);
    errors.set(key, e);
  }
  const touched = Math.max(runs.reduce((a, o) => Math.max(a, o.ts), 0), notes.reduce((a, n) => Math.max(a, n.ts), 0));
  if (!runs.length && !notes.length && !team.length)
    return `engram knows nothing about ${name} in this project. Search wider with: engram recall ${name} --all`;
  const oneLine = (s, max) => clip(s.replace(/\s+/g, " ").trim(), max);
  const out = [`engram table: ${name}`];
  out.push(`- last touched: ${touched ? localTime(touched) : "never"} ` + `(${runs.length} recorded run(s) in this project, ${runs.filter((o) => o.error).length} failed)`);
  if (team.length || others.length) {
    out.push("Caveats and notes:");
    for (const t of team.slice(0, TABLE_NOTES))
      out.push(`- [team ${t.kind}] ${t.title}: ${oneLine(summaryOf(t), 160)} (${t.path})`);
    for (const n of others.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || b.ts - a.ts).slice(0, Math.max(0, TABLE_NOTES - team.length)))
      out.push(`- [${n.kind} ${localDay(n.ts)} ${n.id}] ${n.title}: ${oneLine(n.body, 160)}`);
  }
  if (errors.size) {
    out.push("Most common errors:");
    for (const [line, e] of [...errors].sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last).slice(0, TABLE_ERRORS))
      out.push(`- ${e.count}× ${line} (last ${localDay(e.last)})`);
  }
  if (fixes.length) {
    out.push("Fixes that resolved errors:");
    for (const n of fixes.sort((a, b) => b.ts - a.ts).slice(0, TABLE_FIXES))
      out.push(`- [fix ${localDay(n.ts)} ${n.id}] ${oneLine(n.title, 140)}: ${oneLine(fixDisplay(n.body), 160)}`);
  }
  return out.join(`
`);
}
var kindOrder = (kind) => {
  const i = ["caveat", "metric", "decision", "fact", "query", "note"].indexOf(kind);
  return i === -1 ? 99 : i;
};
function diskUsage(path) {
  let bytes = 0;
  let files = 0;
  const walk = (p) => {
    let st;
    try {
      st = statSync4(p);
    } catch {
      return;
    }
    if (st.isDirectory())
      for (const f of readdirSync4(p))
        walk(join4(p, f));
    else {
      bytes += st.size;
      files++;
    }
  };
  walk(path);
  return { bytes, files };
}
var size = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
var TOP_TABLES = 10;
function stats() {
  const cwd = process.cwd();
  const project = projectId(cwd);
  const dir = dataDir();
  const total = diskUsage(dir);
  const part = (rel) => diskUsage(join4(dir, rel));
  const obsDisk = part("obs");
  const parts = [
    ["notes.jsonl", part("notes.jsonl")],
    ["hits.jsonl", part("hits.jsonl")],
    ["index", part("index")],
    ["recaps", part("recaps")],
    ["error.log", part("error.log")]
  ];
  const rest = total.bytes - obsDisk.bytes - parts.reduce((a, [, u]) => a + u.bytes, 0);
  const all = allObservations();
  const mine = all.filter((o) => o.project === project);
  const projects = new Set(all.map((o) => o.project)).size;
  const notes = allNotes();
  const byKind = KINDS.map((k) => [k, notes.filter((n) => n.kind === k).length]).filter(([, c]) => c);
  const team = loadTeam(cwd).items;
  const counts = new Map;
  for (const o of mine) {
    if (o.tool === "prompt")
      continue;
    for (const t of new Set(extractTables(o.input).map((x) => x.toLowerCase())))
      counts.set(t, (counts.get(t) || 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_TABLES);
  const lines = [
    "engram stats",
    `- data dir: ${dir} (${size(total.bytes)} in ${total.files} files)`,
    `  - observations: ${size(obsDisk.bytes)} in ${obsDisk.files} files`,
    `  - ${parts.map(([n, u]) => `${n} ${size(u.bytes)}`).join(", ")}, other ${size(Math.max(0, rest))}`,
    `- observations: ${mine.length} in this project (${mine.filter((o) => o.error).length} errors, ` + `${mine.filter((o) => o.tool === "prompt").length} prompts); ${all.length} across ${projects} project(s)`,
    `- notes: ${notes.length}${byKind.length ? ` (${byKind.map(([k, c]) => `${k} ${c}`).join(", ")})` : ""}; ` + `${notes.filter(visibleIn(project)).length} recalled in this project`,
    ...lifecycleLines(notes, new Set(team.map((i) => i.id))),
    `- team items loaded here: ${team.length}`
  ];
  if (top.length) {
    lines.push("- top tables in this project (by recorded runs):");
    for (const [t, c] of top)
      lines.push(`  - ${t}: ${c}`);
  }
  return lines.join(`
`);
}
function lifecycleLines(notes, teamIds) {
  const usage = noteUsage();
  const count = (f) => notes.filter(f).length;
  const states = notes.map((n) => ({ n, l: lifecycle(n, usage.get(n.id)) }));
  const demoted = states.filter((s) => s.l.state === "demoted");
  const reasons = ["idle", "unconfirmed"].map((r) => [r, demoted.filter((s) => s.l.reason === r).length]).filter(([, c]) => c).map(([r, c]) => `${r} ${c}`);
  return [
    `- notes by source: auto ${count((n) => noteSource(n) === "auto" && !teamIds.has(n.id))}, ` + `curated ${count((n) => noteSource(n) === "user" && !teamIds.has(n.id))}, ` + `shared with the team ${count((n) => teamIds.has(n.id))}; global ${count((n) => !!n.global)}`,
    `- lifecycle: active ${notes.length - demoted.length}, demoted ${demoted.length}` + (reasons.length ? ` (${reasons.join(", ")})` : "") + ` — automatic fixes not shown for ${DECAY_IDLE_DAYS} days, or shown ${DECAY_MAX_HITS}+ times ` + "without their error recurring, leave prompt injection but stay searchable"
  ];
}
function terminalCommand() {
  const script = process.argv[1] || "";
  const launcher = join4(dirname3(dirname3(script)), "hooks", "run-hook.sh");
  return existsSync4(launcher) ? `sh "${launcher}"` : `node "${script}"`;
}
var RECENT_ERRORS_MS = 7 * 86400000;
function hookHealth() {
  const errors = hookErrors();
  if (!errors.length)
    return ["- hook errors: none logged"];
  const last = errors[errors.length - 1];
  const recent = errors.filter((e) => Date.now() - e.ts < RECENT_ERRORS_MS);
  const lines = [`- hook errors: ${errors.length} logged, last ${localTime(last.ts)}`];
  if (recent.length) {
    lines.push(`  WARNING: ${recent.length} hook error(s) in the past 7 days; recall or capture may be failing. Latest:`);
    for (const e of recent.slice(-3))
      lines.push(`  - ${localTime(e.ts)} ${e.message.replace(/\s+/g, " ").slice(0, 200)}`);
    lines.push(`  Full log: ${join4(dataDir(), "error.log")}`);
  }
  return lines;
}
function purge(target) {
  if (!target)
    throw new Error("Usage: engram purge <regex|obs-id>");
  const byId = target.startsWith("obs-");
  let matches;
  if (byId)
    matches = (_text, id) => id === target;
  else {
    let re;
    try {
      re = new RegExp(target, "i");
    } catch (e) {
      throw new Error(`Invalid regular expression: ${e.message}`);
    }
    matches = (text) => re.test(text);
  }
  const report = rewriteStores((text, record) => matches(text, record.id) ? null : text);
  return [
    `Purged ${target}`,
    `- observations: ${report.observations}`,
    `- notes: ${report.notes}`,
    `- recaps: ${report.recaps}`
  ].join(`
`);
}
function resanitize() {
  const report = rewriteStores((text) => sanitize(text));
  return [
    "Resanitized stored text",
    `- observations: ${report.observations}`,
    `- notes: ${report.notes}`,
    `- recaps: ${report.recaps}`
  ].join(`
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
      out = save(opt, pos.includes("--global"));
    else if (cmd === "forget")
      out = forget(pos[0] || "") ? `Forgot ${pos[0]}` : `No saved note with id "${pos[0]}"`;
    else if (cmd === "purge")
      out = purge(pos[0] || "");
    else if (cmd === "resanitize")
      out = resanitize();
    else if (cmd === "share")
      out = share(pos.find((p) => !p.startsWith("--")), opt, pos.includes("--yes"), pos.includes("--update"));
    else if (cmd === "scope")
      out = scope(pos[0]);
    else if (cmd === "history")
      out = history(pos, opt);
    else if (cmd === "status")
      out = status();
    else if (cmd === "table")
      out = table(pos.join(" "));
    else if (cmd === "stats")
      out = stats();
    else
      out = USAGE;
    console.log(out);
    runDeferred();
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
