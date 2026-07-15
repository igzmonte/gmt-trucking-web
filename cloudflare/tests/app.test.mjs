import test from "node:test";
import assert from "node:assert/strict";

import { handleRequest } from "../src/app.mjs";
import { createSession } from "../src/auth.mjs";

function envWithRows(rows = {}) {
  return {
    GMT_SESSION_SECRET: "test-secret",
    __runs: [],
    DB: {
      prepare(sql) {
        const state = { sql, params: [] };
        const source = (table) => rows[table] || [];
        const byId = (table) => source(table).find((row) => Number(row.id) === Number(state.params.at(-1)));
        const filtered = (table) => {
          const data = source(table);
          if (!state.sql.includes(" LIKE ?")) return data;
          const needle = String(state.params[0] || "").replaceAll("%", "").toLowerCase();
          return data.filter((row) => Object.values(row).some((value) => String(value ?? "").toLowerCase().includes(needle)));
        };
        const tableFrom = () => {
          const match = state.sql.match(/FROM\s+([a-z_]+)/i) || state.sql.match(/DELETE FROM\s+([a-z_]+)/i) || state.sql.match(/INSERT INTO\s+([a-z_]+)/i) || state.sql.match(/UPDATE\s+([a-z_]+)/i);
          return match?.[1];
        };
        return {
          bind(...params) {
            state.params = params;
            return this;
          },
          async all() {
            if (state.sql.includes("FROM trips t")) return { results: rows.trips || [] };
            if (state.sql.includes("FROM employees")) return { results: filtered("employees").slice(0, 25) };
            if (state.sql.includes("FROM assets")) return { results: filtered("assets").slice(0, 25) };
            if (state.sql.includes("FROM clients")) return { results: filtered("clients").slice(0, 25) };
            if (state.sql.includes("FROM suppliers")) return { results: filtered("suppliers").slice(0, 25) };
            return { results: [] };
          },
          async first() {
            if (state.sql.includes("FROM users")) return rows.user || null;
            if (state.sql.includes("COUNT(*) AS total FROM employees") && state.sql.includes("LIKE")) return { total: rows.employeesCount ?? filtered("employees").length };
            if (state.sql.includes("COUNT(*) AS total FROM assets") && state.sql.includes("LIKE")) return { total: rows.assetsCount ?? filtered("assets").length };
            if (state.sql.includes("COUNT(*) AS total FROM clients") && state.sql.includes("LIKE")) return { total: rows.clientsCount ?? filtered("clients").length };
            if (state.sql.includes("COUNT(*) AS total FROM suppliers") && state.sql.includes("LIKE")) return { total: rows.suppliersCount ?? filtered("suppliers").length };
            if (state.sql.includes("COUNT(*) AS total FROM") && state.params.length) {
              const refs = rows.refs || {};
              const table = tableFrom();
              return { total: refs[table] || 0 };
            }
            if (state.sql.includes("COUNT(*) AS total FROM trips")) return { total: 0 };
            if (state.sql.includes("COUNT(*) AS total FROM employees")) return { total: rows.employeesCount ?? source("employees").length };
            if (state.sql.includes("COUNT(*) AS total FROM assets")) return { total: rows.assetsCount ?? source("assets").length };
            if (state.sql.includes("COUNT(*) AS total FROM clients")) return { total: rows.clientsCount ?? source("clients").length };
            if (state.sql.includes("COUNT(*) AS total FROM suppliers")) return { total: rows.suppliersCount ?? source("suppliers").length };
            if (state.sql.includes("SELECT id FROM employees WHERE id=?")) return byId("employees") || null;
            if (state.sql.includes("SELECT id FROM assets WHERE id=?")) return byId("assets") || null;
            if (state.sql.includes("SELECT id FROM clients WHERE id=?")) return byId("clients") || null;
            if (state.sql.includes("SELECT id FROM suppliers WHERE id=?")) return byId("suppliers") || null;
            if (state.sql.includes("SELECT * FROM employees WHERE id=?")) return byId("employees") || null;
            if (state.sql.includes("SELECT * FROM assets WHERE id=?")) return byId("assets") || null;
            if (state.sql.includes("SELECT * FROM clients WHERE id=?")) return byId("clients") || null;
            if (state.sql.includes("SELECT * FROM suppliers WHERE id=?")) return byId("suppliers") || null;
            if (state.sql.match(/SELECT id FROM (employees|assets|clients|suppliers) WHERE/)) {
              if (rows.duplicate) return { id: rows.duplicate };
              return null;
            }
            if (state.sql.includes("SUM(grand_total)")) return { total: 0 };
            if (state.sql.includes("SUM(amount_paid)")) return { total: 0 };
            return null;
          },
          async run() {
            rows.runs?.push({ sql: state.sql, params: state.params });
            return { success: true };
          },
        };
      },
    },
  };
}

async function authedRequest(url, role = "admin", init = {}) {
  const token = await createSession({ id: 1, username: role, role, active: 1 }, "test-secret");
  const headers = new Headers(init.headers || {});
  headers.set("cookie", `gmt_session=${token}`);
  return new Request(url, { ...init, headers });
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

test("login explains when D1 setup has not created users table", async () => {
  const badEnv = envWithRows();
  badEnv.DB.prepare = () => ({
    bind() {
      return this;
    },
    async first() {
      throw new Error("no such table: users");
    },
  });
  const body = new URLSearchParams({ username: "test_admin", password: "characterization-only" });
  const response = await handleRequest(new Request("https://example.test/login", { method: "POST", body }), badEnv);
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Database is not initialized yet/);
});

test("master data list supports search, pagination, and edit actions for admins", async () => {
  const env = envWithRows({
    employees: [{ id: 1, employee_code: "EMP-001", full_name: "Driver One", employee_type: "Driver", payroll_basis: "Per Trip", employment_status: "Active" }],
    employeesCount: 30,
  });
  const response = await handleRequest(await authedRequest("https://example.test/employees?q=Driver&page=2"), env);
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /Driver One/);
  assert.match(text, /Page 2 of 2/);
  assert.match(text, /\/employees\/1\/edit/);
  assert.match(text, /\/employees\/export\.csv\?q=Driver/);
});

test("master data CSV export preserves filtered headers and rows for viewer", async () => {
  const env = envWithRows({
    employees: [{ id: 1, employee_code: "EMP-001", full_name: "Driver One", employee_type: "Driver", payroll_basis: "Per Trip", employment_status: "Active" }],
  });
  const response = await handleRequest(await authedRequest("https://example.test/employees/export.csv?q=Driver", "viewer"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(await response.text(), /Code,Name,Type,Basis,Status\n"EMP-001","Driver One","Driver","Per Trip","Active"/);
});

test("master data create validates required and unique fields", async () => {
  const body = new URLSearchParams({ employee_code: "EMP-001", full_name: "", employee_type: "", daily_rate: "abc", trip_rate: "" });
  let response = await handleRequest(await authedRequest("https://example.test/employees/new", "admin", { method: "POST", body }), envWithRows());
  assert.equal(response.status, 400);
  assert.match(await response.text(), /full name is required/);

  const duplicateBody = new URLSearchParams({ employee_code: "EMP-001", full_name: "Driver One", employee_type: "Driver" });
  response = await handleRequest(await authedRequest("https://example.test/employees/new", "admin", { method: "POST", body: duplicateBody }), envWithRows({ duplicate: 99 }));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /employee code must be unique/);
});

test("master data create saves cleaned values and redirects with success", async () => {
  const runs = [];
  const body = new URLSearchParams({ employee_code: "EMP-099", full_name: "New Driver", employee_type: "Driver", daily_rate: "1200.50", trip_rate: "" });
  const response = await handleRequest(await authedRequest("https://example.test/employees/new", "encoder", { method: "POST", body }), envWithRows({ runs }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /Employees%20created/);
  assert.match(runs[0].sql, /INSERT INTO employees/);
  assert.equal(runs[0].params.at(-3), "1200.5");
  assert.equal(runs[0].params.at(-2), "0");
});

test("master data permissions block viewer mutations and accounting access", async () => {
  const body = new URLSearchParams({ full_name: "Nope", employee_type: "Driver" });
  let response = await handleRequest(await authedRequest("https://example.test/employees/new", "viewer", { method: "POST", body }), envWithRows());
  assert.equal(response.status, 403);
  assert.match(await response.text(), /do not have permission to edit/);

  response = await handleRequest(await authedRequest("https://example.test/employees", "accounting"), envWithRows());
  assert.equal(response.status, 403);
  assert.match(await response.text(), /do not have permission to view/);
});

test("master data delete is POST-only and guarded by related records", async () => {
  const env = envWithRows({
    employees: [{ id: 1, employee_code: "EMP-001", full_name: "Driver One", employee_type: "Driver" }],
    refs: { trips: 1 },
  });
  let response = await handleRequest(await authedRequest("https://example.test/employees/1/delete", "admin"), env);
  assert.equal(response.status, 405);

  response = await handleRequest(await authedRequest("https://example.test/employees/1/delete", "admin", { method: "POST" }), env);
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /Cannot\+delete|Cannot%20delete/);
});

test("master data delete removes unused records", async () => {
  const runs = [];
  const response = await handleRequest(await authedRequest("https://example.test/suppliers/1/delete", "admin", { method: "POST" }), envWithRows({
    suppliers: [{ id: 1, supplier_name: "Parts Supplier" }],
    runs,
  }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /Suppliers%20deleted/);
  assert.match(runs[0].sql, /DELETE FROM suppliers WHERE id=/);
});
