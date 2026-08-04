(() => {
  const moneyFields = ["fuel_surcharge", "loading_fee", "unloading_fee", "waiting_fee", "tolls", "additional_stop_charge", "special_handling_fee", "other_charges"];

  function focusable(root) {
    return [...root.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter((element) => !element.hidden && element.getClientRects().length);
  }

  function keepFocusInside(event, root) {
    if (event.key !== "Tab") return;
    const items = focusable(root);
    if (!items.length) return;
    const first = items[0]; const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function setupMobileNavigation() {
    const nav = document.querySelector("[data-mobile-nav]");
    const openButton = document.querySelector("[data-nav-open]");
    const closeButton = document.querySelector("[data-nav-close]");
    const backdrop = document.querySelector("[data-nav-backdrop]");
    if (!nav || !openButton || !backdrop) return;
    const media = matchMedia("(max-width: 760px)");
    let returnFocus = openButton;
    const isOpen = () => document.body.classList.contains("nav-open");
    function close({ restore = true } = {}) {
      document.body.classList.remove("nav-open");
      openButton.setAttribute("aria-expanded", "false");
      backdrop.hidden = true;
      if (media.matches) nav.inert = true;
      if (restore) returnFocus?.focus();
    }
    function open() {
      if (!media.matches) return;
      returnFocus = document.activeElement;
      nav.inert = false;
      backdrop.hidden = false;
      document.body.classList.add("nav-open");
      openButton.setAttribute("aria-expanded", "true");
      requestAnimationFrame(() => focusable(nav)[0]?.focus());
    }
    function sync() {
      if (media.matches) close({ restore: false });
      else { document.body.classList.remove("nav-open"); backdrop.hidden = true; nav.inert = false; openButton.setAttribute("aria-expanded", "false"); }
    }
    openButton.addEventListener("click", open);
    closeButton?.addEventListener("click", () => close());
    backdrop.addEventListener("click", () => close());
    nav.querySelectorAll("a[href]").forEach((link) => link.addEventListener("click", () => { if (media.matches) close({ restore: false }); }));
    document.addEventListener("keydown", (event) => {
      if (!media.matches || !isOpen()) return;
      if (event.key === "Escape") { event.preventDefault(); close(); }
      else keepFocusInside(event, nav);
    });
    media.addEventListener?.("change", sync);
    sync();
  }

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

  function setupComboboxes(root = document) {
    root.querySelectorAll("[data-combobox]").forEach((box) => {
      if (box.dataset.comboboxReady) return;
      box.dataset.comboboxReady = "1";
      const input = box.querySelector("[data-combobox-input]");
      const toggle = box.querySelector("[data-combobox-toggle]");
      const list = box.querySelector("[data-combobox-options]");
      const select = box.querySelector("select[data-searchable-select]");
      if (!input || !list || !select) return;
      let active = -1;
      const quickCreate = box.hasAttribute("data-quick-create")
        && /admin|encoder/.test(document.querySelector(".sidebar-brand p")?.textContent?.toLowerCase() || "")
        ? { kind: box.dataset.quickCreateKind || "", context: box.dataset.quickCreateContext || "", label: box.dataset.quickCreateLabel || "record" }
        : null;

      function choices(query = "") {
        const text = query.trim().toLocaleLowerCase();
        return [...select.options].filter((option) => !text || option.textContent.toLocaleLowerCase().includes(text)).slice(0, 80);
      }
      function render(query = "") {
        const options = choices(query);
        const queryText = query.trim();
        const canCreate = Boolean(quickCreate && queryText && !options.length);
        const total = options.length + (canCreate ? 1 : 0);
        active = total && active >= 0 ? Math.min(active, total - 1) : -1;
        list.replaceChildren();
        options.forEach((option, index) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = `combobox-option${index === active ? " active" : ""}`;
          button.setAttribute("role", "option");
          button.dataset.value = option.value;
          button.textContent = option.textContent;
          button.addEventListener("mousedown", (event) => { event.preventDefault(); choose(button.dataset.value); });
          list.append(button);
        });
        if (canCreate) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = `combobox-option combobox-quick-create-option${active === options.length ? " active" : ""}`;
          button.setAttribute("role", "option");
          button.dataset.quickCreateQuery = queryText;
          button.textContent = `Create “${queryText}” as ${quickCreate.label}`;
          button.addEventListener("mousedown", (event) => {
            event.preventDefault();
            requestQuickCreate(queryText);
          });
          list.append(button);
        } else if (!options.length) {
          const empty = document.createElement("span");
          empty.className = "combobox-empty";
          empty.setAttribute("role", "option");
          empty.setAttribute("aria-disabled", "true");
          empty.textContent = quickCreate && !queryText ? "No records yet — type a name or code to create one" : queryText ? "No matching records" : "No options available";
          list.append(empty);
        }
      }
      function open(query = input.value) {
        box.classList.add("open"); input.setAttribute("aria-expanded", "true"); render(query);
      }
      function close() { box.classList.remove("open"); input.setAttribute("aria-expanded", "false"); active = -1; }
      function requestQuickCreate(query) {
        close();
        box.dispatchEvent(new CustomEvent("quick-create-request", { bubbles: true, detail: { box, query } }));
      }
      function choose(value) {
        select.value = value;
        input.value = select.selectedOptions[0]?.textContent || "";
        input.title = input.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        close();
      }
      input.addEventListener("focus", () => open(""));
      input.addEventListener("input", () => open(input.value));
      input.addEventListener("keydown", (event) => {
        const options = choices(input.value);
        const queryText = input.value.trim();
        const canCreate = Boolean(quickCreate && queryText && !options.length);
        const total = options.length + (canCreate ? 1 : 0);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); active = total ? Math.max(0, Math.min(total - 1, active + (event.key === "ArrowDown" ? 1 : -1))) : -1; render(input.value);
        } else if (event.key === "Enter" && active >= 0) {
          event.preventDefault();
          if (canCreate && active === options.length) requestQuickCreate(queryText);
          else if (options[active]) choose(options[active].value);
        }
        else if (event.key === "Escape") close();
      });
      toggle?.addEventListener("click", () => box.classList.contains("open") ? close() : (input.focus(), open("")));
      input.addEventListener("blur", () => setTimeout(() => {
        if (!box.contains(document.activeElement)) {
          input.value = select.selectedOptions[0]?.value ? select.selectedOptions[0].textContent : "";
          close();
        }
      }, 100));
      select.addEventListener("change", () => { input.value = select.selectedOptions[0]?.value ? select.selectedOptions[0].textContent : ""; input.title = input.value; });
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
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") location.assign(href);
      else keepFocusInside(event, dialog);
    });
    requestAnimationFrame(() => dialog.querySelector("input:not([type=hidden]),select,textarea,button")?.focus());
  }

  function setupQuickCreate() {
    const roleText = document.querySelector(".sidebar-brand p")?.textContent?.toLowerCase() || "";
    if (!roleText.includes("admin") && !roleText.includes("encoder")) return;
    function formError(overlay, message) {
      let box = overlay.querySelector(".quick-create-errors");
      if (!box) { box = document.createElement("section"); box.className = "quick-create-errors"; overlay.querySelector(".dialog-body")?.prepend(box); }
      box.textContent = message;
    }
    function mount(markup, trigger, query = "") {
      const holder = document.createElement("div"); holder.innerHTML = markup;
      const overlay = holder.firstElementChild;
      if (!overlay) return;
      document.body.append(overlay);
      setupComboboxes(overlay);
      let keydown;
      const close = ({ preserveQuery = true } = {}) => {
        if (keydown) document.removeEventListener("keydown", keydown);
        overlay.remove();
        const input = trigger?.querySelector("[data-combobox-input]");
        if (input) {
          if (preserveQuery) { input.value = query; input.title = query; }
          input.focus();
        }
      };
      overlay.querySelectorAll("[data-quick-create-close]").forEach((button) => button.addEventListener("click", close));
      overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
      keydown = (event) => {
        if (event.key === "Escape") { event.preventDefault(); close(); }
        else keepFocusInside(event, overlay.querySelector("[data-quick-create-dialog]") || overlay);
      };
      document.addEventListener("keydown", keydown);
      const form = overlay.querySelector("[data-quick-create-form]");
      form?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const submit = form.querySelector('button[type="submit"], button:not([type])');
        if (submit) submit.disabled = true;
        try {
          const response = await fetch(form.action, { method: "POST", body: new FormData(form), headers: { Accept: "application/json" } });
          const payload = await response.json();
          if (!payload.ok) {
            if (payload.dialog) { document.removeEventListener("keydown", keydown); overlay.remove(); mount(payload.dialog, trigger, query); }
            else formError(overlay, payload.error || "Could not create the record.");
            return;
          }
          const select = trigger?.querySelector("select[data-searchable-select]");
          if (!select) throw new Error("The related selection could not be updated.");
          const old = [...select.options].find((option) => String(option.value) === String(payload.record.id));
          if (old) old.textContent = payload.record.label;
          else select.add(new Option(payload.record.label, payload.record.id));
          select.value = String(payload.record.id);
          if (payload.record.kind === "recurring" && payload.record.autofill) {
            const dataNode = document.getElementById("trip-form-data");
            if (dataNode) {
              const data = JSON.parse(dataNode.textContent || "{}");
              data.masters = [...(data.masters || []).filter((item) => String(item.id) !== String(payload.record.id)), payload.record.autofill];
              dataNode.textContent = JSON.stringify(data);
            }
          }
          select.dispatchEvent(new Event("change", { bubbles: true }));
          close({ preserveQuery: false });
        } catch (error) {
          formError(overlay, error?.message || "Network error. Your current form is still unchanged.");
        } finally { if (submit) submit.disabled = false; }
      });
      requestAnimationFrame(() => overlay.querySelector("input:not([type=hidden]), select, textarea, button")?.focus());
    }
    document.addEventListener("quick-create-request", async (event) => {
      const trigger = event.detail?.box;
      const query = String(event.detail?.query || "").trim();
      if (!trigger || !query) return;
      const params = new URLSearchParams({ prefill: query });
      if (trigger.dataset.quickCreateContext) params.set("context", trigger.dataset.quickCreateContext);
      try {
        const response = await fetch(`/quick-create/${encodeURIComponent(trigger.dataset.quickCreateKind)}?${params}`, { headers: { Accept: "text/html" } });
        if (!response.ok) throw new Error("Quick create is not available.");
        mount(await response.text(), trigger, query);
      } catch (error) {
        const message = document.createElement("span");
        message.className = "quick-create-message error";
        message.textContent = error?.message || "Could not open quick create.";
        trigger.parentElement?.append(message);
        setTimeout(() => message.remove(), 5000);
        trigger.querySelector("[data-combobox-input]")?.focus();
      }
    });
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

  function setupProjectForms() {
    const projectForm = document.querySelector("[data-project-form] form");
    if (projectForm) setupPayItems(projectForm);
    const workForm = document.querySelector("[data-project-work-form] form");
    if (!workForm) return;
    setupPayItems(workForm);
    const number = (name) => Number(workForm.querySelector(`[name="${name}"]`)?.value || 0);
    const update = () => {
      const base = number("billing_quantity") * number("client_unit_rate");
      const extras = moneyFields.reduce((sum, name) => sum + number(name), 0);
      workForm.querySelector("[data-project-base]")?.replaceChildren(document.createTextNode(base.toLocaleString(undefined, { minimumFractionDigits: 2 })));
      workForm.querySelector("[data-project-extras]")?.replaceChildren(document.createTextNode(extras.toLocaleString(undefined, { minimumFractionDigits: 2 })));
      workForm.querySelector("[data-project-total]")?.replaceChildren(document.createTextNode((base + extras).toLocaleString(undefined, { minimumFractionDigits: 2 })));
    };
    workForm.querySelectorAll('input[type="number"]').forEach((field) => field.addEventListener("input", update));
    const billingUnit = workForm.querySelector('[name="billing_unit"]');
    const billingQuantity = workForm.querySelector('[name="billing_quantity"]');
    const defaults = (kind) => {
      const basis = workForm.querySelector(`[name="${kind}_pay_basis"]`);
      const quantity = workForm.querySelector(`[name="${kind}_pay_quantity"]`);
      if (!basis || !quantity || Number(quantity.value || 0) > 0) return;
      if (basis.value === "Per Day") quantity.value = "1";
      else if (basis.value.replace("Per ", "") === billingUnit?.value) quantity.value = billingQuantity?.value || "";
    };
    ["primary", "helper"].forEach((kind) => workForm.querySelector(`[name="${kind}_pay_basis"]`)?.addEventListener("change", () => defaults(kind)));
    billingQuantity?.addEventListener("input", () => { defaults("primary"); defaults("helper"); });
    billingUnit?.addEventListener("change", () => { defaults("primary"); defaults("helper"); });
    defaults("primary"); defaults("helper");
    update();
  }

  function setupMobileAccordions() {
    const media = matchMedia("(max-width: 760px)");
    const roots = document.querySelectorAll("[data-trip-form], [data-project-form], [data-project-work-form]");
    roots.forEach((root) => {
      const sections = [...root.querySelectorAll(".workspace-card")].filter((section) => section.querySelector(":scope > h3"));
      sections.forEach((section, index) => {
        const title = section.querySelector(":scope > h3");
        if (!title || section.dataset.mobileAccordionReady) return;
        section.dataset.mobileAccordionReady = "1";
        section.classList.add("mobile-accordion-section");
        title.classList.add("mobile-accordion-title");
        const button = document.createElement("button");
        button.type = "button"; button.className = "mobile-accordion-toggle";
        button.innerHTML = `<span>${title.textContent}</span><span aria-hidden="true" data-accordion-icon>⌄</span>`;
        title.after(button);
        const hasError = Boolean(section.querySelector(".error,[aria-invalid='true']"));
        const setOpen = (open) => {
          section.classList.toggle("is-collapsed", !open);
          button.setAttribute("aria-expanded", String(open));
          button.querySelector("[data-accordion-icon]").textContent = open ? "⌃" : "⌄";
        };
        button.addEventListener("click", () => setOpen(section.classList.contains("is-collapsed")));
        section._mobileSetOpen = setOpen;
        setOpen(index === 0 || hasError);
      });
      const sync = () => sections.forEach((section, index) => section._mobileSetOpen?.(!media.matches || index === 0 || Boolean(section.querySelector(".error,[aria-invalid='true']"))));
      media.addEventListener?.("change", sync);
      sync();
    });
  }

  function setupMobileFilters() {
    document.querySelectorAll("details.list-filters").forEach((details) => {
      const summary = details.querySelector("summary");
      const controls = [...details.querySelectorAll("input,select")];
      if (!summary) return;
      const label = summary.textContent.trim() || "Filters";
      const update = () => {
        const active = controls.filter((control) => control.value && control.value !== "all").length;
        summary.textContent = active ? `${label} (${active})` : label;
        if (matchMedia("(max-width: 760px)").matches && active) details.open = true;
      };
      controls.forEach((control) => control.addEventListener("change", update));
      if (matchMedia("(max-width: 760px)").matches && !controls.some((control) => control.value && control.value !== "all")) details.open = false;
      update();
    });
    document.querySelectorAll("details.dashboard-mobile-filters").forEach((details) => {
      const media = matchMedia("(max-width: 760px)");
      const sync = () => { details.open = !media.matches; };
      media.addEventListener?.("change", sync);
      sync();
    });
  }

  setupMobileNavigation(); setupComboboxes(); setupTabs(); setupDialogs(); setupQuickCreate(); setupTripForm(); setupProjectForms(); setupRepairTotal(); setupMobileAccordions(); setupMobileFilters();
})();
