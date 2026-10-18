/**
 * Sanitizer for redacting secrets, credentials, and sensitive data from queries and outputs.
 */

// Common patterns for secrets and credentials
const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // Database connection strings: e.g. postgresql://user:pass@host:5432/db
  {
    name: "db_uri",
    regex:
      /(?:postgresql|postgres|mysql|snowflake|redshift|bigquery|mongodb|sqlserver):\/\/[^\s:]+:([^\s@]+)@[^\s/]+/gi,
  },
  // Key-value password patterns: e.g. password=xyz, pwd: xyz, secret: xyz
  {
    name: "kv_secret",
    regex:
      /(?:password|passwd|pwd|secret|api_key|apikey|access_token|private_key)\s*[:=]\s*["']?([^\s"';,]+)["']?/gi,
  },
  // JWT tokens: eyJ...
  {
    name: "jwt",
    regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
  },
  // Bearer tokens
  {
    name: "bearer",
    regex: /Bearer\s+([a-zA-Z0-9_\-\.~+/]{20,})/gi,
  },
  // AWS Access Key ID
  {
    name: "aws_access_key",
    regex: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g,
  },
  // GitHub Personal Access Token (classic & fine-grained)
  {
    name: "github_pat",
    regex: /(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{36,}/g,
  },
  // OpenAI / Anthropic / Generic API Keys (sk-..., ant-...)
  {
    name: "llm_api_key",
    regex: /(?:sk-[a-zA-Z0-9]{20,}|sk-ant-[a-zA-Z0-9-_]{20,})/g,
  },
];

/**
 * Redacts known sensitive patterns and credentials from a text string.
 */
export function sanitizeContent(content: string): string {
  if (!content) return "";

  let sanitized = content;

  // DB URI: Replace password part up to the last @host
  sanitized = sanitized.replace(
    /((?:postgresql|postgres|mysql|snowflake|redshift|bigquery|mongodb|sqlserver):\/\/[^\s:]+:)(.*)(@[a-zA-Z0-9.\-_]+(?::\d+)?(?:\/[^\s]*)?)/gi,
    "$1[REDACTED_SECRET]$3",
  );

  // Key-value secret patterns: replace the value
  sanitized = sanitized.replace(
    /((?:password|passwd|pwd|secret|api_key|apikey|access_token|private_key)\s*[:=]\s*["']?)([^\s"';,]+)(["']?)/gi,
    (match, prefix, val, suffix) => `${prefix}[REDACTED_SECRET]${suffix}`,
  );

  // JWT
  sanitized = sanitized.replace(
    /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
    "[REDACTED_JWT]",
  );

  // Bearer token
  sanitized = sanitized.replace(/Bearer\s+([a-zA-Z0-9_\-\.~+/]{20,})/gi, "Bearer [REDACTED_TOKEN]");

  // AWS Access Key
  sanitized = sanitized.replace(
    /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g,
    "[REDACTED_AWS_KEY]",
  );

  // GitHub tokens
  sanitized = sanitized.replace(
    /(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{36,}/g,
    "[REDACTED_GITHUB_TOKEN]",
  );

  // LLM API Keys
  sanitized = sanitized.replace(
    /(?:sk-[a-zA-Z0-9]{20,}|sk-ant-[a-zA-Z0-9-_]{20,})/g,
    "[REDACTED_API_KEY]",
  );

  return sanitized;
}
