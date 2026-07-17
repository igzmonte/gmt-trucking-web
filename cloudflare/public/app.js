(() => {
  function setSelectValue(form, name, value) {
    const select = form.querySelector(`select[name="${name}"]`);
    if (!select || value === undefined || value === null || value === "") return;
    const option = [...select.options].find((item) => String(item.value) === String(value));
    if (option) select.value = String(value);
  }

  function setFieldValue(form, name, value) {
    const field = form.querySelector(`[name="${name}"]`);
    if (field && value !== undefined && value !== null) field.value = value;
  }

  function setupSearchableSelects() {
    document.querySelectorAll("select[data-searchable-select]").forEach((select) => {
      const label = select.closest("label");
      const filter = label?.querySelector("[data-select-filter]");
      if (!filter) return;
      filter.setAttribute("aria-label", "Filter available options");
      filter.addEventListener("input", () => {
        const query = filter.value.trim().toLocaleLowerCase();
        [...select.options].forEach((option) => {
          option.hidden = Boolean(option.value) && Boolean(query) && !option.textContent.toLocaleLowerCase().includes(query);
        });
      });
    });
  }

  function setupTripForm() {
    const container = document.querySelector("[data-trip-form]");
    const dataNode = document.getElementById("trip-form-data");
    const form = container?.querySelector("form");
    if (!form || !dataNode) return;

    let data;
    try {
      data = JSON.parse(dataNode.textContent || "{}");
    } catch {
      return;
    }

    const masterSelect = form.querySelector('select[name="recurring_master_id"]');
    const tripType = form.querySelector('select[name="trip_type"]');
    const assetSelect = form.querySelector('select[name="asset_id"]');
    const helpers = ["helper_1", "helper_2", "helper_3"].map((name) => form.querySelector(`select[name="${name}"]`));
    const guidance = form.querySelector("[data-trip-crew-guidance]");

    function selectedMaster() {
      return (data.masters || []).find((master) => String(master.id) === String(masterSelect?.value || ""));
    }

    function updateCrewGuidance() {
      if (!guidance) return;
      const asset = (data.assets || []).find((item) => String(item.id) === String(assetSelect?.value || ""));
      const master = selectedMaster();
      const values = helpers.map((field) => field?.value || "");
      const selected = values.filter(Boolean);
      const messages = [];

      if (asset) messages.push(`${asset.asset_code || "Selected unit"} allows up to ${asset.helper_limit} helper(s).`);
      else messages.push("Select an asset to see its helper allowance.");
      if (master) messages.push(`Template expects ${master.helper_count} helper(s).`);
      if (selected.length !== new Set(selected).size) messages.push("Choose each helper only once.");
      if ((!values[0] && (values[1] || values[2])) || (!values[1] && values[2])) messages.push("Fill helper positions in order.");
      if (asset && selected.length > Number(asset.helper_limit)) messages.push(`Too many helpers for ${asset.asset_code || "this unit"}.`);

      guidance.textContent = messages.join(" ");
      guidance.classList.toggle("error", messages.some((message) => message.startsWith("Choose") || message.startsWith("Fill") || message.startsWith("Too many")));
    }

    function applyTemplate() {
      const master = selectedMaster();
      if (!master) {
        updateCrewGuidance();
        return;
      }
      if (tripType) tripType.value = "Recurring Trip";
      setSelectValue(form, "client_id", master.client_id);
      setFieldValue(form, "job_description", master.job_description);
      setFieldValue(form, "origin", master.origin);
      setFieldValue(form, "destination", master.destination);
      setSelectValue(form, "asset_id", master.asset_id);
      setSelectValue(form, "driver_id", master.driver_id);
      setFieldValue(form, "base_trip_rate", master.base_trip_rate);
      setFieldValue(form, "driver_pay_rate", master.driver_pay_rate);
      setFieldValue(form, "helper_pay_rate", master.helper_pay_rate);
      const notes = [master.default_extra_note, master.remarks ? `Template remarks: ${master.remarks}` : ""].filter(Boolean).join("\n\n");
      setFieldValue(form, "notes", notes);
      updateCrewGuidance();
    }

    masterSelect?.addEventListener("change", applyTemplate);
    tripType?.addEventListener("change", () => {
      if (tripType.value === "Spot Trip" && masterSelect) masterSelect.value = "";
      updateCrewGuidance();
    });
    assetSelect?.addEventListener("change", updateCrewGuidance);
    helpers.forEach((field) => field?.addEventListener("change", updateCrewGuidance));
    updateCrewGuidance();
  }

  setupSearchableSelects();
  setupTripForm();
})();
