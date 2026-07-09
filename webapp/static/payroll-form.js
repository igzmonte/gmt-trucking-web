document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("[data-payroll-form]");
  if (!form) return;
  const value = name => Number.parseFloat(form.querySelector(`[name="${name}"]`)?.value) || 0;
  const deductions = ["vale_deduction", "cash_advance_deduction", "sss", "philhealth", "pagibig", "withholding_tax", "change_deduction", "other_deduction"];
  const refresh = () => {
    const deductionTotal = deductions.reduce((sum, name) => sum + value(name), 0);
    const net = value("gross_pay") + value("additional_pay") - deductionTotal;
    form.querySelector("[data-payroll-deductions]").textContent = deductionTotal.toFixed(2);
    form.querySelector("[data-payroll-net]").textContent = net.toFixed(2);
  };
  ["gross_pay", "additional_pay", ...deductions].forEach(name => form.querySelector(`[name="${name}"]`)?.addEventListener("input", refresh));
  refresh();
});
