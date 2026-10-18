import { describe, expect, it } from "bun:test";
import { sanitize } from "../src/sanitizer";

/** Token-shaped fixtures are assembled at runtime so secret scanners do not flag this file. */
const fake = (...parts: string[]) => parts.join("");

const leaks: Array<[string, string, string]> = [
  [
    "postgres URI",
    "postgresql://myuser:supersecret123@db.prod.internal:5432/analytics",
    "supersecret123",
  ],
  ["password with @", "snowflake://analyst:P@ssw0rd!@acct.snowflakecomputing.com/WH", "P@ssw0rd!"],
  [
    "JSON private_key",
    '{"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg\\n-----END PRIVATE KEY-----\\n"}',
    "MIIEvQIBADANBg",
  ],
  ["JSON password", '{"password": "hunter2xyz"}', "hunter2xyz"],
  ["env suffix", "export SNOWFLAKE_PASSWORD=abc123", "abc123"],
  ["DB_PASS", "DB_PASS=abc123", "abc123"],
  ["token=", "token=abcdef123456", "abcdef123456"],
  ["stripe", `STRIPE=${fake("sk_", "live_", "51H", "x".repeat(24))}`, "51Hxxxx"],
  [
    "slack",
    `slack ${fake("xo", "xb-", "123456789012-123456789012-abcdefABCDEF")}`,
    "123456789012-1234",
  ],
  ["google", `key ${fake("AI", "za", "SyA1234567890abcdefghijklmnopqrstu")}`, "SyA123"],
  [
    "databricks",
    `databricks ${fake("da", "pi", "1234567890abcdef1234567890abcdef")}`,
    "1234567890abcdef12",
  ],
  ["bearer", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", "abcdefghijklmnop"],
  ["basic", "Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l", "YWxhZGRpbjpvcGVuc2VzYW1l"],
  ["cli flag", "bq query --token abcd1234secret", "abcd1234secret"],
  ["email", "WHERE email = 'jane.doe@example.com'", "jane.doe@example.com"],
  [
    "jwt",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J_wStmock12345",
    "dozjgNryP4J",
  ],
  ["aws", fake("AK", "IA", "IOSFODNN7EXAMPLE"), "IOSFODNN7EXAMPLE"],
  ["PGPASSWORD", "PGPASSWORD=Zq9Lm2Xw psql -h db -U bob -c 'select 1'", "Zq9Lm2Xw"],
  ["mysql -p", "mysql -u root -pZq9Lm2Xw analytics -e 'select 1'", "Zq9Lm2Xw"],
  ["curl -u", "curl -u alice:Zq9Lm2Xw https://api.example.com/v1/x", "Zq9Lm2Xw"],
  ["Authorization Token", "curl -H 'Authorization: Token Zq9Lm2Xwabcdef' https://x", "Zq9Lm2Xw"],
  [
    "sqlalchemy driver",
    "create_engine('postgresql+psycopg2://bob:Zq9Lm2Xw@db.internal/analytics')",
    "Zq9Lm2Xw",
  ],
  ["redis no user", "redis-cli -u redis://:Zq9Lm2Xw@cache.internal:6379", "Zq9Lm2Xw"],
  [
    "azure",
    "'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=Zq9Lm2Xw==;EndpointSuffix=x'",
    "Zq9Lm2Xw",
  ],
  [
    "mcp key/value",
    '{"projectId":"p1","key":"STRIPE_SECRET","value":"Zq9Lm2Xw","target":["production"]}',
    "Zq9Lm2Xw",
  ],
  ["mcp value/key", '{"value":"ab\\"Zq9Lm2Xw","key":"DB_PASSWORD"}', "Zq9Lm2Xw"],
  ["quoted with spaces", "export SNOWFLAKE_PASSWORD='a b Zq9Lm2Xw'; python run.py", "Zq9Lm2Xw"],
  ["python kwarg", "connect(user='bob', password='Zq9 Lm2Xw')", "Lm2Xw"],
  ["odbc braces", "'DRIVER={Snowflake};SERVER=x;PWD={Zq;9Lm2Xw}'", "9Lm2Xw"],
  ["prose", "the snowflake password is Zq9Lm2Xw, use it", "Zq9Lm2Xw"],
  ["prose ja", "本番のパスワードはZq9Lm2Xwです", "Zq9Lm2Xw"],
  ["phone", 'invalid input: "Taro 090-1234-5678"', "090-1234-5678"],
  ["card", "card 4111 1111 1111 1111", "4111 1111 1111 1111"],
  ["mailto", "python x.py --to mailto:jane.doe@corp.example.com", "jane.doe"],
  ["urlencoded email", "curl https://h/x?u=jane.doe%40corp.example.com", "jane.doe"],
  [
    "s3 signature",
    "curl 'https://b.s3.amazonaws.com/x?X-Amz-Signature=Zq9Lm2Xw0123'",
    "Zq9Lm2Xw0123",
  ],
  ["passphrase", "private_key_passphrase=Zq9Lm2Xw", "Zq9Lm2Xw"],
  ["sql create user", "CREATE USER bi PASSWORD 'Sup3rSecret!99';", "Sup3rSecret"],
  ["sql identified by", 'ALTER USER bi IDENTIFIED BY "Sup3rSecret!99";', "Sup3rSecret"],
  [
    "environ subscript",
    'os.environ["WAREHOUSE_API_TOKEN"] = "zq8Lm2Vx9Rt4Yw7Pb3Nc"',
    "zq8Lm2Vx9Rt4",
  ],
];

describe("sanitize", () => {
  for (const [name, raw, secret] of leaks) {
    it(`redacts ${name}`, () => expect(sanitize(raw)).not.toContain(secret));
  }

  it("keeps the rest of the line after a DB URI", () => {
    expect(sanitize("snowflake://user:p@ss@acct/db then more text")).toBe(
      "snowflake://user:[REDACTED_SECRET]@acct/db then more text",
    );
  });

  it("leaves ordinary SQL alone", () => {
    const sql = `SELECT u.id, count(o.id) AS order_count, max_tokens
      FROM dim_users u LEFT JOIN fct_orders o ON u.id = o.user_id
      WHERE u.deleted_at IS NULL AND bypass_flag = 1 AND token_count = 3 AND pass_rate=0.9
        AND is_secret_santa = true AND user_id = 1234567890123 AND dt = '2026-10-18' GROUP BY 1;`;
    expect(sanitize(sql)).toBe(sql);
  });
});
