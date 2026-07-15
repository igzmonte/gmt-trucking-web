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
            if (state.sql.includes("FROM recurring_trip_masters r")) return { results: filtered("recurring").slice(0, 25) };
            if (state.sql.includes("FROM employees")) return { results: filtered("employees").slice(0, 25) };
            if (state.sql.includes("FROM assets")) return { results: filtered("assets").slice(0, 25) };
            if (state.sql.includes("FROM clients")) return { results: filtered("clients").slice(0, 25) };
            if (state.sql.includes("FROM suppliers")) return { results: filtered("suppliers").slice(0, 25) };
            return { results: [] };
          },
          async first() {
            if (state.sql.includes("FROM users")) return rows.user || null;
            if (state.sql.includes("COUNT(*) AS total FROM recurring_trip_masters") && state.sql.includes("LIKE")) return { total: rows.recurringCount ?? filtered("recurring").length };
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
            if (state.sql.includes("COUNT(*) AS total FROM recurring_trip_masters")) return { total: rows.recurringCount ?? source("recurring").length };
            if (state.sql.includes("COUNT(*) AS total FROM employees")) return { total: rows.employeesCount ?? source("employees").length };
            if (state.sql.includes("COUNT(*) AS total FROM assets")) return { total: rows.assetsCount ?? source("assets").length };
            if (state.sql.includes("COUNT(*) AS total FROM clients")) return { total: rows.clientsCount ?? source("clients").length };
            if (state.sql.includes("COUNT(*) AS total FROM suppliers")) return { total: rows.suppliersCount ?? source("suppliers").length };
            if (state.sql.includes("SELECT id FROM recurring_trip_masters WHERE id=?")) return byId("recurring") || null;
            if (state.sql.includes("SELECT id FROM employees WHERE id=?")) return byId("employees") || null;
            if (state.sql.includes("SELECT id FROM assets WHERE id=?")) return byId("assets") || null;
            if (state.sql.includes("SELECT id FROM clients WHERE id=?")) return byId("clients") || null;
            if (state.sql.includes("SELECT id FROM suppliers WHERE id=?")) return byId("suppliers") || null;
            if (state.sql.includes("SELECT * FROM recurring_trip_masters WHERE id=?")) return byId("recurring") || null;
            if (state.sql.includes("SELECT * FROM employees WHERE id=?")) return byId("employees") || null;
            if (state.sql.includes("SELECT * FROM assets WHERE id=?")) return byId("assets") || null;
            if (state.sql.includes("SELECT * FROM clients WHERE id=?")) return byId("clients") || null;
            if (state.sql.includes("SELECT * FROM suppliers WHERE id=?")) return byId("suppliers") || null;
            if (state.sql.match(/SELECT id FROM (employees|assets|clients|suppliers|recurring_trip_masters) WHERE/)) {
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

test("recurring trips list supports search, pagination, and editor actions", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/recurring-trips?q=RM&page=2", "admin"), envWithRows({
    recurringCount: 30,
    recurring: [{
      id: 1, master_code: "RM-001", client_name: "Client One", origin: "Warehouse", destination: "Depot",
      asset_code: "UNIT-001", driver_name: "Driver One", default_helper_count: 2, standard_base_rate: 2500,
      driver_pay_rate: 600, helper_pay_rate: 300,
    }],
  }));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /RM-001/);
  assert.match(text, /New Template/);
  assert.match(text, /Page 2 of 2/);
  assert.match(text, /\/recurring-trips\/1\/edit/);
  assert.match(text, /\/recurring-trips\/export\.csv\?q=RM/);
});

test("recurring trips CSV export uses Django-compatible headers", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/recurring-trips/export.csv?q=RM", "viewer"), envWithRows({
    recurring: [{
      id: 1, master_code: "RM-001", client_name: "Client One", job_description: "Item Job", origin: "Warehouse",
      destination: "Depot", asset_code: "UNIT-001", driver_name: "Driver One", default_helper_count: 2,
      standard_base_rate: 2500, driver_pay_rate: 600, helper_pay_rate: 300, active: 1,
    }],
  }));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /ID,Code,Client,Item \/ Job,Origin,Destination,Asset,Driver,Helpers,Base Rate,Driver Pay,Helper Pay,Active/);
});

test("recurring trip form shows detailed dropdown labels", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/recurring-trips/new", "admin"), envWithRows({
    clients: [{ id: 1, client_code: "CLI-001", client_name: "Client One" }],
    assets: [{ id: 2, asset_code: "UNIT-001", plate_no: "ABC-123", asset_type: "Cargo Truck", make_model: "Isuzu" }],
    employees: [{ id: 3, employee_code: "EMP-001", full_name: "Driver One", employee_type: "Driver", payroll_basis: "Per Trip" }],
  }));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /CLI-001/);
  assert.match(text, /UNIT-001/);
  assert.match(text, /ABC-123/);
  assert.match(text, /EMP-001/);
  assert.match(text, /Item \/ Job/);
});

test("recurring trip create validates helper limit and duplicate code", async () => {
  const tooMany = new URLSearchParams({ master_code: "RM-NEW", default_helper_count: "11" });
  let response = await handleRequest(await authedRequest("https://example.test/recurring-trips/new", "admin", { method: "POST", body: tooMany }), envWithRows());
  assert.equal(response.status, 400);
  assert.match(await response.text(), /cannot exceed 10/);

  const duplicate = new URLSearchParams({ master_code: "RM-001", default_helper_count: "1" });
  response = await handleRequest(await authedRequest("https://example.test/recurring-trips/new", "admin", { method: "POST", body: duplicate }), envWithRows({ duplicate: 1 }));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /master code must be unique/);
});

test("recurring trip create and edit save cleaned values", async () => {
  let runs = [];
  let body = new URLSearchParams({
    master_code: "RM-NEW", client_id: "1", job_description: "Delivery", origin: "A", destination: "B",
    default_asset_id: "2", default_driver_id: "3", default_helper_count: "2", standard_base_rate: "2500.50",
    driver_pay_rate: "", helper_pay_rate: "300", active: "1",
  });
  let response = await handleRequest(await authedRequest("https://example.test/recurring-trips/new", "encoder", { method: "POST", body }), envWithRows({ runs }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /Recurring%20trip%20master%20saved/);
  assert.match(runs[0].sql, /INSERT INTO recurring_trip_masters/);
  assert.equal(runs[0].params[8], "2500.5");

  runs = [];
  body = new URLSearchParams({ master_code: "RM-EDIT", default_helper_count: "1", active: "0" });
  response = await handleRequest(await authedRequest("https://example.test/recurring-trips/1/edit", "admin", { method: "POST", body }), envWithRows({
    recurring: [{ id: 1, master_code: "RM-OLD" }],
    runs,
  }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /updated/);
  assert.match(runs[0].sql, /UPDATE recurring_trip_masters SET/);
});

test("recurring trip permissions block viewer mutations and accounting access", async () => {
  const body = new URLSearchParams({ master_code: "RM-X" });
  let response = await handleRequest(await authedRequest("https://example.test/recurring-trips/new", "viewer", { method: "POST", body }), envWithRows());
  assert.equal(response.status, 403);
  assert.match(await response.text(), /do not have permission to edit/);

  response = await handleRequest(await authedRequest("https://example.test/recurring-trips", "accounting"), envWithRows());
  assert.equal(response.status, 403);
});

test("recurring trip delete is POST-only and clears linked trips first", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/recurring-trips/1/delete", "admin"), envWithRows({
    recurring: [{ id: 1, master_code: "RM-001" }],
  }));
  assert.equal(response.status, 405);

  const runs = [];
  response = await handleRequest(await authedRequest("https://example.test/recurring-trips/1/delete", "admin", { method: "POST" }), envWithRows({
    recurring: [{ id: 1, master_code: "RM-001" }],
    runs,
  }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /existing%20trips%20kept/i);
  assert.match(runs[0].sql, /UPDATE trips SET recurring_master_id=NULL/);
  assert.match(runs[1].sql, /DELETE FROM recurring_trip_masters/);
});

test("trip create dropdown uses recurring template detail labels", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/trips/new", "admin"), envWithRows({
    recurring: [{ id: 1, master_code: "RM-001", client_name: "Client One", origin: "A", destination: "B", job_description: "Delivery" }],
  }));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /RM-001/);
  assert.match(text, /Client One/);
  assert.match(text, /Delivery/);
});
