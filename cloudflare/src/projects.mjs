import { canEdit, requireEdit, requireView } from "./access.mjs";
import { all, batch, first, run } from "./db.mjs";
import { layout, moneyCell, numberInput, selectInput, table, textareaInput, textInput } from "./html.mjs";
import {
  EXTRA_FIELDS,
  HELPER_LIMITS,
  choiceLabel,
  nextProjectNo,
  nextProjectWorkNo,
  projectBaseAmount,
  projectBillableTotal,
  projectEmployeeBasePay,
  projectExtraTotal,
} from "./services.mjs";
import { csv, esc, html, parseForm, peso, redirect, todayISO } from "./utils.mjs";

const PAGE = "Projects";
const PROJECT_STATUSES = ["Draft", "Active", "Completed", "Cancelled"];
const WORK_STATUSES = ["Draft", "Completed", "Cancelled"];
const BASES = ["Trip", "Hour", "Day"];
const PAY_BASES = ["Per Trip", "Per Hour", "Per Day", "Manual"];
const RECORDING_MODES = ["Single", "Repeating"];
const SEARCHABLE = { searchable: true };
function quick(kind, context = "") {
  return { searchable: true, quickCreate: { kind, context } };
}

function fail(access, user, path) {
  if (!access) return null;
  if (access.redirect) return redirect(access.redirect);
  return html(
    layout({
      title: access.status === 403 ? "Forbidden" : "Error",
      user,
      path,
      content: `<section class="panel"><p class="error">${esc(access.message)}</p></section>`,
    }),
    access.status || 400,
  );
}

function numeric(value) {
  const result = Number(value || 0);
  return Number.isFinite(result) ? result : 0;
}

function csvRow(values) {
  return values.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",");
}

function errorsPanel(errors) {
  return errors.length
    ? `<section class="panel"><ul class="error">${errors.map((error) => `<li>${esc(error)}</li>`).join("")}</ul></section>`
    : "";
}

function messages(url) {
  const ok = url.searchParams.get("ok");
  const error = url.searchParams.get("error");
  return `${ok ? `<section class="message success">${esc(ok)}</section>` : ""}${error ? `<section class="message error">${esc(error)}</section>` : ""}`;
}

function statusClass(status) {
  return String(status || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function badge(status) {
  return `<span class="status status-${statusClass(status)}">${esc(status)}</span>`;
}

function pagination(base, params, page, total) {
  const pages = Math.max(1, Math.ceil(Number(total || 0) / 25));
  if (pages <= 1) return `<p class="pagination">Page 1 of 1</p>`;
  const make = (value, text) => {
    const query = new URLSearchParams(params);
    query.set("page", String(value));
    return `<a class="button secondary" href="${base}?${query.toString()}">${text}</a>`;
  };
  return `<nav class="pagination">${page > 1 ? make(page - 1, "Previous") : ""}<span>Page ${page} of ${pages}</span>${page < pages ? make(page + 1, "Next") : ""}</nav>`;
}

function listSort(url, options, fallback) {
  const requested = url.searchParams.get("sort");
  const key = options[requested] ? requested : fallback;
  const dir = url.searchParams.get("dir") === "asc" ? "asc" : "desc";
  return { key, dir, order: `${options[key].sql} ${dir.toUpperCase()}` };
}

function listParams(url, names, sort) {
  const params = new URLSearchParams();
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value) params.set(name, value);
  }
  if (sort?.key) params.set("sort", sort.key);
  if (sort?.dir) params.set("dir", sort.dir);
  return params;
}

function sortableHeaders(columns, sort, params) {
  return columns.map((column) => {
    if (!column.key) return column.label;
    const next = new URLSearchParams(params);
    const current = sort.key === column.key;
    next.set("sort", column.key);
    next.set("dir", current && sort.dir === "asc" ? "desc" : "asc");
    next.delete("page");
    const indicator = current ? ` <span class="sort-indicator" aria-hidden="true">${sort.dir === "asc" ? "▲" : "▼"}</span>` : "";
    return { mobileLabel: column.label, html: `<a class="sort-link${current ? " is-sorted" : ""}" href="?${next.toString()}" aria-label="Sort by ${esc(column.label)}${current ? `, currently ${sort.dir === "asc" ? "ascending" : "descending"}` : ""}">${esc(column.label)}${indicator}</a>` };
  });
}

function selectFilter(name, label, options, selected) {
  return `<label>${esc(label)}<select name="${esc(name)}"><option value="">All</option>${options.map(([value, text]) => `<option value="${esc(value)}"${String(value) === String(selected) ? " selected" : ""}>${esc(text)}</option>`).join("")}</select></label>`;
}

function dateFilter(name, label, value) {
  return `<label>${esc(label)}<input type="date" name="${esc(name)}" value="${esc(value || "")}"></label>`;
}

function browserJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function parseItems(raw, label) {
  if (!raw) return { items: [], errors: [] };
  try {
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error();
    const items = [];
    const errors = [];
    rows.forEach((row, index) => {
      const itemLabel = String(row?.label || "").trim();
      const amount = numeric(row?.amount);
      if (!itemLabel || amount <= 0) errors.push(`${label} pay item ${index + 1} needs a label and a positive amount.`);
      else items.push({ label: itemLabel, amount, sort_order: index + 1 });
    });
    return { items, errors };
  } catch {
    return { items: [], errors: [`Invalid ${label.toLowerCase()} pay-item data.`] };
  }
}

function itemsJson(items, type) {
  return JSON.stringify(
    (items || [])
      .filter((item) => item.employee_type === type)
      .map((item) => ({ label: item.label, amount: item.amount })),
  );
}

async function choices(env) {
  return await Promise.all([
    all(env, "SELECT * FROM clients WHERE active=1 ORDER BY client_name, id"),
    all(env, "SELECT * FROM assets ORDER BY asset_code, id"),
    all(env, "SELECT * FROM employees WHERE active=1 AND employee_type IN ('Driver','Operator') ORDER BY full_name, id"),
    all(env, "SELECT * FROM employees WHERE active=1 AND employee_type='Helper' ORDER BY full_name, id"),
  ]);
}

async function loadProject(env, id) {
  const project = await first(
    env,
    `SELECT p.*, c.client_name, c.client_code, c.billing_address,
            a.asset_code, a.asset_type, a.plate_no, a.make_model,
            e.employee_code AS primary_code, e.full_name AS primary_name, e.employee_type AS primary_type
       FROM projects p
       LEFT JOIN clients c ON c.id=p.client_id
       LEFT JOIN assets a ON a.id=p.asset_id
       LEFT JOIN employees e ON e.id=p.primary_employee_id
      WHERE p.id=?`,
    [id],
  );
  if (!project) return null;
  project.helpers = await all(
    env,
    `SELECT ph.*, e.employee_code, e.full_name, e.employee_type
       FROM project_helpers ph JOIN employees e ON e.id=ph.employee_id
      WHERE ph.project_id=? ORDER BY ph.helper_order, ph.id`,
    [id],
  );
  project.pay_items = await all(
    env,
    "SELECT * FROM project_pay_item_defaults WHERE project_id=? ORDER BY employee_type, sort_order, id",
    [id],
  );
  return project;
}

async function loadWork(env, id) {
  const work = await first(
    env,
    `SELECT w.*, p.project_no, p.status AS project_status,
            c.client_name, a.asset_code, a.asset_type, a.plate_no,
            e.full_name AS primary_name, e.employee_code AS primary_code
       FROM project_work_entries w
       JOIN projects p ON p.id=w.project_id
       LEFT JOIN clients c ON c.id=w.client_id_snapshot
       LEFT JOIN assets a ON a.id=w.asset_id_snapshot
       LEFT JOIN employees e ON e.id=w.primary_employee_id
      WHERE w.id=?`,
    [id],
  );
  if (!work) return null;
  work.helpers = await all(
    env,
    `SELECT wh.*, e.employee_code, e.full_name
       FROM project_work_helpers wh JOIN employees e ON e.id=wh.employee_id
      WHERE wh.work_entry_id=? ORDER BY wh.helper_order, wh.id`,
    [id],
  );
  work.pay_items = await all(
    env,
    "SELECT * FROM project_work_pay_items WHERE work_entry_id=? ORDER BY employee_type, sort_order, id",
    [id],
  );
  return work;
}

async function nextProjectNumber(env, date) {
  const year = String(date).slice(0, 4);
  const row = await first(
    env,
    "SELECT project_no FROM projects WHERE project_no LIKE ? ORDER BY project_no DESC LIMIT 1",
    [`PRJ-${year}-%`],
  );
  return nextProjectNo(date, row?.project_no || "");
}

async function nextWorkNumber(env, date) {
  const year = String(date).slice(0, 4);
  const row = await first(
    env,
    "SELECT work_no FROM project_work_entries WHERE work_no LIKE ? ORDER BY work_no DESC LIMIT 1",
    [`PWL-${year}-%`],
  );
  return nextProjectWorkNo(date, row?.work_no || "");
}

function projectValues(data) {
  const values = {
    project_no: String(data.project_no || "").trim(),
    reference_no: String(data.reference_no || "").trim(),
    start_date: String(data.start_date || "").trim(),
    end_date: String(data.end_date || "").trim() || null,
    client_id: data.client_id || null,
    job_description: String(data.job_description || "").trim(),
    origin: String(data.origin || "").trim(),
    destination: String(data.destination || "").trim(),
    project_location: String(data.project_location || "").trim(),
    asset_id: data.asset_id || null,
    primary_employee_id: data.primary_employee_id || null,
    billing_basis: BASES.includes(data.billing_basis) ? data.billing_basis : "Trip",
    work_recording_mode: RECORDING_MODES.includes(data.work_recording_mode) ? data.work_recording_mode : "Single",
    default_billing_quantity: numeric(data.default_billing_quantity),
    client_unit_rate: numeric(data.client_unit_rate),
    primary_pay_basis: PAY_BASES.includes(data.primary_pay_basis) ? data.primary_pay_basis : "Per Trip",
    default_primary_pay_quantity: numeric(data.default_primary_pay_quantity),
    primary_pay_rate: numeric(data.primary_pay_rate),
    default_primary_manual_pay: numeric(data.default_primary_manual_pay),
    helper_pay_basis: PAY_BASES.includes(data.helper_pay_basis) ? data.helper_pay_basis : "Per Trip",
    default_helper_pay_quantity: numeric(data.default_helper_pay_quantity),
    helper_pay_rate: numeric(data.helper_pay_rate),
    default_helper_manual_pay: numeric(data.default_helper_manual_pay),
    status: PROJECT_STATUSES.includes(data.status) ? data.status : "Draft",
    notes: String(data.notes || "").trim(),
  };
  for (const field of EXTRA_FIELDS) values[field] = numeric(data[field]);
  return values;
}

async function validateProject(env, values, helperIds, payItems, id = null) {
  const errors = [];
  if (!values.start_date) errors.push("Start date is required.");
  if (values.end_date && values.end_date < values.start_date) errors.push("End date cannot be before the start date.");
  if (!values.client_id) errors.push("Client is required.");
  if (!values.asset_id) errors.push("Asset is required.");
  if (!values.primary_employee_id) errors.push("Primary Driver / Operator is required.");
  if (!values.job_description) errors.push("Item / Job is required.");
  if (values.default_billing_quantity <= 0) errors.push("Default daily quantity must be greater than zero.");
  for (const field of ["client_unit_rate", "default_primary_pay_quantity", "primary_pay_rate", "default_primary_manual_pay", "default_helper_pay_quantity", "helper_pay_rate", "default_helper_manual_pay", ...EXTRA_FIELDS]) {
    if (values[field] < 0) errors.push(`${field.replaceAll("_", " ")} cannot be negative.`);
  }
  const selected = helperIds.filter(Boolean);
  if (selected.length !== new Set(selected).size) errors.push("Helpers must be unique.");
  if (!helperIds[0] && helperIds.slice(1).some(Boolean)) errors.push("Fill helper positions in order.");
  if (!helperIds[1] && helperIds.slice(2).some(Boolean)) errors.push("Fill helper positions in order.");
  if (values.asset_id) {
    const asset = await first(env, "SELECT asset_type FROM assets WHERE id=?", [values.asset_id]);
    const maximum = HELPER_LIMITS[asset?.asset_type] ?? 3;
    if (selected.length > maximum) errors.push(`${asset?.asset_type || "Selected unit"} allows at most ${maximum} helper(s).`);
  }
  if (values.project_no) {
    const duplicate = await first(
      env,
      `SELECT id FROM projects WHERE project_no=?${id ? " AND id<>?" : ""} LIMIT 1`,
      id ? [values.project_no, id] : [values.project_no],
    );
    if (duplicate) errors.push("Project number is already in use.");
  }
  if (payItems.some((item) => item.employee_type === "Helper") && !selected.length) {
    errors.push("Assign a helper before adding Helper pay items.");
  }
  if (values.status === "Completed") {
    const summary = id ? await first(env, "SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('Completed','Billed') THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN status='Draft' THEN 1 ELSE 0 END) AS drafts FROM project_work_entries WHERE project_id=?", [id]) : { total: 0, completed: 0, drafts: 0 };
    if (values.work_recording_mode === "Single" && !numeric(summary?.total)) errors.push("Use Complete Project & Record Work to create the single financial work record.");
    if (values.work_recording_mode === "Repeating" && !numeric(summary?.completed)) errors.push("Record and complete at least one Daily Work entry before completing this Project.");
    if (values.work_recording_mode === "Repeating" && numeric(summary?.drafts)) errors.push("Complete or cancel all Draft work entries before completing this Project.");
  }
  return errors;
}

function selectChoices(name, label, values, selected) {
  return selectInput(
    name,
    label,
    values.map((value) => ({ id: value, name: value })),
    selected,
    (row) => row.name,
    "",
  );
}

function recordingModeChoices(selected) {
  return selectInput(
    "work_recording_mode",
    "Work recording mode",
    [
      { id: "Single", name: "Single Work Total" },
      { id: "Repeating", name: "Repeating Daily Work" },
    ],
    selected || "Single",
    (row) => row.name,
    "",
  );
}

function payItemsBlock(row, prefix = "") {
  const primaryRaw = row.primary_pay_items ?? itemsJson(row.pay_items, "Primary");
  const helperRaw = row.helper_pay_items ?? itemsJson(row.pay_items, "Helper");
  return `<section class="workspace-card pay-items-card project-pay-items"><h3>Pay Items</h3>
    <input type="hidden" name="${prefix}primary_pay_items" value="${esc(primaryRaw)}">
    <input type="hidden" name="${prefix}helper_pay_items" value="${esc(helperRaw)}">
    <div class="pay-items-area">
      <div class="pay-item-group" data-pay-items="primary"><div class="pay-item-header"><h4>Primary Employee Pay Items</h4><button type="button" data-add-pay-item>Add Primary Item</button></div><div data-pay-item-rows></div></div>
      <div class="pay-item-group" data-pay-items="helper"><div class="pay-item-header"><h4>Helper Pay Items</h4><button type="button" data-add-pay-item>Add Helper Item</button></div><div data-pay-item-rows></div></div>
    </div>
  </section>`;
}

async function projectForm(env, row = {}, id = null, errors = []) {
  const [clients, assets, primaryEmployees, helpers] = await choices(env);
  const selectedHelpers = row.helpers || [];
  const statusOptions = row.status === "Completed" ? PROJECT_STATUSES : PROJECT_STATUSES.filter((status) => status !== "Completed");
  const overview = `${textInput("project_no", "Project No.", row.project_no || "")}${textInput("reference_no", "Ref. No.", row.reference_no || "")}${textInput("start_date", "Start date", row.start_date || todayISO(), 'type="date" required')}${textInput("end_date", "End date", row.end_date || "", 'type="date"')}${recordingModeChoices(row.work_recording_mode)}${selectChoices("status", "Status", statusOptions, row.status || "Draft")}`;
  const scope = `${selectInput("client_id", "Client", clients, row.client_id || "", (item) => choiceLabel("client", item), "---------", quick("client"))}${textareaInput("job_description", "Item / Job", row.job_description || "", 'rows="2" required')}${textInput("project_location", "Project location", row.project_location || "")}`;
  const route = `${textInput("origin", "Origin", row.origin || "")}${textInput("destination", "Destination", row.destination || "")}`;
  const crew = `${selectInput("asset_id", "Asset", assets, row.asset_id || "", (item) => choiceLabel("asset", item), "---------", quick("asset"))}${selectInput("primary_employee_id", "Primary Driver / Operator", primaryEmployees, row.primary_employee_id || "", (item) => choiceLabel("employee", item), "---------", quick("employee", "primary"))}${[0, 1, 2].map((index) => selectInput(`helper_${index + 1}`, `Helper ${index + 1}`, helpers, selectedHelpers[index]?.employee_id || row[`helper_${index + 1}`] || "", (item) => choiceLabel("employee", item), "---------", quick("employee", "helper"))).join("")}<p class="trip-crew-guidance muted">Helper allowance follows the selected asset type.</p>`;
  const billing = `${selectChoices("billing_basis", "Billing basis", BASES, row.billing_basis || "Trip")}${numberInput("default_billing_quantity", "Default quantity", row.default_billing_quantity ?? 1)}${numberInput("client_unit_rate", "Client unit rate", row.client_unit_rate ?? 0)}`;
  const pay = `${selectChoices("primary_pay_basis", "Primary pay basis", PAY_BASES, row.primary_pay_basis || "Per Trip")}${numberInput("default_primary_pay_quantity", "Primary pay quantity default", row.default_primary_pay_quantity ?? "")}${numberInput("primary_pay_rate", "Primary pay rate", row.primary_pay_rate ?? 0)}${numberInput("default_primary_manual_pay", "Primary manual pay default", row.default_primary_manual_pay ?? 0)}${selectChoices("helper_pay_basis", "Helper pay basis", PAY_BASES, row.helper_pay_basis || "Per Trip")}${numberInput("default_helper_pay_quantity", "Helper pay quantity default", row.default_helper_pay_quantity ?? "")}${numberInput("helper_pay_rate", "Helper pay pool rate", row.helper_pay_rate ?? 0)}${numberInput("default_helper_manual_pay", "Helper manual pay default", row.default_helper_manual_pay ?? 0)}`;
  const extras = EXTRA_FIELDS.map((field) => numberInput(field, field.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()), row[field] ?? 0)).join("");
  const data = {
    assets: assets.map((asset) => ({ id: asset.id, asset_type: asset.asset_type, helper_limit: HELPER_LIMITS[asset.asset_type] ?? 3 })),
  };
  return `${errorsPanel(errors)}<section data-project-form><form method="post" action="${id ? `/projects/${id}/edit` : "/projects/new"}" class="app-form project-workspace">
    <div class="workspace-grid project-top">
      <section class="workspace-card"><h3>Project Overview</h3><div class="field-grid">${overview}</div></section>
      <section class="workspace-card"><h3>Client &amp; Scope</h3><div class="field-grid">${scope}</div></section>
      <section class="workspace-card"><h3>Route / Project Location</h3><div class="field-grid">${route}</div></section>
      <section class="workspace-card"><h3>Unit &amp; Crew</h3><div class="field-grid">${crew}</div></section>
    </div>
    <div class="workspace-grid project-finance">
      <section class="workspace-card"><h3>Client Billing Rate</h3><div class="field-grid">${billing}</div></section>
      <section class="workspace-card"><h3>Employee Pay Rates</h3><div class="field-grid">${pay}</div></section>
      <section class="workspace-card"><h3>Default Extra Charges</h3><div class="charge-grid">${extras}</div></section>
    </div>
    ${payItemsBlock(row)}
    <section class="workspace-card project-notes">${textareaInput("notes", "Notes", row.notes || "", 'rows="2"')}</section>
    <div class="sticky-actions"><a class="button secondary" href="${id ? `/projects/${id}` : "/projects"}">Cancel</a>${id ? `<button>Save Project</button>` : `<button name="after_save" value="record_work">Save &amp; ${row.work_recording_mode === "Repeating" ? "Record Daily Work" : "Record Work"}</button><button class="button secondary" name="after_save" value="list">Save Project</button>`}</div>
  </form></section><script id="project-form-data" type="application/json">${browserJson(data)}</script>`;
}

async function saveProject(env, values, helpers, payItems, id = null) {
  const fields = [
    "project_no", "reference_no", "start_date", "end_date", "client_id", "job_description",
    "origin", "destination", "project_location", "asset_id", "primary_employee_id",
    "billing_basis", "work_recording_mode", "default_billing_quantity", "client_unit_rate", "primary_pay_basis",
    "default_primary_pay_quantity", "primary_pay_rate", "default_primary_manual_pay", "helper_pay_basis", "default_helper_pay_quantity", "helper_pay_rate", "default_helper_manual_pay", ...EXTRA_FIELDS, "status", "notes",
  ];
  let projectId = id;
  if (id) {
    await run(env, `UPDATE projects SET ${fields.map((field) => `${field}=?`).join(",")} WHERE id=?`, [...fields.map((field) => values[field]), id]);
  } else {
    await run(env, `INSERT INTO projects (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`, fields.map((field) => values[field]));
    projectId = (await first(env, "SELECT id FROM projects WHERE project_no=?", [values.project_no]))?.id;
  }
  await run(env, "DELETE FROM project_helpers WHERE project_id=?", [projectId]);
  for (const [index, employeeId] of helpers.filter(Boolean).entries()) {
    await run(env, "INSERT INTO project_helpers (project_id,employee_id,helper_order) VALUES (?,?,?)", [projectId, employeeId, index + 1]);
  }
  await run(env, "DELETE FROM project_pay_item_defaults WHERE project_id=?", [projectId]);
  for (const item of payItems) {
    await run(env, "INSERT INTO project_pay_item_defaults (project_id,employee_type,label,amount,sort_order) VALUES (?,?,?,?,?)", [projectId, item.employee_type, item.label, item.amount, item.sort_order]);
  }
  return projectId;
}

async function projectList(request, env, user, path) {
  const access = requireView(user, PAGE);
  if (access) return fail(access, user, path);
  const url = new URL(request.url);
  const query = String(url.searchParams.get("q") || "").trim();
  const status = PROJECT_STATUSES.includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "";
  const clientId = Number(url.searchParams.get("client_id")) || 0;
  const assetId = Number(url.searchParams.get("asset_id")) || 0;
  const billingBasis = BASES.includes(url.searchParams.get("billing_basis")) ? url.searchParams.get("billing_basis") : "";
  const dateFrom = String(url.searchParams.get("start_date_from") || "");
  const dateTo = String(url.searchParams.get("start_date_to") || "");
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const clauses = [];
  const params = [];
  if (query) {
    clauses.push("(p.project_no LIKE ? OR p.reference_no LIKE ? OR p.job_description LIKE ? OR c.client_name LIKE ? OR a.asset_code LIKE ? OR e.full_name LIKE ?)");
    params.push(...Array(6).fill(`%${query}%`));
  }
  if (PROJECT_STATUSES.includes(status)) {
    clauses.push("p.status=?");
    params.push(status);
  }
  if (clientId) { clauses.push("p.client_id=?"); params.push(clientId); }
  if (assetId) { clauses.push("p.asset_id=?"); params.push(assetId); }
  if (billingBasis) { clauses.push("p.billing_basis=?"); params.push(billingBasis); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) { clauses.push("p.start_date>=?"); params.push(dateFrom); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) { clauses.push("p.start_date<=?"); params.push(dateTo); }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const sorts = {
    project_no: { sql: "p.project_no", label: "Project No." }, client: { sql: "c.client_name", label: "Client" },
    item_job: { sql: "p.job_description", label: "Item / Job" }, start_date: { sql: "p.start_date", label: "Dates" },
    asset: { sql: "a.asset_code", label: "Asset" }, primary: { sql: "e.full_name", label: "Primary" },
    billing_basis: { sql: "p.billing_basis", label: "Default Work" }, entries: { sql: "work_count", label: "Entries" }, status: { sql: "p.status", label: "Status" },
  };
  const sort = listSort(url, sorts, "start_date");
  const count = await first(env, `SELECT COUNT(*) AS total FROM projects p LEFT JOIN clients c ON c.id=p.client_id LEFT JOIN assets a ON a.id=p.asset_id LEFT JOIN employees e ON e.id=p.primary_employee_id${where}`, params);
  const rows = await all(env, `SELECT p.*, c.client_name, a.asset_code, e.full_name AS primary_name, (SELECT COUNT(*) FROM project_work_entries w WHERE w.project_id=p.id) AS work_count FROM projects p LEFT JOIN clients c ON c.id=p.client_id LEFT JOIN assets a ON a.id=p.asset_id LEFT JOIN employees e ON e.id=p.primary_employee_id${where} ORDER BY ${sort.order},p.id DESC LIMIT 25 OFFSET ?`, [...params, (page - 1) * 25]);
  const searchParams = listParams(url, ["q", "status", "client_id", "asset_id", "billing_basis", "start_date_from", "start_date_to"], sort);
  const [clients, assets] = await choices(env);
  const listRows = rows.map((row) => {
    const noWork = !numeric(row.work_count);
    const recordAction = canEdit(user, PAGE) && row.work_recording_mode === "Repeating" && ["Draft", "Active"].includes(row.status)
      ? ` <a class="status-action" href="/projects/${row.id}/work/new">Record Work</a>`
      : "";
    const singleAction = canEdit(user, PAGE) && row.work_recording_mode === "Single" && noWork && ["Draft", "Active", "Completed"].includes(row.status)
      ? ` <a class="status-action" href="/projects/${row.id}/complete">${row.status === "Completed" ? "Create Work" : "Complete &amp; Record"}</a>`
      : "";
    const legacySingleAction = canEdit(user, PAGE) && row.work_recording_mode === "Repeating" && noWork && row.status === "Completed"
      ? ` <a class="status-action" href="/projects/${row.id}">Create Work</a>`
      : "";
    return `<tr><td><a href="/projects/${row.id}">${esc(row.project_no)}</a></td><td>${esc(row.client_name || "")}</td><td>${esc(row.job_description)}</td><td>${esc(row.start_date)}${row.end_date ? ` – ${esc(row.end_date)}` : ""}</td><td>${esc(row.asset_code || "")}</td><td>${esc(row.primary_name || "")}</td><td>${esc(`${row.default_billing_quantity} ${row.billing_basis}${Number(row.default_billing_quantity) === 1 ? "" : "s"}`)}<small class="cell-detail">${esc(row.work_recording_mode === "Single" ? "Single total" : "Repeating")}</small></td><td>${esc(row.work_count || 0)}${noWork ? `<small class="cell-detail no-work-recorded">No work recorded</small>` : ""}</td><td>${badge(row.status)}</td><td><a href="/projects/${row.id}">View</a>${canEdit(user, PAGE) ? ` <a href="/projects/${row.id}/edit">Edit</a>` : ""}${recordAction}${singleAction}${legacySingleAction}</td></tr>`;
  });
  const controls = `<section class="panel toolbar list-toolbar"><form method="get" class="list-query-form"><div class="list-search-row"><input name="q" value="${esc(query)}" placeholder="Search projects"><button>Apply</button><a class="button secondary" href="/projects">Clear</a></div><details class="list-filters" open><summary>Filters</summary><div class="list-filter-grid">${selectFilter("status", "Status", PROJECT_STATUSES.map((value) => [value, value]), status)}${selectFilter("client_id", "Client", clients.map((row) => [row.id, `${row.client_code || ""}, ${row.client_name}`]), clientId)}${selectFilter("asset_id", "Asset", assets.map((row) => [row.id, `${row.asset_code || ""}, ${row.plate_no || row.asset_type || ""}`]), assetId)}${selectFilter("billing_basis", "Billing basis", BASES.map((value) => [value, value]), billingBasis)}${dateFilter("start_date_from", "Start from", dateFrom)}${dateFilter("start_date_to", "Start to", dateTo)}</div></details></form><div class="toolbar-actions">${canEdit(user, PAGE) ? `<a class="button" href="/projects/new">New Project</a>` : ""}<a class="button secondary" href="/projects/export.csv${searchParams.toString() ? `?${searchParams}` : ""}">Export CSV</a></div></section>`;
  const headers = sortableHeaders([{ key: "project_no", label: "Project No." }, { key: "client", label: "Client" }, { key: "item_job", label: "Item / Job" }, { key: "start_date", label: "Dates" }, { key: "asset", label: "Asset" }, { key: "primary", label: "Primary" }, { key: "billing_basis", label: "Default Work" }, { key: "entries", label: "Entries" }, { key: "status", label: "Status" }, { label: "Actions" }], sort, searchParams);
  return html(layout({ title: "Projects List", user, path, content: `${messages(url)}${controls}${table(headers, listRows, { empty: "No projects found." })}${pagination("/projects", searchParams, page, count?.total)}` }));
}

async function projectFormPage(request, env, user, path, id = null) {
  const access = requireEdit(user, PAGE);
  if (access) return fail(access, user, path);
  let row = id ? await loadProject(env, id) : { status: "Draft", work_recording_mode: "Single", start_date: todayISO(), default_billing_quantity: 1 };
  if (id && !row) return html("Not found", 404);
  if (request.method === "GET") {
    return html(layout({ title: id ? "Edit Project Details" : "New Project Details", user, path, content: await projectForm(env, row, id) }));
  }
  const data = await parseForm(request);
  const values = projectValues(data);
  const saveAndRecord = !id && data.after_save === "record_work";
  if (saveAndRecord) values.status = "Active";
  if (!values.project_no && values.start_date) values.project_no = await nextProjectNumber(env, values.start_date);
  const helperIds = [data.helper_1, data.helper_2, data.helper_3].map((value) => value || "");
  const primary = parseItems(data.primary_pay_items, "Primary");
  const helper = parseItems(data.helper_pay_items, "Helper");
  const payItems = [...primary.items.map((item) => ({ ...item, employee_type: "Primary" })), ...helper.items.map((item) => ({ ...item, employee_type: "Helper" }))];
  const errors = [...primary.errors, ...helper.errors, ...(await validateProject(env, values, helperIds, payItems, id))];
  if (errors.length) {
    row = { ...row, ...values, ...data, helpers: helperIds.filter(Boolean).map((employee_id) => ({ employee_id })), primary_pay_items: data.primary_pay_items, helper_pay_items: data.helper_pay_items };
    return html(layout({ title: id ? "Edit Project Details" : "New Project Details", user, path, content: await projectForm(env, row, id, errors) }), 400);
  }
  const projectId = await saveProject(env, values, helperIds, payItems, id);
  if (saveAndRecord) {
    if (values.work_recording_mode === "Single") {
      return redirect(`/projects/${projectId}/complete?ok=${encodeURIComponent(`Project ${values.project_no} saved. Confirm its one completed work record.`)}`);
    }
    return redirect(`/projects/${projectId}/work/new?ok=${encodeURIComponent(`Project ${values.project_no} saved as Active. Record the actual daily work before Billing or Payroll.`)}`);
  }
  return redirect(`/projects/${projectId}?ok=${encodeURIComponent(`Project ${values.project_no} saved.`)}`);
}

function workValues(data, project, existing = {}) {
  const billingUnit = BASES.includes(data.billing_unit) ? data.billing_unit : project.billing_basis;
  const billingQuantity = numeric(data.billing_quantity ?? project.default_billing_quantity);
  const primaryBasis = PAY_BASES.includes(data.primary_pay_basis) ? data.primary_pay_basis : project.primary_pay_basis;
  const helperBasis = PAY_BASES.includes(data.helper_pay_basis) ? data.helper_pay_basis : project.helper_pay_basis;
  const defaultPayQuantity = (basis, stored) => numeric(stored) || (basis === "Per Day" ? 1 : basis.replace("Per ", "") === billingUnit ? billingQuantity : 0);
  const values = {
    work_no: String(data.work_no || existing.work_no || "").trim(),
    work_date: String(data.work_date || "").trim(),
    reference_no: String(data.reference_no || "").trim(),
    billing_unit: billingUnit,
    billing_quantity: billingQuantity,
    client_unit_rate: numeric(data.client_unit_rate ?? project.client_unit_rate),
    primary_pay_basis: primaryBasis,
    primary_pay_quantity: numeric(data.primary_pay_quantity || defaultPayQuantity(primaryBasis, project.default_primary_pay_quantity)),
    primary_pay_rate: numeric(data.primary_pay_rate ?? project.primary_pay_rate),
    primary_manual_pay: numeric(data.primary_manual_pay ?? project.default_primary_manual_pay),
    helper_pay_basis: helperBasis,
    helper_pay_quantity: numeric(data.helper_pay_quantity || defaultPayQuantity(helperBasis, project.default_helper_pay_quantity)),
    helper_pay_rate: numeric(data.helper_pay_rate ?? project.helper_pay_rate),
    helper_manual_pay: numeric(data.helper_manual_pay ?? project.default_helper_manual_pay),
    start_time: data.start_time || null,
    end_time: data.end_time || null,
    meter_start: data.meter_start === "" || data.meter_start == null ? null : numeric(data.meter_start),
    meter_end: data.meter_end === "" || data.meter_end == null ? null : numeric(data.meter_end),
    status: existing.status || "Draft",
    notes: String(data.notes || "").trim(),
  };
  for (const field of EXTRA_FIELDS) values[field] = numeric(data[field] ?? project[field]);
  values.base_charge = projectBaseAmount(values);
  values.extra_total = projectExtraTotal(values);
  values.total_charge = projectBillableTotal(values);
  return values;
}

function validateWork(values, project, helperCount, payItems) {
  const errors = [];
  if (!values.work_date) errors.push("Work date is required.");
  if (values.work_date && values.work_date < project.start_date) errors.push("Work date cannot be before the project start date.");
  if (values.work_date && project.end_date && values.work_date > project.end_date) errors.push("Work date cannot be after the project end date.");
  if (values.billing_quantity <= 0) errors.push("Actual billing quantity must be greater than zero.");
  for (const field of ["client_unit_rate", "primary_pay_quantity", "primary_pay_rate", "primary_manual_pay", "helper_pay_quantity", "helper_pay_rate", "helper_manual_pay", ...EXTRA_FIELDS]) {
    if (values[field] < 0) errors.push(`${field.replaceAll("_", " ")} cannot be negative.`);
  }
  if (values.meter_start != null && values.meter_start < 0) errors.push("Hour-meter start cannot be negative.");
  if (values.meter_end != null && values.meter_end < 0) errors.push("Hour-meter end cannot be negative.");
  if (values.meter_start != null && values.meter_end != null && values.meter_end < values.meter_start) errors.push("Hour-meter end cannot be below the start reading.");
  if (values.primary_pay_basis !== "Manual" && values.primary_pay_quantity <= 0) errors.push("Review the primary pay quantity; it must be greater than zero.");
  if (values.primary_pay_basis === "Manual" && values.primary_manual_pay < 0) errors.push("Manual primary pay cannot be negative.");
  if (helperCount && values.helper_pay_basis !== "Manual" && values.helper_pay_quantity <= 0) errors.push("Review the helper pay quantity; it must be greater than zero.");
  if (payItems.some((item) => item.employee_type === "Helper") && !helperCount) errors.push("Helper pay items require at least one assigned helper.");
  return errors;
}

async function workForm(env, project, row = {}, entryId = null, errors = []) {
  const base = {
    billing_unit: project.billing_basis,
    billing_quantity: project.default_billing_quantity,
    client_unit_rate: project.client_unit_rate,
    primary_pay_basis: project.primary_pay_basis,
    primary_pay_quantity: project.default_primary_pay_quantity,
    primary_pay_rate: project.primary_pay_rate,
    primary_manual_pay: project.default_primary_manual_pay,
    helper_pay_basis: project.helper_pay_basis,
    helper_pay_quantity: project.default_helper_pay_quantity,
    helper_pay_rate: project.helper_pay_rate,
    helper_manual_pay: project.default_helper_manual_pay,
    work_date: todayISO(),
    pay_items: project.pay_items,
    ...Object.fromEntries(EXTRA_FIELDS.map((field) => [field, project[field]])),
    ...row,
  };
  const billing = `${selectChoices("billing_unit", "Billing unit", BASES, base.billing_unit)}${numberInput("billing_quantity", "Actual billing quantity", base.billing_quantity ?? 1)}${numberInput("client_unit_rate", "Client unit rate", base.client_unit_rate ?? 0)}`;
  const pay = `${selectChoices("primary_pay_basis", "Primary pay basis", PAY_BASES, base.primary_pay_basis)}${numberInput("primary_pay_quantity", "Primary pay quantity", base.primary_pay_quantity ?? "")}${numberInput("primary_pay_rate", "Primary pay rate", base.primary_pay_rate ?? 0)}${numberInput("primary_manual_pay", "Primary manual pay", base.primary_manual_pay ?? 0)}${selectChoices("helper_pay_basis", "Helper pay basis", PAY_BASES, base.helper_pay_basis)}${numberInput("helper_pay_quantity", "Helper pay quantity", base.helper_pay_quantity ?? "")}${numberInput("helper_pay_rate", "Helper pay pool rate", base.helper_pay_rate ?? 0)}${numberInput("helper_manual_pay", "Helper manual pay pool", base.helper_manual_pay ?? 0)}`;
  const extras = EXTRA_FIELDS.map((field) => numberInput(field, field.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()), base[field] ?? 0)).join("");
  const total = projectBillableTotal({ ...base, billing_quantity: base.billing_quantity || 0 });
  return `${errorsPanel(errors)}<section data-project-work-form><form method="post" action="${entryId ? `/projects/${project.id}/work/${entryId}/edit` : `/projects/${project.id}/work/new`}" class="app-form project-work-entry">
    <section class="panel detail-hero"><div><span class="dialog-kicker">Daily Work Entry</span><h3>${esc(project.project_no)}</h3><p>${esc(project.client_name || "")} · ${esc(project.job_description)}</p></div>${badge(base.status || "Draft")}</section>
    <div class="workspace-grid work-entry-grid compact-work-entry">
      <section class="workspace-card"><h3>Actual Work</h3><div class="field-grid">${textInput("work_no", "Work entry no.", base.work_no || "", entryId ? 'readonly' : 'placeholder="Generated when saved" readonly')}${textInput("work_date", "Work date", base.work_date, 'type="date" required')}${textInput("reference_no", "Ref. No.", base.reference_no || "")}${selectChoices("billing_unit", "Billing unit", BASES, base.billing_unit)}${numberInput("billing_quantity", "Actual quantity", base.billing_quantity ?? 1)}</div></section>
      <section class="workspace-card"><h3>Client Total</h3><div class="field-grid">${numberInput("client_unit_rate", "Client unit rate", base.client_unit_rate ?? 0)}</div><div class="trip-summary-bar"><div><span>Base</span><strong data-project-base>${esc(projectBaseAmount(base).toFixed(2))}</strong></div><div><span>Extras</span><strong data-project-extras>${esc(projectExtraTotal(base).toFixed(2))}</strong></div><div><span>Total</span><strong data-project-total>${esc(total.toFixed(2))}</strong></div></div></section>
      <section class="workspace-card"><h3>Optional readings</h3><div class="field-grid">${textInput("start_time", "Start time", base.start_time || "", 'type="time"')}${textInput("end_time", "End time", base.end_time || "", 'type="time"')}${numberInput("meter_start", "Hour-meter start", base.meter_start ?? "")}${numberInput("meter_end", "Hour-meter end", base.meter_end ?? "")}</div></section>
    </div>
    <details class="workspace-card work-overrides"><summary>Adjust Rates &amp; Charges</summary><div class="workspace-grid"><section><h3>Employee Pay</h3><div class="field-grid">${pay}</div><p class="field-help">Per-Day defaults to one day. Review quantities when pay units differ from billing.</p></section><section><h3>Flat Extra Charges</h3><div class="charge-grid">${extras}</div></section></div></details>
    <details class="workspace-card work-overrides"><summary>Pay Items</summary>${payItemsBlock(base)}</details>
    <section class="workspace-card project-notes">${textareaInput("notes", "Entry notes", base.notes || "", 'rows="2"')}</section>
    <div class="sticky-actions"><a class="button secondary" href="/projects/${project.id}">Cancel</a><button name="after_save" value="draft">Save Draft</button><button class="button secondary" name="after_save" value="another">Save &amp; Add Another</button><button name="after_save" value="complete">Save &amp; Complete</button></div>
  </form></section>`;
}

async function saveWork(env, project, values, payItems, entryId = null) {
  const fields = [
    "work_no", "project_id", "work_date", "reference_no", "billing_unit", "billing_quantity",
    "client_unit_rate", "base_charge", "primary_employee_id", "primary_pay_basis",
    "primary_pay_quantity", "primary_pay_rate", "primary_manual_pay", "helper_pay_basis",
    "helper_pay_quantity", "helper_pay_rate", "helper_manual_pay", "client_id_snapshot",
    "asset_id_snapshot", "job_description_snapshot", "origin_snapshot", "destination_snapshot",
    "project_location_snapshot", "start_time", "end_time", "meter_start", "meter_end",
    ...EXTRA_FIELDS, "extra_total", "total_charge", "status", "notes",
  ];
  const record = {
    ...values,
    project_id: project.id,
    primary_employee_id: project.primary_employee_id,
    client_id_snapshot: project.client_id,
    asset_id_snapshot: project.asset_id,
    job_description_snapshot: project.job_description,
    origin_snapshot: project.origin,
    destination_snapshot: project.destination,
    project_location_snapshot: project.project_location,
  };
  let workId = entryId;
  if (entryId) {
    await run(env, `UPDATE project_work_entries SET ${fields.filter((field) => field !== "project_id").map((field) => `${field}=?`).join(",")} WHERE id=?`, [...fields.filter((field) => field !== "project_id").map((field) => record[field]), entryId]);
  } else {
    await run(env, `INSERT INTO project_work_entries (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`, fields.map((field) => record[field]));
    workId = (await first(env, "SELECT id FROM project_work_entries WHERE work_no=?", [values.work_no]))?.id;
  }
  await run(env, "DELETE FROM project_work_helpers WHERE work_entry_id=?", [workId]);
  for (const helper of project.helpers || []) {
    await run(env, "INSERT INTO project_work_helpers (work_entry_id,employee_id,helper_order) VALUES (?,?,?)", [workId, helper.employee_id, helper.helper_order]);
  }
  await run(env, "DELETE FROM project_work_pay_items WHERE work_entry_id=?", [workId]);
  for (const item of payItems) {
    await run(env, "INSERT INTO project_work_pay_items (work_entry_id,employee_type,label,amount,sort_order) VALUES (?,?,?,?,?)", [workId, item.employee_type, item.label, item.amount, item.sort_order]);
  }
  return workId;
}

function projectWorkRecord(project, values) {
  return {
    ...values,
    project_id: project.id,
    primary_employee_id: project.primary_employee_id,
    client_id_snapshot: project.client_id,
    asset_id_snapshot: project.asset_id,
    job_description_snapshot: project.job_description,
    origin_snapshot: project.origin,
    destination_snapshot: project.destination,
    project_location_snapshot: project.project_location,
  };
}

function singleWorkErrors(values, project, payItems) {
  const errors = validateWork(values, project, project.helpers.length, payItems);
  if (values.primary_pay_basis === "Manual" && values.primary_manual_pay <= 0) errors.push("Set a Primary manual pay default before completing this Project.");
  if (values.primary_pay_basis !== "Manual" && values.primary_pay_quantity <= 0) errors.push("Set a Primary pay quantity default before completing this Project.");
  if (project.helpers.length && values.helper_pay_basis === "Manual" && values.helper_manual_pay <= 0) errors.push("Set a Helper manual pay pool default before completing this Project.");
  if (project.helpers.length && values.helper_pay_basis !== "Manual" && values.helper_pay_quantity <= 0) errors.push("Set a Helper pay quantity default before completing this Project.");
  return [...new Set(errors)];
}

async function singleWorkPreview(env, project) {
  const values = workValues({ work_date: project.start_date, reference_no: project.reference_no || "" }, project);
  values.work_no = await nextWorkNumber(env, values.work_date);
  values.status = "Completed";
  const payItems = project.pay_items || [];
  return { values, payItems, errors: singleWorkErrors(values, project, payItems) };
}

async function saveSingleWorkCompletion(env, project, preview) {
  const values = preview.values;
  const fields = [
    "work_no", "project_id", "work_date", "reference_no", "billing_unit", "billing_quantity",
    "client_unit_rate", "base_charge", "primary_employee_id", "primary_pay_basis",
    "primary_pay_quantity", "primary_pay_rate", "primary_manual_pay", "helper_pay_basis",
    "helper_pay_quantity", "helper_pay_rate", "helper_manual_pay", "client_id_snapshot",
    "asset_id_snapshot", "job_description_snapshot", "origin_snapshot", "destination_snapshot",
    "project_location_snapshot", "start_time", "end_time", "meter_start", "meter_end",
    ...EXTRA_FIELDS, "extra_total", "total_charge", "status", "notes",
  ];
  const record = projectWorkRecord(project, values);
  const statements = [
    {
      sql: `INSERT INTO project_work_entries (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
      params: fields.map((field) => record[field]),
    },
    ...project.helpers.map((helper) => ({
      sql: "INSERT INTO project_work_helpers (work_entry_id,employee_id,helper_order) VALUES ((SELECT id FROM project_work_entries WHERE work_no=?),?,?)",
      params: [values.work_no, helper.employee_id, helper.helper_order],
    })),
    ...preview.payItems.map((item) => ({
      sql: "INSERT INTO project_work_pay_items (work_entry_id,employee_type,label,amount,sort_order) VALUES ((SELECT id FROM project_work_entries WHERE work_no=?),?,?,?,?)",
      params: [values.work_no, item.employee_type, item.label, item.amount, item.sort_order],
    })),
    { sql: "UPDATE projects SET status='Completed' WHERE id=?", params: [project.id] },
  ];
  await batch(env, statements);
  const work = await first(env, "SELECT id FROM project_work_entries WHERE work_no=?", [values.work_no]);
  return { id: work?.id, values };
}

function financeActions(project, entry, user) {
  if (!entry || entry.status !== "Completed") return "";
  const dateParams = `period_from=${encodeURIComponent(entry.work_date)}&period_to=${encodeURIComponent(entry.work_date)}`;
  const billing = canEdit(user, "Billing") ? `<a class="button" href="/billing/new?client=${encodeURIComponent(project.client_id)}&${dateParams}">Create Billing for This Work</a>` : "";
  const employees = [
    { id: entry.primary_employee_id, label: "Primary" },
    ...(entry.helpers || []).map((helper) => ({ id: helper.employee_id, label: helper.full_name || "Helper" })),
  ];
  const payroll = canEdit(user, "Payroll")
    ? employees.map((employee) => `<a class="button secondary" href="/payroll/new?employee=${encodeURIComponent(employee.id)}&${dateParams}">Create ${esc(employee.label)} Payroll</a>`).join(" ")
    : "";
  return billing || payroll ? `<section class="panel project-finance-next"><h3>Ready for Finance</h3><p>${esc(entry.work_no)} is completed and can now be included once in Billing and Payroll.</p><div class="toolbar-actions">${billing}${payroll}</div></section>` : "";
}

async function projectCompletePage(request, env, user, path, projectId) {
  const access = requireEdit(user, PAGE);
  if (access) return fail(access, user, path);
  const project = await loadProject(env, projectId);
  if (!project) return html("Project not found", 404);
  if (project.work_recording_mode !== "Single") return redirect(`/projects/${projectId}?error=${encodeURIComponent("Repeating Daily Work projects must be closed after their work entries are completed.")}`);
  const count = await first(env, "SELECT COUNT(*) AS total FROM project_work_entries WHERE project_id=?", [projectId]);
  if (numeric(count?.total)) return redirect(`/projects/${projectId}?error=${encodeURIComponent("This Single Work Total project already has a recorded work entry.")}`);
  const preview = await singleWorkPreview(env, project);
  if (request.method === "GET") {
    const primary = projectEmployeeBasePay(preview.values, "primary", project.helpers.length);
    const helper = project.helpers.length ? projectEmployeeBasePay(preview.values, "helper", project.helpers.length) * project.helpers.length : 0;
    const content = `${errorsPanel(preview.errors)}<section class="panel project-complete-preview"><h3>Complete Project &amp; Record Work</h3><p>This creates one completed Work Entry from the saved Project defaults. It will immediately be eligible for Billing and Payroll.</p><dl class="detail-list"><dt>Work date</dt><dd>${esc(preview.values.work_date)}</dd><dt>Quantity</dt><dd>${esc(`${preview.values.billing_quantity} ${preview.values.billing_unit}`)}</dd><dt>Client rate</dt><dd>${esc(peso(preview.values.client_unit_rate))}</dd><dt>Base charge</dt><dd>${esc(peso(preview.values.base_charge))}</dd><dt>Extra charges</dt><dd>${esc(peso(preview.values.extra_total))}</dd><dt>Client total</dt><dd><strong>${esc(peso(preview.values.total_charge))}</strong></dd><dt>Primary pay</dt><dd>${esc(peso(primary))}</dd><dt>Helper pool</dt><dd>${esc(peso(helper))}</dd></dl>${preview.errors.length ? `<p><a class="button" href="/projects/${projectId}/edit">Edit Project Defaults</a> <a class="button secondary" href="/projects/${projectId}">Cancel</a></p>` : `<form method="post"><p class="status-warning">Confirm that the date, quantity, rates, crew, and pay defaults are correct. This financial snapshot cannot be edited after Billing or Payroll uses it.</p><div class="form-actions"><button>Complete Project &amp; Record Work</button><a class="button secondary" href="/projects/${projectId}">Cancel</a></div></form>`}</section>`;
    return html(layout({ title: "Complete Project", user, path, content }));
  }
  if (preview.errors.length) return redirect(`/projects/${projectId}/edit?error=${encodeURIComponent("Complete the Project pay defaults before recording this work.")}`);
  try {
    const saved = await saveSingleWorkCompletion(env, project, preview);
    return redirect(`/projects/${projectId}?ok=${encodeURIComponent(`Project completed and ${saved.values.work_no} was recorded.`)}&completed_work=${saved.id || ""}`);
  } catch {
    return redirect(`/projects/${projectId}?error=${encodeURIComponent("The Project was not completed because its work record could not be saved. Review the defaults and try again.")}`);
  }
}

async function projectCloseRepeating(request, env, user, path, projectId) {
  const access = requireEdit(user, PAGE);
  if (access) return fail(access, user, path);
  if (request.method !== "POST") return html("Closing a Project requires POST.", 405);
  const project = await loadProject(env, projectId);
  if (!project) return html("Project not found", 404);
  const summary = await first(env, "SELECT SUM(CASE WHEN status IN ('Completed','Billed') THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN status='Draft' THEN 1 ELSE 0 END) AS drafts FROM project_work_entries WHERE project_id=?", [projectId]);
  if (project.work_recording_mode !== "Repeating" || !numeric(summary?.completed) || numeric(summary?.drafts)) return redirect(`/projects/${projectId}?error=${encodeURIComponent("Complete or cancel all Draft work entries and ensure at least one work entry is Completed before closing this Project.")}`);
  await run(env, "UPDATE projects SET status='Completed' WHERE id=?", [projectId]);
  return redirect(`/projects/${projectId}?ok=${encodeURIComponent("Project completed. Its completed work entries remain available to Billing and Payroll.")}`);
}

async function projectUseSingleWork(request, env, user, path, projectId) {
  const access = requireEdit(user, PAGE);
  if (access) return fail(access, user, path);
  if (request.method !== "POST") return html("Choosing a work recording mode requires POST.", 405);
  const project = await loadProject(env, projectId);
  if (!project) return html("Project not found", 404);
  const count = await first(env, "SELECT COUNT(*) AS total FROM project_work_entries WHERE project_id=?", [projectId]);
  if (project.work_recording_mode !== "Repeating" || project.status !== "Completed" || numeric(count?.total)) {
    return redirect(`/projects/${projectId}?error=${encodeURIComponent("Only completed zero-entry Projects can be changed to Single Work Total.")}`);
  }
  await run(env, "UPDATE projects SET work_recording_mode='Single',status='Active' WHERE id=?", [projectId]);
  return redirect(`/projects/${projectId}/complete?ok=${encodeURIComponent("Project is ready to create its one completed work record from the saved defaults.")}`);
}

async function workFormPage(request, env, user, path, projectId, entryId = null) {
  const access = requireEdit(user, PAGE);
  if (access) return fail(access, user, path);
  const project = await loadProject(env, projectId);
  if (!project) return html("Project not found", 404);
  if (project.work_recording_mode === "Single" && !entryId) {
    return redirect(`/projects/${projectId}/complete?error=${encodeURIComponent("Single Work Total projects record their one work entry when you complete the Project.")}`);
  }
  if (!entryId && !["Draft", "Active"].includes(project.status)) {
    return redirect(`/projects/${projectId}?error=${encodeURIComponent("Completed or cancelled projects cannot accept new work entries.")}`);
  }
  let row = entryId ? await loadWork(env, entryId) : {};
  if (!entryId && request.method === "GET") {
    const copyId = Number(new URL(request.url).searchParams.get("copy")) || 0;
    if (copyId) {
      const source = await loadWork(env, copyId);
      if (!source || Number(source.project_id) !== Number(projectId)) return redirect(`/projects/${projectId}?error=${encodeURIComponent("The selected work entry could not be duplicated.")}`);
      const nextDate = new Date(`${source.work_date}T00:00:00Z`);
      nextDate.setUTCDate(nextDate.getUTCDate() + 1);
      const candidate = nextDate.toISOString().slice(0, 10);
      row = {
        ...source,
        work_no: "", reference_no: "", start_time: "", end_time: "", meter_start: "", meter_end: "", notes: "", status: "Draft",
        work_date: !project.end_date || candidate <= project.end_date ? candidate : "",
        primary_pay_items: itemsJson(source.pay_items, "Primary"),
        helper_pay_items: itemsJson(source.pay_items, "Helper"),
      };
    }
  }
  if (entryId && (!row || Number(row.project_id) !== Number(projectId))) return html("Work entry not found", 404);
  if (entryId) {
    const lock = await workLock(env, row);
    if (lock || row.status !== "Draft") return redirect(`/projects/${projectId}?error=${encodeURIComponent(lock || "Only Draft work entries can be edited.")}`);
  }
  if (request.method === "GET") {
    return html(layout({ title: entryId ? "Edit Daily Work" : "New Daily Work", user, path, content: `${messages(new URL(request.url))}${await workForm(env, project, row, entryId)}` }));
  }
  const data = await parseForm(request);
  const values = workValues(data, project, row);
  if (!values.work_no && values.work_date) values.work_no = await nextWorkNumber(env, values.work_date);
  const primary = parseItems(data.primary_pay_items, "Primary");
  const helper = parseItems(data.helper_pay_items, "Helper");
  const payItems = [...primary.items.map((item) => ({ ...item, employee_type: "Primary" })), ...helper.items.map((item) => ({ ...item, employee_type: "Helper" }))];
  const errors = [...primary.errors, ...helper.errors, ...validateWork(values, project, project.helpers.length, payItems)];
  if (errors.length) {
    row = { ...row, ...data, ...values, primary_pay_items: data.primary_pay_items, helper_pay_items: data.helper_pay_items };
    return html(layout({ title: entryId ? "Edit Daily Work" : "New Daily Work", user, path, content: await workForm(env, project, row, entryId, errors) }), 400);
  }
  const action = data.after_save || "draft";
  if (action === "complete") values.status = "Completed";
  const workId = await saveWork(env, project, values, payItems, entryId);
  if (project.status === "Draft") await run(env, "UPDATE projects SET status='Active' WHERE id=?", [projectId]);
  if (action === "another") return redirect(`/projects/${projectId}/work/new?copy=${workId}&ok=${encodeURIComponent(`Work entry ${values.work_no} saved. Add the next work record.`)}`);
  const completed = action === "complete" ? `&completed_work=${workId}` : "";
  return redirect(`/projects/${projectId}?ok=${encodeURIComponent(`Work entry ${values.work_no} ${action === "complete" ? "saved and marked Completed" : "saved"}.`)}${completed}#work-${workId}`);
}

async function workLock(env, entry) {
  const [billing, payroll] = await Promise.all([
    first(env, "SELECT COUNT(*) AS total FROM billing_project_lines WHERE work_entry_id=?", [entry.id]),
    first(env, "SELECT COUNT(*) AS total FROM payroll_project_entries WHERE work_entry_id=?", [entry.id]),
  ]);
  const links = [];
  if (numeric(billing?.total)) links.push("Billing");
  if (numeric(payroll?.total)) links.push("Payroll");
  return links.length ? `This work entry is linked to ${links.join(" and ")} and is locked.` : "";
}

async function workStatusPage(request, env, user, path, projectId, entryId) {
  const access = requireEdit(user, PAGE);
  if (access) return fail(access, user, path);
  const entry = await loadWork(env, entryId);
  if (!entry || Number(entry.project_id) !== Number(projectId)) return html("Not found", 404);
  const lock = await workLock(env, entry);
  if (request.method === "GET") {
    const choicesMarkup = selectChoices("status", "New status", WORK_STATUSES, entry.status);
    const content = `<section class="panel status-update-form"><dl class="trip-status-summary"><dt>Work Entry</dt><dd>${esc(entry.work_no)}</dd><dt>Project</dt><dd>${esc(entry.project_no)}</dd><dt>Work date</dt><dd>${esc(entry.work_date)}</dd><dt>Quantity</dt><dd>${esc(`${entry.billing_quantity} ${entry.billing_unit}`)}</dd><dt>Current status</dt><dd>${badge(entry.status)}</dd></dl>${lock ? `<p class="status-warning">${esc(lock)}</p>` : `<form method="post">${choicesMarkup}<p class="status-warning">Completed work becomes eligible for Payroll and Billing. Confirm the quantities, rates, crew, and charges before completion.</p><div class="form-actions"><button>Update Status</button><a class="button secondary" href="/projects/${projectId}">Cancel</a></div></form>`}</section>`;
    return html(layout({ title: "Update Work Status", user, path, content }));
  }
  if (lock || entry.status === "Billed") return redirect(`/projects/${projectId}?error=${encodeURIComponent(lock || "Billed status is system-controlled.")}`);
  const data = await parseForm(request);
  if (!WORK_STATUSES.includes(data.status)) return redirect(`/projects/${projectId}?error=${encodeURIComponent("Invalid work status.")}`);
  await run(env, "UPDATE project_work_entries SET status=? WHERE id=?", [data.status, entryId]);
  const completed = data.status === "Completed" ? `&completed_work=${entryId}` : "";
  return redirect(`/projects/${projectId}?ok=${encodeURIComponent(`${entry.work_no} marked ${data.status}.`)}${completed}`);
}

async function workDeletePage(request, env, user, path, projectId, entryId) {
  const access = requireEdit(user, PAGE);
  if (access) return fail(access, user, path);
  if (request.method !== "POST") return html("Delete requires POST.", 405);
  const entry = await loadWork(env, entryId);
  if (!entry || Number(entry.project_id) !== Number(projectId)) return redirect(`/projects/${projectId}?error=Work%20entry%20not%20found.`);
  const lock = await workLock(env, entry);
  if (lock) return redirect(`/projects/${projectId}?error=${encodeURIComponent(lock)}`);
  await run(env, "DELETE FROM project_work_entries WHERE id=?", [entryId]);
  return redirect(`/projects/${projectId}?ok=${encodeURIComponent(`${entry.work_no} deleted.`)}`);
}

async function projectDetail(request, env, user, path, id) {
  const access = requireView(user, PAGE);
  if (access) return fail(access, user, path);
  const project = await loadProject(env, id);
  if (!project) return html("Not found", 404);
  const entries = await all(env, `SELECT w.*, (SELECT COUNT(*) FROM billing_project_lines bpl WHERE bpl.work_entry_id=w.id) AS billed_link, (SELECT COUNT(*) FROM payroll_project_entries ppe WHERE ppe.work_entry_id=w.id) AS payroll_links FROM project_work_entries w WHERE w.project_id=? ORDER BY w.work_date DESC,w.id DESC`, [id]);
  const url = new URL(request.url);
  const helperNames = project.helpers.map((helper) => helper.full_name).join(", ") || "None";
  const rows = entries.map((entry) => {
    const locked = numeric(entry.billed_link) || numeric(entry.payroll_links);
    const quick = canEdit(user, PAGE) && entry.status === "Draft"
      ? `<form method="post" action="/projects/${id}/work/${entry.id}/status" class="inline-status-form" onsubmit="return confirm('Mark this work entry Completed? It will become eligible for Payroll and Billing.');"><input type="hidden" name="status" value="Completed"><button class="status-action">Mark Complete</button></form>`
      : "";
    return `<tr id="work-${entry.id}"><td>${esc(entry.work_no)}</td><td>${esc(entry.work_date)}</td><td>${esc(entry.reference_no || "—")}</td><td>${esc(entry.billing_unit)}</td><td class="num">${esc(entry.billing_quantity)}</td>${moneyCell(entry.client_unit_rate)}${moneyCell(entry.extra_total)}${moneyCell(entry.total_charge)}<td>${badge(entry.status)}${quick}</td><td>${canEdit(user, PAGE) && entry.status === "Draft" && !locked ? `<a href="/projects/${id}/work/${entry.id}/edit">Edit</a> ` : ""}${canEdit(user, PAGE) && entry.status !== "Billed" && !locked ? `<a href="/projects/${id}/work/${entry.id}/status">Status</a>` : ""}</td></tr>`;
  });
  const hero = `<section class="panel detail-hero"><div><span class="dialog-kicker">Equipment Project</span><h3>${esc(project.project_no)}</h3><p>${esc(project.client_name || "")} · ${esc(project.start_date)}${project.end_date ? ` to ${esc(project.end_date)}` : " onward"}</p></div>${badge(project.status)}</section>`;
  const modeLabel = project.work_recording_mode === "Single" ? "Single Work Total" : "Repeating Daily Work";
  const details = `<div class="detail-grid"><section class="panel"><h3>Client &amp; Scope</h3><dl class="detail-list"><dt>Ref. No.</dt><dd>${esc(project.reference_no || "—")}</dd><dt>Item / Job</dt><dd>${esc(project.job_description)}</dd><dt>Location</dt><dd>${esc(project.project_location || "—")}</dd><dt>Route</dt><dd>${esc([project.origin, project.destination].filter(Boolean).join(" → ") || "—")}</dd></dl></section><section class="panel"><h3>Unit &amp; Crew</h3><dl class="detail-list"><dt>Asset</dt><dd>${esc([project.asset_code, project.plate_no, project.asset_type].filter(Boolean).join(", "))}</dd><dt>Primary</dt><dd>${esc([project.primary_code, project.primary_name, project.primary_type].filter(Boolean).join(", "))}</dd><dt>Helpers</dt><dd>${esc(helperNames)}</dd></dl></section><section class="panel"><h3>Work Recording</h3><dl class="detail-list"><dt>Mode</dt><dd>${esc(modeLabel)}</dd><dt>Default quantity</dt><dd>${esc(`${project.default_billing_quantity} ${project.billing_basis}`)}</dd><dt>Client unit rate</dt><dd>${esc(peso(project.client_unit_rate))}</dd><dt>Default extras</dt><dd>${esc(peso(projectExtraTotal(project)))}</dd></dl></section><section class="panel"><h3>Employee Pay Defaults</h3><dl class="detail-list"><dt>Primary</dt><dd>${esc(`${project.primary_pay_basis}, ${peso(project.primary_pay_rate)}`)}</dd><dt>Helper pool</dt><dd>${esc(`${project.helper_pay_basis}, ${peso(project.helper_pay_rate)}`)}</dd></dl></section></div>`;
  const noWork = entries.length === 0;
  const recordWork = canEdit(user, PAGE) && project.work_recording_mode === "Repeating" && ["Draft", "Active"].includes(project.status)
    ? `<a class="button" href="/projects/${id}/work/new">Record Daily Work</a>`
    : "";
  const duplicateLast = canEdit(user, PAGE) && project.work_recording_mode === "Repeating" && entries.length && ["Draft", "Active"].includes(project.status)
    ? `<a class="button secondary" href="/projects/${id}/work/new?copy=${entries[0].id}">Duplicate Last Entry</a>`
    : "";
  const completeSingle = canEdit(user, PAGE) && project.work_recording_mode === "Single" && noWork && ["Draft", "Active", "Completed"].includes(project.status)
    ? `<a class="button" href="/projects/${id}/complete">${project.status === "Completed" ? "Create Completed Work from Defaults" : "Complete Project &amp; Record Work"}</a>`
    : "";
  const legacySingle = canEdit(user, PAGE) && project.work_recording_mode === "Repeating" && noWork && project.status === "Completed"
    ? `<form method="post" action="/projects/${id}/use-single-work" class="inline-status-form" onsubmit="return confirm('Create one completed work record from this Project defaults?');"><button class="button">Create Completed Work from Defaults</button></form>`
    : "";
  const closeRepeating = canEdit(user, PAGE) && project.work_recording_mode === "Repeating" && ["Draft", "Active"].includes(project.status)
    ? `<form method="post" action="/projects/${id}/close" class="inline-status-form" onsubmit="return confirm('Complete this Project after all Daily Work entries are completed or cancelled?');"><button class="button secondary">Complete Project</button></form>`
    : "";
  const toolbar = `<div class="detail-toolbar project-detail-toolbar"><a class="button secondary" href="/projects">← Projects List</a><div class="toolbar-actions">${canEdit(user, PAGE) ? `<a class="button secondary" href="/projects/${id}/edit">Edit Project</a>${completeSingle}${legacySingle}${recordWork}${duplicateLast}${closeRepeating}` : ""}</div></div>
    <section class="panel project-print-filter"><form method="get" action="/projects/${id}/print" target="_blank"><label>Date From<input type="date" name="date_from" value="${esc(project.start_date)}"></label><label>Date To<input type="date" name="date_to" value="${esc(project.end_date || todayISO())}"></label><button class="button secondary">Print Project Summary</button></form></section>`;
  const emptyWork = project.work_recording_mode === "Single"
    ? `<div class="empty-state project-work-empty"><h4>No work record created yet</h4><p>This Single Work Total project has one financial work record. Complete the Project to create it from the defaults shown above.</p>${completeSingle}</div>`
    : legacySingle
      ? `<div class="empty-state project-work-empty"><h4>No work record was created</h4><p>This older Project was marked completed without a work entry, so it is not available to Billing or Payroll. Create one completed work record from its saved defaults, or edit the Project to use repeating work.</p>${legacySingle}</div>`
      : `<div class="empty-state project-work-empty"><h4>No daily work recorded</h4><p>Project values are reusable defaults only. They are not included in Billing or Payroll until you record actual daily work and mark that entry Completed.</p>${recordWork}<p class="muted">You may record multiple entries for different dates, shifts, trips, hours, or days.</p></div>`;
  const work = `<section class="panel"><div class="section-header"><h3>Daily Work Entries</h3><span>${entries.length} entries</span></div>${noWork ? emptyWork : table(["Work No.", "Date", "Ref. No.", "Unit", "Quantity", "Rate", "Extras", "Total", "Status", "Actions"], rows, { bare: true })}</section>`;
  const danger = canEdit(user, PAGE) ? `<section class="detail-danger"><form method="post" action="/projects/${id}/delete" onsubmit="return confirm('Delete this project? Projects with work entries cannot be deleted.');"><button class="danger-button">Delete Project</button></form></section>` : "";
  const completedEntry = entries.find((entry) => Number(entry.id) === Number(url.searchParams.get("completed_work")));
  if (completedEntry) completedEntry.helpers = await all(env, "SELECT wh.*, e.full_name FROM project_work_helpers wh LEFT JOIN employees e ON e.id=wh.employee_id WHERE wh.work_entry_id=? ORDER BY wh.helper_order", [completedEntry.id]);
  return html(layout({ title: "Project Details", user, path, content: `${messages(url)}${toolbar}${hero}${details}${project.notes ? `<section class="panel"><h3>Notes</h3><p>${esc(project.notes)}</p></section>` : ""}${financeActions(project, completedEntry, user)}${work}${danger}` }));
}

async function projectDelete(request, env, user, path, id) {
  const access = requireEdit(user, PAGE);
  if (access) return fail(access, user, path);
  if (request.method !== "POST") return html("Delete requires POST.", 405);
  const project = await loadProject(env, id);
  if (!project) return redirect("/projects?error=Project%20not%20found.");
  const count = await first(env, "SELECT COUNT(*) AS total FROM project_work_entries WHERE project_id=?", [id]);
  if (numeric(count?.total)) return redirect(`/projects/${id}?error=${encodeURIComponent("Projects with daily work entries cannot be deleted. Complete or cancel the project instead.")}`);
  await run(env, "DELETE FROM projects WHERE id=?", [id]);
  return redirect(`/projects?ok=${encodeURIComponent(`${project.project_no} deleted.`)}`);
}

async function projectReopenAndRecordWork(request, env, user, path, id) {
  const access = requireEdit(user, PAGE);
  if (access) return fail(access, user, path);
  if (request.method !== "POST") return html("Reopen requires POST.", 405);
  const project = await loadProject(env, id);
  if (!project) return redirect("/projects?error=Project%20not%20found.");
  const count = await first(env, "SELECT COUNT(*) AS total FROM project_work_entries WHERE project_id=?", [id]);
  if (project.status !== "Completed" || numeric(count?.total)) {
    return redirect(`/projects/${id}?error=${encodeURIComponent("Only completed projects with no daily work entries can be reopened this way.")}`);
  }
  await run(env, "UPDATE projects SET status='Active' WHERE id=?", [id]);
  return redirect(`/projects/${id}/work/new?ok=${encodeURIComponent("Project reopened as Active. Record the actual daily work before Billing or Payroll.")}`);
}

async function projectExport(request, env, user, path) {
  const access = requireView(user, PAGE);
  if (access) return fail(access, user, path);
  const url = new URL(request.url);
  const query = String(url.searchParams.get("q") || "").trim();
  const status = PROJECT_STATUSES.includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "";
  const clientId = Number(url.searchParams.get("client_id")) || 0;
  const assetId = Number(url.searchParams.get("asset_id")) || 0;
  const billingBasis = BASES.includes(url.searchParams.get("billing_basis")) ? url.searchParams.get("billing_basis") : "";
  const dateFrom = String(url.searchParams.get("start_date_from") || "");
  const dateTo = String(url.searchParams.get("start_date_to") || "");
  const clauses = [];
  const params = [];
  if (query) {
    clauses.push("(p.project_no LIKE ? OR p.reference_no LIKE ? OR p.job_description LIKE ? OR c.client_name LIKE ? OR a.asset_code LIKE ? OR e.full_name LIKE ?)");
    params.push(...Array(6).fill(`%${query}%`));
  }
  if (PROJECT_STATUSES.includes(status)) {
    clauses.push("p.status=?");
    params.push(status);
  }
  if (clientId) { clauses.push("p.client_id=?"); params.push(clientId); }
  if (assetId) { clauses.push("p.asset_id=?"); params.push(assetId); }
  if (billingBasis) { clauses.push("p.billing_basis=?"); params.push(billingBasis); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) { clauses.push("p.start_date>=?"); params.push(dateFrom); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) { clauses.push("p.start_date<=?"); params.push(dateTo); }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const sorts = { project_no: { sql: "p.project_no" }, client: { sql: "c.client_name" }, item_job: { sql: "p.job_description" }, start_date: { sql: "p.start_date" }, asset: { sql: "a.asset_code" }, primary: { sql: "e.full_name" }, billing_basis: { sql: "p.billing_basis" }, entries: { sql: "work_count" }, status: { sql: "p.status" } };
  const sort = listSort(url, sorts, "start_date");
  const rows = await all(env, `SELECT p.*,c.client_name,a.asset_code,e.full_name AS primary_name,(SELECT COUNT(*) FROM project_work_entries w WHERE w.project_id=p.id) AS work_count,(SELECT COALESCE(SUM(w.total_charge),0) FROM project_work_entries w WHERE w.project_id=p.id AND w.status IN ('Completed','Billed')) AS completed_total FROM projects p LEFT JOIN clients c ON c.id=p.client_id LEFT JOIN assets a ON a.id=p.asset_id LEFT JOIN employees e ON e.id=p.primary_employee_id${where} ORDER BY ${sort.order},p.id DESC`, params);
  const lines = [csvRow(["ID", "Project No.", "Ref. No.", "Start Date", "End Date", "Client", "Item / Job", "Route / Location", "Asset", "Primary Employee", "Billing Basis", "Default Quantity", "Client Rate", "Status", "Work Entries", "Completed Work Total"])];
  for (const row of rows) lines.push(csvRow([row.id, row.project_no, row.reference_no, row.start_date, row.end_date, row.client_name, row.job_description, row.project_location || `${row.origin || ""} -> ${row.destination || ""}`, row.asset_code, row.primary_name, row.billing_basis, row.default_billing_quantity, row.client_unit_rate, row.status, row.work_count, row.completed_total]));
  return csv(lines.join("\n"), "projects.csv");
}

async function settings(env) {
  const rows = await all(env, "SELECT setting_key,setting_value FROM system_settings");
  return Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
}

function printCompany(config) {
  return `<div class="project-print-brand">${config.company_logo_data_url ? `<img src="${esc(config.company_logo_data_url)}" alt="">` : ""}<div><h1>${esc(config.company_name || "GMT Trucking")}</h1><p>${esc(config.company_address || "")}</p><p>${esc([config.company_contact_no, config.company_email].filter(Boolean).join(" · "))}</p></div></div>`;
}

async function projectPrint(request, env, user, path, id) {
  const access = requireView(user, PAGE);
  if (access) return fail(access, user, path);
  const project = await loadProject(env, id);
  if (!project) return html("Not found", 404);
  const url = new URL(request.url);
  const dateFrom = url.searchParams.get("date_from") || project.start_date;
  const dateTo = url.searchParams.get("date_to") || project.end_date || todayISO();
  if (dateFrom > dateTo) return html("Project Summary end date must be on or after its start date.", 400);
  const entries = await all(env, `SELECT * FROM project_work_entries WHERE project_id=? AND work_date BETWEEN ? AND ? AND status IN ('Completed','Billed') ORDER BY work_date,id`, [id, dateFrom, dateTo]);
  const totals = entries.reduce((result, row) => ({ quantity: result.quantity + numeric(row.billing_quantity), base: result.base + numeric(row.base_charge), extras: result.extras + numeric(row.extra_total), total: result.total + numeric(row.total_charge) }), { quantity: 0, base: 0, extras: 0, total: 0 });
  const rows = entries.map((row) => `<tr><td>${esc(row.work_date)}</td><td>${esc(row.work_no)}</td><td>${esc(row.reference_no || "—")}</td><td>${esc(row.billing_unit)}</td><td class="num">${esc(row.billing_quantity)}</td><td class="num">${esc(peso(row.client_unit_rate))}</td><td class="num">${esc(peso(row.base_charge))}</td><td class="num">${esc(peso(row.extra_total))}</td><td class="num">${esc(peso(row.total_charge))}</td></tr>`).join("") || `<tr><td colspan="9">No completed work in this date range.</td></tr>`;
  const config = await settings(env);
  return html(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(project.project_no)} Project Summary</title><style>@page{size:A4 landscape;margin:10mm}body{font:11px Arial,sans-serif;color:#111;margin:0}.print-button{margin-bottom:8px}h1,h2,p{margin:0 0 4px}.project-print-brand{display:flex;gap:12px;align-items:center}.project-print-brand img{max-width:92px;max-height:60px}.header{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:10px}.meta{text-align:right}table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #333;padding:5px;vertical-align:top}th{background:#eee}.num{text-align:right;font-variant-numeric:tabular-nums}.signatures{display:grid;grid-template-columns:repeat(3,1fr);gap:45px;margin-top:55px}.signatures div{border-top:1px solid #111;text-align:center;padding-top:5px}@media print{.print-button{display:none}}</style></head><body><button class="print-button" onclick="window.print()">Print</button><div class="header">${printCompany(config)}<div class="meta"><h2>Equipment Project Work Summary</h2><strong>${esc(project.project_no)}</strong><br>${esc(dateFrom)} to ${esc(dateTo)}</div></div><table><tr><th>Client</th><td>${esc(project.client_name || "")}</td><th>Item / Job</th><td>${esc(project.job_description)}</td><th>Asset</th><td>${esc([project.asset_code, project.plate_no].filter(Boolean).join(", "))}</td></tr><tr><th>Route / Location</th><td colspan="3">${esc(project.project_location || [project.origin, project.destination].filter(Boolean).join(" → ") || "—")}</td><th>Primary</th><td>${esc(project.primary_name || "")}</td></tr></table><table><thead><tr><th>Work Date</th><th>Work No.</th><th>Ref. No.</th><th>Unit</th><th class="num">Quantity</th><th class="num">Rate</th><th class="num">Base</th><th class="num">Extras</th><th class="num">Total</th></tr></thead><tbody>${rows}<tr><th colspan="4">Totals</th><th class="num">${esc(totals.quantity)}</th><th></th><th class="num">${esc(peso(totals.base))}</th><th class="num">${esc(peso(totals.extras))}</th><th class="num">${esc(peso(totals.total))}</th></tr></tbody></table><div class="signatures"><div>Prepared by</div><div>Checked by</div><div>Client / Conforme</div></div></body></html>`);
}

export async function handleProjects({ request, env, user, path }) {
  let match;
  if (path === "/projects") return projectList(request, env, user, path);
  if (path === "/projects/new") return projectFormPage(request, env, user, path);
  if (path === "/projects/export.csv") return projectExport(request, env, user, path);
  match = path.match(/^\/projects\/(\d+)\/print$/);
  if (match) return projectPrint(request, env, user, path, Number(match[1]));
  match = path.match(/^\/projects\/(\d+)\/complete$/);
  if (match) return projectCompletePage(request, env, user, path, Number(match[1]));
  match = path.match(/^\/projects\/(\d+)\/close$/);
  if (match) return projectCloseRepeating(request, env, user, path, Number(match[1]));
  match = path.match(/^\/projects\/(\d+)\/use-single-work$/);
  if (match) return projectUseSingleWork(request, env, user, path, Number(match[1]));
  match = path.match(/^\/projects\/(\d+)\/edit$/);
  if (match) return projectFormPage(request, env, user, path, Number(match[1]));
  match = path.match(/^\/projects\/(\d+)\/delete$/);
  if (match) return projectDelete(request, env, user, path, Number(match[1]));
  match = path.match(/^\/projects\/(\d+)\/reopen-and-record-work$/);
  if (match) return projectReopenAndRecordWork(request, env, user, path, Number(match[1]));
  match = path.match(/^\/projects\/(\d+)\/work\/new$/);
  if (match) return workFormPage(request, env, user, path, Number(match[1]));
  match = path.match(/^\/projects\/(\d+)\/work\/(\d+)\/edit$/);
  if (match) return workFormPage(request, env, user, path, Number(match[1]), Number(match[2]));
  match = path.match(/^\/projects\/(\d+)\/work\/(\d+)\/status$/);
  if (match) return workStatusPage(request, env, user, path, Number(match[1]), Number(match[2]));
  match = path.match(/^\/projects\/(\d+)\/work\/(\d+)\/delete$/);
  if (match) return workDeletePage(request, env, user, path, Number(match[1]), Number(match[2]));
  match = path.match(/^\/projects\/(\d+)$/);
  if (match) return projectDetail(request, env, user, path, Number(match[1]));
  return null;
}
