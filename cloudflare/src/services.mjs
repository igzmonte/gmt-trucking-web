export const EXTRA_FIELDS = [
  "fuel_surcharge", "loading_fee", "unloading_fee", "waiting_fee", "tolls",
  "additional_stop_charge", "special_handling_fee", "other_charges",
];

export const HELPER_LIMITS = {
  "Equipment": 0,
  "Small Truck": 1,
  "Cargo Truck": 2,
  "Trailer Truck": 3,
};

export function decimal(value) {
  const n = Number(value || 0);
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

export function tripExtraTotal(trip) {
  return decimal(EXTRA_FIELDS.reduce((total, field) => total + Number(trip?.[field] || 0), 0));
}

export function tripBillableTotal(trip) {
  return decimal(Number(trip?.base_trip_rate || 0) + tripExtraTotal(trip));
}

export function projectExtraTotal(record) {
  return decimal(
    EXTRA_FIELDS.reduce((total, field) => total + Number(record?.[field] || 0), 0),
  );
}

export function projectBaseAmount(record) {
  return decimal(
    Number(record?.billing_quantity || 0) * Number(record?.client_unit_rate || 0),
  );
}

export function projectBillableTotal(record) {
  return decimal(projectBaseAmount(record) + projectExtraTotal(record));
}

export function projectEmployeeBasePay(record, role = "primary", helperCount = 0) {
  if (role === "helper") {
    if (!helperCount) return 0;
    const pool =
      record?.helper_pay_basis === "Manual"
        ? Number(record?.helper_manual_pay || 0)
        : Number(record?.helper_pay_quantity || 0) *
          Number(record?.helper_pay_rate || 0);
    return decimal(pool / helperCount);
  }
  return decimal(
    record?.primary_pay_basis === "Manual"
      ? Number(record?.primary_manual_pay || 0)
      : Number(record?.primary_pay_quantity || 0) *
        Number(record?.primary_pay_rate || 0),
  );
}

export function calculateNet(grossPay, additionalPay, deductions) {
  const deductionTotal = [
    "vale_deduction", "cash_advance_deduction", "sss", "philhealth", "pagibig",
    "withholding_tax", "change_deduction", "other_deduction",
  ].reduce((total, field) => total + Number(deductions?.[field] || 0), 0);
  return decimal(Number(grossPay || 0) + Number(additionalPay || 0) - deductionTotal);
}

export function nextTripTicketNo(dateValue, lastNumber = 0) {
  const year = String(dateValue || new Date().toISOString().slice(0, 10)).slice(0, 4);
  return `TT-${year}-${String(Number(lastNumber || 0) + 1).padStart(6, "0")}`;
}

export function nextProjectNo(projectDate, previousProjectNo = "") {
  const year =
    String(projectDate || "").slice(0, 4) ||
    String(new Date().getUTCFullYear());
  const prefix = `PRJ-${year}-`;
  const previousNumber = String(previousProjectNo || "").startsWith(prefix)
    ? Number(String(previousProjectNo).slice(prefix.length))
    : 0;
  return `${prefix}${String(previousNumber + 1).padStart(6, "0")}`;
}

export function nextProjectWorkNo(workDate, previousWorkNo = "") {
  const year =
    String(workDate || "").slice(0, 4) ||
    String(new Date().getUTCFullYear());
  const prefix = `PWL-${year}-`;
  const previousNumber = String(previousWorkNo || "").startsWith(prefix)
    ? Number(String(previousWorkNo).slice(prefix.length))
    : 0;
  return `${prefix}${String(previousNumber + 1).padStart(6, "0")}`;
}

export function billingStatus(grandTotal, paidTotal) {
  if (Number(paidTotal || 0) <= 0) return "Open";
  if (Number(paidTotal) >= Number(grandTotal || 0)) return "Paid";
  return "Partially Paid";
}

export function outstandingBalance(grandTotal, paidTotal) {
  return decimal(Number(grandTotal || 0) - Number(paidTotal || 0));
}

export function applyVat(grossTotal, enabled) {
  return enabled ? decimal(Number(grossTotal || 0) * 0.12) : 0;
}

export function choiceLabel(kind, row) {
  if (!row) return "";
  if (kind === "employee") return [row.employee_code, row.full_name, row.employee_type].filter(Boolean).join(", ");
  if (kind === "asset") return [row.asset_code, row.plate_no, row.asset_type].filter(Boolean).join(", ");
  if (kind === "client") return [row.client_code, row.client_name].filter(Boolean).join(", ");
  if (kind === "supplier") return [row.supplier_name, row.contact_person].filter(Boolean).join(", ");
  if (kind === "recurring") return [row.master_code, row.client_name, [row.origin, row.destination].filter(Boolean).join(" → "), row.job_description].filter(Boolean).join(", ");
  if (kind === "billing") return [row.billing_no, row.client_name, row.status].filter(Boolean).join(", ");
  if (kind === "repair") return [`Repair #${row.id}`, row.repair_date, row.repair_description].filter(Boolean).join(", ");
  return String(row.id ?? "");
}
