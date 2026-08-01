import test from "node:test";
import assert from "node:assert/strict";

import { canEdit, canView } from "../src/access.mjs";
import { choiceLabel, nextProjectNo, nextProjectWorkNo, nextTripTicketNo, projectBaseAmount, projectBillableTotal, projectEmployeeBasePay, projectExtraTotal, tripBillableTotal, tripExtraTotal, calculateNet, billingStatus, outstandingBalance, applyVat } from "../src/services.mjs";

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

test("equipment project quantity, flat extras, and employee pay calculations preserve snapshots", () => {
  const dumpTruck = {
    billing_quantity: 4,
    client_unit_rate: 1500,
    fuel_surcharge: 500,
    tolls: 200,
    primary_pay_basis: "Per Trip",
    primary_pay_quantity: 4,
    primary_pay_rate: 300,
    helper_pay_basis: "Per Trip",
    helper_pay_quantity: 4,
    helper_pay_rate: 200,
  };
  assert.equal(projectBaseAmount(dumpTruck), 6000);
  assert.equal(projectExtraTotal(dumpTruck), 700);
  assert.equal(projectBillableTotal(dumpTruck), 6700);
  assert.equal(projectEmployeeBasePay(dumpTruck, "primary"), 1200);
  assert.equal(projectEmployeeBasePay(dumpTruck, "helper", 2), 400);

  const backhoe = {
    billing_quantity: 8,
    client_unit_rate: 2500,
    primary_pay_basis: "Per Day",
    primary_pay_quantity: 1,
    primary_pay_rate: 1200,
    helper_pay_basis: "Manual",
    helper_manual_pay: 600,
  };
  assert.equal(projectBillableTotal(backhoe), 20000);
  assert.equal(projectEmployeeBasePay(backhoe, "primary"), 1200);
  assert.equal(projectEmployeeBasePay(backhoe, "helper", 2), 300);
});

test("running number and dropdown labels stay readable", () => {
  assert.equal(nextTripTicketNo("2026-07-04", 9), "TT-2026-000010");
  assert.equal(nextProjectNo("2026-07-04", "PRJ-2026-000009"), "PRJ-2026-000010");
  assert.equal(nextProjectWorkNo("2026-07-04", "PWL-2026-000099"), "PWL-2026-000100");
  assert.equal(choiceLabel("asset", { asset_code: "UNIT-001", plate_no: "ABC-123", asset_type: "Cargo Truck", make_model: "Isuzu" }), "UNIT-001, ABC-123, Cargo Truck");
  assert.equal(choiceLabel("employee", { employee_code: "EMP-001", full_name: "Driver One", employee_type: "Driver", payroll_basis: "Per Trip" }), "EMP-001, Driver One, Driver");
  assert.equal(choiceLabel("client", { client_code: "CLI-001", client_name: "Client One" }), "CLI-001, Client One");
  assert.equal(choiceLabel("supplier", { supplier_name: "Parts Co.", contact_person: "Pat Reyes" }), "Parts Co., Pat Reyes");
  assert.equal(choiceLabel("recurring", { master_code: "REC-001", client_name: "Client One", origin: "Manila", destination: "Cebu", job_description: "Cargo" }), "REC-001, Client One, Manila → Cebu, Cargo");
  assert.equal(choiceLabel("billing", { billing_no: "BILL-001", client_name: "Client One", status: "Open" }), "BILL-001, Client One, Open");
  assert.equal(choiceLabel("repair", { id: 7, repair_date: "2026-07-17", repair_description: "Brake service" }), "Repair #7, 2026-07-17, Brake service");
});

test("role permissions match current Django matrix", () => {
  assert.equal(canEdit({ role: "admin", active: 1 }, "User Management"), true);
  assert.equal(canView({ role: "admin", active: 1 }, "Data Tools"), true);
  assert.equal(canEdit({ role: "encoder", active: 1 }, "Trips"), true);
  assert.equal(canEdit({ role: "encoder", active: 1 }, "Projects"), true);
  assert.equal(canView({ role: "viewer", active: 1 }, "Projects"), true);
  assert.equal(canView({ role: "viewer", active: 1 }, "Reports"), true);
  assert.equal(canView({ role: "viewer", active: 1 }, "Data Tools"), false);
  assert.equal(canEdit({ role: "viewer", active: 1 }, "Reports"), false);
  assert.equal(canView({ role: "accounting", active: 1 }, "Employees"), false);
  assert.equal(canView({ role: "accounting", active: 1 }, "Projects"), false);
  assert.equal(canEdit({ role: "accounting", active: 1 }, "Billing"), true);
});
