document.addEventListener("DOMContentLoaded", () => {
  const mastersNode = document.getElementById("trip-master-defaults");
  const limitsNode = document.getElementById("asset-helper-limits");
  const masters = mastersNode ? JSON.parse(mastersNode.textContent) : {};
  const limits = limitsNode ? JSON.parse(limitsNode.textContent) : {};
  const extraNames = ["fuel_surcharge", "loading_fee", "unloading_fee", "waiting_fee", "tolls", "additional_stop_charge", "special_handling_fee", "other_charges"];
  const numberValue = (field) => Number.parseFloat(field?.value || "0") || 0;

  document.querySelectorAll("[data-trip-form]").forEach((form) => {
    const field = (name) => form.querySelector(`[name="${name}"]`);
    const setValue = (name, value) => { const target = field(name); if (target && value !== undefined && value !== null) target.value = value; };
    const payRows = { driver: [], helper: [] };
    const syncPayItems = (kind) => {
      const hidden = field(`${kind}_pay_items`);
      if (hidden) hidden.value = JSON.stringify(payRows[kind].map((row) => ({ label: row.label.value.trim(), amount: row.amount.value })));
    };
    const renderPayItems = (kind) => {
      const container = form.querySelector(`[data-pay-items="${kind}"]`);
      if (!container) return;
      container.replaceChildren();
      payRows[kind].forEach((row, index) => {
        const wrapper = document.createElement("div"); wrapper.className = "pay-item-row";
        row.label.placeholder = `${kind === "driver" ? "Driver" : "Helper"} item label`;
        row.amount.type = "number"; row.amount.min = "0.01"; row.amount.step = "0.01"; row.amount.placeholder = "Amount";
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "remove-pay-item"; remove.textContent = "Remove";
        remove.addEventListener("click", () => { payRows[kind].splice(index, 1); renderPayItems(kind); syncPayItems(kind); });
        row.label.addEventListener("input", () => syncPayItems(kind)); row.amount.addEventListener("input", () => syncPayItems(kind));
        wrapper.append(row.label, row.amount, remove); container.append(wrapper);
      });
    };
    const addPayItem = (kind, value = {}) => {
      const label = document.createElement("input"); label.value = value.label || "";
      const amount = document.createElement("input"); amount.value = value.amount || "";
      payRows[kind].push({ label, amount }); renderPayItems(kind); syncPayItems(kind);
    };
    ["driver", "helper"].forEach((kind) => {
      const hidden = field(`${kind}_pay_items`);
      try { JSON.parse(hidden?.value || "[]").forEach((row) => addPayItem(kind, row)); } catch (_) { /* server validation handles malformed data */ }
      form.querySelector(`[data-add-pay-item="${kind}"]`)?.addEventListener("click", () => addPayItem(kind));
    });
    const updateTotals = () => {
      const base = numberValue(field("base_trip_rate"));
      const extra = extraNames.reduce((sum, name) => sum + numberValue(field(name)), 0);
      form.querySelector("[data-trip-base]").textContent = base.toFixed(2);
      form.querySelector("[data-trip-extra]").textContent = extra.toFixed(2);
      form.querySelector("[data-trip-total]").textContent = (base + extra).toFixed(2);
    };
    const updateHelpers = (suggested = null) => {
      const maximum = Number(limits[field("asset")?.value] ?? 3);
      for (let index = 1; index <= 3; index += 1) {
        const helper = field(`helper_${index}`);
        if (!helper) continue;
        const wrapper = helper.closest(".compact-field, p");
        if (wrapper) wrapper.hidden = index > maximum;
        helper.disabled = index > maximum;
        if (index > maximum) helper.value = "";
      }
      const guidance = form.querySelector("[data-helper-guidance]");
      if (guidance) guidance.textContent = suggested === null ? `This unit allows up to ${maximum} helper(s).` : `Template expects ${suggested} helper(s); this unit allows up to ${maximum}.`;
    };
    const updateTripType = () => {
      const recurring = field("trip_type")?.value === "Recurring Trip";
      const master = field("recurring_master");
      if (master) { master.disabled = !recurring; if (!recurring) master.value = ""; }
    };
    field("recurring_master")?.addEventListener("change", () => {
      const defaults = masters[field("recurring_master").value];
      if (!defaults) return;
      ["client", "job_description", "origin", "destination", "asset", "driver", "base_trip_rate", "driver_pay_rate", "helper_pay_rate"].forEach((name) => setValue(name, defaults[name]));
      if (field("notes") && !field("notes").value.trim()) setValue("notes", defaults.notes);
      updateHelpers(defaults.helper_count);
      updateTotals();
    });
    field("trip_type")?.addEventListener("change", updateTripType);
    field("asset")?.addEventListener("change", () => updateHelpers());
    ["base_trip_rate", ...extraNames].forEach((name) => field(name)?.addEventListener("input", updateTotals));
    form.addEventListener("submit", () => { syncPayItems("driver"); syncPayItems("helper"); });
    updateTripType(); updateHelpers(); updateTotals();
  });
});
