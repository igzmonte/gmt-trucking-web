document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("[data-repair-form]");
  if (!form) return;
  const names = ["parts_cost", "labor_cost", "other_cost"];
  const total = form.querySelector('[name="total_cost"]');
  const refresh = () => {
    const value = names.reduce((sum, name) => sum + (Number.parseFloat(form.querySelector(`[name="${name}"]`)?.value) || 0), 0);
    if (total) total.value = value.toFixed(2);
  };
  names.forEach(name => form.querySelector(`[name="${name}"]`)?.addEventListener("input", refresh));
  refresh();
});
