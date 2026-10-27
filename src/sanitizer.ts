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

/**
 * The Japanese My Number check digit. A bare 12-digit run is far more often an id or a date
 * in SQL than a personal number, so the rule that uses this also requires a My Number label.
 */
function myNumberOk(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length !== 12) return false;
  const n = [...d].map(Number);
  let sum = 0;
  for (let i = 1; i <= 11; i++) sum += n[11 - i] * (i <= 6 ? i + 1 : i - 5);
  const check = 11 - (sum % 11);
  return (check >= 10 ? 0 : check) === n[11];
}

const MY_NUMBER_LABEL = "(?:マイナンバー(?:カード)?|個人番号|my\\s*number)";

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
  // CLI flags, matched on the secret-bearing part of the name: --password, --db-password=,
  // --secret-key, --api-token, --passphrase, -pwd. The flag has to end in a secret word, so a
  // path flag such as --key-file is left alone, and a number is never treated as a secret, so a
  // count such as --max-tokens 1000 survives.
  [
    /(\s--?[\w-]*(?:password|passwd|passphrase|secret|token|key|pwd)(?:=|\s+))(?!-?\d+(?:\.\d+)?\b)(\S+)/gi,
    "$1[REDACTED_SECRET]",
  ],
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
  // Google OAuth access tokens (ya29.) and OAuth client secrets (GOCSPX-).
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, "[REDACTED_GOOGLE_TOKEN]"],
  [/\bGOCSPX-[A-Za-z0-9_-]{20,}/g, "[REDACTED_GOOGLE_SECRET]"],
  // Hugging Face user access tokens.
  [/\bhf_[A-Za-z0-9]{30,}/g, "[REDACTED_HF_TOKEN]"],
  // npm tokens, and the .npmrc form `//registry/:_authToken=<value>` or `_authToken <value>`.
  [/\bnpm_[A-Za-z0-9]{30,}/g, "[REDACTED_NPM_TOKEN]"],
  [
    /((?:\/\/[^\s]*|)_authToken["']?\s*[:=]\s*|\b_authToken\s+)["']?[A-Za-z0-9_-]{8,}["']?/gi,
    "$1[REDACTED_SECRET]",
  ],
  // SendGrid: SG.<22 chars>.<43 chars>
  [/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, "[REDACTED_SENDGRID_KEY]"],
  // Cookie headers carry session ids, so the value goes. A cookie value always has a `name=`
  // pair, which keeps prose such as "Cookie: see the docs" intact.
  [/\b((?:Set-)?Cookie:\s*)(?=[^\n]*=)[^\n]+/gi, "$1[REDACTED_COOKIE]"],
  // sshpass -p <password>
  [/(\bsshpass\b[^\n]*?\s-p\s*)["']?[^\s"']+["']?/g, "$1[REDACTED_SECRET]"],
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
  // My Number needs its label and a valid check digit. An unlabelled 12-digit run is left
  // alone, because SQL is full of ids and dates that long.
  [
    new RegExp(
      `(${MY_NUMBER_LABEL}\\s*(?:は|が|:|：|=|is)?\\s*)(\\d{4}[ -]?\\d{4}[ -]?\\d{4})`,
      "gi",
    ),
    (m, label: string, digits: string) => (myNumberOk(digits) ? `${label}[REDACTED_MY_NUMBER]` : m),
  ],
];

export function sanitize(text: string | undefined | null): string {
  if (!text) return "";
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep as string);
  return out;
}
