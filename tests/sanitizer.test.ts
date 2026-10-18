import { describe, expect, it } from "bun:test";
import { sanitizeContent } from "../src/core/sanitizer";

describe("sanitizeContent", () => {
  it("redacts postgres connection string passwords", () => {
    const raw = "Connecting to postgresql://myuser:supersecret123@db.prod.internal:5432/analytics";
    const cleaned = sanitizeContent(raw);
    expect(cleaned).toBe(
      "Connecting to postgresql://myuser:[REDACTED_SECRET]@db.prod.internal:5432/analytics",
    );
  });

  it("redacts snowflake connection string passwords", () => {
    const raw = "snowflake://analyst:P@ssw0rd!@myaccount.snowflakecomputing.com/ANALYTICS_WH";
    const cleaned = sanitizeContent(raw);
    expect(cleaned).toBe(
      "snowflake://analyst:[REDACTED_SECRET]@myaccount.snowflakecomputing.com/ANALYTICS_WH",
    );
  });

  it("redacts key-value secrets in configuration", () => {
    const raw = 'export API_KEY="sk-12345678901234567890" and password: my_password_99;';
    const cleaned = sanitizeContent(raw);
    expect(cleaned).toContain("[REDACTED_SECRET]");
  });

  it("redacts Bearer tokens and JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J_wStmockSignature12345";
    const raw = `Authorization: Bearer ${jwt}`;
    const cleaned = sanitizeContent(raw);
    expect(cleaned).not.toContain(jwt);
    expect(cleaned).toContain("[REDACTED_JWT]");
  });

  it("preserves regular SQL and text intact", () => {
    const sql = `
      SELECT u.id, count(o.id) as order_count
      FROM dim_users u
      LEFT JOIN fct_orders o ON u.id = o.user_id
      WHERE u.deleted_at IS NULL
      GROUP BY 1;
    `;
    expect(sanitizeContent(sql)).toBe(sql);
  });
});
