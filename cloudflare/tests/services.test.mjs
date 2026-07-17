import test from "node:test";
import assert from "node:assert/strict";

import { canEdit, canView } from "../src/access.mjs";
import { choiceLabel, nextTripTicketNo, tripBillableTotal, tripExtraTotal, calculateNet, billingStatus, outstandingBalance, applyVat } from "../src/services.mjs";

test("trip totals match Django parity rules", () => {
  const trip = {
    base_trip_rate: 10000,
    fuel_surcharge: 500,
    loading_fee: 100,
    unloading_fee: 100,
    waiting_fee: 0,
    tolls: 50,
    additional_stop_charge: 0,
    special_handling_fee: 0,
    other_charges: 25,
  };
  assert.equal(tripExtraTotal(trip), 775);
  assert.equal(tripBillableTotal(trip), 10775);
});

test("payroll net and billing helpers preserve financial behavior", () => {
  assert.equal(calculateNet(3000, 150, { vale_deduction: 500, cash_advance_deduction: 1000, other_deduction: 25 }), 1625);
  assert.equal(applyVat(10675, true), 1281);
  assert.equal(outstandingBalance(12356, 2000), 10356);
  assert.equal(billingStatus(12356, 0), "Open");
  assert.equal(billingStatus(12356, 2000), "Partially Paid");
  assert.equal(billingStatus(12356, 13000), "Paid");
});

test("running number and dropdown labels stay readable", () => {
  assert.equal(nextTripTicketNo("2026-07-04", 9), "TT-2026-000010");
  assert.equal(choiceLabel("asset", { asset_code: "UNIT-001", plate_no: "ABC-123", asset_type: "Cargo Truck", make_model: "Isuzu" }), "UNIT-001 — ABC-123 — Cargo Truck — Isuzu");
  assert.equal(choiceLabel("employee", { employee_code: "EMP-001", full_name: "Driver One", employee_type: "Driver", payroll_basis: "Per Trip" }), "EMP-001 — Driver One — Driver — Per Trip");
});

test("role permissions match current Django matrix", () => {
  assert.equal(canEdit({ role: "admin", active: 1 }, "User Management"), true);
  assert.equal(canView({ role: "admin", active: 1 }, "Data Tools"), true);
  assert.equal(canEdit({ role: "encoder", active: 1 }, "Trips"), true);
  assert.equal(canView({ role: "viewer", active: 1 }, "Reports"), true);
  assert.equal(canView({ role: "viewer", active: 1 }, "Data Tools"), false);
  assert.equal(canEdit({ role: "viewer", active: 1 }, "Reports"), false);
  assert.equal(canView({ role: "accounting", active: 1 }, "Employees"), false);
  assert.equal(canEdit({ role: "accounting", active: 1 }, "Billing"), true);
});
