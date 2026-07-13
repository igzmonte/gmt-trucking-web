import test from "node:test";
import assert from "node:assert/strict";

import { handleRequest } from "../src/app.mjs";

function envWithRows(rows = {}) {
  return {
    GMT_SESSION_SECRET: "test-secret",
    DB: {
      prepare(sql) {
        const state = { sql, params: [] };
        return {
          bind(...params) {
            state.params = params;
            return this;
          },
          async all() {
            if (state.sql.includes("FROM trips t")) return { results: rows.trips || [] };
            if (state.sql.includes("FROM employees")) return { results: rows.employees || [] };
            if (state.sql.includes("FROM assets")) return { results: rows.assets || [] };
            if (state.sql.includes("FROM clients")) return { results: rows.clients || [] };
            return { results: [] };
          },
          async first() {
            if (state.sql.includes("FROM users")) return rows.user || null;
            if (state.sql.includes("COUNT(*) AS total FROM trips")) return { total: 0 };
            if (state.sql.includes("COUNT(*) AS total FROM employees")) return { total: 0 };
            if (state.sql.includes("SUM(grand_total)")) return { total: 0 };
            if (state.sql.includes("SUM(amount_paid)")) return { total: 0 };
            return null;
          },
          async run() {
            return { success: true };
          },
        };
      },
    },
  };
}

test("health endpoint is public and reports Cloudflare runtime", async () => {
  const response = await handleRequest(new Request("https://example.test/health"), envWithRows());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, runtime: "cloudflare", database: true });
});

test("protected routes redirect anonymous users to login", async () => {
  const response = await handleRequest(new Request("https://example.test/trips"), envWithRows());
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/login");
});
