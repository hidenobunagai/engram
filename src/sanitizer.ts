/**
 * Redacts credentials and obvious PII before anything is written to disk.
 * Regex redaction is a best-effort filter, not a security boundary.
 */

const DB_SCHEMES =
  "postgresql|postgres|mysql|mariadb|snowflake|redshift|bigquery|mongodb|mongodb\\+srv|sqlserver|mssql|oracle|jdbc:[a-z]+|clickhouse|databricks|trino|presto|redis|rediss|amqps?|sftp|ftps?|smtps?|https?";

const KV_KEYS =
  "password|passwd|pwd|pass|pgpassword|passphrase|secret|api[_-]?key|access[_-]?key|account[_-]?key|shared[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|private[_-]?key|credentials?|sig|signature|x-amz-signature|x-amz-credential";

/** Names whose sibling "value" holds a secret, e.g. MCP calls like {"key":"STRIPE_SECRET","value":"..."}. */
const SECRET_NAME = '"[^"]*(?:secret|token|passw|pwd|pass|key|credential)[^"]*"';
const JSON_STR = '"(?:[^"\\\\]|\\\\.)*"';

/** Quoted runs and ODBC {braced} values are taken whole so a space or ";" inside cannot leak the tail. */
const VALUE = `${JSON_STR}|'[^']*'|\\{[^}]*\\}|[^\\s"',;}]+`;

const NOT_LITERAL = "(?!(?:-?\\d+(?:\\.\\d+)?|true|false|null)(?![\\w.-]))";

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

const RULES: Array<[RegExp, string | ((m: string, ...g: string[]) => string)]> = [
  // PEM blocks (service account keys, Snowflake key-pair auth). Also matches JSON-escaped "\n".
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  // scheme(+driver)://[user]:password@host — greedy \S* backtracks to the last "@" in the URI token,
  // so passwords containing "@" are covered without eating the rest of the line.
  [
    new RegExp(`((?:${DB_SCHEMES})(?:\\+\\w+)?:\\/\\/[^\\s:/@]*:)\\S*(@[\\w.-]+(?::\\d+)?)`, "gi"),
    "$1[REDACTED_SECRET]$2",
  ],
  [
    new RegExp(`("(?:key|name)"\\s*:\\s*${SECRET_NAME}\\s*,\\s*"value"\\s*:\\s*)${JSON_STR}`, "gi"),
    '$1"[REDACTED_SECRET]"',
  ],
  [
    new RegExp(
      `("value"\\s*:\\s*)${JSON_STR}(\\s*,\\s*"(?:key|name)"\\s*:\\s*${SECRET_NAME})`,
      "gi",
    ),
    '$1"[REDACTED_SECRET]"$2',
  ],
  // key=value, key: value, "key": "value", PREFIX_KEY=value (SNOWFLAKE_PASSWORD, DB_PASS).
  // Numbers and booleans are skipped so `token_count = 3` style SQL survives.
  [
    new RegExp(
      `(\\b(?:[A-Za-z0-9]+_)*(?:${KV_KEYS})(?:_(?:prod|dev|test|stg|staging|\\d+))?["']?\\]?\\s*[:=]\\s*)${NOT_LITERAL}(?:${VALUE})`,
      "gi",
    ),
    "$1[REDACTED_SECRET]",
  ],
  // SQL DDL: CREATE USER x PASSWORD 'v', IDENTIFIED BY 'v'
  [/(\b(?:password|identified\s+by)\s+)(?:'[^']*'|"[^"]*")/gi, "$1[REDACTED_SECRET]"],
  [/(\b(?:mysql|mariadb|mysqldump|mysqladmin)\b[^\n|;&]*?\s-p)[^\s-]\S*/g, "$1[REDACTED_SECRET]"],
  [/(\s(?:-u|--user)\s+[^\s:]+:)\S+/g, "$1[REDACTED_SECRET]"],
  [/(Authorization:\s*(?:Token|Key|ApiKey))\s+\S+/gi, "$1 [REDACTED_TOKEN]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9_\-.~+/]{8,}=*/gi, "$1 [REDACTED_TOKEN]"],
  // CLI flags: --password secret, --token=secret
  [/(\s--?(?:password|passwd|pwd|token|secret)(?:=|\s+))(\S+)/gi, "$1[REDACTED_SECRET]"],
  // Prose in prompts: "the password is X", "パスワードは X"
  [
    /(\b(?:password|passwd|secret|token|api ?key)\s+(?:is|was|=|:)\s+["']?)[^\s"']{6,}/gi,
    "$1[REDACTED_SECRET]",
  ],
  [
    /((?:パスワード|シークレット|トークン|APIキー)\s*(?:は|が|:|：|=)\s*["'「]?)[^\s"'」、。]{6,}/gi,
    "$1[REDACTED_SECRET]",
  ],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [
    /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g,
    "[REDACTED_AWS_KEY]",
  ],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{30,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED_API_KEY]"],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, "[REDACTED_API_KEY]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, "[REDACTED_GOOGLE_KEY]"],
  [/\bdapi[a-f0-9]{32}\b/g, "[REDACTED_DATABRICKS_TOKEN]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[REDACTED_GITLAB_TOKEN]"],
  // PII that commonly shows up in WHERE clauses and error messages
  [
    /(?<![A-Za-z0-9._%+\-\]])[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    "[REDACTED_EMAIL]",
  ],
  [
    /(?<![\d-])(?:0\d{1,4}-\d{1,4}-\d{3,4}|0[789]0\d{8}|\+\d{1,3}[ -]?\d{1,4}[ -]\d{2,4}[ -]\d{3,4})(?![\d-])/g,
    "[REDACTED_PHONE]",
  ],
  [
    /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
    (m) => (luhn(m.replace(/\D/g, "")) ? "[REDACTED_CARD]" : m),
  ],
];

export function sanitize(text: string | undefined | null): string {
  if (!text) return "";
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep as string);
  return out;
}
