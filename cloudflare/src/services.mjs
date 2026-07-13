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
  if (kind === "employee") return [row.employee_code, row.full_name, row.employee_type, row.payroll_basis].filter(Boolean).join(" — ");
  if (kind === "asset") return [row.asset_code, row.plate_no, row.asset_type, row.make_model].filter(Boolean).join(" — ");
  if (kind === "client") return [row.client_code, row.client_name].filter(Boolean).join(" — ");
  if (kind === "supplier") return [row.supplier_name, row.contact_person].filter(Boolean).join(" — ");
  if (kind === "recurring") return [row.master_code, row.client_name, [row.origin, row.destination].filter(Boolean).join(" → "), row.job_description].filter(Boolean).join(" — ");
  return String(row.id ?? "");
}
