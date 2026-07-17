import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { handleRequest } from "../src/app.mjs";
import { createSession, verifyPassword } from "../src/auth.mjs";

function envWithRows(rows = {}) {
  return {
    GMT_SESSION_SECRET: "test-secret",
    __runs: [],
    DB: {
      prepare(sql) {
        const state = { sql, params: [] };
        const rowKey = (table) => ({
          billing_statements: "billing",
          billing_lines: "billingLines",
          billing_adjustments: "billingAdjustments",
          cash_advances: "cashAdvances",
          payroll_entries: "payroll",
          payroll_trips: "payrollTrips",
          payroll_additional_lines: "payrollLines",
          recurring_trip_masters: "recurring",
          system_settings: "settings",
          trip_employee_pay_items: "payItems",
          trip_helpers: "tripHelpers",
          vale_records: "vale",
        })[table] || table;
        const source = (table) => rows[rowKey(table)] || [];
        const byId = (table) => source(table).find((row) => Number(row.id) === Number(state.params.at(-1)));
        const userRows = () => rows.users || (rows.user ? [rows.user] : []);
        const filtered = (table) => {
          const data = source(table);
          if (!state.sql.includes(" LIKE ?")) return data;
          const needle = String(state.params[0] || "").replaceAll("%", "").toLowerCase();
          return data.filter((row) => Object.values(row).some((value) => String(value ?? "").toLowerCase().includes(needle)));
        };
        const filteredUsers = () => {
          let data = userRows();
          if (state.sql.includes(" LIKE ?")) {
            const needle = String(state.params[0] || "").replaceAll("%", "").toLowerCase();
            data = data.filter((row) => [row.username, row.first_name, row.last_name, row.email].some((value) => String(value ?? "").toLowerCase().includes(needle)));
          }
          if (state.sql.includes("role=?")) {
            const role = state.params.find((param) => ["admin", "encoder", "viewer", "accounting"].includes(param));
            if (role) data = data.filter((row) => row.role === role);
          }
          if (state.sql.includes("active=1")) data = data.filter((row) => Number(row.active) === 1);
          if (state.sql.includes("active=0")) data = data.filter((row) => Number(row.active) === 0);
          return data;
        };
        const sum = (table, field, predicate = () => true) => source(table)
          .filter(predicate)
          .reduce((total, row) => total + Number(row[field] || 0), 0);
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
            if (state.sql.trim().startsWith("SELECT b.") && state.sql.includes("paid_as_of") && state.sql.includes("FROM billing_statements b WHERE")) {
              const asOf = state.params[0];
              const clientId = state.params[1];
              const dateFrom = state.sql.includes("b.billing_date>=?") ? state.params[2] : "";
              const dateTo = state.sql.includes("b.billing_date<=?") ? state.params[state.params.length - 1] : "";
              const rowsForSoa = (rows.billing || []).filter((row) => {
                const clientMatches = Number(row.client_id) === Number(clientId);
                const fromMatches = !dateFrom || row.billing_date >= dateFrom;
                const toMatches = !dateTo || row.billing_date <= dateTo;
                return clientMatches && fromMatches && toMatches;
              }).map((row) => {
                const paid = (rows.collections || [])
                  .filter((collection) => Number(collection.billing_id) === Number(row.id) && collection.collection_date <= asOf)
                  .reduce((sum, collection) => sum + Number(collection.amount_paid || 0), 0);
                return { ...row, paid_as_of: paid };
              });
              return { results: rowsForSoa };
            }
            if (state.sql.trim().startsWith("SELECT b.") && state.sql.includes("FROM billing_statements b")) return { results: rows.billing || [] };
            if (state.sql.trim().startsWith("SELECT bl.") && state.sql.includes("FROM billing_lines bl")) return { results: rows.billingLines || [] };
            if (state.sql.includes("FROM billing_adjustments")) return { results: rows.billingAdjustments || [] };
            if (state.sql.includes("SELECT * FROM collections WHERE billing_id=?")) {
              const billingId = state.params[0];
              return { results: (rows.collections || []).filter((row) => Number(row.billing_id) === Number(billingId)) };
            }
            if (state.sql.trim() === "SELECT * FROM collections") return { results: rows.collections || [] };
            if (state.sql.trim().startsWith("SELECT co.") && state.sql.includes("FROM collections co")) return { results: rows.collections || [] };
            if (state.sql.includes("SELECT trip_id FROM billing_lines")) return { results: rows.billingLines || [] };
            if (state.sql.trim().startsWith("SELECT p.") && state.sql.includes("FROM payroll_entries p")) return { results: rows.payroll || [] };
            if (state.sql.trim().startsWith("SELECT pt.") && state.sql.includes("FROM payroll_trips pt")) return { results: rows.payrollTrips || [] };
            if (state.sql.includes("FROM payroll_additional_lines")) return { results: rows.payrollLines || [] };
            if (state.sql.includes("FROM vale_records WHERE")) return { results: rows.vale || [] };
            if (state.sql.includes("FROM cash_advances WHERE")) return { results: rows.cashAdvances || [] };
            if (state.sql.includes("FROM repairs r")) return { results: rows.repairs || [] };
            if (state.sql.includes("FROM payables p")) return { results: rows.payables || [] };
            if (state.sql.includes("FROM vale_records v")) return { results: rows.vale || [] };
            if (state.sql.includes("FROM cash_advances c")) return { results: rows.cashAdvances || [] };
            if (state.sql.trim() === "SELECT * FROM trips") return { results: rows.trips || [] };
            if (state.sql.includes("FROM trips t")) return { results: rows.trips || [] };
            if (state.sql.includes("FROM trip_helpers th")) return { results: rows.tripHelpers || [] };
            if (state.sql.includes("FROM trip_employee_pay_items")) {
              const [tripId, employeeType] = state.params;
              const payItems = (rows.payItems || []).filter((row) => {
                const tripMatches = !tripId || row.trip_id == null || Number(row.trip_id) === Number(tripId);
                const typeMatches = !employeeType || row.employee_type === employeeType;
                return tripMatches && typeMatches;
              });
              return { results: payItems };
            }
            if (state.sql.includes("FROM recurring_trip_masters r")) return { results: filtered("recurring").slice(0, 25) };
            if (state.sql.includes("FROM users")) return { results: filteredUsers().slice(0, 25) };
            if (state.sql.includes("FROM repairs ORDER BY")) return { results: rows.repairs || [] };
            if (state.sql.includes("FROM employees WHERE active=1 AND employee_type='Driver'")) return { results: rows.drivers || filtered("employees").filter((row) => row.employee_type === "Driver").slice(0, 25) };
            if (state.sql.includes("FROM employees WHERE active=1 AND employee_type='Helper'")) return { results: rows.helpers || filtered("employees").filter((row) => row.employee_type === "Helper").slice(0, 25) };
            if (state.sql.includes("FROM employees")) return { results: filtered("employees").slice(0, 25) };
            if (state.sql.includes("FROM assets")) return { results: filtered("assets").slice(0, 25) };
            if (state.sql.includes("FROM clients")) return { results: filtered("clients").slice(0, 25) };
            if (state.sql.includes("FROM suppliers")) return { results: filtered("suppliers").slice(0, 25) };
            if (state.sql.includes("FROM system_settings")) return { results: rows.settings || [] };
            if (state.sql.trim().startsWith("SELECT ")) {
              const table = tableFrom();
              if (table) return { results: source(table) };
            }
            return { results: [] };
          },
          async first() {
            if (state.sql.includes("FROM users WHERE username=? AND active=1")) return userRows().find((row) => row.username === state.params[0] && Number(row.active) === 1) || null;
            if (state.sql.includes("FROM users WHERE id=?")) return userRows().find((row) => Number(row.id) === Number(state.params[0])) || null;
            if (state.sql.includes("SELECT id FROM users WHERE username=?")) {
              const [username, id] = state.params;
              return userRows().find((row) => row.username === username && (!id || Number(row.id) !== Number(id))) || null;
            }
            if (state.sql.includes("COUNT(*) AS total FROM users WHERE role='admin' AND active=1 AND id<>?")) {
              return { total: userRows().filter((row) => row.role === "admin" && Number(row.active) === 1 && Number(row.id) !== Number(state.params[0])).length };
            }
            if (state.sql.includes("COUNT(*) AS total FROM users WHERE role='admin' AND active=1")) {
              return { total: userRows().filter((row) => row.role === "admin" && Number(row.active) === 1).length };
            }
            if (state.sql.includes("COUNT(*) AS total FROM users")) return { total: rows.usersCount ?? filteredUsers().length };
            if (state.sql.includes("COUNT(*) AS total FROM billing_statements b")) return { total: rows.billingCount ?? filtered("billing").length };
            if (state.sql.includes("COUNT(*) AS total FROM collections co")) return { total: rows.collectionsCount ?? filtered("collections").length };
            if (state.sql.includes("SELECT b.*,") && state.sql.includes("FROM billing_statements b") && state.sql.includes("WHERE b.id=?")) return byId("billing") || null;
            if (state.sql.includes("SELECT id FROM billing_statements WHERE billing_no=?")) {
              if ((rows.runs || []).some((run) => run.sql.includes("INSERT INTO billing_statements"))) return { id: rows.createdBillingId || 61 };
              return null;
            }
            if (state.sql.includes("SELECT billing_no FROM billing_statements WHERE billing_no LIKE")) return rows.lastBilling || null;
            if (state.sql.includes("COUNT(*) AS total FROM collections WHERE billing_id=?")) return { total: rows.collectionCount ?? (rows.collections || []).filter((row) => Number(row.billing_id) === Number(state.params[0])).length };
            if (state.sql.includes("SELECT grand_total, COALESCE") && state.sql.includes("FROM billing_statements WHERE id=?")) return byId("billing") || rows.billingRecalc || null;
            if (state.sql.includes("SELECT b.*, COALESCE") && state.sql.includes("FROM billing_statements b WHERE b.id=?")) return byId("billing") || null;
            if (state.sql.includes("SELECT * FROM collections WHERE id=?")) return byId("collections") || null;
            if (state.sql.includes("COUNT(*) AS total FROM payroll_entries p")) return { total: rows.payrollCount ?? filtered("payroll").length };
            if (state.sql.includes("SELECT p.*,") && state.sql.includes("FROM payroll_entries p")) return byId("payroll") || null;
            if (state.sql.includes("SELECT id FROM payroll_entries WHERE employee_id=?")) {
              if ((rows.runs || []).some((run) => run.sql.includes("INSERT INTO payroll_entries"))) return { id: rows.createdPayrollId || 51 };
              return null;
            }
            if (state.sql.includes("SELECT * FROM payroll_entries WHERE id=?")) return byId("payroll") || null;
            if (state.sql.includes("COUNT(*) AS total FROM repairs r")) return { total: rows.repairsCount ?? filtered("repairs").length };
            if (state.sql.includes("COUNT(*) AS total FROM payables p")) return { total: rows.payablesCount ?? filtered("payables").length };
            if (state.sql.includes("COUNT(*) AS total FROM vale_records v")) return { total: rows.valeCount ?? filtered("vale").length };
            if (state.sql.includes("COUNT(*) AS total FROM cash_advances c")) return { total: rows.cashCount ?? filtered("cashAdvances").length };
            if (state.sql.includes("COUNT(*) AS total FROM trips WHERE status='Ongoing'")) return { total: source("trips").filter((row) => row.status === "Ongoing").length };
            if (state.sql.includes("COUNT(*) AS total FROM trips WHERE status='Completed'")) return { total: source("trips").filter((row) => row.status === "Completed").length };
            if (state.sql.includes("COUNT(*) AS total FROM trips WHERE")) return { total: (rows.refs || {}).trips || 0 };
            if (state.sql.includes("COUNT(*) AS total FROM trips")) return { total: rows.tripsCount ?? filtered("trips").length };
            if (state.sql.includes("COUNT(*) AS total FROM employees WHERE active=1")) return { total: source("employees").filter((row) => row.active !== 0).length };
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
            if (state.sql.includes("COUNT(*) AS total FROM") && !state.sql.includes("LEFT JOIN")) {
              const table = tableFrom();
              if (table) return { total: source(table).length };
            }
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
            const orphanSql = [
              ["trip_helpers_missing_trips", "FROM trip_helpers th LEFT JOIN trips"],
              ["trip_helpers_missing_employees", "FROM trip_helpers th LEFT JOIN employees"],
              ["trip_pay_items_missing_trips", "FROM trip_employee_pay_items pi LEFT JOIN trips"],
              ["trips_missing_clients", "FROM trips t LEFT JOIN clients"],
              ["trips_missing_assets", "FROM trips t LEFT JOIN assets"],
              ["trips_missing_drivers", "FROM trips t LEFT JOIN employees"],
              ["recurring_missing_clients", "FROM recurring_trip_masters r LEFT JOIN clients"],
              ["repairs_missing_assets", "FROM repairs r LEFT JOIN assets"],
              ["repairs_missing_suppliers", "FROM repairs r LEFT JOIN suppliers"],
              ["payables_missing_suppliers", "FROM payables p LEFT JOIN suppliers"],
              ["vale_missing_employees", "FROM vale_records v LEFT JOIN employees"],
              ["cash_missing_employees", "FROM cash_advances c LEFT JOIN employees"],
              ["payroll_trips_missing_entries", "FROM payroll_trips pt LEFT JOIN payroll_entries"],
              ["payroll_trips_missing_trips", "FROM payroll_trips pt LEFT JOIN trips"],
              ["payroll_lines_missing_entries", "FROM payroll_additional_lines pl LEFT JOIN payroll_entries"],
              ["billing_lines_missing_statements", "FROM billing_lines bl LEFT JOIN billing_statements"],
              ["billing_lines_missing_trips", "FROM billing_lines bl LEFT JOIN trips"],
              ["billing_adjustments_missing_statements", "FROM billing_adjustments ba LEFT JOIN billing_statements"],
              ["collections_missing_billing", "FROM collections co LEFT JOIN billing_statements"],
              ["collections_missing_clients", "FROM collections co LEFT JOIN clients"],
            ].find(([, marker]) => state.sql.includes(marker));
            if (orphanSql) return { total: rows.orphanCounts?.[orphanSql[0]] || 0 };
            if (state.sql.includes("SUM(base_trip_rate)") && state.sql.includes("FROM trips")) {
              const trips = source("trips");
              const extra = (trip) => ["fuel_surcharge", "loading_fee", "unloading_fee", "waiting_fee", "tolls", "additional_stop_charge", "special_handling_fee", "other_charges"].reduce((total, field) => total + Number(trip[field] || 0), 0);
              return {
                count: trips.length,
                base_total: trips.reduce((total, trip) => total + Number(trip.base_trip_rate || 0), 0),
                extra_total: trips.reduce((total, trip) => total + extra(trip), 0),
                billable_total: trips.reduce((total, trip) => total + Number(trip.base_trip_rate || 0) + extra(trip), 0),
              };
            }
            if (state.sql.includes("SUM(gross_pay)") && state.sql.includes("FROM payroll_entries")) {
              const payroll = source("payroll_entries");
              const deductions = (row) => ["vale_deduction", "cash_advance_deduction", "sss", "philhealth", "pagibig", "withholding_tax", "change_deduction", "other_deduction"].reduce((total, field) => total + Number(row[field] || 0), 0);
              return {
                gross_total: payroll.reduce((total, row) => total + Number(row.gross_pay || 0), 0),
                additional_total: payroll.reduce((total, row) => total + Number(row.additional_pay || 0), 0),
                deduction_total: payroll.reduce((total, row) => total + deductions(row), 0),
                net_total: payroll.reduce((total, row) => total + Number(row.net_pay || 0), 0),
              };
            }
            if (state.sql.includes("SUM(grand_total)") && state.sql.includes("FROM billing_statements")) return { grand_total: sum("billing_statements", "grand_total") };
            if (state.sql.includes("SUM(amount_paid)") && state.sql.includes("FROM collections")) return { paid_total: sum("collections", "amount_paid") };
            if (state.sql.includes("SUM(amount)") && state.sql.includes("FROM payables") && state.sql.includes("status IN")) return { open_total: sum("payables", "amount", (row) => ["Open", "Partial"].includes(row.status)) };
            if (state.sql.includes("SUM(balance)") && state.sql.includes("FROM vale_records") && state.sql.includes("status='Open'")) return { open_balance: sum("vale_records", "balance", (row) => row.status === "Open") };
            if (state.sql.includes("SUM(balance)") && state.sql.includes("FROM cash_advances") && state.sql.includes("status='Open'")) return { open_balance: sum("cash_advances", "balance", (row) => row.status === "Open") };
            if (state.sql.includes("SUM(grand_total)") && state.sql.includes("FROM billing_statements")) return { total: sum("billing", "grand_total") };
            if (state.sql.includes("SUM(amount_paid)") && state.sql.includes("FROM collections")) return { total: sum("collections", "amount_paid") };
            if (state.sql.includes("SUM(net_pay)") && state.sql.includes("FROM payroll_entries")) return { total: sum("payroll", "net_pay") };
            if (state.sql.includes("COUNT(*) AS total FROM repairs WHERE status='Open'")) return { total: source("repairs").filter((row) => row.status === "Open").length };
            if (state.sql.includes("SUM(amount)") && state.sql.includes("FROM payables")) return { total: sum("payables", "amount", (row) => ["Open", "Partial"].includes(row.status)) };
            if (state.sql.includes("SUM(balance)") && state.sql.includes("FROM vale_records")) return { total: sum("vale", "balance", (row) => row.status === "Open") };
            if (state.sql.includes("SUM(balance)") && state.sql.includes("FROM cash_advances")) return { total: sum("cashAdvances", "balance", (row) => row.status === "Open") };
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

async function authedRequest(url, role = "admin", init = {}, secret = "test-secret") {
  const token = await createSession({ id: 1, username: role, role, active: 1 }, secret);
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

function payrollBody(overrides = {}) {
  return new URLSearchParams({
    employee: "3",
    period_from: "2026-07-01",
    period_to: "2026-07-31",
    expected_trip_ids: "[1]",
    pay_date: "2026-07-31",
    unit_description: "1 trip(s)",
    days_count: "0",
    gross_pay: "3000",
    additional_pay: "150",
    vale_deduction: "500",
    cash_advance_deduction: "1000",
    sss: "0",
    philhealth: "0",
    pagibig: "0",
    withholding_tax: "0",
    change_deduction: "0",
    other_deduction: "25",
    remarks: "Payroll test",
    ...overrides,
  });
}

function payrollEmployee(overrides = {}) {
  return {
    id: 3,
    employee_code: "PAY-D",
    full_name: "Payroll Driver",
    employee_type: "Driver",
    payroll_basis: "Per Trip",
    active: 1,
    ...overrides,
  };
}

function payrollTrip(overrides = {}) {
  return sampleTrip({
    id: 1,
    trip_ticket_no: "TT-PAY-001",
    trip_date: "2026-07-04",
    status: "Completed",
    driver_id: 3,
    driver_pay_rate: 3000,
    helper_pay_rate: 600,
    driver_additional_pay: 150,
    helper_additional_pay: 200,
    helper_count: 2,
    job_description: "Payroll delivery service",
    ...overrides,
  });
}

function payrollEntry(overrides = {}) {
  return {
    id: 51,
    pay_date: "2026-07-31",
    period_from: "2026-07-01",
    period_to: "2026-07-31",
    employee_id: 3,
    employee_code: "PAY-D",
    full_name: "Payroll Driver",
    employee_type: "Driver",
    payroll_basis: "Per Trip",
    unit_description: "1 trip(s)",
    trips_count: 1,
    days_count: 0,
    gross_pay: 3000,
    additional_pay: 150,
    driver_trip_additional_pay: 150,
    helper_trip_additional_pay: 0,
    vale_deduction: 500,
    cash_advance_deduction: 1000,
    sss: 0,
    philhealth: 0,
    pagibig: 0,
    withholding_tax: 0,
    change_deduction: 0,
    other_deduction: 25,
    net_pay: 1625,
    remarks: "Payroll test",
    ...overrides,
  };
}

function billingBody(overrides = {}) {
  return new URLSearchParams({
    client: "1",
    period_from: "2026-07-01",
    period_to: "2026-07-31",
    expected_trip_ids: "[1]",
    billing_date: "2026-07-31",
    vat_enabled: "1",
    addition_label: "Fuel adjustment",
    addition_amount: "100",
    deduction_label: "Discount",
    deduction_amount: "50",
    notes: "Billing test",
    ...overrides,
  });
}

function billingEntry(overrides = {}) {
  return {
    id: 61,
    billing_no: "BILL-2026-000061",
    client_id: 1,
    client_code: "CLI-001",
    client_name: "Client One",
    billing_address: "Client Address",
    billing_date: "2026-07-31",
    period_from: "2026-07-01",
    period_to: "2026-07-31",
    base_charges_total: 1000,
    extra_charges_total: 75,
    gross_total: 1075,
    vat_enabled: 1,
    vat_amount: 129,
    additions_total: 100,
    deductions_total: 50,
    grand_total: 1254,
    paid_amount: 500,
    status: "Partially Paid",
    notes: "Billing test",
    ...overrides,
  };
}

function billingLine(overrides = {}) {
  return {
    id: 1,
    billing_id: 61,
    trip_id: 1,
    trip_date: "2026-07-15",
    trip_ticket_no: "TT-BILL-001",
    reference_no: "OR-CLIENT-1",
    job_description: "Billing delivery service",
    origin: "Warehouse",
    destination: "Site",
    asset_code: "UNIT-001",
    amount_base: 1000,
    amount_extra: 75,
    amount_total: 1075,
    ...overrides,
  };
}

function companySettings(overrides = {}) {
  return Object.entries({
    company_name: "Acme Logistics",
    company_address: "123 Road",
    company_contact_no: "0917-000-0000",
    company_email: "ops@example.test",
    company_tax_info: "TIN 123",
    default_vat_enabled: "1",
    prepared_by_default: "Maria",
    checked_by_default: "Juan",
    billing_footer_note: "Billing footer",
    soa_footer_note: "SOA footer",
    ...overrides,
  }).map(([key, value]) => ({ key, value }));
}

function collectionBody(overrides = {}) {
  return new URLSearchParams({
    collection_date: "2026-08-01",
    billing_id: "61",
    amount_paid: "500",
    reference_no: "RCPT-001",
    payment_method: "Bank Transfer",
    notes: "Collection test",
    ...overrides,
  });
}

function collectionEntry(overrides = {}) {
  return {
    id: 71,
    collection_date: "2026-08-01",
    client_id: 1,
    client_name: "Client One",
    billing_id: 61,
    billing_no: "BILL-2026-000061",
    amount_paid: 500,
    reference_no: "RCPT-001",
    payment_method: "Bank Transfer",
    notes: "Collection test",
    ...overrides,
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
  let text = await response.text();
  assert.match(text, /full name is required/);
  assert.match(text, /data-dialog/);

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
  assert.equal(runs[0].params[8], "1200.5");
  assert.equal(runs[0].params[9], "0");
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

test("trip form exposes searchable dropdowns, recurring autofill data, and crew guidance", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/trips/new", "admin"), envWithRows({
    clients: [{ id: 1, client_code: "CLI-001", client_name: "Client One", active: 1 }],
    assets: [{ id: 2, asset_code: "UNIT-001", plate_no: "ABC-123", asset_type: "Cargo Truck", make_model: "Isuzu" }],
    drivers: [{ id: 3, employee_code: "EMP-003", full_name: "Driver One", employee_type: "Driver", payroll_basis: "Per Trip", active: 1 }],
    helpers: [{ id: 4, employee_code: "EMP-004", full_name: "Helper One", employee_type: "Helper", payroll_basis: "Per Trip", active: 1 }],
    recurring: [{
      id: 5, master_code: "REC-005", client_id: 1, client_name: "Client One", job_description: "Cement delivery",
      origin: "Warehouse", destination: "Site", default_asset_id: 2, default_driver_id: 3,
      default_helper_count: 2, standard_base_rate: 2500, driver_pay_rate: 600, helper_pay_rate: 350,
      default_extra_note: "Handle carefully", remarks: "Call client before arrival", active: 1,
    }],
  }));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /<script defer src="\/app\.js"><\/script>/);
  assert.match(text, /data-searchable-select/);
  assert.match(text, /role="combobox"/);
  assert.match(text, /placeholder="Search or select/);
  assert.match(text, /data-trip-crew-guidance/);
  assert.match(text, /id="trip-form-data"/);
  assert.match(text, /"default_extra_note":"Handle carefully"/);
  assert.match(text, /"helper_limit":2/);
  assert.match(text, /CLI-001, Client One/);
  assert.match(text, /UNIT-001, ABC-123, Cargo Truck/);
  assert.match(text, /EMP-003, Driver One, Driver/);
  assert.doesNotMatch(text, /Per Trip/);
  assert.match(text, /REC-005, Client One, Warehouse → Site, Cement delivery/);
});

test("dropdown browser enhancement filters native selects and applies trip template fields", () => {
  const script = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(script, /data-combobox/);
  assert.match(script, /select\.options/);
  assert.match(script, /combobox-option/);
  assert.match(script, /setSelectValue\(form, "client_id", master\.client_id\)/);
  assert.match(script, /setFieldValue\(form, "job_description", master\.job_description\)/);
  assert.match(script, /Template remarks:/);
  assert.match(script, /tripType\.value === "Spot Trip"/);
  assert.match(script, /Too many helpers/);
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
  assert.match(text, /class="status status-planned status-link"/);
  assert.match(text, /\/trips\/1\/status\?next=/);
  assert.match(text, /Mark Complete/);
});

test("trip status controls are interactive for editors and read-only for viewers", async () => {
  const rows = { trips: [sampleTrip({ status: "Ongoing" })] };
  let response = await handleRequest(await authedRequest("https://example.test/trips", "encoder"), envWithRows(rows));
  let text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /status-ongoing status-link/);
  assert.match(text, /Mark Complete/);

  response = await handleRequest(await authedRequest("https://example.test/trips", "viewer"), envWithRows(rows));
  text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /<span class="status status-ongoing">Ongoing<\/span>/);
  assert.doesNotMatch(text, /\/trips\/1\/status/);
  assert.doesNotMatch(text, /Mark Complete/);
});

test("trip status dialog shows context, allowed statuses, and preserves list filters", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/trips/1/status?next=%2Ftrips%3Fq%3DOR-123%26status%3DOngoing%26page%3D2", "admin"), envWithRows({
    tripsCount: 30,
    trips: [sampleTrip({ status: "Ongoing" })],
  }));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /data-dialog/);
  assert.match(text, /Update Trip Status/);
  assert.match(text, /TT-2026-000001/);
  assert.match(text, /Client One/);
  assert.match(text, /Warehouse.*Site/);
  assert.match(text, /Current Status/);
  assert.match(text, /Completed trips become eligible for Payroll and Billing/);
  assert.match(text, /name="next" value="\/trips\?q=OR-123&amp;status=Ongoing&amp;page=2"/);
  assert.match(text, /Page 2 of 2/);
});

test("trip status POST updates valid statuses and preserves list context", async () => {
  const runs = [];
  const body = new URLSearchParams({ status: "Completed", next: "/trips?q=OR-123&status=Ongoing&page=2" });
  const response = await handleRequest(await authedRequest("https://example.test/trips/1/status", "encoder", { method: "POST", body }), envWithRows({
    trips: [sampleTrip({ status: "Ongoing" })],
    runs,
  }));
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get("location"), "https://example.test");
  assert.equal(location.pathname, "/trips");
  assert.equal(location.searchParams.get("q"), "OR-123");
  assert.equal(location.searchParams.get("status"), "Ongoing");
  assert.equal(location.searchParams.get("page"), "2");
  assert.match(location.searchParams.get("ok"), /status changed to Completed/);
  const update = runs.find((item) => item.sql === "UPDATE trips SET status=? WHERE id=?");
  assert.deepEqual(update?.params, ["Completed", 1]);
});

test("trip status rejects invalid, system-controlled, and financially linked changes", async () => {
  let runs = [];
  let response = await handleRequest(await authedRequest("https://example.test/trips/1/status", "admin", {
    method: "POST",
    body: new URLSearchParams({ status: "Paid", next: "/trips" }),
  }), envWithRows({ trips: [sampleTrip()], runs }));
  assert.equal(response.status, 303);
  assert.match(new URL(response.headers.get("location"), "https://example.test").searchParams.get("error"), /valid operational/);
  assert.equal(runs.filter((item) => item.sql.startsWith("UPDATE trips SET status")).length, 0);

  runs = [];
  response = await handleRequest(await authedRequest("https://example.test/trips/1/status", "admin", {
    method: "POST",
    body: new URLSearchParams({ status: "Completed", next: "/trips" }),
  }), envWithRows({ trips: [sampleTrip({ status: "Billed" })], runs }));
  assert.equal(response.status, 303);
  assert.match(new URL(response.headers.get("location"), "https://example.test").searchParams.get("error"), /controlled by Billing/);
  assert.equal(runs.length, 0);

  for (const linkedTable of ["billing_lines", "payroll_trips"]) {
    runs = [];
    response = await handleRequest(await authedRequest("https://example.test/trips/1/status", "admin", {
      method: "POST",
      body: new URLSearchParams({ status: "Cancelled", next: "/trips" }),
    }), envWithRows({ trips: [sampleTrip({ status: "Completed" })], refs: { [linkedTable]: 1 }, runs }));
    assert.equal(response.status, 303);
    assert.match(new URL(response.headers.get("location"), "https://example.test").searchParams.get("error"), /status is locked/);
    assert.equal(runs.length, 0);
  }
});

test("trip status permissions block viewer mutation and accounting access", async () => {
  const body = new URLSearchParams({ status: "Completed", next: "/trips" });
  let response = await handleRequest(await authedRequest("https://example.test/trips/1/status", "viewer", { method: "POST", body }), envWithRows({ trips: [sampleTrip()] }));
  assert.equal(response.status, 403);
  response = await handleRequest(await authedRequest("https://example.test/trips/1/status", "accounting"), envWithRows({ trips: [sampleTrip()] }));
  assert.equal(response.status, 403);
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

test("trip detail edit preserves Billed and Paid system statuses", async () => {
  for (const systemStatus of ["Billed", "Paid"]) {
    const runs = [];
    const body = tripBody({ trip_ticket_no: "TT-2026-000001", status: "Planned" });
    const response = await handleRequest(await authedRequest("https://example.test/trips/1/edit", "admin", { method: "POST", body }), envWithRows({
      runs,
      trips: [sampleTrip({ status: systemStatus })],
      assets: [{ id: 2, asset_type: "Trailer Truck", asset_code: "UNIT-001" }],
    }));
    assert.equal(response.status, 303);
    const update = runs.find((item) => item.sql.startsWith("UPDATE trips SET"));
    assert.equal(update?.params[13], systemStatus);
  }
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

test("payroll list supports search pagination and filtered export links", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/payroll?q=Driver&page=2", "accounting"), envWithRows({
    payrollCount: 30,
    payroll: [payrollEntry()],
  }));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /Payroll/);
  assert.match(text, /Payroll Driver/);
  assert.match(text, /Page 2 of 2/);
  assert.match(text, /\/payroll\/51/);
  assert.match(text, /\/payroll\/51\/print/);
  assert.match(text, /\/payroll\/export\.csv\?q=Driver/);
});

test("payroll CSV export includes Django-compatible headers and raw numeric values", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/payroll/export.csv", "viewer"), envWithRows({
    payroll: [payrollEntry()],
  }));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /Payroll ID,Pay Date,Period From,Period To,Employee Code,Employee Name,Employee Type,Gross Pay,Additional Pay,Deductions,Net Pay,Remarks/);
  assert.match(text, /"51","2026-07-31","2026-07-01","2026-07-31","PAY-D","Payroll Driver","Driver","3000","150","1525","1625","Payroll test"/);
});

test("payroll preview calculates driver and helper trip earnings with remaining advances", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/payroll/new?employee=3&period_from=2026-07-01&period_to=2026-07-31", "admin"), envWithRows({
    employees: [payrollEmployee()],
    trips: [payrollTrip()],
    payItems: [{ id: 1, trip_id: 1, employee_type: "Driver", label: "Night Shift", amount: 150 }],
    vale: [{ id: 7, employee_id: 3, balance: 500, installment_amount: 500, status: "Open" }],
    cashAdvances: [{ id: 8, employee_id: 3, balance: 1000, status: "Open" }],
  }));
  assert.equal(response.status, 200);
  let text = await response.text();
  assert.match(text, /Preview Gross/);
  assert.match(text, /TT-PAY-001/);
  assert.match(text, /Payroll delivery service/);
  assert.match(text, /Night Shift/);
  assert.match(text, /Remaining Vale/);
  assert.match(text, /Remaining Cash Advance/);
  assert.match(text, /value="\[1\]"/);

  response = await handleRequest(await authedRequest("https://example.test/payroll/new?employee=4&period_from=2026-07-01&period_to=2026-07-31", "admin"), envWithRows({
    employees: [payrollEmployee({ id: 4, employee_code: "PAY-H", full_name: "Payroll Helper", employee_type: "Helper" })],
    trips: [payrollTrip()],
    tripHelpers: [{ id: 1, trip_id: 1, employee_id: 4, helper_order: 1 }],
    payItems: [{ id: 2, trip_id: 1, employee_type: "Helper", label: "Loading", amount: 200 }],
  }));
  assert.equal(response.status, 200);
  text = await response.text();
  assert.match(text, /Payroll Helper/);
  assert.match(text, /Loading/);
  assert.match(text, /300\.00/);
});

test("payroll save creates entry, claims trips, adds lines, and applies advance balances", async () => {
  const runs = [];
  const response = await handleRequest(await authedRequest("https://example.test/payroll/new", "accounting", { method: "POST", body: payrollBody() }), envWithRows({
    employees: [payrollEmployee()],
    trips: [payrollTrip()],
    payItems: [{ id: 1, trip_id: 1, employee_type: "Driver", label: "Night Shift", amount: 150 }],
    vale: [{ id: 7, employee_id: 3, balance: 500, installment_amount: 500, status: "Open" }],
    cashAdvances: [{ id: 8, employee_id: 3, balance: 1000, status: "Open" }],
    createdPayrollId: 51,
    runs,
  }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /\/payroll\/51/);
  assert.ok(runs.some((run) => run.sql.includes("INSERT INTO payroll_entries")));
  assert.ok(runs.some((run) => run.sql.includes("INSERT INTO payroll_trips")));
  assert.ok(runs.some((run) => run.sql.includes("INSERT INTO payroll_additional_lines")));
  assert.ok(runs.some((run) => run.sql.includes("UPDATE vale_records SET balance=?, status=?") && run.params[0] === "0" && run.params[1] === "Paid"));
  assert.ok(runs.some((run) => run.sql.includes("UPDATE cash_advances SET balance=?, status=?, applied=?") && run.params[0] === "0" && run.params[1] === "Paid" && Number(run.params[2]) === 1));
});

test("payroll save rejects stale eligibility and deduction values above available balances", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/payroll/new", "admin", { method: "POST", body: payrollBody({ expected_trip_ids: "[99]" }) }), envWithRows({
    employees: [payrollEmployee()],
    trips: [payrollTrip()],
    vale: [{ id: 7, employee_id: 3, balance: 500, installment_amount: 500, status: "Open" }],
    cashAdvances: [{ id: 8, employee_id: 3, balance: 1000, status: "Open" }],
  }));
  assert.equal(response.status, 400);
  let text = await response.text();
  assert.match(text, /eligibility changed/i);

  response = await handleRequest(await authedRequest("https://example.test/payroll/new", "admin", { method: "POST", body: payrollBody({ vale_deduction: "900" }) }), envWithRows({
    employees: [payrollEmployee()],
    trips: [payrollTrip()],
    vale: [{ id: 7, employee_id: 3, balance: 500, installment_amount: 500, status: "Open" }],
    cashAdvances: [{ id: 8, employee_id: 3, balance: 1000, status: "Open" }],
  }));
  assert.equal(response.status, 400);
  text = await response.text();
  assert.match(text, /Deduction cannot exceed the remaining Vale total/i);
});

test("payroll detail and print show payslip trip rows, remarks, balances, deductions, net pay, and signature", async () => {
  const env = envWithRows({
    payroll: [payrollEntry()],
    payrollTrips: [{
      payroll_id: 51,
      trip_id: 1,
      trip_ticket_no: "TT-PAY-001",
      trip_date: "2026-07-04",
      origin: "Warehouse",
      destination: "Site",
      job_description: "Payroll delivery service",
      driver_pay_rate: 3000,
      helper_pay_rate: 600,
      helper_count: 2,
    }],
    payrollLines: [{ payroll_id: 51, label: "Night Shift", amount: 150 }],
    vale: [{ id: 7, employee_id: 3, balance: 250 }],
    cashAdvances: [{ id: 8, employee_id: 3, balance: 1000 }],
  });

  let response = await handleRequest(await authedRequest("https://example.test/payroll/51", "viewer"), env);
  assert.equal(response.status, 200);
  let text = await response.text();
  assert.match(text, /Trip Ticket \/ Waybill/);
  assert.match(text, /Item \/ Job/);
  assert.match(text, /Payroll delivery service/);
  assert.match(text, /Night Shift/);
  assert.match(text, /Net Pay/);

  response = await handleRequest(await authedRequest("https://example.test/payroll/51/print", "viewer"), env);
  assert.equal(response.status, 200);
  text = await response.text();
  assert.match(text, /Remarks/);
  assert.match(text, /Remaining Vale/);
  assert.match(text, /Remaining Cash Advance/);
  assert.match(text, /Deductions/);
  assert.match(text, /Received by: \/ Employee Signature/);
});

test("payroll delete is POST-only, reverses advances, and releases claimed trips", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/payroll/51/delete", "admin"), envWithRows());
  assert.equal(response.status, 405);

  const runs = [];
  response = await handleRequest(await authedRequest("https://example.test/payroll/51/delete", "admin", { method: "POST" }), envWithRows({
    payroll: [payrollEntry()],
    vale: [{ id: 7, employee_id: 3, amount: 1000, balance: 500, status: "Paid" }],
    cashAdvances: [{ id: 8, employee_id: 3, amount: 1500, balance: 500, status: "Paid", applied: 1 }],
    runs,
  }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /\/payroll\?ok=Payroll%20deleted/);
  assert.ok(runs.some((run) => run.sql.includes("UPDATE vale_records SET balance=?, status='Open'") && run.params[0] === "1000"));
  assert.ok(runs.some((run) => run.sql.includes("UPDATE cash_advances SET balance=?, status='Open', applied=0") && run.params[0] === "1500"));
  assert.ok(runs.some((run) => run.sql.includes("DELETE FROM payroll_entries WHERE id=?")));
});

test("payroll permissions allow admin accounting reads while blocking encoder and viewer mutation", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/payroll", "encoder"), envWithRows());
  assert.equal(response.status, 403);

  response = await handleRequest(await authedRequest("https://example.test/payroll/new", "viewer", { method: "POST", body: payrollBody() }), envWithRows());
  assert.equal(response.status, 403);

  response = await handleRequest(await authedRequest("https://example.test/payroll", "accounting"), envWithRows());
  assert.equal(response.status, 200);
});

test("billing list and CSV export show balances, status, and filtered links", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/billing?q=Client&page=2", "accounting"), envWithRows({
    billingCount: 30,
    billing: [billingEntry()],
  }));
  assert.equal(response.status, 200);
  let text = await response.text();
  assert.match(text, /Billing/);
  assert.match(text, /BILL-2026-000061/);
  assert.match(text, /Client One/);
  assert.match(text, /Partially Paid/);
  assert.match(text, /Page 2 of 2/);
  assert.match(text, /\/billing\/61\/print/);
  assert.match(text, /\/billing\/export\.csv\?q=Client/);

  response = await handleRequest(await authedRequest("https://example.test/billing/export.csv", "viewer"), envWithRows({
    billing: [billingEntry()],
  }));
  assert.equal(response.status, 200);
  text = await response.text();
  assert.match(text, /Billing No.,Billing Date,Client,Period From,Period To,Gross,VAT,Additions,Deductions,Grand Total,Paid,Balance,Status,Notes/);
  assert.match(text, /"BILL-2026-000061","2026-07-31","Client One"/);
  assert.match(text, /"1254","500","754","Partially Paid"/);
});

test("billing preview includes eligible unbilled trips and trip labels", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/billing/new?client=1&period_from=2026-07-01&period_to=2026-07-31", "admin"), envWithRows({
    clients: [{ id: 1, client_code: "CLI-001", client_name: "Client One" }],
    trips: [sampleTrip({ id: 1, trip_ticket_no: "TT-BILL-001", status: "Completed", client_id: 1, job_description: "Billing delivery service" })],
  }));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /Eligible Trips/);
  assert.match(text, /TT-BILL-001/);
  assert.match(text, /Ref\. No\.: OR-123/);
  assert.match(text, /Billing delivery service/);
  assert.match(text, /value="\[1\]"/);
});

test("billing save creates statement, lines, adjustments, and marks trips billed", async () => {
  const runs = [];
  const response = await handleRequest(await authedRequest("https://example.test/billing/new", "accounting", { method: "POST", body: billingBody() }), envWithRows({
    clients: [{ id: 1, client_code: "CLI-001", client_name: "Client One" }],
    trips: [sampleTrip({ id: 1, trip_ticket_no: "TT-BILL-001", status: "Completed", client_id: 1 })],
    lastBilling: { billing_no: "BILL-2026-000060" },
    createdBillingId: 61,
    runs,
  }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /\/billing\/61/);
  const statement = runs.find((run) => run.sql.includes("INSERT INTO billing_statements"));
  assert.ok(statement);
  assert.equal(statement.params[0], "BILL-2026-000061");
  assert.equal(statement.params[6], "75");
  assert.equal(statement.params[9], "129");
  assert.equal(statement.params[12], "1254");
  assert.ok(runs.some((run) => run.sql.includes("INSERT INTO billing_lines")));
  assert.ok(runs.some((run) => run.sql.includes("INSERT INTO billing_adjustments") && run.params[1] === "Addition"));
  assert.ok(runs.some((run) => run.sql.includes("INSERT INTO billing_adjustments") && run.params[1] === "Deduction"));
  assert.ok(runs.some((run) => run.sql.includes("UPDATE trips SET status='Billed' WHERE id=?") && run.params[0] === 1));
});

test("billing validation, detail, print, and delete protection work", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/billing/new", "admin", { method: "POST", body: billingBody({ deduction_amount: "2000" }) }), envWithRows({
    clients: [{ id: 1, client_code: "CLI-001", client_name: "Client One" }],
    trips: [sampleTrip({ id: 1, status: "Completed", client_id: 1 })],
  }));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Grand total cannot be negative/);

  const env = envWithRows({
    billing: [billingEntry()],
    billingLines: [billingLine()],
    billingAdjustments: [{ billing_id: 61, line_type: "Addition", label: "Fuel adjustment", amount: 100 }],
    collections: [collectionEntry()],
  });
  response = await handleRequest(await authedRequest("https://example.test/billing/61", "viewer"), env);
  assert.equal(response.status, 200);
  let text = await response.text();
  assert.match(text, /Trip Ticket \/ Waybill/);
  assert.match(text, /Ref\. No\.: OR-CLIENT-1/);
  assert.match(text, /Item \/ Job/);
  assert.match(text, /Billing delivery service/);
  assert.match(text, /Collections/);

  response = await handleRequest(await authedRequest("https://example.test/billing/61/print", "viewer"), env);
  assert.equal(response.status, 200);
  text = await response.text();
  assert.match(text, /Billing Statement/);
  assert.match(text, /<th>Ref\. No\.<\/th>/);
  assert.match(text, /OR-CLIENT-1/);
  assert.match(text, /Received by \/ Conforme/);

  response = await handleRequest(await authedRequest("https://example.test/billing/61/delete", "admin"), envWithRows());
  assert.equal(response.status, 405);

  response = await handleRequest(await authedRequest("https://example.test/billing/61/delete", "admin", { method: "POST" }), envWithRows({ collectionCount: 1 }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /cannot%20be%20deleted/);

  const runs = [];
  response = await handleRequest(await authedRequest("https://example.test/billing/61/delete", "admin", { method: "POST" }), envWithRows({
    billingLines: [{ trip_id: 1 }],
    runs,
  }));
  assert.equal(response.status, 303);
  assert.ok(runs.some((run) => run.sql.includes("UPDATE trips SET status='Completed' WHERE id=?")));
  assert.ok(runs.some((run) => run.sql.includes("DELETE FROM billing_statements WHERE id=?")));
});

test("collections list and CSV export show billing client payment data", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/collections?q=RCPT&page=2", "accounting"), envWithRows({
    collectionsCount: 30,
    collections: [collectionEntry()],
  }));
  assert.equal(response.status, 200);
  let text = await response.text();
  assert.match(text, /Collections/);
  assert.match(text, /RCPT-001/);
  assert.match(text, /Bank Transfer/);
  assert.match(text, /Page 2 of 2/);
  assert.match(text, /\/collections\/71\/edit/);

  response = await handleRequest(await authedRequest("https://example.test/collections/export.csv", "viewer"), envWithRows({
    collections: [collectionEntry()],
  }));
  assert.equal(response.status, 200);
  text = await response.text();
  assert.match(text, /Collection ID,Collection Date,Billing No.,Client,Amount Paid,Reference No.,Payment Method,Notes/);
  assert.match(text, /"71","2026-08-01","BILL-2026-000061","Client One","500","RCPT-001","Bank Transfer","Collection test"/);
});

test("collection create edit and delete recalculate billing status", async () => {
  let runs = [];
  let response = await handleRequest(await authedRequest("https://example.test/collections/new", "accounting", { method: "POST", body: collectionBody() }), envWithRows({
    billing: [billingEntry()],
    runs,
  }));
  assert.equal(response.status, 303);
  assert.ok(runs.some((run) => run.sql.includes("INSERT INTO collections")));
  assert.ok(runs.some((run) => run.sql.includes("UPDATE billing_statements SET status=?") && run.params[0] === "Partially Paid"));

  response = await handleRequest(await authedRequest("https://example.test/collections/new", "accounting", { method: "POST", body: collectionBody({ amount_paid: "5000" }) }), envWithRows({
    billing: [billingEntry({ paid_amount: 0 })],
  }));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Payment cannot exceed outstanding balance/);

  runs = [];
  response = await handleRequest(await authedRequest("https://example.test/collections/71/edit", "admin", { method: "POST", body: collectionBody({ amount_paid: "754" }) }), envWithRows({
    billing: [billingEntry()],
    collections: [collectionEntry()],
    runs,
  }));
  assert.equal(response.status, 303);
  assert.ok(runs.some((run) => run.sql.includes("UPDATE collections SET")));
  assert.ok(runs.some((run) => run.sql.includes("UPDATE billing_statements SET status=?")));

  response = await handleRequest(await authedRequest("https://example.test/collections/71/delete", "admin"), envWithRows());
  assert.equal(response.status, 405);

  runs = [];
  response = await handleRequest(await authedRequest("https://example.test/collections/71/delete", "admin", { method: "POST" }), envWithRows({
    billing: [billingEntry()],
    collections: [collectionEntry()],
    runs,
  }));
  assert.equal(response.status, 303);
  assert.ok(runs.some((run) => run.sql.includes("DELETE FROM collections WHERE id=?")));
  assert.ok(runs.some((run) => run.sql.includes("UPDATE billing_statements SET status=?")));
});

test("billing and collections permissions block encoder and viewer mutations", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/billing", "encoder"), envWithRows());
  assert.equal(response.status, 403);

  response = await handleRequest(await authedRequest("https://example.test/collections", "encoder"), envWithRows());
  assert.equal(response.status, 403);

  response = await handleRequest(await authedRequest("https://example.test/billing/new", "viewer", { method: "POST", body: billingBody() }), envWithRows());
  assert.equal(response.status, 403);

  response = await handleRequest(await authedRequest("https://example.test/collections/new", "viewer", { method: "POST", body: collectionBody() }), envWithRows());
  assert.equal(response.status, 403);
});

test("SOA outstanding mode uses as-of payments and hides fully paid rows", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/billing/soa?client=1&mode=outstanding&as_of=2026-08-10", "accounting"), envWithRows({
    clients: [{ id: 1, client_code: "CLI-001", client_name: "Client One", billing_address: "Client Address" }],
    billing: [
      billingEntry({ id: 61, billing_no: "BILL-OPEN", client_id: 1, grand_total: 1254, billing_date: "2026-07-31" }),
      billingEntry({ id: 62, billing_no: "BILL-PAID", client_id: 1, grand_total: 500, billing_date: "2026-07-30" }),
    ],
    collections: [
      collectionEntry({ billing_id: 61, amount_paid: 500, collection_date: "2026-08-01" }),
      collectionEntry({ billing_id: 62, amount_paid: 500, collection_date: "2026-08-01" }),
      collectionEntry({ billing_id: 61, amount_paid: 754, collection_date: "2026-09-01" }),
    ],
  }));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /Statement of Account/);
  assert.match(text, /Client One/);
  assert.match(text, /BILL-OPEN/);
  assert.doesNotMatch(text, /BILL-PAID/);
  assert.match(text, /Partially Paid/);
  assert.match(text, /\/billing\/61/);
  assert.match(text, /Total Balance/);
});

test("SOA all activity includes paid rows and date range filters billing dates", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/billing/soa?client=1&mode=all&as_of=2026-08-10&date_from=2026-07-31&date_to=2026-07-31", "viewer"), envWithRows({
    clients: [{ id: 1, client_code: "CLI-001", client_name: "Client One" }],
    billing: [
      billingEntry({ id: 61, billing_no: "BILL-IN-RANGE", client_id: 1, grand_total: 1254, billing_date: "2026-07-31" }),
      billingEntry({ id: 62, billing_no: "BILL-OUT-RANGE", client_id: 1, grand_total: 500, billing_date: "2026-07-30" }),
    ],
    collections: [collectionEntry({ billing_id: 61, amount_paid: 1254, collection_date: "2026-08-01" })],
  }));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /BILL-IN-RANGE/);
  assert.doesNotMatch(text, /BILL-OUT-RANGE/);
  assert.match(text, /Paid/);
  assert.match(text, /All Activity/);
});

test("SOA printable and CSV preserve filters, totals, and signatures", async () => {
  const env = envWithRows({
    clients: [{ id: 1, client_code: "CLI-001", client_name: "Client One", billing_address: "Client Address" }],
    billing: [billingEntry({ id: 61, billing_no: "BILL-SOA", client_id: 1, grand_total: 1254, billing_date: "2026-07-31" })],
    collections: [collectionEntry({ billing_id: 61, amount_paid: 500, collection_date: "2026-08-01" })],
  });
  let response = await handleRequest(await authedRequest("https://example.test/billing/soa/print?client=1&mode=outstanding&as_of=2026-08-10", "viewer"), env);
  assert.equal(response.status, 200);
  let text = await response.text();
  assert.match(text, /Statement of Account/);
  assert.match(text, /Client Address/);
  assert.match(text, /BILL-SOA/);
  assert.match(text, /Prepared by/);
  assert.match(text, /Checked by/);
  assert.match(text, /Received\/Conforme/);

  response = await handleRequest(await authedRequest("https://example.test/billing/soa/export.csv?client=1&mode=outstanding&as_of=2026-08-10", "accounting"), env);
  assert.equal(response.status, 200);
  text = await response.text();
  assert.match(text, /Billing No.,Billing Date,Billing Period,Grand Total,Payments,Balance,Status/);
  assert.match(text, /"BILL-SOA","2026-07-31","2026-07-01 to 2026-07-31","1254","500","754","Partially Paid"/);
});

test("SOA permissions allow finance viewers and block encoder", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/billing/soa", "admin"), envWithRows());
  assert.equal(response.status, 200);

  response = await handleRequest(await authedRequest("https://example.test/billing/soa", "viewer"), envWithRows());
  assert.equal(response.status, 200);

  response = await handleRequest(await authedRequest("https://example.test/billing/soa/export.csv", "accounting"), envWithRows());
  assert.equal(response.status, 200);

  response = await handleRequest(await authedRequest("https://example.test/billing/soa", "encoder"), envWithRows());
  assert.equal(response.status, 403);
});

test("dashboard shows operational metrics and hides finance-heavy sections by role", async () => {
  const env = envWithRows({
    employees: [{ id: 3, employee_code: "EMP-003", full_name: "Driver One", active: 1 }],
    trips: [
      sampleTrip({ id: 1, status: "Ongoing", trip_ticket_no: "TT-ONGOING" }),
      sampleTrip({ id: 2, status: "Completed", trip_ticket_no: "TT-COMPLETE" }),
    ],
    billing: [billingEntry({ id: 61, billing_no: "BILL-DASH", grand_total: 1254 })],
    collections: [collectionEntry({ id: 71, reference_no: "RCPT-DASH", amount_paid: 500 })],
    payroll: [payrollEntry({ id: 51, full_name: "Payroll Driver", net_pay: 1625 })],
    repairs: [{ id: 41, status: "Open", repair_date: "2026-07-15", repair_description: "Oil change", total_cost: 800 }],
    payables: [{ id: 31, status: "Open", payable_date: "2026-07-15", description: "Supplier invoice", amount: 2000 }],
    vale: [{ id: 21, status: "Open", balance: 250 }],
    cashAdvances: [{ id: 22, status: "Open", balance: 400 }],
  });

  let response = await handleRequest(await authedRequest("https://example.test/", "admin"), env);
  assert.equal(response.status, 200);
  let text = await response.text();
  assert.match(text, /Ongoing Trips/);
  assert.match(text, /Completed Trips/);
  assert.match(text, /Receivables/);
  assert.match(text, /Open Advances/);
  assert.match(text, /Open Payables/);
  assert.match(text, /Recent Activity/);
  assert.match(text, /data-tab="billing"/);
  assert.match(text, /data-tab="collections"/);
  assert.match(text, /data-tab="payroll"/);
  assert.match(text, /TT-ONGOING/);
  assert.match(text, /BILL-DASH/);
  assert.match(text, /RCPT-DASH/);

  response = await handleRequest(await authedRequest("https://example.test/", "encoder"), env);
  assert.equal(response.status, 200);
  text = await response.text();
  assert.doesNotMatch(text, /Receivables/);
  assert.doesNotMatch(text, /data-tab="billing"/);
  assert.doesNotMatch(text, /data-tab="payroll"/);
  assert.match(text, /Open Repairs/);
});

test("reports permissions, selector, invalid date validation, and all report slugs render", async () => {
  const slugs = [
    "this_month_trips",
    "ongoing_trips",
    "completed_trips",
    "unbilled_trips",
    "billing_summary",
    "receivables_summary",
    "payables_summary",
    "vale_balance",
    "cash_advance_balance",
    "payroll_summary",
    "repair_summary",
    "fleet_utilization",
  ];

  let response = await handleRequest(await authedRequest("https://example.test/reports", "encoder"), envWithRows());
  assert.equal(response.status, 403);

  for (const slug of slugs) {
    response = await handleRequest(await authedRequest(`https://example.test/reports?report=${slug}`, "viewer"), envWithRows());
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, />Print</);
    assert.match(text, /Export CSV/);
    assert.match(text, /No rows match this report and its filters/);
  }

  response = await handleRequest(await authedRequest("https://example.test/reports?report=this_month_trips&date_from=2026-07-31&date_to=2026-07-01", "accounting"), envWithRows());
  assert.equal(response.status, 400);
  assert.match(await response.text(), /End date must be on or after start date/);
});

test("reports filter trips, receivables, and fleet utilization with correct core calculations", async () => {
  const env = envWithRows({
    trips: [
      sampleTrip({ id: 1, status: "Completed", trip_ticket_no: "TT-UNBILLED", reference_no: "REF-A", trip_date: "2026-07-15", base_trip_rate: 1000, fuel_surcharge: 50, loading_fee: 25, asset_id: 2 }),
      sampleTrip({ id: 2, status: "Completed", trip_ticket_no: "TT-BILLED", reference_no: "REF-B", trip_date: "2026-07-16", base_trip_rate: 700, fuel_surcharge: 10, loading_fee: 0, asset_id: 2 }),
    ],
    billingLines: [{ billing_id: 61, trip_id: 2 }],
    billing: [billingEntry({ id: 61, billing_no: "BILL-REPORT", grand_total: 1254, status: "Partially Paid" })],
    collections: [collectionEntry({ billing_id: 61, amount_paid: 500 })],
    assets: [{ id: 2, asset_code: "UNIT-001", asset_type: "Truck", plate_no: "ABC-123" }],
  });

  let response = await handleRequest(await authedRequest("https://example.test/reports?report=unbilled_trips&date_from=2026-07-01&date_to=2026-07-31", "viewer"), env);
  assert.equal(response.status, 200);
  let text = await response.text();
  assert.match(text, /TT-UNBILLED/);
  assert.doesNotMatch(text, /TT-BILLED/);

  response = await handleRequest(await authedRequest("https://example.test/reports?report=receivables_summary", "accounting"), env);
  assert.equal(response.status, 200);
  text = await response.text();
  assert.match(text, /BILL-REPORT/);
  assert.match(text, /754\.00/);
  assert.match(text, /Partially Paid/);

  response = await handleRequest(await authedRequest("https://example.test/reports?report=fleet_utilization", "admin"), env);
  assert.equal(response.status, 200);
  text = await response.text();
  assert.match(text, /UNIT-001/);
  assert.match(text, /Truck/);
  assert.match(text, /1,700\.00/);
  assert.match(text, /85\.00/);
});

test("printable reports and CSV export preserve filters and raw numeric values", async () => {
  const env = envWithRows({
    trips: [sampleTrip({ id: 1, status: "Completed", trip_ticket_no: "TT-CSV", reference_no: "REF-CSV", trip_date: "2026-07-15", client_name: "Client CSV", base_trip_rate: 1000 })],
  });

  let response = await handleRequest(await authedRequest("https://example.test/reports/print?report=unbilled_trips&q=CSV&date_from=2026-07-01&date_to=2026-07-31", "viewer"), env);
  assert.equal(response.status, 200);
  let text = await response.text();
  assert.match(text, /GMT Trucking/);
  assert.match(text, /Unbilled Trips/);
  assert.match(text, /Generated:/);
  assert.match(text, /Rows:/);
  assert.match(text, /Print/);
  assert.match(text, /TT-CSV/);

  response = await handleRequest(await authedRequest("https://example.test/reports/export.csv?report=unbilled_trips&q=CSV&date_from=2026-07-01&date_to=2026-07-31", "accounting"), env);
  assert.equal(response.status, 200);
  text = await response.text();
  assert.match(text, /Trip Ticket \/ Waybill,Date,Client,Base Rate/);
  assert.match(text, /"TT-CSV","2026-07-15","Client CSV","1000"/);
});

test("settings page is admin-only and persists company defaults", async () => {
  const runs = [];
  let response = await handleRequest(await authedRequest("https://example.test/settings", "admin"), envWithRows({
    settings: companySettings({ company_name: "Existing Company" }),
  }));
  let text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /Existing Company/);
  assert.match(text, /Default VAT enabled/);
  assert.match(text, /Company logo/);
  assert.doesNotMatch(text, /Generate Statement of Account/);

  const body = new URLSearchParams({
    company_name: "Updated Logistics",
    company_address: "Updated Address",
    company_contact_no: "123",
    company_email: "ops@updated.test",
    company_tax_info: "VAT 456",
    default_vat_enabled: "1",
    prepared_by_default: "Prepared Person",
    checked_by_default: "Checked Person",
    billing_footer_note: "Pay within 7 days",
    soa_footer_note: "SOA note",
  });
  response = await handleRequest(await authedRequest("https://example.test/settings", "admin", { method: "POST", body }), envWithRows({ runs }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/settings?ok=Settings%20updated.");
  assert.equal(runs.filter((run) => run.sql.includes("INSERT INTO system_settings")).length, 11);
  assert.deepEqual(runs.find((run) => run.params[0] === "company_name").params, ["company_name", "Updated Logistics"]);
  assert.deepEqual(runs.find((run) => run.params[0] === "default_vat_enabled").params, ["default_vat_enabled", "1"]);
  assert.deepEqual(runs.find((run) => run.params[0] === "company_logo_data_url").params, ["company_logo_data_url", ""]);

  response = await handleRequest(await authedRequest("https://example.test/settings", "viewer"), envWithRows());
  assert.equal(response.status, 403);
  response = await handleRequest(await authedRequest("https://example.test/settings", "encoder"), envWithRows());
  assert.equal(response.status, 403);
  response = await handleRequest(await authedRequest("https://example.test/settings", "accounting"), envWithRows());
  assert.equal(response.status, 403);
});

test("settings logo upload preview validation and removal are supported", async () => {
  const logo = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  const body = new FormData();
  body.set("company_name", "Logo Logistics");
  body.set("company_email", "logo@example.test");
  body.set("company_logo", logo, "logo.png");
  const runs = [];
  let response = await handleRequest(await authedRequest("https://example.test/settings", "admin", { method: "POST", body }), envWithRows({ runs }));
  assert.equal(response.status, 303);
  const savedLogo = runs.find((run) => run.params[0] === "company_logo_data_url")?.params[1];
  assert.match(savedLogo, /^data:image\/png;base64,/);

  response = await handleRequest(await authedRequest("https://example.test/settings", "admin"), envWithRows({
    settings: companySettings({ company_logo_data_url: savedLogo }),
  }));
  let text = await response.text();
  assert.match(text, /Company logo preview/);
  assert.match(text, /Remove current logo/);

  const removeBody = new URLSearchParams({
    company_name: "Logo Logistics",
    remove_company_logo: "1",
  });
  const removeRuns = [];
  response = await handleRequest(await authedRequest("https://example.test/settings", "admin", { method: "POST", body: removeBody }), envWithRows({
    runs: removeRuns,
    settings: companySettings({ company_logo_data_url: savedLogo }),
  }));
  assert.equal(response.status, 303);
  assert.deepEqual(removeRuns.find((run) => run.params[0] === "company_logo_data_url").params, ["company_logo_data_url", ""]);

  const invalid = new FormData();
  invalid.set("company_name", "Logo Logistics");
  invalid.set("company_logo", new Blob(["bad"], { type: "text/plain" }), "logo.txt");
  response = await handleRequest(await authedRequest("https://example.test/settings", "admin", { method: "POST", body: invalid }), envWithRows());
  text = await response.text();
  assert.equal(response.status, 400);
  assert.match(text, /PNG, JPEG, WebP, or SVG/);

  const tooLarge = new FormData();
  tooLarge.set("company_name", "Logo Logistics");
  tooLarge.set("company_logo", new Blob([new Uint8Array(250 * 1024 + 1)], { type: "image/png" }), "large.png");
  response = await handleRequest(await authedRequest("https://example.test/settings", "admin", { method: "POST", body: tooLarge }), envWithRows());
  text = await response.text();
  assert.equal(response.status, 400);
  assert.match(text, /250 KB or smaller/);
});

test("company settings flow into printables and billing VAT defaults", async () => {
  const env = envWithRows({
    settings: companySettings(),
    trips: [sampleTrip()],
    tripHelpers: [{ id: 1, employee_id: 4, helper_order: 1, full_name: "Helper One", employee_code: "EMP-004" }],
    payItems: [{ id: 1, employee_type: "Driver", label: "Driver allowance", amount: 100, sort_order: 1 }],
    payroll: [payrollEntry()],
    payrollTrips: [payrollTrip()],
    billing: [billingEntry()],
    billingLines: [billingLine()],
    billingAdjustments: [{ id: 1, line_type: "Addition", label: "Fuel adjustment", amount: 100 }],
    collections: [collectionEntry()],
    clients: [{ id: 1, client_code: "CLI-001", client_name: "Client One", billing_address: "Client Address" }],
  });

  for (const url of [
    "https://example.test/trips/1/print",
    "https://example.test/payroll/51/print",
    "https://example.test/billing/61/print",
    "https://example.test/billing/soa/print?client=1&mode=all&as_of=2026-08-10",
    "https://example.test/reports/print?report=unbilled_trips&date_from=2026-07-01&date_to=2026-07-31",
  ]) {
    const response = await handleRequest(await authedRequest(url, "viewer"), env);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /Acme Logistics/);
    assert.match(text, /123 Road/);
  }

  let response = await handleRequest(await authedRequest("https://example.test/billing/61/print", "viewer"), env);
  let text = await response.text();
  assert.match(text, /Billing footer/);
  assert.match(text, /Maria<br>Prepared by/);

  response = await handleRequest(await authedRequest("https://example.test/billing/soa/print?client=1&mode=all&as_of=2026-08-10", "viewer"), env);
  text = await response.text();
  assert.match(text, /SOA footer/);
  assert.match(text, /Juan<br>Checked by/);

  response = await handleRequest(await authedRequest("https://example.test/billing/new?client=1&period_from=2026-07-01&period_to=2026-07-31", "admin"), env);
  text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /name="vat_enabled" value="1" checked/);
  assert.match(text, /₱ 129\.00/);
});

test("company logo appears on customer printables but not payslips", async () => {
  const logo = "data:image/png;base64,TE9HTw==";
  const env = envWithRows({
    settings: companySettings({ company_logo_data_url: logo }),
    trips: [sampleTrip()],
    tripHelpers: [{ id: 1, employee_id: 4, helper_order: 1, full_name: "Helper One", employee_code: "EMP-004" }],
    payItems: [{ id: 1, employee_type: "Driver", label: "Driver allowance", amount: 100, sort_order: 1 }],
    payroll: [payrollEntry()],
    payrollTrips: [payrollTrip()],
    billing: [billingEntry()],
    billingLines: [billingLine()],
    clients: [{ id: 1, client_code: "CLI-001", client_name: "Client One", billing_address: "Client Address" }],
  });

  for (const url of [
    "https://example.test/trips/1/print",
    "https://example.test/billing/61/print",
    "https://example.test/billing/soa/print?client=1&mode=all&as_of=2026-08-10",
    "https://example.test/reports/print?report=unbilled_trips&date_from=2026-07-01&date_to=2026-07-31",
  ]) {
    const response = await handleRequest(await authedRequest(url, "viewer"), env);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /class="company-logo"/);
    assert.match(text, /data:image\/png;base64,TE9HTw==/);
  }

  let response = await handleRequest(await authedRequest("https://example.test/trips/1/print", "viewer"), env);
  let text = await response.text();
  assert.match(text, /Trip Ticket \/ Waybill/);
  assert.match(text, /Ref\. No\./);
  assert.match(text, /Item \/ Job/);
  assert.match(text, /Handle with care/);
  assert.match(text, /Prepared By/);

  response = await handleRequest(await authedRequest("https://example.test/billing/61/print", "viewer"), env);
  text = await response.text();
  assert.match(text, /<th>Ref\. No\.<\/th>/);
  assert.match(text, /OR-CLIENT-1/);
  assert.match(text, /Billing footer/);
  assert.match(text, /Maria<br>Prepared by/);

  response = await handleRequest(await authedRequest("https://example.test/billing/soa/print?client=1&mode=all&as_of=2026-08-10", "viewer"), env);
  text = await response.text();
  assert.match(text, /SOA footer/);
  assert.match(text, /Maria<br>Prepared by/);
  assert.match(text, /Juan<br>Checked by/);

  response = await handleRequest(await authedRequest("https://example.test/reports/print?report=unbilled_trips&date_from=2026-07-01&date_to=2026-07-31", "viewer"), env);
  text = await response.text();
  assert.match(text, /Rows:/);
  assert.match(text, /No rows match this report and its filters|TT-2026-000001/);

  response = await handleRequest(await authedRequest("https://example.test/payroll/51/print", "viewer"), env);
  text = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(text, /class="company-logo"/);
  assert.doesNotMatch(text, /data:image\/png;base64,TE9HTw==/);
});

test("restored shell removes preview wording and published credentials", async () => {
  const response = await handleRequest(new Request("https://example.test/login"), { ...envWithRows(), GMT_APP_NAME: "GMT Operations" });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /GMT Operations/);
  assert.doesNotMatch(text, /migration preview|Cloudflare Migration|characterization-only|test_admin/i);
});

test("master data forms open as grouped dialogs over their list pages", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/employees/new", "admin"), envWithRows({
    employees: [{ id: 1, employee_code: "EMP-001", full_name: "Existing Employee", employee_type: "Driver", payroll_basis: "Per Trip", employment_status: "Active" }],
  }));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /class="app-dialog app-dialog-wide"/);
  assert.match(text, /Existing Employee/);
  assert.match(text, /Identity/);
  assert.match(text, /Contact/);
  assert.match(text, /Employment/);
  assert.match(text, /Compensation/);
  assert.match(text, /name="address"/);
  assert.match(text, /name="date_hired"/);
  assert.match(text, /name="active"/);
});

test("short operational forms use dialogs while complex work uses sectioned workspaces", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/advances/vale/new", "admin"), envWithRows());
  let text = await response.text();
  assert.match(text, /data-dialog/);
  assert.match(text, /Vale \/ Cash Advance/);

  response = await handleRequest(await authedRequest("https://example.test/collections/new", "admin"), envWithRows());
  text = await response.text();
  assert.match(text, /data-dialog/);
  assert.match(text, /Payment record/);

  response = await handleRequest(await authedRequest("https://example.test/repairs/new", "admin"), envWithRows());
  text = await response.text();
  assert.match(text, /Repair Information/);
  assert.match(text, /Cost Breakdown/);
  assert.match(text, /data-repair-total/);
});

test("trip workspace hides JSON and renders semantic sections with pay item controls", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/trips/new", "admin"), envWithRows());
  const text = await response.text();
  assert.match(text, /Trip Overview/);
  assert.match(text, /Route &amp; Schedule/);
  assert.match(text, /Unit &amp; Crew/);
  assert.match(text, /Employee Pay Rates/);
  assert.match(text, /Trip \/ Unit Charges/);
  assert.match(text, /type="hidden" name="driver_pay_items"/);
  assert.match(text, /class="field-span-2 trip-recurring-field"/);
  assert.match(text, /class="field-span-2 trip-status-field"/);
  assert.ok(text.indexOf("trip-recurring-field") < text.indexOf("trip-status-field"));
  assert.match(text, /class="pay-item-header"><h4>Driver Pay Items<\/h4><button type="button" data-add-pay-item>/);
  assert.match(text, /class="pay-item-header"><h4>Helper Pay Items<\/h4><button type="button" data-add-pay-item>/);
  assert.match(text, /data-pay-items="driver"[\s\S]*data-pay-item-rows/);
  assert.doesNotMatch(text, /pay items JSON/);
});

test("compact layout css reduces screen scale for dense forms", () => {
  const css = fs.readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
  assert.match(css, /body\{margin:0;font:13px\/1\.3/);
  assert.match(css, /grid-template-columns:218px minmax\(0,1fr\)/);
  assert.match(css, /sidebar-scroll\{min-height:0;overflow-y:auto/);
  assert.match(css, /app-main\{min-width:0;height:100vh;overflow-y:auto/);
  assert.match(css, /trip-top\{grid-template-columns/);
  assert.match(css, /field-span-2\{grid-column:1\/-1/);
  assert.match(css, /pay-items-card\{display:grid/);
  assert.match(css, /pay-item-header\{display:flex/);
  assert.match(css, /combobox-input\{[^}]*text-overflow:ellipsis/);
  assert.match(css, /report-filters\{display:grid/);
  assert.match(css, /settings-logo-block/);
});

test("data tools page and JSON backup are admin-only and exclude password hashes", async () => {
  const env = envWithRows({
    users: [{ id: 1, username: "admin", password_hash: "should-not-export", first_name: "A", last_name: "Admin", email: "a@example.test", role: "admin", active: 1, created_at: "2026-07-17" }],
    employees: [payrollEmployee()],
    assets: [{ id: 2, asset_code: "UNIT-001", asset_type: "Truck", plate_no: "ABC-123" }],
    clients: [{ id: 1, client_code: "CLI-001", client_name: "Client One", billing_address: "Client Address" }],
    suppliers: [{ id: 7, supplier_name: "Parts Supplier" }],
    trips: [sampleTrip({ status: "Completed" })],
    payroll: [payrollEntry()],
    billing: [billingEntry()],
    billingLines: [billingLine()],
    collections: [collectionEntry()],
    payables: [{ id: 8, payable_date: "2026-07-31", amount: 300, status: "Open", supplier_id: 7 }],
    vale: [{ id: 9, employee_id: 3, date_granted: "2026-07-01", amount: 1000, balance: 250, status: "Open" }],
    cashAdvances: [{ id: 10, employee_id: 3, date_granted: "2026-07-01", amount: 500, balance: 125, status: "Open" }],
    settings: companySettings({ company_logo_data_url: "data:image/png;base64,TE9HTw==" }),
  });

  let response = await handleRequest(await authedRequest("https://example.test/data-tools", "admin"), env);
  let text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /Data Tools/);
  assert.match(text, /Download JSON Backup/);
  assert.match(text, /Financial Control Totals/);
  assert.match(text, /Trips billable total/);
  assert.match(text, /Password hashes/);
  assert.match(text, /Staged Live-Use Checklist/);
  assert.match(text, /User Management/);

  response = await handleRequest(await authedRequest("https://example.test/data-tools/export.json", "admin"), env);
  text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.match(response.headers.get("content-disposition"), /gmt-d1-backup-/);
  assert.doesNotMatch(text, /password_hash/);
  assert.doesNotMatch(text, /should-not-export/);
  const backup = JSON.parse(text);
  assert.equal(backup.metadata.credentials_excluded, true);
  assert.equal(backup.metadata.browser_import_supported, false);
  assert.equal(backup.counts.trips, 1);
  assert.equal(backup.controls.billing.receivable_balance, 754);
  assert.equal(backup.controls.payables.open_total, 300);
  assert.equal(backup.tables.users[0].username, "admin");
  assert.equal("password_hash" in backup.tables.users[0], false);
  assert.equal(backup.tables.system_settings.find((row) => row.key === "company_logo_data_url")?.value, "data:image/png;base64,TE9HTw==");

  for (const role of ["encoder", "viewer", "accounting"]) {
    response = await handleRequest(await authedRequest("https://example.test/data-tools", role), envWithRows());
    assert.equal(response.status, 403);
  }
});

test("data tools verification reports relationship warnings", async () => {
  const response = await handleRequest(await authedRequest("https://example.test/data-tools", "admin"), envWithRows({
    users: [{ id: 1, username: "admin", role: "admin", active: 1 }],
    orphanCounts: {
      billing_lines_missing_trips: 2,
      trip_helpers_missing_employees: 1,
    },
  }));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /Billing lines with missing trips/);
  assert.match(text, /Trip helpers with missing employees/);
  assert.match(text, />2<\/td>/);
  assert.match(text, />1<\/td>/);
});

test("staged live-use checklist reports ready, attention, and blocking conditions", async () => {
  const safeSecret = "stage-ready-session-secret-that-is-long-enough";
  const readyEnv = envWithRows({
    users: [{ id: 1, username: "admin", role: "admin", active: 1 }],
    employees: [payrollEmployee()],
    assets: [{ id: 2, asset_code: "UNIT-001", asset_type: "Truck" }],
    clients: [{ id: 1, client_code: "CLI-001", client_name: "Client One" }],
    suppliers: [{ id: 7, supplier_name: "Parts Supplier" }],
    settings: companySettings(),
  });
  readyEnv.GMT_SESSION_SECRET = safeSecret;

  let response = await handleRequest(await authedRequest("https://example.test/data-tools/checklist", "admin", {}, safeSecret), readyEnv);
  let text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /Staged Live-Use Readiness/);
  assert.match(text, /<h3>Ready<\/h3>/);
  assert.match(text, /Required Staged-Test Sequence/);
  assert.match(text, /Trip Ticket \/ Waybill/);
  assert.match(text, /Download a fresh JSON backup/);

  const attentionEnv = envWithRows({
    users: [{ id: 1, username: "test_admin", role: "admin", active: 1 }],
    settings: companySettings({ company_address: "", company_contact_no: "", company_email: "" }),
  });
  attentionEnv.GMT_SESSION_SECRET = safeSecret;
  response = await handleRequest(await authedRequest("https://example.test/data-tools/checklist", "admin", {}, safeSecret), attentionEnv);
  text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /<h3>Attention Needed<\/h3>/);
  assert.match(text, /preview account test_admin is active/);
  assert.match(text, /Complete the company profile/);
  assert.match(text, /No employees records found yet/);

  response = await handleRequest(await authedRequest("https://example.test/data-tools/checklist", "admin"), envWithRows({
    users: [],
    orphanCounts: { billing_lines_missing_trips: 2 },
  }));
  text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /<h3>Blocked<\/h3>/);
  assert.match(text, /Create or reactivate at least one Admin account/);
  assert.match(text, /Set a unique, long GMT_SESSION_SECRET/);
  assert.match(text, /Billing lines with missing trips: 2/);

  for (const role of ["encoder", "viewer", "accounting"]) {
    response = await handleRequest(await authedRequest("https://example.test/data-tools/checklist", role), envWithRows());
    assert.equal(response.status, 403);
  }
});

test("database setup failures return a safe 503 page instead of a Worker exception", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  let response;
  try {
    response = await handleRequest(new Request("https://example.test/login", {
      method: "POST",
      body: new URLSearchParams({ username: "admin", password: "not-used" }),
    }), { GMT_SESSION_SECRET: "safe-session-secret-for-error-boundary" });
  } finally {
    console.error = originalConsoleError;
  }
  const text = await response.text();
  assert.equal(response.status, 503);
  assert.match(text, /Application setup required/);
  assert.match(text, /Cloudflare D1 database binding and setup/);
  assert.doesNotMatch(text, /TypeError|prepare|stack|undefined/);
});

test("user management lists filters and exports users without password hashes", async () => {
  const env = envWithRows({
    users: [
      { id: 1, username: "admin", first_name: "Aileen", last_name: "Admin", email: "admin@example.test", role: "admin", active: 1, password_hash: "secret" },
      { id: 2, username: "viewer_one", first_name: "View", last_name: "Only", email: "viewer@example.test", role: "viewer", active: 0, password_hash: "hidden" },
    ],
  });
  let response = await handleRequest(await authedRequest("https://example.test/users?q=view&role=viewer&active=inactive", "admin"), env);
  assert.equal(response.status, 200);
  let text = await response.text();
  assert.match(text, /User Management/);
  assert.match(text, /viewer_one/);
  assert.doesNotMatch(text, /admin@example\.test/);
  assert.match(text, /New User/);
  assert.match(text, /Export CSV/);

  response = await handleRequest(await authedRequest("https://example.test/users/export.csv?q=view&role=viewer&active=inactive", "admin"), env);
  assert.equal(response.status, 200);
  text = await response.text();
  assert.match(text, /"Username","First Name","Last Name","Email","Role","Active"/);
  assert.match(text, /"viewer_one","View","Only","viewer@example.test","Viewer","Inactive"/);
  assert.doesNotMatch(text, /password_hash|hidden|secret/);
});

test("user management create validates unique usernames and stores a verifiable password hash", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/users/new", "admin", {
    method: "POST",
    body: new URLSearchParams({ username: "", first_name: "New", last_name: "User", email: "", role: "viewer", active: "1", password: "" }),
  }), envWithRows());
  assert.equal(response.status, 400);
  let text = await response.text();
  assert.match(text, /Username is required/);
  assert.match(text, /Password is required/);

  response = await handleRequest(await authedRequest("https://example.test/users/new", "admin", {
    method: "POST",
    body: new URLSearchParams({ username: "admin", first_name: "New", last_name: "User", email: "", role: "viewer", active: "1", password: "new-password" }),
  }), envWithRows({ users: [{ id: 1, username: "admin", role: "admin", active: 1 }] }));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Username must be unique/);

  const runs = [];
  response = await handleRequest(await authedRequest("https://example.test/users/new", "admin", {
    method: "POST",
    body: new URLSearchParams({ username: "new_viewer", first_name: "New", last_name: "Viewer", email: "new@example.test", role: "viewer", active: "1", password: "new-password" }),
  }), envWithRows({ users: [{ id: 1, username: "admin", role: "admin", active: 1 }], runs }));
  assert.equal(response.status, 303);
  const insert = runs.find((run) => run.sql.includes("INSERT INTO users"));
  assert.ok(insert);
  assert.equal(insert.params[0], "new_viewer");
  assert.equal(insert.params[5], "viewer");
  assert.equal(await verifyPassword("new-password", insert.params[1]), true);
});

test("user management edit password reset and deactivate enforce admin safety", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/users/1/edit", "admin", {
    method: "POST",
    body: new URLSearchParams({ username: "admin", first_name: "Only", last_name: "Admin", email: "", role: "viewer", active: "1" }),
  }), envWithRows({ users: [{ id: 1, username: "admin", role: "admin", active: 1 }] }));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /At least one active admin account is required/);

  const editRuns = [];
  response = await handleRequest(await authedRequest("https://example.test/users/2/edit", "admin", {
    method: "POST",
    body: new URLSearchParams({ username: "encoder_one", first_name: "Encode", last_name: "One", email: "encode@example.test", role: "encoder", active: "1" }),
  }), envWithRows({
    users: [
      { id: 1, username: "admin", role: "admin", active: 1 },
      { id: 2, username: "viewer_one", first_name: "View", last_name: "One", email: "", role: "viewer", active: 1 },
    ],
    runs: editRuns,
  }));
  assert.equal(response.status, 303);
  assert.ok(editRuns.some((run) => run.sql.includes("UPDATE users SET username=?") && run.params[4] === "encoder"));

  const passwordRuns = [];
  response = await handleRequest(await authedRequest("https://example.test/users/2/password", "admin", {
    method: "POST",
    body: new URLSearchParams({ password: "changed-password", confirm_password: "different" }),
  }), envWithRows({ users: [{ id: 1, username: "admin", role: "admin", active: 1 }, { id: 2, username: "viewer_one", role: "viewer", active: 1 }] }));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Password confirmation does not match/);

  response = await handleRequest(await authedRequest("https://example.test/users/2/password", "admin", {
    method: "POST",
    body: new URLSearchParams({ password: "changed-password", confirm_password: "changed-password" }),
  }), envWithRows({ users: [{ id: 1, username: "admin", role: "admin", active: 1 }, { id: 2, username: "viewer_one", role: "viewer", active: 1 }], runs: passwordRuns }));
  assert.equal(response.status, 303);
  const update = passwordRuns.find((run) => run.sql.includes("UPDATE users SET password_hash=?"));
  assert.ok(update);
  assert.equal(await verifyPassword("changed-password", update.params[0]), true);

  response = await handleRequest(await authedRequest("https://example.test/users/1/deactivate", "admin", { method: "POST" }), envWithRows({
    users: [{ id: 1, username: "admin", role: "admin", active: 1 }, { id: 2, username: "other_admin", role: "admin", active: 1 }],
  }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /cannot%20deactivate%20your%20own%20account/i);

  response = await handleRequest(await authedRequest("https://example.test/users/2/deactivate", "admin", { method: "POST" }), envWithRows({
    users: [{ id: 1, username: "admin", role: "admin", active: 1 }, { id: 2, username: "other_admin", role: "admin", active: 1 }],
  }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /User%20deactivated/);
});

test("user management permissions and live role refresh are enforced", async () => {
  let response = await handleRequest(await authedRequest("https://example.test/users", "encoder"), envWithRows());
  assert.equal(response.status, 403);

  response = await handleRequest(await authedRequest("https://example.test/users", "viewer"), envWithRows());
  assert.equal(response.status, 403);

  response = await handleRequest(await authedRequest("https://example.test/users", "accounting"), envWithRows());
  assert.equal(response.status, 403);

  response = await handleRequest(await authedRequest("https://example.test/billing", "encoder"), envWithRows({
    users: [{ id: 1, username: "changed_role", role: "accounting", active: 1 }],
  }));
  assert.equal(response.status, 200);

  response = await handleRequest(await authedRequest("https://example.test/billing", "admin"), envWithRows({
    users: [{ id: 1, username: "inactive_admin", role: "admin", active: 0 }],
  }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/login");
});
