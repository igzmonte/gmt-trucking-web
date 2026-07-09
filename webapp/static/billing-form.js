document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("[data-billing-form]");
  if (!form) return;
  const tripInput = form.querySelector('[name="trip_ids"]');
  const adjustmentInput = form.querySelector('[name="adjustments"]');
  const initial = JSON.parse(document.getElementById("billing-adjustment-data")?.textContent || "[]");
  const containers = Object.fromEntries(["Addition", "Deduction"].map(type => [type, form.querySelector(`[data-adjustments="${type}"]`)]));
  const number = value => Number.parseFloat(value) || 0;
  const addRow = (type, data = {}) => {
    const row = document.createElement("div"); row.className = "adjustment-row"; row.dataset.type = type;
    row.innerHTML = `<input class="adjustment-label" placeholder="Label" value=""><input class="adjustment-amount" type="number" min="0.01" step="0.01" placeholder="Amount" value=""><button type="button" class="remove-pay-item">&times;</button>`;
    row.querySelector(".adjustment-label").value = data.label || ""; row.querySelector(".adjustment-amount").value = data.amount || "";
    row.querySelector("button").addEventListener("click", () => { row.remove(); refresh(); }); row.querySelectorAll("input").forEach(input => input.addEventListener("input", refresh));
    containers[type].appendChild(row);
  };
  initial.forEach(row => addRow(row.line_type, row));
  form.querySelectorAll("[data-add-adjustment]").forEach(button => button.addEventListener("click", () => addRow(button.dataset.addAdjustment)));
  const refresh = () => {
    const checked = [...form.querySelectorAll("[data-billing-trip]:checked")]; tripInput.value = JSON.stringify(checked.map(input => Number(input.value)));
    const rows = [...form.querySelectorAll(".adjustment-row")].map((row, index) => ({line_type: row.dataset.type, label: row.querySelector(".adjustment-label").value.trim(), amount: row.querySelector(".adjustment-amount").value, sort_order: index + 1})).filter(row => row.label || row.amount);
    adjustmentInput.value = JSON.stringify(rows);
    const base = checked.reduce((sum, input) => sum + number(input.dataset.base), 0), extra = checked.reduce((sum, input) => sum + number(input.dataset.extra), 0), gross = base + extra;
    const additions = rows.filter(row => row.line_type === "Addition").reduce((sum, row) => sum + number(row.amount), 0), deductions = rows.filter(row => row.line_type === "Deduction").reduce((sum, row) => sum + number(row.amount), 0), vat = form.querySelector('[name="vat_enabled"]').checked ? gross * .12 : 0;
    for (const [key, value] of Object.entries({base, extra, gross, vat, additions, deductions, grand: gross + vat + additions - deductions})) form.querySelector(`[data-bill-${key}]`).textContent = value.toFixed(2);
  };
  form.querySelectorAll("[data-billing-trip], [name=vat_enabled]").forEach(input => input.addEventListener("change", refresh));
  form.querySelectorAll("[data-select-billing]").forEach(button => button.addEventListener("click", () => { form.querySelectorAll("[data-billing-trip]").forEach(input => input.checked = button.dataset.selectBilling === "all"); refresh(); }));
  refresh();
});
