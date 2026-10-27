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
  ["google oauth token", `auth ${fake("ya", "29.", "0A", "b".repeat(30))}`, "0Abbbb"],
  ["google oauth secret", `client ${fake("GOC", "SPX-", "d".repeat(28))}`, "dddddddd"],
  ["huggingface token", `use ${fake("hf", "_", "QwErTy".repeat(5))}`, "QwErTyQwEr"],
  ["npm token", `token ${fake("np", "m_", "Kp2Lm9Xz".repeat(5))}`, "Kp2Lm9XzKp2"],
  [
    "npmrc authToken",
    `//registry.npmjs.org/:_authToken=${fake("np", "m_", "Kp2Lm9Xz".repeat(5))}`,
    "Kp2Lm9XzKp2",
  ],
  [
    "npmrc space separated",
    `//registry.npmjs.org/:_authToken ${fake("npm", "R", "4nQ8sW2v".repeat(5))}`,
    "4nQ8sW2v4n",
  ],
  [
    "sendgrid",
    `mail ${fake("SG", ".", "Zq9Lm2XwRt4Yw7Pb3Nc5Vd1".slice(0, 22), ".", "Kj8Hg6Fd4Sa2".repeat(4).slice(0, 43))}`,
    "Kj8Hg6Fd4Sa2",
  ],
  ["cookie header", "Cookie: session=Zq9Lm2Xwabcd; csrftoken=Zq9Lm2Xw", "Zq9Lm2Xwabcd"],
  ["set-cookie header", "Set-Cookie: sid=Zq9Lm2Xwabcd; Path=/; HttpOnly", "Zq9Lm2Xwabcd"],
  ["sshpass", "sshpass -p Zq9Lm2Xw ssh deploy@host", "Zq9Lm2Xw"],
  ["hyphenated flag", "runner --db-password=Zq9Lm2Xw ~/job", "Zq9Lm2Xw"],
  ["secret-key flag", "app --secret-key Zq9Lm2Xw", "Zq9Lm2Xw"],
  ["passphrase flag", "gpg --passphrase=Zq9Lm2Xw file.gpg", "Zq9Lm2Xw"],
  ["my number ja", "顧客のマイナンバーは123456789018です", "123456789018"],
  ["my number spaced", "マイナンバー: 1234 5678 9018", "1234 5678 9018"],
  ["my number en", "my number is 123456789018", "123456789018"],
  // One row per class the rows above did not reach yet.
  [
    "github token",
    `git push https://${fake("gh", "p_", "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1W")}@github.com/x`,
    "Ab1Cd2Ef3Gh4",
  ],
  [
    "github pat",
    fake("github", "_pat_", "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"),
    "11ABCDEFG012",
  ],
  ["gitlab token", fake("glp", "at-", "Zq9Lm2XwRt4Yw7Pb3Nc5"), "Zq9Lm2XwRt4Y"],
  ["openai key", `OPENAI ${fake("sk", "-proj-", "Zq9Lm2XwRt4Yw7Pb3Nc5Vd1")}`, "Zq9Lm2XwRt4Y"],
  ["anthropic key", fake("sk", "-ant-", "api03-Zq9Lm2XwRt4Yw7Pb3Nc5"), "api03-Zq9Lm2"],
  ["stripe restricted key", fake("rk", "_test_", "Zq9Lm2XwRt4Yw7Pb3Nc5"), "Zq9Lm2XwRt4Y"],
  ["aws temporary key", fake("AS", "IA", "Y34FZKBOKMUTVV7A"), "Y34FZKBOKMUTVV7A"],
  [
    "pem rsa key",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
    "MIIEow",
  ],
  [
    "authorization apikey",
    "curl -H 'Authorization: ApiKey Zq9Lm2Xwabcd' https://x",
    "Zq9Lm2Xwabcd",
  ],
  ["curl --user", "curl --user alice:Zq9Lm2Xw https://x", "Zq9Lm2Xw"],
  ["api-token flag", "tool --api-token Zq9Lm2Xw run", "Zq9Lm2Xw"],
  ["private-key-passphrase flag", "snowsql --private-key-passphrase Zq9Lm2Xw -a acct", "Zq9Lm2Xw"],
  ["-pwd flag", "sqlcmd -pwd Zq9Lm2Xw -S host", "Zq9Lm2Xw"],
  ["api key prose", "the api key is Zq9Lm2XwRt4", "Zq9Lm2XwRt4"],
  ["api key prose ja", "APIキーは Zq9Lm2XwRt4 です", "Zq9Lm2XwRt4"],
  ["landline phone", "連絡先 03-1234-5678 まで", "03-1234-5678"],
  ["international phone", "call +81 90-1234-5678 now", "1234-5678"],
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

  it("does not redact ordinary SQL that the new rules could overreach on", () => {
    const sql = `SELECT *
      FROM fct_orders
      WHERE order_id = 123456789012
        AND customer_sk = 'ACC-2024-0001'
        AND token_count = 1200
        AND run_dt = '20240101'
      LIMIT 500;`;
    expect(sanitize(sql)).toBe(sql);
  });

  it("does not redact these command lines", () => {
    const lines = [
      "bq query --max-tokens 1000 'SELECT 1'",
      "python script.py --token-count 5",
      "docker run --key-file /etc/app/key.json image",
      "npm install --save-dev typescript",
      "sshpass is installed on the runner",
    ];
    for (const line of lines) expect(sanitize(line)).toBe(line);
  });

  it("leaves an unlabelled 12-digit number alone", () => {
    expect(sanitize("user_id = 123456789018")).toBe("user_id = 123456789018");
    expect(sanitize("マイナンバーは123456789012")).toBe("マイナンバーは123456789012");
  });
});
