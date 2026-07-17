(() => {
  const moneyFields = ["fuel_surcharge", "loading_fee", "unloading_fee", "waiting_fee", "tolls", "additional_stop_charge", "special_handling_fee", "other_charges"];

  function setSelectValue(form, name, value) {
    const select = form.querySelector(`select[name="${name}"]`);
    if (!select || value === undefined || value === null || value === "") return;
    const option = [...select.options].find((item) => String(item.value) === String(value));
    if (option) {
      select.value = String(value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function setFieldValue(form, name, value) {
    const field = form.querySelector(`[name="${name}"]`);
    if (field && value !== undefined && value !== null) {
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function setupComboboxes() {
    document.querySelectorAll("[data-combobox]").forEach((box) => {
      const input = box.querySelector("[data-combobox-input]");
      const toggle = box.querySelector("[data-combobox-toggle]");
      const list = box.querySelector("[data-combobox-options]");
      const select = box.querySelector("select[data-searchable-select]");
      if (!input || !list || !select) return;
      let active = -1;

      function choices(query = "") {
        const text = query.trim().toLocaleLowerCase();
        return [...select.options].filter((option) => !text || option.textContent.toLocaleLowerCase().includes(text)).slice(0, 80);
      }
      function render(query = "") {
        const options = choices(query);
        active = Math.min(active, options.length - 1);
        list.innerHTML = options.map((option, index) => `<button type="button" class="combobox-option${index === active ? " active" : ""}" role="option" data-value="${option.value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">${option.textContent.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</button>`).join("");
        list.querySelectorAll(".combobox-option").forEach((button) => button.addEventListener("mousedown", (event) => {
          event.preventDefault();
          choose(button.dataset.value);
        }));
      }
      function open(query = input.value) {
        box.classList.add("open"); input.setAttribute("aria-expanded", "true"); render(query);
      }
      function close() { box.classList.remove("open"); input.setAttribute("aria-expanded", "false"); active = -1; }
      function choose(value) {
        select.value = value;
        input.value = select.selectedOptions[0]?.textContent || "";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        close();
      }
      input.addEventListener("focus", () => open(""));
      input.addEventListener("input", () => open(input.value));
      input.addEventListener("keydown", (event) => {
        const options = choices(input.value);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); active = Math.max(0, Math.min(options.length - 1, active + (event.key === "ArrowDown" ? 1 : -1))); render(input.value);
        } else if (event.key === "Enter" && active >= 0) { event.preventDefault(); choose(options[active].value); }
        else if (event.key === "Escape") close();
      });
      toggle?.addEventListener("click", () => box.classList.contains("open") ? close() : (input.focus(), open("")));
      input.addEventListener("blur", () => setTimeout(() => {
        if (!box.contains(document.activeElement)) {
          input.value = select.selectedOptions[0]?.value ? select.selectedOptions[0].textContent : "";
          close();
        }
      }, 100));
      select.addEventListener("change", () => { input.value = select.selectedOptions[0]?.value ? select.selectedOptions[0].textContent : ""; });
    });
  }

  function setupTabs() {
    document.querySelectorAll("[data-tabs]").forEach((tabs) => {
      const buttons = [...tabs.querySelectorAll("[data-tab]")];
      const panels = [...tabs.querySelectorAll("[data-tab-panel]")];
      function activate(name) {
        buttons.forEach((button) => { const on = button.dataset.tab === name; button.classList.toggle("active", on); button.setAttribute("aria-selected", String(on)); });
        panels.forEach((panel) => { panel.hidden = panel.dataset.tabPanel !== name; });
      }
      buttons.forEach((button) => button.addEventListener("click", () => activate(button.dataset.tab)));
      if (buttons[0]) activate(buttons[0].dataset.tab);
    });
  }

  function setupDialogs() {
    const dialog = document.querySelector("[data-dialog]");
    if (!dialog) return;
    const close = dialog.querySelector(".dialog-close");
    const href = close?.getAttribute("href") || "/";
    document.querySelector("[data-dialog-backdrop]")?.addEventListener("click", () => location.assign(href));
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") location.assign(href); });
    requestAnimationFrame(() => dialog.querySelector("input:not([type=hidden]),select,textarea,button")?.focus());
  }

  function setupPayItems(form) {
    form.querySelectorAll("[data-pay-items]").forEach((group) => {
      const type = group.dataset.payItems;
      const hidden = form.querySelector(`input[name="${type}_pay_items"]`);
      const rows = group.querySelector("[data-pay-item-rows]");
      const add = group.querySelector("[data-add-pay-item]");
      if (!hidden || !rows) return;
      let items = [];
      try { items = JSON.parse(hidden.value || "[]"); } catch { items = []; }
      function sync() {
        items = [...rows.querySelectorAll(".pay-item-row")].map((row) => ({ label: row.querySelector("[data-item-label]").value.trim(), amount: Number(row.querySelector("[data-item-amount]").value || 0) })).filter((item) => item.label || item.amount);
        hidden.value = JSON.stringify(items); updateTripTotals(form);
      }
      function draw() {
        rows.innerHTML = items.map((item) => `<div class="pay-item-row"><input data-item-label placeholder="Description" value="${String(item.label || "").replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"><input data-item-amount type="number" step="0.01" min="0" value="${Number(item.amount || 0)}"><button type="button" aria-label="Remove pay item">×</button></div>`).join("");
        rows.querySelectorAll(".pay-item-row").forEach((row, index) => {
          row.querySelectorAll("input").forEach((field) => field.addEventListener("input", sync));
          row.querySelector("button").addEventListener("click", () => { items.splice(index, 1); draw(); sync(); });
        });
      }
      add?.addEventListener("click", () => { sync(); items.push({ label: "", amount: 0 }); draw(); rows.querySelector(".pay-item-row:last-child input")?.focus(); });
      draw();
    });
  }

  function updateTripTotals(form) {
    const number = (name) => Number(form.querySelector(`[name="${name}"]`)?.value || 0);
    const base = number("base_trip_rate");
    const extras = moneyFields.reduce((sum, name) => sum + number(name), 0);
    form.querySelector("[data-trip-base]")?.replaceChildren(document.createTextNode(base.toLocaleString(undefined, { minimumFractionDigits: 2 })));
    form.querySelector("[data-trip-extras]")?.replaceChildren(document.createTextNode(extras.toLocaleString(undefined, { minimumFractionDigits: 2 })));
    form.querySelector("[data-trip-total]")?.replaceChildren(document.createTextNode((base + extras).toLocaleString(undefined, { minimumFractionDigits: 2 })));
  }

  function setupTripForm() {
    const container = document.querySelector("[data-trip-form]");
    const dataNode = document.getElementById("trip-form-data");
    const form = container?.querySelector("form");
    if (!form || !dataNode) return;
    let data; try { data = JSON.parse(dataNode.textContent || "{}"); } catch { return; }
    const masterSelect = form.querySelector('select[name="recurring_master_id"]');
    const tripType = form.querySelector('select[name="trip_type"]');
    const assetSelect = form.querySelector('select[name="asset_id"]');
    const helpers = ["helper_1", "helper_2", "helper_3"].map((name) => form.querySelector(`select[name="${name}"]`));
    const guidance = form.querySelector("[data-trip-crew-guidance]");
    const selectedMaster = () => (data.masters || []).find((master) => String(master.id) === String(masterSelect?.value || ""));
    function updateCrewGuidance() {
      if (!guidance) return;
      const asset = (data.assets || []).find((item) => String(item.id) === String(assetSelect?.value || ""));
      const master = selectedMaster(); const values = helpers.map((field) => field?.value || ""); const selected = values.filter(Boolean); const messages = [];
      messages.push(asset ? `${asset.asset_code || "Selected unit"} allows up to ${asset.helper_limit} helper(s).` : "Select an asset to see its helper allowance.");
      if (master) messages.push(`Template expects ${master.helper_count} helper(s).`);
      if (selected.length !== new Set(selected).size) messages.push("Choose each helper only once.");
      if ((!values[0] && (values[1] || values[2])) || (!values[1] && values[2])) messages.push("Fill helper positions in order.");
      if (asset && selected.length > Number(asset.helper_limit)) messages.push(`Too many helpers for ${asset.asset_code || "this unit"}.`);
      guidance.textContent = messages.join(" "); guidance.classList.toggle("error", messages.some((message) => /^(Choose|Fill|Too many)/.test(message)));
    }
    function applyTemplate() {
      const master = selectedMaster(); if (!master) return updateCrewGuidance();
      if (tripType) tripType.value = "Recurring Trip";
      setSelectValue(form, "client_id", master.client_id); setFieldValue(form, "job_description", master.job_description); setFieldValue(form, "origin", master.origin); setFieldValue(form, "destination", master.destination); setSelectValue(form, "asset_id", master.asset_id); setSelectValue(form, "driver_id", master.driver_id); setFieldValue(form, "base_trip_rate", master.base_trip_rate); setFieldValue(form, "driver_pay_rate", master.driver_pay_rate); setFieldValue(form, "helper_pay_rate", master.helper_pay_rate);
      setFieldValue(form, "notes", [master.default_extra_note, master.remarks ? `Template remarks: ${master.remarks}` : ""].filter(Boolean).join("\n\n")); updateCrewGuidance();
    }
    masterSelect?.addEventListener("change", applyTemplate); tripType?.addEventListener("change", () => { if (tripType.value === "Spot Trip" && masterSelect) { masterSelect.value = ""; masterSelect.dispatchEvent(new Event("change", { bubbles: true })); } updateCrewGuidance(); }); assetSelect?.addEventListener("change", updateCrewGuidance); helpers.forEach((field) => field?.addEventListener("change", updateCrewGuidance));
    [...form.querySelectorAll('input[type="number"]')].forEach((field) => field.addEventListener("input", () => updateTripTotals(form)));
    setupPayItems(form); updateCrewGuidance(); updateTripTotals(form);
  }

  function setupRepairTotal() {
    const form = document.querySelector("[data-repair-form]"); if (!form) return;
    const fields = ["parts_cost", "labor_cost", "other_cost"].map((name) => form.querySelector(`[name="${name}"]`));
    const output = form.querySelector("[data-repair-total]"); const update = () => { if (output) output.textContent = fields.reduce((sum, field) => sum + Number(field?.value || 0), 0).toLocaleString(undefined, { minimumFractionDigits: 2 }); };
    fields.forEach((field) => field?.addEventListener("input", update)); update();
  }

  setupComboboxes(); setupTabs(); setupDialogs(); setupTripForm(); setupRepairTotal();
})();
