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
            if (state.sql.includes("FROM repairs r")) return { results: rows.repairs || [] };
            if (state.sql.includes("FROM payables p")) return { results: rows.payables || [] };
            if (state.sql.includes("FROM vale_records v")) return { results: rows.vale || [] };
            if (state.sql.includes("FROM cash_advances c")) return { results: rows.cashAdvances || [] };
            if (state.sql.includes("FROM trips t")) return { results: rows.trips || [] };
            if (state.sql.includes("FROM trip_helpers th")) return { results: rows.tripHelpers || [] };
            if (state.sql.includes("FROM trip_employee_pay_items")) return { results: rows.payItems || [] };
            if (state.sql.includes("FROM recurring_trip_masters r")) return { results: filtered("recurring").slice(0, 25) };
            if (state.sql.includes("FROM repairs ORDER BY")) return { results: rows.repairs || [] };
            if (state.sql.includes("FROM employees WHERE active=1 AND employee_type='Driver'")) return { results: rows.drivers || filtered("employees").filter((row) => row.employee_type === "Driver").slice(0, 25) };
            if (state.sql.includes("FROM employees WHERE active=1 AND employee_type='Helper'")) return { results: rows.helpers || filtered("employees").filter((row) => row.employee_type === "Helper").slice(0, 25) };
            if (state.sql.includes("FROM employees")) return { results: filtered("employees").slice(0, 25) };
            if (state.sql.includes("FROM assets")) return { results: filtered("assets").slice(0, 25) };
            if (state.sql.includes("FROM clients")) return { results: filtered("clients").slice(0, 25) };
            if (state.sql.includes("FROM suppliers")) return { results: filtered("suppliers").slice(0, 25) };
            return { results: [] };
          },
          async first() {
            if (state.sql.includes("FROM users")) return rows.user || null;
            if (state.sql.includes("COUNT(*) AS total FROM repairs r")) return { total: rows.repairsCount ?? filtered("repairs").length };
            if (state.sql.includes("COUNT(*) AS total FROM payables p")) return { total: rows.payablesCount ?? filtered("payables").length };
            if (state.sql.includes("COUNT(*) AS total FROM vale_records v")) return { total: rows.valeCount ?? filtered("vale").length };
            if (state.sql.includes("COUNT(*) AS total FROM cash_advances c")) return { total: rows.cashCount ?? filtered("cashAdvances").length };
            if (state.sql.includes("COUNT(*) AS total FROM trips WHERE")) return { total: (rows.refs || {}).trips || 0 };
            if (state.sql.includes("COUNT(*) AS total FROM trips")) return { total: rows.tripsCount ?? filtered("trips").length };
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
            if (state.sql.includes("COUNT(*) AS total FROM recurring_trip_masters")) return { total: rows.recurringCount ?? source("recurring").length };
            if (state.sql.includes("COUNT(*) AS total FROM employees")) return { total: rows.employeesCount ?? source("employees").length };
            if (state.sql.includes("COUNT(*) AS total FROM assets")) return { total: rows.assetsCount ?? source("assets").length };
            if (state.sql.includes("COUNT(*) AS total FROM clients")) return { total: rows.clientsCount ?? source("clients").length };
            if (state.sql.includes("COUNT(*) AS total FROM suppliers")) return { total: rows.suppliersCount ?? source("suppliers").length };
            if (state.sql.includes("SELECT t.*,") && state.sql.includes("FROM trips t")) return byId("trips") || null;
            if (state.sql.includes("SELECT trip_ticket_no FROM trips WHERE trip_ticket_no LIKE")) return rows.lastTicket || null;
            if (state.sql.includes("SELECT id FROM trips WHERE trip_ticket_no=?")) {
              if (rows.duplicateTrip) return { id: rows.duplicateTrip };
              if ((rows.runs || []).some((run) => run.sql.includes("INSERT INTO trips"))) return { id: rows.createdTripId || 77 };
              return null;
            }
            if (state.sql.includes("SELECT trip_ticket_no FROM trips WHERE id=?")) return byId("trips") || null;
            if (state.sql.includes("SELECT asset_type FROM assets WHERE id=?")) return byId("assets") || null;
            if (state.sql.includes("SELECT id FROM recurring_trip_masters WHERE id=?")) return byId("recurring") || null;
            if (state.sql.includes("SELECT id FROM employees WHERE id=?")) return byId("employees") || null;
            if (state.sql.includes("SELECT id FROM assets WHERE id=?")) return byId("assets") || null;
            if (state.sql.includes("SELECT id FROM clients WHERE id=?")) return byId("clients") || null;
            if (state.sql.includes("SELECT id FROM suppliers WHERE id=?")) return byId("suppliers") || null;
            if (state.sql.includes("SELECT * FROM repairs WHERE id=?")) return byId("repairs") || null;
            if (state.sql.includes("SELECT * FROM payables WHERE id=?")) return byId("payables") || null;
            if (state.sql.includes("SELECT * FROM vale_records WHERE id=?")) return byId("vale") || null;
            if (state.sql.includes("SELECT * FROM cash_advances WHERE id=?")) return byId("cashAdvances") || null;
            if (state.sql.includes("SELECT id FROM repairs WHERE repair_date=?")) {
              if ((rows.runs || []).some((run) => run.sql.includes("INSERT INTO repairs"))) return { id: rows.createdRepairId || 41 };
              return null;
            }
            if (state.sql.includes("SELECT id FROM payables WHERE linked_repair_id=?")) return rows.linkedPayable || null;
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

function tripBody(overrides = {}) {
  return new URLSearchParams({
    trip_ticket_no: "",
    reference_no: "OR-123",
    trip_type: "Spot Trip",
    recurring_master_id: "",
    trip_date: "2026-07-15",
    client_id: "1",
    job_description: "AAC Blocks",
    origin: "Warehouse",
    destination: "Site",
    asset_id: "2",
    driver_id: "3",
    dispatch_time: "08:00",
    arrival_time: "12:00",
    status: "Planned",
    base_trip_rate: "1000",
    driver_pay_rate: "300",
    helper_pay_rate: "200",
    fuel_surcharge: "50",
    loading_fee: "25",
    unloading_fee: "0",
    waiting_fee: "0",
    tolls: "0",
    additional_stop_charge: "0",
    special_handling_fee: "0",
    other_charges: "0",
    helper_1: "",
    helper_2: "",
    helper_3: "",
    driver_pay_items: "[]",
    helper_pay_items: "[]",
    notes: "Handle with care",
    ...overrides,
  });
}

function sampleTrip(overrides = {}) {
  return {
    id: 1,
    trip_ticket_no: "TT-2026-000001",
    reference_no: "OR-123",
    trip_type: "Spot Trip",
    recurring_master_id: null,
    recurring_code: "",
    trip_date: "2026-07-15",
    client_id: 1,
    client_name: "Client One",
    job_description: "AAC Blocks",
    origin: "Warehouse",
    destination: "Site",
    asset_id: 2,
    asset_code: "UNIT-001",
    plate_no: "ABC-123",
    driver_id: 3,
    driver_name: "Driver One",
    dispatch_time: "08:00",
    arrival_time: "12:00",
    status: "Planned",
    base_trip_rate: 1000,
    driver_pay_rate: 300,
    helper_pay_rate: 200,
    driver_additional_pay: 100,
    helper_additional_pay: 50,
    fuel_surcharge: 50,
    loading_fee: 25,
    unloading_fee: 0,
    waiting_fee: 0,
    tolls: 0,
    additional_stop_charge: 0,
    special_handling_fee: 0,
    other_charges: 0,
    notes: "Handle with care",
    helper_names: "Helper One",
    ...overrides,
  };
}

function repairBody(overrides = {}) {
  return new URLSearchParams({
    repair_date: "2026-07-16",
    asset_id: "2",
    repair_description: "Oil change",
    meter_value: "12000 km",
    supplier_id: "7",
    parts_cost: "1000",
    labor_cost: "500",
    other_cost: "250",
    status: "Open",
    auto_generate_payable: "1",
    notes: "Urgent",
    ...overrides,
  });
}

function payableBody(overrides = {}) {
  return new URLSearchParams({
    payable_date: "2026-07-16",
    supplier_id: "7",
    source_type: "Manual",
    reference_no: "BILL-1",
    description: "Parts bill",
    amount: "1200",
    due_date: "2026-07-30",
    status: "Open",
    linked_repair_id: "",
    notes: "",
    ...overrides,
  });
}

function advanceBody(overrides = {}) {
  return new URLSearchParams({
    employee_id: "4",
    date_granted: "2026-07-16",
    amount: "1000",
    installment_amount: "250",
    balance: "",
    applied: "0",
    status: "Open",
    notes: "Preview",
    ...overrides,
  });
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

test("trips list supports search, status filter, pagination, totals, and actions", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/trips?q=OR-123&status=Planned&page=2", "admin"), envWithRows({
    tripsCount: 30,
    trips: [sampleTrip()],
  }));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /Trips List/);
  assert.match(text, /Trip Ticket \/ Waybill/);
  assert.match(text, /OR-123/);
  assert.match(text, /Page 2 of 2/);
  assert.match(text, /\/trips\/1\/edit/);
  assert.match(text, /\/trips\/1\/print/);
  assert.match(text, /\/trips\/export\.csv\?q=OR-123&amp;status=Planned/);
});

test("trips CSV export uses Django-compatible headers and raw totals", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/trips/export.csv?status=Planned", "viewer"), envWithRows({
    trips: [sampleTrip()],
  }));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(text, /ID,Trip Ticket \/ Waybill,Ref\. No\.,Type,Date,Client,Route,Asset,Driver,Helpers,Status,Base Rate,Extra Charges,Billable Total/);
  assert.match(text, /"TT-2026-000001","OR-123"/);
  assert.match(text, /"75","1075"/);
});

test("trip create auto-generates ticket and saves helpers plus pay items together", async () => {
  const runs = [];
  const body = tripBody({
    helper_1: "4",
    helper_2: "5",
    driver_pay_items: JSON.stringify([{ label: "Driver allowance", amount: 100 }]),
    helper_pay_items: JSON.stringify([{ label: "Loading", amount: 50 }]),
  });
  const response = await handleRequest(await authedRequest("https://example.test/trips/new", "encoder", { method: "POST", body }), envWithRows({
    runs,
    createdTripId: 88,
    lastTicket: { trip_ticket_no: "TT-2026-000009" },
    assets: [{ id: 2, asset_type: "Trailer Truck", asset_code: "UNIT-001" }],
  }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /\/trips\/88/);
  assert.match(runs[0].sql, /INSERT INTO trips/);
  assert.equal(runs[0].params[0], "TT-2026-000010");
  assert.equal(runs[0].params[17], "100");
  assert.equal(runs[0].params[18], "50");
  assert.equal(runs.filter((run) => run.sql.includes("INSERT INTO trip_helpers")).length, 2);
  assert.equal(runs.filter((run) => run.sql.includes("INSERT INTO trip_employee_pay_items")).length, 2);
});

test("trip edit clears recurring master for spot trips and preserves helper order", async () => {
  const runs = [];
  const body = tripBody({ trip_ticket_no: "TT-2026-000001", trip_type: "Spot Trip", recurring_master_id: "1", helper_1: "4", helper_2: "5" });
  const response = await handleRequest(await authedRequest("https://example.test/trips/1/edit", "admin", { method: "POST", body }), envWithRows({
    runs,
    trips: [sampleTrip({ recurring_master_id: 1, trip_type: "Recurring Trip" })],
    assets: [{ id: 2, asset_type: "Trailer Truck", asset_code: "UNIT-001" }],
  }));
  assert.equal(response.status, 303);
  assert.match(runs[0].sql, /UPDATE trips SET/);
  assert.equal(runs[0].params[3], null);
  const helperRuns = runs.filter((run) => run.sql.includes("INSERT INTO trip_helpers"));
  assert.deepEqual(helperRuns.map((run) => run.params.slice(1)), [["4", 1], ["5", 2]]);
});

test("trip validation rejects required, helper, recurring, and money errors", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/trips/new", "admin", { method: "POST", body: tripBody({ client_id: "", trip_date: "" }) }), envWithRows());
  assert.equal(response.status, 400);
  assert.match(await response.text(), /trip date is required/);

  response = await handleRequest(await authedRequest("https://example.test/trips/new", "admin", { method: "POST", body: tripBody({ trip_type: "Recurring Trip", recurring_master_id: "" }) }), envWithRows());
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Choose a recurring trip master/);

  response = await handleRequest(await authedRequest("https://example.test/trips/new", "admin", { method: "POST", body: tripBody({ helper_1: "4", helper_2: "4" }) }), envWithRows({
    assets: [{ id: 2, asset_type: "Trailer Truck" }],
  }));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Helper selections must be unique/);

  response = await handleRequest(await authedRequest("https://example.test/trips/new", "admin", { method: "POST", body: tripBody({ helper_2: "5" }) }), envWithRows());
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Fill helper positions in order/);

  response = await handleRequest(await authedRequest("https://example.test/trips/new", "admin", { method: "POST", body: tripBody({ helper_1: "4" }) }), envWithRows({
    assets: [{ id: 2, asset_type: "Equipment" }],
  }));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /allows at most 0 helper/);

  response = await handleRequest(await authedRequest("https://example.test/trips/new", "admin", { method: "POST", body: tripBody({ base_trip_rate: "-1" }) }), envWithRows());
  assert.equal(response.status, 400);
  assert.match(await response.text(), /base trip rate cannot be negative/);

  response = await handleRequest(await authedRequest("https://example.test/trips/new", "admin", { method: "POST", body: tripBody({ helper_pay_items: JSON.stringify([{ label: "Loading", amount: 50 }]) }) }), envWithRows());
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Assign at least one helper/);
});

test("trip detail and printable ticket show reference, item job, helpers, charges, and pay items", async () => {
  const env = envWithRows({
    trips: [sampleTrip()],
    tripHelpers: [{ id: 1, employee_id: 4, helper_order: 1, full_name: "Helper One", employee_code: "EMP-004" }],
    payItems: [{ id: 1, employee_type: "Driver", label: "Driver allowance", amount: 100, sort_order: 1 }],
  });
  let response = await handleRequest(await authedRequest("https://example.test/trips/1", "viewer"), env);
  let text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /Trip Ticket \/ Waybill/);
  assert.match(text, /Ref\. No\.: OR-123/);
  assert.match(text, /Item \/ Job/);
  assert.match(text, /Helper One/);
  assert.match(text, /Driver allowance/);

  response = await handleRequest(await authedRequest("https://example.test/trips/1/print", "viewer"), env);
  text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /A4 portrait/);
  assert.match(text, /Client \/ Receiver/);
  assert.match(text, /Driver allowance/);
});

test("trip permissions allow viewer reads but block mutations and accounting access", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/trips/1/print", "viewer"), envWithRows({ trips: [sampleTrip()] }));
  assert.equal(response.status, 200);

  response = await handleRequest(await authedRequest("https://example.test/trips/new", "viewer", { method: "POST", body: tripBody() }), envWithRows());
  assert.equal(response.status, 403);
  assert.match(await response.text(), /do not have permission to edit/);

  response = await handleRequest(await authedRequest("https://example.test/trips", "accounting"), envWithRows());
  assert.equal(response.status, 403);
});

test("trip delete is POST-only, protected by billing and payroll, and removes unused trips", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/trips/1/delete", "admin"), envWithRows({ trips: [sampleTrip()] }));
  assert.equal(response.status, 405);

  response = await handleRequest(await authedRequest("https://example.test/trips/1/delete", "admin", { method: "POST" }), envWithRows({
    trips: [sampleTrip()],
    refs: { billing_lines: 1 },
  }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /already%20used%20by%20billing/);

  response = await handleRequest(await authedRequest("https://example.test/trips/1/delete", "admin", { method: "POST" }), envWithRows({
    trips: [sampleTrip()],
    refs: { payroll_trips: 1 },
  }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /already%20used%20by%20payroll/);

  const runs = [];
  response = await handleRequest(await authedRequest("https://example.test/trips/1/delete", "admin", { method: "POST" }), envWithRows({
    trips: [sampleTrip()],
    runs,
  }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /Trip%20TT-2026-000001%20deleted/);
  assert.match(runs[0].sql, /DELETE FROM trip_helpers/);
  assert.match(runs[1].sql, /DELETE FROM trip_employee_pay_items/);
  assert.match(runs[2].sql, /DELETE FROM trips/);
});

test("repairs list supports search, pagination, export, and detailed linked data", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/repairs?q=oil&status=Open&page=2", "admin"), envWithRows({
    repairsCount: 30,
    repairs: [{
      id: 1, repair_date: "2026-07-16", asset_code: "UNIT-001", plate_no: "ABC-123", repair_description: "Oil change",
      supplier_name: "Parts Supplier", meter_value: "12000 km", total_cost: 1750, status: "Open", payable_ref: "REPAIR-000001",
    }],
  }));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /Oil change/);
  assert.match(text, /REPAIR-000001/);
  assert.match(text, /Page 2 of 2/);
  assert.match(text, /\/repairs\/1\/edit/);
  assert.match(text, /\/repairs\/export\.csv\?q=oil&amp;status=Open/);
});

test("repair form shows asset and supplier detail labels", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/repairs/new", "admin"), envWithRows({
    assets: [{ id: 2, asset_code: "UNIT-001", plate_no: "ABC-123", asset_type: "Cargo Truck", make_model: "Isuzu" }],
    suppliers: [{ id: 7, supplier_name: "Parts Supplier", contact_person: "Ana" }],
  }));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /UNIT-001/);
  assert.match(text, /ABC-123/);
  assert.match(text, /Parts Supplier/);
  assert.match(text, /Ana/);
});

test("repair create calculates total and auto-generates linked payable", async () => {
  const runs = [];
  const response = await handleRequest(await authedRequest("https://example.test/repairs/new", "encoder", { method: "POST", body: repairBody() }), envWithRows({
    runs,
    createdRepairId: 41,
  }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /Repair%20saved/);
  assert.match(runs[0].sql, /INSERT INTO repairs/);
  assert.equal(runs[0].params[8], "1750");
  assert.match(runs.at(-1).sql, /INSERT INTO payables/);
  assert.equal(runs.at(-1).params[3], "REPAIR-000041");
  assert.equal(runs.at(-1).params[5], "1750");
});

test("repair edit updates existing linked payable", async () => {
  const runs = [];
  const response = await handleRequest(await authedRequest("https://example.test/repairs/1/edit", "admin", { method: "POST", body: repairBody({ labor_cost: "700" }) }), envWithRows({
    runs,
    repairs: [{ id: 1, repair_date: "2026-07-15", repair_description: "Old repair" }],
    linkedPayable: { id: 9 },
  }));
  assert.equal(response.status, 303);
  assert.match(runs[0].sql, /UPDATE repairs SET/);
  assert.match(runs.at(-1).sql, /UPDATE payables SET/);
  assert.equal(runs.at(-1).params[5], "1950");
});

test("repair validation rejects required and negative values", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/repairs/new", "admin", { method: "POST", body: repairBody({ repair_date: "", repair_description: "" }) }), envWithRows());
  assert.equal(response.status, 400);
  assert.match(await response.text(), /repair date is required/);

  response = await handleRequest(await authedRequest("https://example.test/repairs/new", "admin", { method: "POST", body: repairBody({ parts_cost: "-1" }) }), envWithRows());
  assert.equal(response.status, 400);
  assert.match(await response.text(), /parts cost cannot be negative/);
});

test("payables list, CSV export, and repair-linked delete protection work", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/payables?q=BILL&page=2", "accounting"), envWithRows({
    payablesCount: 30,
    payables: [{ id: 1, payable_date: "2026-07-16", reference_no: "BILL-1", supplier_name: "Parts Supplier", source_type: "Manual", description: "Parts bill", amount: 1200, due_date: "2026-07-30", status: "Open", linked_repair_id: "" }],
  }));
  let text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /BILL-1/);
  assert.match(text, /Page 2 of 2/);

  response = await handleRequest(await authedRequest("https://example.test/payables/export.csv?q=BILL", "viewer"), envWithRows({
    payables: [{ id: 1, payable_date: "2026-07-16", reference_no: "BILL-1", supplier_name: "Parts Supplier", source_type: "Manual", description: "Parts bill", amount: 1200, due_date: "2026-07-30", status: "Open", linked_repair_id: "" }],
  }));
  text = await response.text();
  assert.match(text, /ID,Date,Supplier,Source,Reference No\.,Description,Amount,Due Date,Status,Linked Repair/);
  assert.match(text, /"1200"/);

  response = await handleRequest(await authedRequest("https://example.test/payables/1/delete", "admin", { method: "POST" }), envWithRows({
    payables: [{ id: 1, linked_repair_id: 2 }],
  }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /Cannot%20delete%20a%20repair-linked%20payable/);
});

test("payable create validates required and negative amount", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/payables/new", "accounting", { method: "POST", body: payableBody({ payable_date: "", description: "" }) }), envWithRows());
  assert.equal(response.status, 400);
  assert.match(await response.text(), /payable date is required/);

  response = await handleRequest(await authedRequest("https://example.test/payables/new", "accounting", { method: "POST", body: payableBody({ amount: "-1" }) }), envWithRows());
  assert.equal(response.status, 400);
  assert.match(await response.text(), /amount cannot be negative/);
});

test("advances page lists vale and cash advance with independent exports", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/advances?q=Joel&vale_page=2&cash_page=2", "admin"), envWithRows({
    valeCount: 30,
    cashCount: 30,
    vale: [{ id: 1, employee_name: "Joel Helper", date_granted: "2026-07-16", amount: 1000, installment_amount: 250, balance: 750, status: "Open" }],
    cashAdvances: [{ id: 2, employee_name: "Joel Helper", date_granted: "2026-07-16", amount: 500, balance: 500, applied: 0, status: "Open" }],
  }));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /Vale/);
  assert.match(text, /Cash Advance/);
  assert.match(text, /Joel Helper/);
  assert.match(text, /\/advances\/vale\/export\.csv\?q=Joel/);
  assert.match(text, /\/advances\/cash\/export\.csv\?q=Joel/);
  assert.match(text, /vale_page=1/);
  assert.match(text, /cash_page=1/);
});

test("vale and cash advance create default balances and clean values", async () => {
  let runs = [];
  let response = await handleRequest(await authedRequest("https://example.test/advances/vale/new", "encoder", { method: "POST", body: advanceBody({ balance: "" }) }), envWithRows({ runs }));
  assert.equal(response.status, 303);
  assert.match(runs[0].sql, /INSERT INTO vale_records/);
  assert.equal(runs[0].params[2], "1000");
  assert.equal(runs[0].params[3], "1000");
  assert.equal(runs[0].params[6], "250");

  runs = [];
  response = await handleRequest(await authedRequest("https://example.test/advances/cash/new", "admin", { method: "POST", body: advanceBody({ applied: "1" }) }), envWithRows({ runs }));
  assert.equal(response.status, 303);
  assert.match(runs[0].sql, /INSERT INTO cash_advances/);
  assert.equal(runs[0].params[2], "1000");
  assert.equal(runs[0].params[3], "1000");
  assert.equal(runs[0].params[6], "1");
});

test("advance validation and permissions are enforced", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/advances/vale/new", "admin", { method: "POST", body: advanceBody({ employee_id: "", amount: "-1" }) }), envWithRows());
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.match(text, /employee is required/);
  assert.match(text, /amount cannot be negative/);

  response = await handleRequest(await authedRequest("https://example.test/advances/cash/new", "viewer", { method: "POST", body: advanceBody() }), envWithRows());
  assert.equal(response.status, 403);

  response = await handleRequest(await authedRequest("https://example.test/advances", "accounting"), envWithRows());
  assert.equal(response.status, 403);
});

test("repairs accounting access is blocked while payables edit access is allowed", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/repairs", "accounting"), envWithRows());
  assert.equal(response.status, 403);

  const runs = [];
  response = await handleRequest(await authedRequest("https://example.test/payables/new", "accounting", { method: "POST", body: payableBody() }), envWithRows({ runs }));
  assert.equal(response.status, 303);
  assert.match(runs[0].sql, /INSERT INTO payables/);
});
