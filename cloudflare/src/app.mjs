import { canEdit, requireEdit, requireView } from "./access.mjs";
import { createSession, clearSessionHeaders, readSession, sessionHeaders, verifyPassword } from "./auth.mjs";
import { all, dashboard, first, run } from "./db.mjs";
import { cards, formPanel, layout, loginPage, moneyCell, numberInput, selectInput, table, textareaInput, textInput } from "./html.mjs";
import { EXTRA_FIELDS, HELPER_LIMITS, choiceLabel, nextTripTicketNo, tripBillableTotal, tripExtraTotal } from "./services.mjs";
import { csv, esc, html, json, money, parseForm, peso, redirect, todayISO } from "./utils.mjs";

const MASTER = {
  "/employees": {
    page: "Employees",
    table: "employees",
    title: "Employees",
    order: "full_name, id",
    search: ["employee_code", "full_name", "contact_no"],
    columns: ["employee_code", "full_name", "employee_type", "payroll_basis", "employment_status"],
    labels: ["Code", "Name", "Type", "Basis", "Status"],
    required: ["full_name", "employee_type"],
    unique: ["employee_code"],
    numeric: ["daily_rate", "trip_rate"],
    defaults: { employment_status: "Active", payroll_basis: "Per Trip", daily_rate: 0, trip_rate: 0 },
    deleteRefs: [
      ["assets", "assigned_employee_id", "assigned fleet/equipment"],
      ["recurring_trip_masters", "default_driver_id", "recurring trips"],
      ["trips", "driver_id", "trips"],
      ["trip_helpers", "employee_id", "trip helper assignments"],
      ["vale_records", "employee_id", "vale records"],
      ["cash_advances", "employee_id", "cash advances"],
      ["payroll_entries", "employee_id", "payroll entries"],
      ["payroll_trips", "employee_id", "payroll trip claims"],
    ],
    fields: [
      ["employee_code", "Employee code"], ["full_name", "Full name"], ["employee_type", "Employee type"],
      ["contact_no", "Contact no"], ["employment_status", "Employment status"], ["payroll_basis", "Payroll basis"],
      ["daily_rate", "Daily rate", "number"], ["trip_rate", "Trip rate", "number"], ["notes", "Notes"],
    ],
  },
  "/fleet": {
    page: "Fleet / Equipment",
    table: "assets",
    title: "Fleet / Equipment",
    order: "asset_code, id",
    search: ["asset_code", "plate_no", "make_model"],
    columns: ["asset_code", "asset_type", "plate_no", "make_model", "status"],
    labels: ["Code", "Type", "Plate", "Model", "Status"],
    required: ["asset_code", "asset_type"],
    unique: ["asset_code"],
    defaults: { status: "Available" },
    deleteRefs: [
      ["recurring_trip_masters", "default_asset_id", "recurring trips"],
      ["trips", "asset_id", "trips"],
      ["repairs", "asset_id", "repairs"],
    ],
    fields: [
      ["asset_code", "Asset code"], ["asset_type", "Asset type"], ["plate_no", "Plate no"],
      ["make_model", "Make/model"], ["capacity_desc", "Capacity"], ["status", "Status"], ["notes", "Notes"],
    ],
  },
  "/clients": {
    page: "Clients",
    table: "clients",
    title: "Clients",
    order: "client_name, id",
    search: ["client_code", "client_name", "contact_person", "contact_no"],
    columns: ["client_code", "client_name", "contact_person", "contact_no", "terms_days"],
    labels: ["Code", "Client", "Contact", "Phone", "Terms"],
    required: ["client_name"],
    unique: ["client_code", "client_name"],
    numeric: ["terms_days"],
    defaults: { terms_days: 30 },
    deleteRefs: [
      ["recurring_trip_masters", "client_id", "recurring trips"],
      ["trips", "client_id", "trips"],
      ["billing_statements", "client_id", "billing statements"],
      ["collections", "client_id", "collections"],
    ],
    fields: [
      ["client_code", "Client code"], ["client_name", "Client name"], ["billing_address", "Billing address"],
      ["contact_person", "Contact person"], ["contact_no", "Contact no"], ["terms_days", "Terms days", "number"], ["notes", "Notes"],
    ],
  },
  "/suppliers": {
    page: "Suppliers",
    table: "suppliers",
    title: "Suppliers",
    order: "supplier_name, id",
    search: ["supplier_name", "contact_person", "contact_no", "address"],
    columns: ["supplier_name", "contact_person", "contact_no", "address"],
    labels: ["Supplier", "Contact", "Phone", "Address"],
    required: ["supplier_name"],
    unique: ["supplier_name"],
    deleteRefs: [
      ["repairs", "supplier_id", "repairs"],
      ["payables", "supplier_id", "payables"],
    ],
    fields: [
      ["supplier_name", "Supplier name"], ["contact_person", "Contact person"],
      ["contact_no", "Contact no"], ["address", "Address"], ["notes", "Notes"],
    ],
  },
};

function errorResponse(error, user, path = "/") {
  if (error?.redirect) return redirect(error.redirect);
  return html(layout({ title: "Forbidden", user, path, content: `<section class="panel"><p class="error">${esc(error?.message || "Forbidden")}</p></section>` }), error?.status || 403);
}

async function login(request, env) {
  if (request.method === "GET") return html(loginPage());
  const data = await parseForm(request);
  let user;
  try {
    user = await first(env, "SELECT * FROM users WHERE username=? AND active=1", [data.username || ""]);
  } catch (error) {
    if (String(error?.message || error).toLowerCase().includes("users")) {
      return html(loginPage("Database is not initialized yet. Run the D1 setup SQL scripts first."), 503);
    }
    throw error;
  }
  if (!user || !(await verifyPassword(data.password || "", user.password_hash))) {
    return html(loginPage("Invalid username or password."), 401);
  }
  const token = await createSession(user, env.GMT_SESSION_SECRET || "development-secret");
  return redirectWithHeaders("/", sessionHeaders(token));
}

function redirectWithHeaders(location, headers) {
  return new Response(null, { status: 303, headers: { Location: location, ...headers } });
}

async function dashboardPage(env, user, path) {
  const data = await dashboard(env);
  const content = `<section class="panel">${cards([
    ["Trips", data.trips],
    ["Ongoing", data.ongoing],
    ["Completed", data.completed],
    ["Employees", data.employees],
  ])}</section><section class="panel"><h3>Receivables</h3><p><strong>${esc(peso(data.receivables))}</strong></p><p>This is the Cloudflare rewrite foundation. Django remains the parity reference while modules are ported.</p></section>`;
  return html(layout({ title: "Dashboard", user, path, content }));
}

function predicate(spec, query) {
  if (!query) return { sql: "", params: [] };
  return {
    sql: ` WHERE ${spec.search.map((field) => `${field} LIKE ?`).join(" OR ")}`,
    params: spec.search.map(() => `%${query}%`),
  };
}

function masterValues(spec, data) {
  const values = {};
  for (const [name] of spec.fields) {
    let value = (data[name] ?? spec.defaults?.[name] ?? "").toString().trim();
    if (spec.numeric?.includes(name)) value = String(Number(value || 0));
    values[name] = value;
  }
  return values;
}

function messagePanel(url) {
  const ok = url.searchParams.get("ok");
  const error = url.searchParams.get("error");
  if (!ok && !error) return "";
  return `<section class="panel"><p class="${error ? "error" : "success"}">${esc(error || ok)}</p></section>`;
}

function pagination(base, query, page, total) {
  const pages = Math.max(1, Math.ceil(total / 25));
  if (pages <= 1) return `<p class="muted">Page 1 of 1</p>`;
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const link = (target, label, disabled = false) => {
    params.set("page", String(target));
    return disabled ? `<span class="button secondary disabled">${esc(label)}</span>` : `<a class="button secondary" href="${base}?${params.toString()}">${esc(label)}</a>`;
  };
  return `<div class="pagination">${link(Math.max(1, page - 1), "Previous", page <= 1)}<span>Page ${page} of ${pages}</span>${link(Math.min(pages, page + 1), "Next", page >= pages)}</div>`;
}

function paginationWithParams(base, params, page, total) {
  const pages = Math.max(1, Math.ceil(total / 25));
  if (pages <= 1) return `<p class="muted">Page 1 of 1</p>`;
  const link = (target, label, disabled = false) => {
    const next = new URLSearchParams(params);
    next.set("page", String(target));
    return disabled ? `<span class="button secondary disabled">${esc(label)}</span>` : `<a class="button secondary" href="${esc(`${base}?${next.toString()}`)}">${esc(label)}</a>`;
  };
  return `<div class="pagination">${link(Math.max(1, page - 1), "Previous", page <= 1)}<span>Page ${page} of ${pages}</span>${link(Math.min(pages, page + 1), "Next", page >= pages)}</div>`;
}

function paginationWithPageParam(base, params, pageParam, page, total) {
  const pages = Math.max(1, Math.ceil(total / 25));
  if (pages <= 1) return `<p class="muted">Page 1 of 1</p>`;
  const link = (target, label, disabled = false) => {
    const next = new URLSearchParams(params);
    next.set(pageParam, String(target));
    return disabled ? `<span class="button secondary disabled">${esc(label)}</span>` : `<a class="button secondary" href="${esc(`${base}?${next.toString()}`)}">${esc(label)}</a>`;
  };
  return `<div class="pagination">${link(Math.max(1, page - 1), "Previous", page <= 1)}<span>Page ${page} of ${pages}</span>${link(Math.min(pages, page + 1), "Next", page >= pages)}</div>`;
}

async function validateMaster(env, spec, values, id = null) {
  const errors = [];
  for (const field of spec.required || []) {
    if (!values[field]) errors.push(`${field.replaceAll("_", " ")} is required.`);
  }
  for (const field of spec.unique || []) {
    if (!values[field]) continue;
    const params = id ? [values[field], id] : [values[field]];
    const row = await first(env, `SELECT id FROM ${spec.table} WHERE ${field}=?${id ? " AND id<>?" : ""} LIMIT 1`, params);
    if (row) errors.push(`${field.replaceAll("_", " ")} must be unique.`);
  }
  return errors;
}

function renderMasterForm(user, path, spec, row, id, errors = []) {
  const fields = spec.fields.map(([name, label, kind]) => kind === "number" ? numberInput(name, label, row[name] ?? spec.defaults?.[name] ?? 0) : textInput(name, label, row[name] ?? spec.defaults?.[name] ?? ""));
  const deleteForm = id ? `<form method="post" action="${path}/${id}/delete" class="delete-form" onsubmit="return confirm('Delete this ${esc(spec.title)} record? This is blocked when related records exist.');"><button class="danger">Delete</button><span class="muted">Deletion is guarded when this record is used by trips, billing, payroll, or related records.</span></form>` : "";
  const errorBox = errors.length ? `<section class="panel"><ul class="error">${errors.map((err) => `<li>${esc(err)}</li>`).join("")}</ul></section>` : "";
  return `${errorBox}${formPanel(id ? `${path}/${id}/edit` : `${path}/new`, fields, "Save")}${deleteForm}`;
}

async function masterList(request, env, user, path, spec) {
  const access = requireView(user, spec.page);
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const offset = (page - 1) * 25;
  const where = predicate(spec, query);
  const countRow = await first(env, `SELECT COUNT(*) AS total FROM ${spec.table}${where.sql}`, where.params);
  const rows = await all(env, `SELECT * FROM ${spec.table}${where.sql} ORDER BY ${spec.order} LIMIT 25 OFFSET ?`, [...where.params, offset]);
  const bodyRows = rows.map((row) => `<tr>${spec.columns.map((col, index) => index === 0 ? `<td>${canEdit(user, spec.page) ? `<a href="${path}/${row.id}/edit">${esc(row[col])}</a>` : esc(row[col])}</td>` : `<td>${esc(row[col])}</td>`).join("")}<td>${canEdit(user, spec.page) ? `<a href="${path}/${row.id}/edit">Edit</a>` : ""}</td></tr>`);
  const exportParams = new URLSearchParams();
  if (query) exportParams.set("q", query);
  const toolbar = `<div class="toolbar"><form><input name="q" value="${esc(query)}" placeholder="Search ${esc(spec.title)}"><button>Search</button></form><div>${canEdit(user, spec.page) ? `<a class="button" href="${path}/new">New Record</a>` : ""} <a class="button secondary" href="${path}/export.csv${exportParams.toString() ? `?${exportParams.toString()}` : ""}">Export CSV</a></div></div>`;
  const content = `${messagePanel(url)}<section class="panel">${toolbar}</section>${table([...spec.labels, "Actions"], bodyRows, { empty: `No ${spec.title.toLowerCase()} found.` })}${pagination(path, query, page, Number(countRow?.total || 0))}`;
  return html(layout({ title: spec.title, user, path, content }));
}

async function masterForm(request, env, user, path, spec, id = null) {
  const access = requireEdit(user, spec.page);
  if (access) return errorResponse(access, user, path);
  const row = id ? await first(env, `SELECT * FROM ${spec.table} WHERE id=?`, [id]) : {};
  if (id && !row) return html("Not found", 404);
  if (request.method === "POST") {
    const data = await parseForm(request);
    const valuesByField = masterValues(spec, data);
    const errors = await validateMaster(env, spec, valuesByField, id);
    if (errors.length) return html(layout({ title: `${id ? "Edit" : "New"} ${spec.title}`, user, path, content: renderMasterForm(user, path, spec, valuesByField, id, errors) }), 400);
    const fields = spec.fields.map(([name]) => name);
    const values = fields.map((name) => valuesByField[name]);
    if (id) {
      try {
        await run(env, `UPDATE ${spec.table} SET ${fields.map((field) => `${field}=?`).join(", ")} WHERE id=?`, [...values, id]);
      } catch (error) {
        return html(layout({ title: `Edit ${spec.title}`, user, path, content: renderMasterForm(user, path, spec, valuesByField, id, [`Could not save record: ${error.message || error}`]) }), 400);
      }
      return redirect(`${path}?ok=${encodeURIComponent(`${spec.title} updated.`)}`);
    } else {
      try {
        await run(env, `INSERT INTO ${spec.table} (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`, values);
      } catch (error) {
        return html(layout({ title: `New ${spec.title}`, user, path, content: renderMasterForm(user, path, spec, valuesByField, id, [`Could not save record: ${error.message || error}`]) }), 400);
      }
      return redirect(`${path}?ok=${encodeURIComponent(`${spec.title} created.`)}`);
    }
  }
  return html(layout({ title: `${id ? "Edit" : "New"} ${spec.title}`, user, path, content: renderMasterForm(user, path, spec, row, id) }));
}

async function masterDelete(request, env, user, path, spec, id) {
  const access = requireEdit(user, spec.page);
  if (access) return errorResponse(access, user, path);
  if (request.method !== "POST") return html(layout({ title: "Method Not Allowed", user, path, content: `<section class="panel"><p class="error">Delete requires POST.</p></section>` }), 405);
  const row = await first(env, `SELECT id FROM ${spec.table} WHERE id=?`, [id]);
  if (!row) return redirect(`${path}?error=${encodeURIComponent("Record not found.")}`);
  for (const [tableName, field, label] of spec.deleteRefs || []) {
    const ref = await first(env, `SELECT COUNT(*) AS total FROM ${tableName} WHERE ${field}=?`, [id]);
    if (Number(ref?.total || 0) > 0) {
      return redirect(`${path}?error=${encodeURIComponent(`Cannot delete because this record is used by ${label}.`)}`);
    }
  }
  await run(env, `DELETE FROM ${spec.table} WHERE id=?`, [id]);
  return redirect(`${path}?ok=${encodeURIComponent(`${spec.title} deleted.`)}`);
}

async function masterExport(request, env, user, path, spec) {
  const access = requireView(user, spec.page);
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const where = predicate(spec, query);
  const rows = await all(env, `SELECT ${spec.columns.join(", ")} FROM ${spec.table}${where.sql} ORDER BY ${spec.order}`, where.params);
  const lines = [spec.labels.join(",")];
  for (const row of rows) lines.push(spec.columns.map((col) => `"${String(row[col] ?? "").replaceAll('"', '""')}"`).join(","));
  return csv(lines.join("\n"), `${spec.table}.csv`);
}

async function recurringList(env, user, path) {
  const access = requireView(user, "Recurring Trips");
  if (access) return errorResponse(access, user, path);
  const rows = await all(env, `SELECT r.*, c.client_name, a.asset_code, e.full_name AS driver_name FROM recurring_trip_masters r LEFT JOIN clients c ON c.id=r.client_id LEFT JOIN assets a ON a.id=r.default_asset_id LEFT JOIN employees e ON e.id=r.default_driver_id ORDER BY r.master_code, r.id`);
  const body = rows.map((r) => `<tr><td>${esc(r.master_code)}</td><td>${esc(r.client_name)}</td><td>${esc(r.origin)} → ${esc(r.destination)}</td><td>${esc(r.asset_code)}</td><td>${esc(r.driver_name)}</td><td class="num">${money(r.standard_base_rate)}</td></tr>`);
  return html(layout({ title: "Recurring Trips", user, path, content: table(["Code", "Client", "Route", "Asset", "Driver", "Base Rate"], body) }));
}

function recurringWhere(query) {
  if (!query) return { sql: "", params: [] };
  return {
    sql: " WHERE r.master_code LIKE ? OR c.client_name LIKE ? OR r.job_description LIKE ? OR r.origin LIKE ? OR r.destination LIKE ?",
    params: Array(5).fill(`%${query}%`),
  };
}

function recurringValues(data) {
  return {
    master_code: (data.master_code || "").trim(),
    client_id: data.client_id || null,
    job_description: (data.job_description || "").trim(),
    origin: (data.origin || "").trim(),
    destination: (data.destination || "").trim(),
    default_asset_id: data.default_asset_id || null,
    default_driver_id: data.default_driver_id || null,
    default_helper_count: String(Number(data.default_helper_count || 0)),
    standard_base_rate: String(Number(data.standard_base_rate || 0)),
    driver_pay_rate: String(Number(data.driver_pay_rate || 0)),
    helper_pay_rate: String(Number(data.helper_pay_rate || 0)),
    default_extra_note: (data.default_extra_note || "").trim(),
    remarks: (data.remarks || "").trim(),
    active: data.active === "0" ? "0" : "1",
  };
}

async function validateRecurring(env, values, id = null) {
  const errors = [];
  if (!values.master_code) errors.push("master code is required.");
  if (Number(values.default_helper_count || 0) > 10) errors.push("Default helper count cannot exceed 10.");
  if (values.master_code) {
    const params = id ? [values.master_code, id] : [values.master_code];
    const duplicate = await first(env, `SELECT id FROM recurring_trip_masters WHERE master_code=?${id ? " AND id<>?" : ""} LIMIT 1`, params);
    if (duplicate) errors.push("master code must be unique.");
  }
  return errors;
}

async function recurringChoices(env) {
  return await Promise.all([
    all(env, "SELECT * FROM clients WHERE active=1 ORDER BY client_name"),
    all(env, "SELECT * FROM assets ORDER BY asset_code"),
    all(env, "SELECT * FROM employees WHERE active=1 AND employee_type='Driver' ORDER BY full_name"),
  ]);
}

async function renderRecurringForm(env, row = {}, id = null, errors = []) {
  const [clients, assets, drivers] = await recurringChoices(env);
  const fields = [
    textInput("master_code", "Code", row.master_code || "", "required"),
    selectInput("client_id", "Client", clients, row.client_id || "", (r) => choiceLabel("client", r)),
    textareaInput("job_description", "Item / Job", row.job_description || "", 'rows="2"'),
    textInput("origin", "Origin", row.origin || ""),
    textInput("destination", "Destination", row.destination || ""),
    selectInput("default_asset_id", "Default asset", assets, row.default_asset_id || "", (r) => choiceLabel("asset", r)),
    selectInput("default_driver_id", "Default driver", drivers, row.default_driver_id || "", (r) => choiceLabel("employee", r)),
    numberInput("default_helper_count", "Default helper count", row.default_helper_count ?? 0),
    numberInput("standard_base_rate", "Base rate", row.standard_base_rate ?? 0),
    numberInput("driver_pay_rate", "Driver pay", row.driver_pay_rate ?? 0),
    numberInput("helper_pay_rate", "Helper pay", row.helper_pay_rate ?? 0),
    textareaInput("default_extra_note", "Default extra note", row.default_extra_note || "", 'rows="2"'),
    textareaInput("remarks", "Remarks", row.remarks || "", 'rows="2"'),
    selectInput("active", "Active", [{ id: "1", name: "Active" }, { id: "0", name: "Inactive" }], row.active ?? "1", (r) => r.name, ""),
  ];
  const errorBox = errors.length ? `<section class="panel"><ul class="error">${errors.map((err) => `<li>${esc(err)}</li>`).join("")}</ul></section>` : "";
  const deleteForm = id ? `<form method="post" action="/recurring-trips/${id}/delete" class="delete-form" onsubmit="return confirm('Delete this recurring template? Existing trips will be kept.');"><button class="danger">Delete</button><span class="muted">Existing trips keep their copied details; only the optional recurring-template link is cleared.</span></form>` : "";
  return `${errorBox}${formPanel(id ? `/recurring-trips/${id}/edit` : "/recurring-trips/new", fields, "Save Template")}${deleteForm}`;
}

async function recurringListPage(request, env, user, path) {
  const access = requireView(user, "Recurring Trips");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const where = recurringWhere(query);
  const countRow = await first(env, `SELECT COUNT(*) AS total FROM recurring_trip_masters r LEFT JOIN clients c ON c.id=r.client_id${where.sql}`, where.params);
  const rows = await all(env, `SELECT r.*, c.client_name, a.asset_code, e.full_name AS driver_name FROM recurring_trip_masters r LEFT JOIN clients c ON c.id=r.client_id LEFT JOIN assets a ON a.id=r.default_asset_id LEFT JOIN employees e ON e.id=r.default_driver_id${where.sql} ORDER BY r.master_code, r.id LIMIT 25 OFFSET ?`, [...where.params, (page - 1) * 25]);
  const body = rows.map((r) => `<tr><td>${canEdit(user, "Recurring Trips") ? `<a href="/recurring-trips/${r.id}/edit">${esc(r.master_code)}</a>` : esc(r.master_code)}</td><td>${esc(r.client_name || "")}</td><td>${esc(r.origin)} â†’ ${esc(r.destination)}</td><td>${esc(r.asset_code || "")}</td><td>${esc(r.driver_name || "")}</td><td class="num">${esc(r.default_helper_count || 0)}</td><td class="num">${money(r.standard_base_rate)}</td><td class="num">${money(r.driver_pay_rate)}</td><td class="num">${money(r.helper_pay_rate)}</td><td>${canEdit(user, "Recurring Trips") ? `<a href="/recurring-trips/${r.id}/edit">Edit</a>` : `<span class="muted">Read only</span>`}</td></tr>`);
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const toolbar = `<div class="toolbar"><form><input name="q" value="${esc(query)}" placeholder="Search recurring trips"><button>Search</button></form><div>${canEdit(user, "Recurring Trips") ? `<a class="button" href="/recurring-trips/new">New Template</a>` : ""} <a class="button secondary" href="/recurring-trips/export.csv${params.toString() ? `?${params.toString()}` : ""}">Export CSV</a></div></div>`;
  const content = `${messagePanel(url)}<section class="panel">${toolbar}</section>${table(["Code", "Client", "Route", "Asset", "Driver", "Helpers", "Base Rate", "Driver Pay", "Helper Pay", "Actions"], body, { empty: "No recurring trip templates found." })}${pagination("/recurring-trips", query, page, Number(countRow?.total || 0))}`;
  return html(layout({ title: "Recurring Trips", user, path, content }));
}

async function recurringFormPage(request, env, user, path, id = null) {
  const access = requireEdit(user, "Recurring Trips");
  if (access) return errorResponse(access, user, path);
  const row = id ? await first(env, "SELECT * FROM recurring_trip_masters WHERE id=?", [id]) : { active: 1 };
  if (id && !row) return html("Not found", 404);
  if (request.method === "POST") {
    const values = recurringValues(await parseForm(request));
    const errors = await validateRecurring(env, values, id);
    if (errors.length) return html(layout({ title: `${id ? "Edit" : "New"} Recurring Trip Master`, user, path, content: await renderRecurringForm(env, values, id, errors) }), 400);
    const fields = Object.keys(values);
    const params = fields.map((field) => values[field]);
    try {
      if (id) {
        await run(env, `UPDATE recurring_trip_masters SET ${fields.map((field) => `${field}=?`).join(", ")} WHERE id=?`, [...params, id]);
        return redirect(`/recurring-trips?ok=${encodeURIComponent("Recurring trip master updated.")}`);
      }
      await run(env, `INSERT INTO recurring_trip_masters (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`, params);
      return redirect(`/recurring-trips?ok=${encodeURIComponent("Recurring trip master saved.")}`);
    } catch (error) {
      return html(layout({ title: `${id ? "Edit" : "New"} Recurring Trip Master`, user, path, content: await renderRecurringForm(env, values, id, [`Could not save recurring trip: ${error.message || error}`]) }), 400);
    }
  }
  return html(layout({ title: `${id ? "Edit" : "New"} Recurring Trip Master`, user, path, content: await renderRecurringForm(env, row, id) }));
}

async function recurringDeletePage(request, env, user, path, id) {
  const access = requireEdit(user, "Recurring Trips");
  if (access) return errorResponse(access, user, path);
  if (request.method !== "POST") return html(layout({ title: "Method Not Allowed", user, path, content: `<section class="panel"><p class="error">Delete requires POST.</p></section>` }), 405);
  const row = await first(env, "SELECT id FROM recurring_trip_masters WHERE id=?", [id]);
  if (!row) return redirect("/recurring-trips?error=Record%20not%20found.");
  await run(env, "UPDATE trips SET recurring_master_id=NULL WHERE recurring_master_id=?", [id]);
  await run(env, "DELETE FROM recurring_trip_masters WHERE id=?", [id]);
  return redirect(`/recurring-trips?ok=${encodeURIComponent("Recurring trip master deleted; existing trips kept their transaction snapshots.")}`);
}

async function recurringExportPage(request, env, user, path) {
  const access = requireView(user, "Recurring Trips");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const where = recurringWhere((url.searchParams.get("q") || "").trim());
  const rows = await all(env, `SELECT r.*, c.client_name, a.asset_code, e.full_name AS driver_name FROM recurring_trip_masters r LEFT JOIN clients c ON c.id=r.client_id LEFT JOIN assets a ON a.id=r.default_asset_id LEFT JOIN employees e ON e.id=r.default_driver_id${where.sql} ORDER BY r.id`, where.params);
  const lines = ["ID,Code,Client,Item / Job,Origin,Destination,Asset,Driver,Helpers,Base Rate,Driver Pay,Helper Pay,Active"];
  for (const row of rows) {
    lines.push([row.id, row.master_code, row.client_name || "", row.job_description || "", row.origin || "", row.destination || "", row.asset_code || "", row.driver_name || "", row.default_helper_count || 0, row.standard_base_rate || 0, row.driver_pay_rate || 0, row.helper_pay_rate || 0, row.active ? "True" : "False"].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","));
  }
  return csv(lines.join("\n"), "recurring_trips.csv");
}

async function tripList(env, user, path) {
  const access = requireView(user, "Trips");
  if (access) return errorResponse(access, user, path);
  const rows = await all(env, `SELECT t.*, c.client_name, a.asset_code, e.full_name AS driver_name FROM trips t LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN assets a ON a.id=t.asset_id LEFT JOIN employees e ON e.id=t.driver_id ORDER BY t.trip_date DESC, t.id DESC LIMIT 100`);
  const body = rows.map((t) => `<tr><td><a href="/trips/${t.id}">${esc(t.trip_ticket_no)}</a></td><td>${esc(t.reference_no || "—")}</td><td>${esc(t.trip_date)}</td><td>${esc(t.client_name)}</td><td>${esc(t.origin)} → ${esc(t.destination)}</td><td>${esc(t.driver_name || "")}</td><td>${esc(t.asset_code || "")}</td><td><span class="status">${esc(t.status)}</span></td>${moneyCell(tripBillableTotal(t))}</tr>`);
  const toolbar = `<div class="toolbar"><form><input name="q" placeholder="Search trips"><button>Search</button></form><div>${canEdit(user, "Trips") ? `<a class="button" href="/trips/new">New Trip Details</a>` : ""} <a class="button secondary" href="/trips/export.csv">Export CSV</a></div></div>`;
  return html(layout({ title: "Trips List", user, path, content: `<section class="panel">${toolbar}</section>${table(["Trip Ticket / Waybill", "Ref. No.", "Date", "Client", "Route", "Driver", "Unit", "Status", "Total"], body)}` }));
}

async function tripForm(request, env, user, path) {
  const access = requireEdit(user, "Trips");
  if (access) return errorResponse(access, user, path);
  const [clients, assets, drivers, masters] = await Promise.all([
    all(env, "SELECT * FROM clients WHERE active=1 ORDER BY client_name"),
    all(env, "SELECT * FROM assets ORDER BY asset_code"),
    all(env, "SELECT * FROM employees WHERE active=1 AND employee_type='Driver' ORDER BY full_name"),
    all(env, "SELECT r.*, c.client_name FROM recurring_trip_masters r LEFT JOIN clients c ON c.id=r.client_id WHERE r.active=1 ORDER BY r.master_code"),
  ]);
  if (request.method === "POST") {
    const data = await parseForm(request);
    let ticket = data.trip_ticket_no?.trim();
    if (!ticket) {
      const row = await first(env, "SELECT trip_ticket_no FROM trips WHERE trip_ticket_no LIKE ? ORDER BY trip_ticket_no DESC LIMIT 1", [`TT-${String(data.trip_date).slice(0, 4)}-%`]);
      const last = Number(String(row?.trip_ticket_no || "0").split("-").at(-1) || 0);
      ticket = nextTripTicketNo(data.trip_date, last);
    }
    await run(env, `INSERT INTO trips (trip_ticket_no, reference_no, trip_type, recurring_master_id, trip_date, client_id, job_description, origin, destination, asset_id, driver_id, status, base_trip_rate, driver_pay_rate, helper_pay_rate, fuel_surcharge, loading_fee, unloading_fee, waiting_fee, tolls, additional_stop_charge, special_handling_fee, other_charges, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      ticket, data.reference_no || "", data.trip_type || "Spot Trip", data.recurring_master_id || null, data.trip_date,
      data.client_id || null, data.job_description || "", data.origin || "", data.destination || "",
      data.asset_id || null, data.driver_id || null, data.status || "Planned",
      data.base_trip_rate || 0, data.driver_pay_rate || 0, data.helper_pay_rate || 0,
      data.fuel_surcharge || 0, data.loading_fee || 0, data.unloading_fee || 0, data.waiting_fee || 0,
      data.tolls || 0, data.additional_stop_charge || 0, data.special_handling_fee || 0, data.other_charges || 0,
      data.notes || "",
    ]);
    return redirect("/trips");
  }
  const fields = [
    textInput("trip_ticket_no", "Trip Ticket / Waybill"),
    textInput("reference_no", "Ref. No."),
    textInput("trip_date", "Trip date", todayISO(), 'type="date" required'),
    selectInput("trip_type", "Trip type", [{ id: "Spot Trip", name: "Spot Trip" }, { id: "Recurring Trip", name: "Recurring Trip" }], "Spot Trip", (r) => r.name),
    selectInput("recurring_master_id", "Recurring master", masters, "", (r) => choiceLabel("recurring", r)),
    selectInput("client_id", "Client", clients, "", (r) => choiceLabel("client", r)),
    textInput("job_description", "Item / Job"),
    textInput("origin", "Origin"),
    textInput("destination", "Destination"),
    selectInput("asset_id", "Asset", assets, "", (r) => choiceLabel("asset", r)),
    selectInput("driver_id", "Driver", drivers, "", (r) => choiceLabel("employee", r)),
    textInput("status", "Status", "Planned"),
    numberInput("base_trip_rate", "Base trip rate"),
    numberInput("driver_pay_rate", "Driver pay rate"),
    numberInput("helper_pay_rate", "Helper pay rate"),
    numberInput("fuel_surcharge", "Fuel surcharge"),
    numberInput("loading_fee", "Loading fee"),
    numberInput("unloading_fee", "Unloading fee"),
    numberInput("waiting_fee", "Waiting fee"),
    numberInput("tolls", "Tolls"),
    numberInput("additional_stop_charge", "Additional stop charge"),
    numberInput("special_handling_fee", "Special handling fee"),
    numberInput("other_charges", "Other charges"),
    textInput("notes", "Notes"),
  ];
  return html(layout({ title: "New Trip Details", user, path, content: formPanel("/trips/new", fields, "Save Trip") }));
}

async function tripDetail(env, user, path, id, print = false) {
  const access = requireView(user, "Trips");
  if (access) return errorResponse(access, user, path);
  const trip = await first(env, `SELECT t.*, c.client_name, a.asset_code, a.plate_no, e.full_name AS driver_name FROM trips t LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN assets a ON a.id=t.asset_id LEFT JOIN employees e ON e.id=t.driver_id WHERE t.id=?`, [id]);
  if (!trip) return html("Not found", 404);
  const content = `<section class="panel"><h3>${esc(trip.trip_ticket_no)}</h3><p>${esc(trip.client_name || "")} · ${esc(trip.trip_date)} · Ref. No.: ${esc(trip.reference_no || "—")}</p><dl><dt>Route</dt><dd>${esc(trip.origin)} → ${esc(trip.destination)}</dd><dt>Item / Job</dt><dd>${esc(trip.job_description)}</dd><dt>Unit</dt><dd>${esc(trip.asset_code || "")} ${esc(trip.plate_no || "")}</dd><dt>Driver</dt><dd>${esc(trip.driver_name || "")}</dd><dt>Total</dt><dd>${esc(peso(tripBillableTotal(trip)))}</dd></dl>${print ? "" : `<p><a class="button secondary" href="/trips/${trip.id}/print" target="_blank">Printable Trip Ticket</a></p>`}</section>`;
  if (print) return html(`<!doctype html><title>${esc(trip.trip_ticket_no)}</title><link rel="stylesheet" href="/app.css"><main>${content}<button class="print-button" onclick="print()">Print</button></main>`);
  return html(layout({ title: "Trip Details", user, path, content }));
}

const TRIP_MONEY_FIELDS = [
  "base_trip_rate", "driver_pay_rate", "helper_pay_rate", "fuel_surcharge", "loading_fee",
  "unloading_fee", "waiting_fee", "tolls", "additional_stop_charge", "special_handling_fee", "other_charges",
];

const TRIP_STATUSES = ["Planned", "Ongoing", "Completed", "Cancelled"];

function moneyValue(value) {
  const number = Number(value || 0);
  return String(Number.isFinite(number) ? number : 0);
}

function tripWhere(query, status) {
  const clauses = [];
  const params = [];
  if (query) {
    clauses.push("(t.trip_ticket_no LIKE ? OR t.reference_no LIKE ? OR c.client_name LIKE ? OR t.origin LIKE ? OR t.destination LIKE ? OR e.full_name LIKE ? OR a.asset_code LIKE ?)");
    params.push(...Array(7).fill(`%${query}%`));
  }
  if (status && TRIP_STATUSES.includes(status)) {
    clauses.push("t.status=?");
    params.push(status);
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

function tripValues(data) {
  const values = {
    trip_ticket_no: (data.trip_ticket_no || "").trim(),
    reference_no: (data.reference_no || "").trim(),
    trip_type: data.trip_type === "Recurring Trip" ? "Recurring Trip" : "Spot Trip",
    recurring_master_id: data.recurring_master_id || null,
    trip_date: (data.trip_date || "").trim(),
    client_id: data.client_id || null,
    job_description: (data.job_description || "").trim(),
    origin: (data.origin || "").trim(),
    destination: (data.destination || "").trim(),
    asset_id: data.asset_id || null,
    driver_id: data.driver_id || null,
    dispatch_time: data.dispatch_time || null,
    arrival_time: data.arrival_time || null,
    status: TRIP_STATUSES.includes(data.status) ? data.status : "Planned",
    notes: (data.notes || "").trim(),
  };
  for (const field of TRIP_MONEY_FIELDS) values[field] = moneyValue(data[field]);
  if (values.trip_type === "Spot Trip") values.recurring_master_id = null;
  return values;
}

function parsePayItems(raw, employeeType) {
  if (!raw) return { items: [], errors: [] };
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    return { items: [], errors: [`Invalid ${employeeType.toLowerCase()} pay-item data.`] };
  }
  if (!Array.isArray(rows)) return { items: [], errors: [`Invalid ${employeeType.toLowerCase()} pay-item data.`] };
  const items = [];
  const errors = [];
  rows.forEach((row, index) => {
    const label = String(row?.label || "").trim();
    const amount = Number(row?.amount || 0);
    if (!label || !Number.isFinite(amount) || amount <= 0) {
      errors.push(`${employeeType} pay item ${index + 1} needs a label and an amount greater than zero.`);
    } else {
      items.push({ employee_type: employeeType, label, amount: String(amount), sort_order: index + 1 });
    }
  });
  return { items, errors };
}

async function tripChoices(env, currentMasterId = "") {
  return await Promise.all([
    all(env, "SELECT * FROM clients WHERE active=1 ORDER BY client_name"),
    all(env, "SELECT * FROM assets ORDER BY asset_code"),
    all(env, "SELECT * FROM employees WHERE active=1 AND employee_type='Driver' ORDER BY full_name"),
    all(env, "SELECT * FROM employees WHERE active=1 AND employee_type='Helper' ORDER BY full_name, id"),
    all(env, `SELECT r.*, c.client_name FROM recurring_trip_masters r LEFT JOIN clients c ON c.id=r.client_id WHERE r.active=1${currentMasterId ? " OR r.id=?" : ""} ORDER BY r.master_code`, currentMasterId ? [currentMasterId] : []),
  ]);
}

async function loadTrip(env, id) {
  const trip = await first(env, `SELECT t.*, c.client_name, a.asset_code, a.plate_no, a.make_model, e.full_name AS driver_name, r.master_code AS recurring_code FROM trips t LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN assets a ON a.id=t.asset_id LEFT JOIN employees e ON e.id=t.driver_id LEFT JOIN recurring_trip_masters r ON r.id=t.recurring_master_id WHERE t.id=?`, [id]);
  if (!trip) return null;
  trip.helpers = await all(env, "SELECT th.*, e.full_name, e.employee_code, e.employee_type, e.payroll_basis FROM trip_helpers th JOIN employees e ON e.id=th.employee_id WHERE th.trip_id=? ORDER BY th.helper_order, th.id", [id]);
  trip.pay_items = await all(env, "SELECT * FROM trip_employee_pay_items WHERE trip_id=? ORDER BY employee_type, sort_order, id", [id]);
  return trip;
}

async function validateTrip(env, values, helpers, payItems, id = null) {
  const errors = [];
  if (!values.trip_date) errors.push("trip date is required.");
  if (!values.client_id) errors.push("client is required.");
  if (values.trip_type === "Recurring Trip" && !values.recurring_master_id) errors.push("Choose a recurring trip master.");
  if (values.trip_ticket_no) {
    const duplicate = await first(env, `SELECT id FROM trips WHERE trip_ticket_no=?${id ? " AND id<>?" : ""} LIMIT 1`, id ? [values.trip_ticket_no, id] : [values.trip_ticket_no]);
    if (duplicate) errors.push("This trip ticket number is already in use.");
  }
  for (const field of TRIP_MONEY_FIELDS) {
    const amount = Number(values[field] || 0);
    if (!Number.isFinite(amount)) errors.push(`${field.replaceAll("_", " ")} must be a valid amount.`);
    if (amount < 0) errors.push(`${field.replaceAll("_", " ")} cannot be negative.`);
  }
  const helperIds = helpers.filter(Boolean);
  if (helperIds.length !== new Set(helperIds).size) errors.push("Helper selections must be unique.");
  if (!helpers[0] && (helpers[1] || helpers[2])) errors.push("Fill helper positions in order.");
  if (!helpers[1] && helpers[2]) errors.push("Fill helper positions in order.");
  if (values.asset_id) {
    const asset = await first(env, "SELECT asset_type FROM assets WHERE id=?", [values.asset_id]);
    const maximum = HELPER_LIMITS[asset?.asset_type] ?? 3;
    if (helperIds.length > maximum) errors.push(`${asset?.asset_type || "Selected unit"} allows at most ${maximum} helper(s).`);
  }
  if (payItems.some((item) => item.employee_type === "Helper") && helperIds.length === 0) {
    errors.push("Assign at least one helper before adding Helper pay items.");
  }
  return errors;
}

async function nextTicket(env, dateValue) {
  const row = await first(env, "SELECT trip_ticket_no FROM trips WHERE trip_ticket_no LIKE ? ORDER BY trip_ticket_no DESC LIMIT 1", [`TT-${String(dateValue).slice(0, 4)}-%`]);
  const last = Number(String(row?.trip_ticket_no || "0").split("-").at(-1) || 0);
  return nextTripTicketNo(dateValue, last);
}

function payItemsJson(items, type) {
  return JSON.stringify((items || []).filter((item) => item.employee_type === type).map((item) => ({ label: item.label, amount: item.amount })));
}

async function renderTripForm(env, row = {}, id = null, errors = []) {
  const existingHelpers = row.helpers || [];
  const [clients, assets, drivers, helpers, masters] = await tripChoices(env, row.recurring_master_id || "");
  const fields = [
    textInput("trip_ticket_no", "Trip Ticket / Waybill", row.trip_ticket_no || ""),
    textInput("reference_no", "Ref. No.", row.reference_no || ""),
    textInput("trip_date", "Trip date", row.trip_date || todayISO(), 'type="date" required'),
    selectInput("trip_type", "Trip type", [{ id: "Spot Trip", name: "Spot Trip" }, { id: "Recurring Trip", name: "Recurring Trip" }], row.trip_type || "Spot Trip", (r) => r.name, ""),
    selectInput("recurring_master_id", "Recurring master", masters, row.recurring_master_id || "", (r) => choiceLabel("recurring", r)),
    selectInput("status", "Status", TRIP_STATUSES.map((status) => ({ id: status, name: status })), row.status || "Planned", (r) => r.name, ""),
    selectInput("client_id", "Client", clients, row.client_id || "", (r) => choiceLabel("client", r)),
    textareaInput("job_description", "Item / Job", row.job_description || "", 'rows="2"'),
    textInput("origin", "Origin", row.origin || ""),
    textInput("destination", "Destination", row.destination || ""),
    textInput("dispatch_time", "Dispatch time", row.dispatch_time || "", 'type="time"'),
    textInput("arrival_time", "Arrival time", row.arrival_time || "", 'type="time"'),
    selectInput("asset_id", "Asset", assets, row.asset_id || "", (r) => choiceLabel("asset", r)),
    selectInput("driver_id", "Driver", drivers, row.driver_id || "", (r) => choiceLabel("employee", r)),
    selectInput("helper_1", "Helper 1", helpers, existingHelpers[0]?.employee_id || row.helper_1 || "", (r) => choiceLabel("employee", r)),
    selectInput("helper_2", "Helper 2", helpers, existingHelpers[1]?.employee_id || row.helper_2 || "", (r) => choiceLabel("employee", r)),
    selectInput("helper_3", "Helper 3", helpers, existingHelpers[2]?.employee_id || row.helper_3 || "", (r) => choiceLabel("employee", r)),
    numberInput("driver_pay_rate", "Driver pay rate", row.driver_pay_rate ?? 0),
    numberInput("helper_pay_rate", "Helper pay rate", row.helper_pay_rate ?? 0),
    numberInput("base_trip_rate", "Base trip rate", row.base_trip_rate ?? 0),
    ...EXTRA_FIELDS.map((field) => numberInput(field, field.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()), row[field] ?? 0)),
    textareaInput("driver_pay_items", "Driver pay items JSON", row.driver_pay_items ?? payItemsJson(row.pay_items, "Driver"), 'rows="2" placeholder=\'[{"label":"Allowance","amount":100}]\''),
    textareaInput("helper_pay_items", "Helper pay items JSON", row.helper_pay_items ?? payItemsJson(row.pay_items, "Helper"), 'rows="2" placeholder=\'[{"label":"Loading","amount":50}]\''),
    textareaInput("notes", "Notes", row.notes || "", 'rows="2"'),
  ];
  const errorBox = errors.length ? `<section class="panel"><ul class="error">${errors.map((err) => `<li>${esc(err)}</li>`).join("")}</ul></section>` : "";
  return `${errorBox}${formPanel(id ? `/trips/${id}/edit` : "/trips/new", fields, "Save Trip")}`;
}

async function saveTrip(env, values, helpers, payItems, id = null) {
  const driverAdditional = payItems.filter((item) => item.employee_type === "Driver").reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const helperAdditional = payItems.filter((item) => item.employee_type === "Helper").reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const fields = ["trip_ticket_no", "reference_no", "trip_type", "recurring_master_id", "trip_date", "client_id", "job_description", "origin", "destination", "asset_id", "driver_id", "dispatch_time", "arrival_time", "status", "base_trip_rate", "driver_pay_rate", "helper_pay_rate", "driver_additional_pay", "helper_additional_pay", ...EXTRA_FIELDS, "notes"];
  const paramsByField = { ...values, driver_additional_pay: String(driverAdditional), helper_additional_pay: String(helperAdditional) };
  let tripId = id;
  if (id) {
    await run(env, `UPDATE trips SET ${fields.map((field) => `${field}=?`).join(", ")} WHERE id=?`, [...fields.map((field) => Object.hasOwn(paramsByField, field) ? paramsByField[field] : ""), id]);
  } else {
    await run(env, `INSERT INTO trips (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`, fields.map((field) => Object.hasOwn(paramsByField, field) ? paramsByField[field] : ""));
    const created = await first(env, "SELECT id FROM trips WHERE trip_ticket_no=? LIMIT 1", [values.trip_ticket_no]);
    tripId = created?.id;
  }
  await run(env, "DELETE FROM trip_helpers WHERE trip_id=?", [tripId]);
  for (const [index, helperId] of helpers.filter(Boolean).entries()) {
    await run(env, "INSERT INTO trip_helpers (trip_id, employee_id, helper_order) VALUES (?,?,?)", [tripId, helperId, index + 1]);
  }
  await run(env, "DELETE FROM trip_employee_pay_items WHERE trip_id=?", [tripId]);
  for (const item of payItems) {
    await run(env, "INSERT INTO trip_employee_pay_items (trip_id, employee_type, label, amount, sort_order) VALUES (?,?,?,?,?)", [tripId, item.employee_type, item.label, item.amount, item.sort_order]);
  }
  return tripId;
}

async function tripListPage(request, env, user, path) {
  const access = requireView(user, "Trips");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const status = (url.searchParams.get("status") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const where = tripWhere(query, status);
  const countRow = await first(env, `SELECT COUNT(*) AS total FROM trips t LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN assets a ON a.id=t.asset_id LEFT JOIN employees e ON e.id=t.driver_id${where.sql}`, where.params);
  const rows = await all(env, `SELECT t.*, c.client_name, a.asset_code, e.full_name AS driver_name, (SELECT GROUP_CONCAT(full_name, '; ') FROM (SELECT he.full_name FROM trip_helpers th JOIN employees he ON he.id=th.employee_id WHERE th.trip_id=t.id ORDER BY th.helper_order, th.id)) AS helper_names FROM trips t LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN assets a ON a.id=t.asset_id LEFT JOIN employees e ON e.id=t.driver_id${where.sql} ORDER BY t.trip_date DESC, t.id DESC LIMIT 25 OFFSET ?`, [...where.params, (page - 1) * 25]);
  const body = rows.map((t) => `<tr><td><a href="/trips/${t.id}">${esc(t.trip_ticket_no)}</a></td><td>${esc(t.reference_no || "—")}</td><td>${esc(t.trip_date)}</td><td>${esc(t.client_name || "")}</td><td>${esc(t.origin)} → ${esc(t.destination)}</td><td>${esc(t.driver_name || "")}${t.helper_names ? `<small class="cell-detail">${esc(t.helper_names)}</small>` : ""}</td><td>${esc(t.asset_code || "")}</td><td><span class="status">${esc(t.status)}</span></td>${moneyCell(t.base_trip_rate)}${moneyCell(tripExtraTotal(t))}${moneyCell(tripBillableTotal(t))}<td><a href="/trips/${t.id}">View</a> <a href="/trips/${t.id}/print" target="_blank">Print</a>${canEdit(user, "Trips") ? ` <a href="/trips/${t.id}/edit">Edit</a>` : ""}</td></tr>`);
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (status) params.set("status", status);
  const statusOptions = `<select name="status"><option value="">All statuses</option>${TRIP_STATUSES.map((item) => `<option value="${esc(item)}"${item === status ? " selected" : ""}>${esc(item)}</option>`).join("")}</select>`;
  const exportHref = `/trips/export.csv${params.toString() ? `?${params.toString()}` : ""}`;
  const toolbar = `<div class="toolbar"><form><input name="q" value="${esc(query)}" placeholder="Search trips">${statusOptions}<button>Search</button></form><div>${canEdit(user, "Trips") ? `<a class="button" href="/trips/new">New Trip</a>` : ""} <a class="button secondary" href="${esc(exportHref)}">Export CSV</a></div></div>`;
  const content = `${messagePanel(url)}<section class="panel">${toolbar}</section>${table(["Trip Ticket / Waybill", "Ref. No.", "Date", "Client", "Route", "Driver / Helpers", "Unit", "Status", "Base", "Extra", "Total", "Actions"], body, { empty: "No trips found." })}${paginationWithParams("/trips", params, page, Number(countRow?.total || 0))}`;
  return html(layout({ title: "Trips List", user, path, content }));
}

async function tripFormPage(request, env, user, path, id = null) {
  const access = requireEdit(user, "Trips");
  if (access) return errorResponse(access, user, path);
  const row = id ? await loadTrip(env, id) : { trip_date: todayISO(), trip_type: "Spot Trip", status: "Planned" };
  if (id && !row) return html("Not found", 404);
  if (request.method === "POST") {
    const data = await parseForm(request);
    const values = tripValues(data);
    const helpers = [data.helper_1 || "", data.helper_2 || "", data.helper_3 || ""];
    const driverPay = parsePayItems(data.driver_pay_items, "Driver");
    const helperPay = parsePayItems(data.helper_pay_items, "Helper");
    const payItems = [...driverPay.items, ...helperPay.items];
    if (!values.trip_ticket_no && values.trip_date) values.trip_ticket_no = await nextTicket(env, values.trip_date);
    const errors = [...driverPay.errors, ...helperPay.errors, ...(await validateTrip(env, values, helpers, payItems, id))];
    if (errors.length) return html(layout({ title: `${id ? "Edit" : "New"} Trip Details`, user, path, content: await renderTripForm(env, { ...values, ...data }, id, errors) }), 400);
    try {
      const tripId = await saveTrip(env, values, helpers, payItems, id);
      return redirect(`/trips/${tripId}?ok=${encodeURIComponent(id ? "Trip record updated." : "Trip record saved.")}`);
    } catch (error) {
      return html(layout({ title: `${id ? "Edit" : "New"} Trip Details`, user, path, content: await renderTripForm(env, { ...values, ...data }, id, [`Could not save trip: ${error.message || error}`]) }), 400);
    }
  }
  return html(layout({ title: `${id ? "Edit" : "New"} Trip Details`, user, path, content: await renderTripForm(env, row, id) }));
}

async function tripDetailPage(request, env, user, path, id, print = false) {
  const access = requireView(user, "Trips");
  if (access) return errorResponse(access, user, path);
  const trip = await loadTrip(env, id);
  if (!trip) return html("Not found", 404);
  const helperNames = (trip.helpers || []).map((row) => row.full_name).join("; ") || "None";
  const extraRows = EXTRA_FIELDS.filter((field) => Number(trip[field] || 0)).map((field) => `<dt>${esc(field.replaceAll("_", " "))}</dt><dd>${esc(peso(trip[field]))}</dd>`).join("");
  const payRows = (trip.pay_items || []).map((item) => `<div class="detail-pay-row"><span>${esc(item.label)} <small>${esc(item.employee_type)}</small></span><strong>${esc(peso(item.amount))}</strong></div>`).join("") || `<p class="muted">No additional pay items.</p>`;
  const main = `<section class="panel detail-hero"><div><span class="dialog-kicker">${esc(trip.trip_type)} · Trip Ticket / Waybill</span><h3>${esc(trip.trip_ticket_no)}</h3><p>${esc(trip.client_name || "No client")} · ${esc(trip.trip_date)} · Ref. No.: ${esc(trip.reference_no || "—")}</p></div><span class="status detail-status">${esc(trip.status)}</span></section><div class="detail-grid"><section class="panel"><h3>Route & Schedule</h3><dl class="detail-list"><dt>Item / Job</dt><dd>${esc(trip.job_description || "—")}</dd><dt>Origin</dt><dd>${esc(trip.origin || "—")}</dd><dt>Destination</dt><dd>${esc(trip.destination || "—")}</dd><dt>Dispatch</dt><dd>${esc(trip.dispatch_time || "—")}</dd><dt>Arrival</dt><dd>${esc(trip.arrival_time || "—")}</dd><dt>Recurring Master</dt><dd>${esc(trip.recurring_code || "—")}</dd></dl></section><section class="panel"><h3>Unit & Crew</h3><dl class="detail-list"><dt>Asset</dt><dd>${esc([trip.asset_code, trip.plate_no].filter(Boolean).join(" · ") || "—")}</dd><dt>Driver</dt><dd>${esc(trip.driver_name || "—")}</dd><dt>Helpers</dt><dd>${esc(helperNames)}</dd><dt>Driver Pay Rate</dt><dd>${esc(peso(trip.driver_pay_rate))}</dd><dt>Helper Pay Pool</dt><dd>${esc(peso(trip.helper_pay_rate))}</dd></dl></section><section class="panel"><h3>Billing Breakdown</h3><dl class="detail-list"><dt>Base Trip Rate</dt><dd>${esc(peso(trip.base_trip_rate))}</dd>${extraRows}<dt class="detail-total">Billable Total</dt><dd class="detail-total">${esc(peso(tripBillableTotal(trip)))}</dd></dl></section><section class="panel"><h3>Employee Pay Items</h3>${payRows}</section></div>${trip.notes ? `<section class="panel"><h3>Notes</h3><p>${esc(trip.notes)}</p></section>` : ""}`;
  if (print) {
    const extraTable = EXTRA_FIELDS.filter((field) => Number(trip[field] || 0)).map((field) => `<tr><td>${esc(field.replaceAll("_", " "))}</td><td class="num">${esc(peso(trip[field]))}</td></tr>`).join("");
    const payTable = (trip.pay_items || []).map((item) => `<tr><td>${esc(item.label)}</td><td>${esc(item.employee_type)}</td><td class="num">${esc(peso(item.amount))}</td></tr>`).join("") || `<tr><td colspan="3">No additional employee pay items.</td></tr>`;
    return html(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(trip.trip_ticket_no)}</title><style>@page{size:A4 portrait;margin:12mm}body{font:12px Arial,sans-serif;color:#111}button{margin-bottom:10px}.header{display:flex;justify-content:space-between;border-bottom:2px solid #111;margin-bottom:14px;padding-bottom:8px}h1{margin:0;font-size:22px}table{width:100%;border-collapse:collapse;margin:10px 0}td,th{border:1px solid #333;padding:6px;vertical-align:top}.label{font-weight:bold;width:22%;background:#f3f3f3}.num{text-align:right}.signatures{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;margin-top:70px}.signatures div{border-top:1px solid #111;text-align:center;padding-top:6px}@media print{button{display:none}}</style></head><body><button onclick="window.print()">Print</button><div class="header"><div><h1>GMT Trucking</h1><strong>Trip Ticket / Waybill</strong></div><div><strong>${esc(trip.trip_ticket_no)}</strong><br>${esc(trip.trip_date)}</div></div><table><tr><td class="label">Trip Ticket / Waybill</td><td>${esc(trip.trip_ticket_no)}</td><td class="label">Ref. No.</td><td>${esc(trip.reference_no || "—")}</td></tr><tr><td class="label">Date</td><td>${esc(trip.trip_date)}</td><td class="label">Type / Status</td><td>${esc(trip.trip_type)} / ${esc(trip.status)}</td></tr><tr><td class="label">Client</td><td colspan="3">${esc(trip.client_name || "")}</td></tr><tr><td class="label">Item / Job</td><td colspan="3">${esc(trip.job_description || "")}</td></tr><tr><td class="label">Origin</td><td>${esc(trip.origin || "")}</td><td class="label">Destination</td><td>${esc(trip.destination || "")}</td></tr><tr><td class="label">Unit</td><td>${esc([trip.asset_code, trip.plate_no].filter(Boolean).join(" · "))}</td><td class="label">Driver</td><td>${esc(trip.driver_name || "")}</td></tr><tr><td class="label">Helpers</td><td colspan="3">${esc(helperNames)}</td></tr><tr><td class="label">Dispatch</td><td>${esc(trip.dispatch_time || "")}</td><td class="label">Arrival</td><td>${esc(trip.arrival_time || "")}</td></tr></table><table><thead><tr><th>Charge</th><th class="num">Amount</th></tr></thead><tbody><tr><td>Base Trip Rate</td><td class="num">${esc(peso(trip.base_trip_rate))}</td></tr>${extraTable}<tr><th>Total</th><th class="num">${esc(peso(tripBillableTotal(trip)))}</th></tr></tbody></table><table><thead><tr><th>Employee Pay Item</th><th>Type</th><th class="num">Amount</th></tr></thead><tbody>${payTable}</tbody></table>${trip.notes ? `<p><strong>Notes:</strong><br>${esc(trip.notes)}</p>` : ""}<div class="signatures"><div>Prepared By</div><div>Driver</div><div>Client / Receiver</div></div></body></html>`);
  }
  const actions = `<div class="detail-toolbar"><a class="button secondary" href="/trips">← Trips List</a><div><a class="button secondary" href="/trips/${id}/print" target="_blank">Print Ticket</a>${canEdit(user, "Trips") ? ` <a class="button" href="/trips/${id}/edit">Edit Details</a>` : ""}</div></div>`;
  const deleteForm = canEdit(user, "Trips") ? `<section class="detail-danger"><form method="post" action="/trips/${id}/delete" onsubmit="return confirm('Delete this trip? This cannot be undone.');"><button class="danger-button">Delete Trip</button></form></section>` : "";
  return html(layout({ title: "Trip Details", user, path, content: `${messagePanel(new URL(request.url))}${actions}${main}${deleteForm}` }));
}

async function tripDeletePage(request, env, user, path, id) {
  const access = requireEdit(user, "Trips");
  if (access) return errorResponse(access, user, path);
  if (request.method !== "POST") return html(layout({ title: "Method Not Allowed", user, path, content: `<section class="panel"><p class="error">Delete requires POST.</p></section>` }), 405);
  const row = await first(env, "SELECT trip_ticket_no FROM trips WHERE id=?", [id]);
  if (!row) return redirect("/trips?error=Trip%20not%20found.");
  for (const [tableName, label] of [["billing_lines", "billing"], ["payroll_trips", "payroll"]]) {
    const ref = await first(env, `SELECT COUNT(*) AS total FROM ${tableName} WHERE trip_id=?`, [id]);
    if (Number(ref?.total || 0) > 0) return redirect(`/trips?error=${encodeURIComponent(`This trip is already used by ${label} and cannot be deleted.`)}`);
  }
  await run(env, "DELETE FROM trip_helpers WHERE trip_id=?", [id]);
  await run(env, "DELETE FROM trip_employee_pay_items WHERE trip_id=?", [id]);
  await run(env, "DELETE FROM trips WHERE id=?", [id]);
  return redirect(`/trips?ok=${encodeURIComponent(`Trip ${row.trip_ticket_no} deleted.`)}`);
}

async function tripExportPage(request, env, user, path) {
  const access = requireView(user, "Trips");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const where = tripWhere((url.searchParams.get("q") || "").trim(), (url.searchParams.get("status") || "").trim());
  const rows = await all(env, `SELECT t.*, c.client_name, a.asset_code, e.full_name AS driver_name, (SELECT GROUP_CONCAT(full_name, '; ') FROM (SELECT he.full_name FROM trip_helpers th JOIN employees he ON he.id=th.employee_id WHERE th.trip_id=t.id ORDER BY th.helper_order, th.id)) AS helper_names FROM trips t LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN assets a ON a.id=t.asset_id LEFT JOIN employees e ON e.id=t.driver_id${where.sql} ORDER BY t.id`, where.params);
  const lines = ["ID,Trip Ticket / Waybill,Ref. No.,Type,Date,Client,Route,Asset,Driver,Helpers,Status,Base Rate,Extra Charges,Billable Total"];
  for (const row of rows) {
    lines.push([row.id, row.trip_ticket_no, row.reference_no || "", row.trip_type, row.trip_date, row.client_name || "", `${row.origin || ""} -> ${row.destination || ""}`, row.asset_code || "", row.driver_name || "", row.helper_names || "", row.status, row.base_trip_rate || 0, tripExtraTotal(row), tripBillableTotal(row)].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","));
  }
  return csv(lines.join("\n"), "trips.csv");
}

const REPAIR_STATUSES = ["Open", "Completed", "Cancelled"];
const PAYABLE_STATUSES = ["Open", "Partial", "Paid", "Cancelled"];
const ADVANCE_STATUSES = ["Open", "Paid", "Cancelled"];

function quotedCsvRow(values) {
  return values.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",");
}

function numeric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function numericText(value) {
  return String(numeric(value));
}

function requireNonNegative(values, fields) {
  const errors = [];
  for (const field of fields) {
    if (numeric(values[field]) < 0) errors.push(`${field.replaceAll("_", " ")} cannot be negative.`);
  }
  return errors;
}

function repairWhere(query, status = "") {
  const clauses = [];
  const params = [];
  if (query) {
    clauses.push("(r.repair_description LIKE ? OR r.meter_value LIKE ? OR a.asset_code LIKE ? OR s.supplier_name LIKE ?)");
    params.push(...Array(4).fill(`%${query}%`));
  }
  if (status && REPAIR_STATUSES.includes(status)) {
    clauses.push("r.status=?");
    params.push(status);
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

function repairValues(data) {
  const parts = numeric(data.parts_cost);
  const labor = numeric(data.labor_cost);
  const other = numeric(data.other_cost);
  return {
    repair_date: (data.repair_date || "").trim(),
    asset_id: data.asset_id || null,
    repair_description: (data.repair_description || "").trim(),
    meter_value: (data.meter_value || "").trim(),
    supplier_id: data.supplier_id || null,
    parts_cost: String(parts),
    labor_cost: String(labor),
    other_cost: String(other),
    total_cost: String(parts + labor + other),
    status: REPAIR_STATUSES.includes(data.status) ? data.status : "Open",
    notes: (data.notes || "").trim(),
    auto_generate_payable: data.auto_generate_payable === "1" ? "1" : "0",
  };
}

async function repairChoices(env) {
  return await Promise.all([
    all(env, "SELECT * FROM assets ORDER BY asset_code"),
    all(env, "SELECT * FROM suppliers ORDER BY supplier_name"),
  ]);
}

async function renderRepairForm(env, row = {}, id = null, errors = []) {
  const [assets, suppliers] = await repairChoices(env);
  const fields = [
    textInput("repair_date", "Repair date", row.repair_date || todayISO(), 'type="date" required'),
    selectInput("asset_id", "Asset", assets, row.asset_id || "", (r) => choiceLabel("asset", r)),
    textareaInput("repair_description", "Description", row.repair_description || "", 'rows="2" required'),
    textInput("meter_value", "Meter value", row.meter_value || ""),
    selectInput("supplier_id", "Supplier", suppliers, row.supplier_id || "", (r) => choiceLabel("supplier", r)),
    numberInput("parts_cost", "Parts cost", row.parts_cost ?? 0),
    numberInput("labor_cost", "Labor cost", row.labor_cost ?? 0),
    numberInput("other_cost", "Other cost", row.other_cost ?? 0),
    selectInput("status", "Status", REPAIR_STATUSES.map((status) => ({ id: status, name: status })), row.status || "Open", (r) => r.name, ""),
    selectInput("auto_generate_payable", "Auto-generate payable", [{ id: "0", name: "No" }, { id: "1", name: "Yes" }], row.auto_generate_payable ? "1" : "0", (r) => r.name, ""),
    textareaInput("notes", "Notes", row.notes || "", 'rows="2"'),
  ];
  const errorBox = errors.length ? `<section class="panel"><ul class="error">${errors.map((err) => `<li>${esc(err)}</li>`).join("")}</ul></section>` : "";
  const deleteForm = id ? `<form method="post" action="/repairs/${id}/delete" class="delete-form" onsubmit="return confirm('Delete this repair?');"><button class="danger">Delete</button></form>` : "";
  return `${errorBox}${formPanel(id ? `/repairs/${id}/edit` : "/repairs/new", fields, "Save Repair")}${deleteForm}`;
}

async function validateRepair(values) {
  const errors = [];
  if (!values.repair_date) errors.push("repair date is required.");
  if (!values.repair_description) errors.push("repair description is required.");
  errors.push(...requireNonNegative(values, ["parts_cost", "labor_cost", "other_cost", "total_cost"]));
  return errors;
}

async function upsertRepairPayable(env, repairId, values) {
  if (values.auto_generate_payable !== "1" || !values.supplier_id || numeric(values.total_cost) <= 0) return;
  const existing = await first(env, "SELECT id FROM payables WHERE linked_repair_id=?", [repairId]);
  const payable = {
    payable_date: values.repair_date,
    supplier_id: values.supplier_id,
    source_type: "Repair",
    reference_no: `REPAIR-${String(repairId).padStart(6, "0")}`,
    description: values.repair_description,
    amount: values.total_cost,
    due_date: "",
    status: "Open",
    notes: values.notes,
    linked_repair_id: repairId,
  };
  const fields = Object.keys(payable);
  if (existing) {
    await run(env, `UPDATE payables SET ${fields.map((field) => `${field}=?`).join(", ")} WHERE id=?`, [...fields.map((field) => payable[field]), existing.id]);
  } else {
    await run(env, `INSERT INTO payables (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`, fields.map((field) => payable[field]));
  }
}

async function saveRepair(env, values, id = null) {
  const fields = Object.keys(values);
  let repairId = id;
  if (id) {
    await run(env, `UPDATE repairs SET ${fields.map((field) => `${field}=?`).join(", ")} WHERE id=?`, [...fields.map((field) => values[field]), id]);
  } else {
    const result = await run(env, `INSERT INTO repairs (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`, fields.map((field) => values[field]));
    repairId = result?.meta?.last_row_id;
    if (!repairId) {
      const created = await first(env, "SELECT id FROM repairs WHERE repair_date=? AND repair_description=? ORDER BY id DESC LIMIT 1", [values.repair_date, values.repair_description]);
      repairId = created?.id;
    }
  }
  await upsertRepairPayable(env, repairId, values);
  return repairId;
}

async function repairsPage(request, env, user, path) {
  const access = requireView(user, "Repairs");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const status = (url.searchParams.get("status") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const where = repairWhere(query, status);
  const countRow = await first(env, `SELECT COUNT(*) AS total FROM repairs r LEFT JOIN assets a ON a.id=r.asset_id LEFT JOIN suppliers s ON s.id=r.supplier_id${where.sql}`, where.params);
  const rows = await all(env, `SELECT r.*, a.asset_code, a.plate_no, s.supplier_name, p.reference_no AS payable_ref FROM repairs r LEFT JOIN assets a ON a.id=r.asset_id LEFT JOIN suppliers s ON s.id=r.supplier_id LEFT JOIN payables p ON p.linked_repair_id=r.id${where.sql} ORDER BY r.repair_date DESC, r.id DESC LIMIT 25 OFFSET ?`, [...where.params, (page - 1) * 25]);
  const body = rows.map((row) => `<tr><td>${esc(row.repair_date)}</td><td>${esc(row.asset_code || "")}<small class="cell-detail">${esc(row.plate_no || "")}</small></td><td>${canEdit(user, "Repairs") ? `<a href="/repairs/${row.id}/edit">${esc(row.repair_description)}</a>` : esc(row.repair_description)}</td><td>${esc(row.supplier_name || "")}</td><td>${esc(row.meter_value || "")}</td>${moneyCell(row.total_cost)}<td><span class="status">${esc(row.status)}</span></td><td>${esc(row.payable_ref || "")}</td><td>${canEdit(user, "Repairs") ? `<a href="/repairs/${row.id}/edit">Edit</a>` : `<span class="muted">Read only</span>`}</td></tr>`);
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (status) params.set("status", status);
  const statusOptions = `<select name="status"><option value="">All statuses</option>${REPAIR_STATUSES.map((item) => `<option value="${esc(item)}"${item === status ? " selected" : ""}>${esc(item)}</option>`).join("")}</select>`;
  const toolbar = `<div class="toolbar"><form><input name="q" value="${esc(query)}" placeholder="Search repairs">${statusOptions}<button>Search</button></form><div>${canEdit(user, "Repairs") ? `<a class="button" href="/repairs/new">New Repair</a>` : ""} <a class="button secondary" href="${esc(`/repairs/export.csv${params.toString() ? `?${params.toString()}` : ""}`)}">Export CSV</a></div></div>`;
  const content = `${messagePanel(url)}<section class="panel">${toolbar}</section>${table(["Date", "Asset", "Description", "Supplier", "Meter", "Total Cost", "Status", "Payable", "Actions"], body, { empty: "No repairs found." })}${paginationWithParams("/repairs", params, page, Number(countRow?.total || 0))}`;
  return html(layout({ title: "Repairs", user, path, content }));
}

async function repairFormPage(request, env, user, path, id = null) {
  const access = requireEdit(user, "Repairs");
  if (access) return errorResponse(access, user, path);
  const row = id ? await first(env, "SELECT * FROM repairs WHERE id=?", [id]) : { repair_date: todayISO(), status: "Open" };
  if (id && !row) return html("Not found", 404);
  if (request.method === "POST") {
    const values = repairValues(await parseForm(request));
    const errors = await validateRepair(values);
    if (errors.length) return html(layout({ title: `${id ? "Edit" : "New"} Repair`, user, path, content: await renderRepairForm(env, values, id, errors) }), 400);
    try {
      await saveRepair(env, values, id);
      return redirect(`/repairs?ok=${encodeURIComponent(id ? "Repair updated." : "Repair saved.")}`);
    } catch (error) {
      return html(layout({ title: `${id ? "Edit" : "New"} Repair`, user, path, content: await renderRepairForm(env, values, id, [`Could not save repair: ${error.message || error}`]) }), 400);
    }
  }
  return html(layout({ title: `${id ? "Edit" : "New"} Repair`, user, path, content: await renderRepairForm(env, row, id) }));
}

async function repairDeletePage(request, env, user, path, id) {
  const access = requireEdit(user, "Repairs");
  if (access) return errorResponse(access, user, path);
  if (request.method !== "POST") return html(layout({ title: "Method Not Allowed", user, path, content: `<section class="panel"><p class="error">Delete requires POST.</p></section>` }), 405);
  await run(env, "DELETE FROM payables WHERE linked_repair_id=?", [id]);
  await run(env, "DELETE FROM repairs WHERE id=?", [id]);
  return redirect(`/repairs?ok=${encodeURIComponent("Repair deleted.")}`);
}

async function repairExportPage(request, env, user, path) {
  const access = requireView(user, "Repairs");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const where = repairWhere((url.searchParams.get("q") || "").trim(), (url.searchParams.get("status") || "").trim());
  const rows = await all(env, `SELECT r.*, a.asset_code, s.supplier_name, p.reference_no AS payable_ref FROM repairs r LEFT JOIN assets a ON a.id=r.asset_id LEFT JOIN suppliers s ON s.id=r.supplier_id LEFT JOIN payables p ON p.linked_repair_id=r.id${where.sql} ORDER BY r.id`, where.params);
  const lines = ["ID,Date,Asset,Description,Supplier,Meter,Parts,Labor,Other,Total Cost,Status,Payable"];
  for (const row of rows) lines.push(quotedCsvRow([row.id, row.repair_date, row.asset_code || "", row.repair_description, row.supplier_name || "", row.meter_value, row.parts_cost, row.labor_cost, row.other_cost, row.total_cost, row.status, row.payable_ref || ""]));
  return csv(lines.join("\n"), "repairs.csv");
}

function payableWhere(query, status = "") {
  const clauses = [];
  const params = [];
  if (query) {
    clauses.push("(p.reference_no LIKE ? OR p.description LIKE ? OR s.supplier_name LIKE ? OR p.source_type LIKE ?)");
    params.push(...Array(4).fill(`%${query}%`));
  }
  if (status && PAYABLE_STATUSES.includes(status)) {
    clauses.push("p.status=?");
    params.push(status);
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

function payableValues(data) {
  return {
    payable_date: (data.payable_date || "").trim(),
    supplier_id: data.supplier_id || null,
    source_type: (data.source_type || "Manual").trim(),
    reference_no: (data.reference_no || "").trim(),
    description: (data.description || "").trim(),
    amount: numericText(data.amount),
    due_date: (data.due_date || "").trim(),
    status: PAYABLE_STATUSES.includes(data.status) ? data.status : "Open",
    notes: (data.notes || "").trim(),
    linked_repair_id: data.linked_repair_id || null,
  };
}

async function payableChoices(env) {
  return await Promise.all([
    all(env, "SELECT * FROM suppliers ORDER BY supplier_name"),
    all(env, "SELECT id, repair_date, repair_description FROM repairs ORDER BY repair_date DESC, id DESC LIMIT 200"),
  ]);
}

async function renderPayableForm(env, row = {}, id = null, errors = []) {
  const [suppliers, repairs] = await payableChoices(env);
  const fields = [
    textInput("payable_date", "Payable date", row.payable_date || todayISO(), 'type="date" required'),
    selectInput("supplier_id", "Supplier", suppliers, row.supplier_id || "", (r) => choiceLabel("supplier", r)),
    textInput("source_type", "Source type", row.source_type || "Manual"),
    textInput("reference_no", "Reference no.", row.reference_no || ""),
    textareaInput("description", "Description", row.description || "", 'rows="2" required'),
    numberInput("amount", "Amount", row.amount ?? 0),
    textInput("due_date", "Due date", row.due_date || "", 'type="date"'),
    selectInput("status", "Status", PAYABLE_STATUSES.map((status) => ({ id: status, name: status })), row.status || "Open", (r) => r.name, ""),
    selectInput("linked_repair_id", "Linked repair", repairs, row.linked_repair_id || "", (r) => `Repair #${r.id} — ${r.repair_date} — ${r.repair_description}`),
    textareaInput("notes", "Notes", row.notes || "", 'rows="2"'),
  ];
  const errorBox = errors.length ? `<section class="panel"><ul class="error">${errors.map((err) => `<li>${esc(err)}</li>`).join("")}</ul></section>` : "";
  const deleteForm = id ? `<form method="post" action="/payables/${id}/delete" class="delete-form" onsubmit="return confirm('Delete this payable? Repair-linked payables are protected.');"><button class="danger">Delete</button></form>` : "";
  return `${errorBox}${formPanel(id ? `/payables/${id}/edit` : "/payables/new", fields, "Save Payable")}${deleteForm}`;
}

function validatePayable(values) {
  const errors = [];
  if (!values.payable_date) errors.push("payable date is required.");
  if (!values.description) errors.push("description is required.");
  if (numeric(values.amount) < 0) errors.push("amount cannot be negative.");
  return errors;
}

async function payablesPage(request, env, user, path) {
  const access = requireView(user, "Payables");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const status = (url.searchParams.get("status") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const where = payableWhere(query, status);
  const countRow = await first(env, `SELECT COUNT(*) AS total FROM payables p LEFT JOIN suppliers s ON s.id=p.supplier_id${where.sql}`, where.params);
  const rows = await all(env, `SELECT p.*, s.supplier_name FROM payables p LEFT JOIN suppliers s ON s.id=p.supplier_id${where.sql} ORDER BY p.payable_date DESC, p.id DESC LIMIT 25 OFFSET ?`, [...where.params, (page - 1) * 25]);
  const body = rows.map((row) => `<tr><td>${esc(row.payable_date)}</td><td>${canEdit(user, "Payables") ? `<a href="/payables/${row.id}/edit">${esc(row.reference_no || `PAY-${row.id}`)}</a>` : esc(row.reference_no || `PAY-${row.id}`)}</td><td>${esc(row.supplier_name || "")}</td><td>${esc(row.source_type || "")}</td><td>${esc(row.description || "")}</td>${moneyCell(row.amount)}<td>${esc(row.due_date || "")}</td><td><span class="status">${esc(row.status)}</span></td><td>${row.linked_repair_id ? `Repair #${esc(row.linked_repair_id)}` : ""}</td><td>${canEdit(user, "Payables") ? `<a href="/payables/${row.id}/edit">Edit</a>` : `<span class="muted">Read only</span>`}</td></tr>`);
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (status) params.set("status", status);
  const statusOptions = `<select name="status"><option value="">All statuses</option>${PAYABLE_STATUSES.map((item) => `<option value="${esc(item)}"${item === status ? " selected" : ""}>${esc(item)}</option>`).join("")}</select>`;
  const toolbar = `<div class="toolbar"><form><input name="q" value="${esc(query)}" placeholder="Search payables">${statusOptions}<button>Search</button></form><div>${canEdit(user, "Payables") ? `<a class="button" href="/payables/new">New Payable</a>` : ""} <a class="button secondary" href="${esc(`/payables/export.csv${params.toString() ? `?${params.toString()}` : ""}`)}">Export CSV</a></div></div>`;
  const content = `${messagePanel(url)}<section class="panel">${toolbar}</section>${table(["Date", "Ref. No.", "Supplier", "Source", "Description", "Amount", "Due", "Status", "Linked Repair", "Actions"], body, { empty: "No payables found." })}${paginationWithParams("/payables", params, page, Number(countRow?.total || 0))}`;
  return html(layout({ title: "Payables", user, path, content }));
}

async function payableFormPage(request, env, user, path, id = null) {
  const access = requireEdit(user, "Payables");
  if (access) return errorResponse(access, user, path);
  const row = id ? await first(env, "SELECT * FROM payables WHERE id=?", [id]) : { payable_date: todayISO(), source_type: "Manual", status: "Open" };
  if (id && !row) return html("Not found", 404);
  if (request.method === "POST") {
    const values = payableValues(await parseForm(request));
    const errors = validatePayable(values);
    if (errors.length) return html(layout({ title: `${id ? "Edit" : "New"} Payable`, user, path, content: await renderPayableForm(env, values, id, errors) }), 400);
    const fields = Object.keys(values);
    try {
      if (id) await run(env, `UPDATE payables SET ${fields.map((field) => `${field}=?`).join(", ")} WHERE id=?`, [...fields.map((field) => values[field]), id]);
      else await run(env, `INSERT INTO payables (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`, fields.map((field) => values[field]));
      return redirect(`/payables?ok=${encodeURIComponent(id ? "Payable updated." : "Payable saved.")}`);
    } catch (error) {
      return html(layout({ title: `${id ? "Edit" : "New"} Payable`, user, path, content: await renderPayableForm(env, values, id, [`Could not save payable: ${error.message || error}`]) }), 400);
    }
  }
  return html(layout({ title: `${id ? "Edit" : "New"} Payable`, user, path, content: await renderPayableForm(env, row, id) }));
}

async function payableDeletePage(request, env, user, path, id) {
  const access = requireEdit(user, "Payables");
  if (access) return errorResponse(access, user, path);
  if (request.method !== "POST") return html(layout({ title: "Method Not Allowed", user, path, content: `<section class="panel"><p class="error">Delete requires POST.</p></section>` }), 405);
  const row = await first(env, "SELECT * FROM payables WHERE id=?", [id]);
  if (row?.linked_repair_id) return redirect(`/payables?error=${encodeURIComponent("Cannot delete a repair-linked payable. Unlink the repair/payable first.")}`);
  await run(env, "DELETE FROM payables WHERE id=?", [id]);
  return redirect(`/payables?ok=${encodeURIComponent("Payable deleted.")}`);
}

async function payableExportPage(request, env, user, path) {
  const access = requireView(user, "Payables");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const where = payableWhere((url.searchParams.get("q") || "").trim(), (url.searchParams.get("status") || "").trim());
  const rows = await all(env, `SELECT p.*, s.supplier_name FROM payables p LEFT JOIN suppliers s ON s.id=p.supplier_id${where.sql} ORDER BY p.id`, where.params);
  const lines = ["ID,Date,Supplier,Source,Reference No.,Description,Amount,Due Date,Status,Linked Repair"];
  for (const row of rows) lines.push(quotedCsvRow([row.id, row.payable_date, row.supplier_name || "", row.source_type, row.reference_no, row.description, row.amount, row.due_date || "", row.status, row.linked_repair_id || ""]));
  return csv(lines.join("\n"), "payables.csv");
}

const ADVANCE_SPECS = {
  vale: {
    page: "Vale / Cash Advance",
    title: "Vale",
    table: "vale_records",
    route: "vale",
    dateField: "date_granted",
    amountFields: ["amount", "installment_amount", "balance"],
    columns: ["employee_name", "date_granted", "amount", "installment_amount", "balance", "status"],
    labels: ["Employee", "Date", "Amount", "Installment", "Balance", "Status"],
  },
  cash: {
    page: "Vale / Cash Advance",
    title: "Cash Advance",
    table: "cash_advances",
    route: "cash",
    dateField: "date_granted",
    amountFields: ["amount", "balance"],
    columns: ["employee_name", "date_granted", "amount", "balance", "applied", "status"],
    labels: ["Employee", "Date", "Amount", "Balance", "Applied", "Status"],
  },
};

function advanceValues(data, type) {
  const amount = numeric(data.amount);
  const balanceValue = data.balance === undefined || data.balance === "" ? amount : numeric(data.balance);
  const values = {
    employee_id: data.employee_id || null,
    date_granted: (data.date_granted || "").trim(),
    amount: String(amount),
    balance: String(balanceValue),
    status: ADVANCE_STATUSES.includes(data.status) ? data.status : "Open",
    notes: (data.notes || "").trim(),
  };
  if (type === "vale") values.installment_amount = numericText(data.installment_amount);
  if (type === "cash") values.applied = data.applied === "1" ? "1" : "0";
  return values;
}

function validateAdvance(values, type) {
  const errors = [];
  if (!values.employee_id) errors.push("employee is required.");
  if (!values.date_granted) errors.push("date granted is required.");
  errors.push(...requireNonNegative(values, type === "vale" ? ["amount", "installment_amount", "balance"] : ["amount", "balance"]));
  return errors;
}

async function renderAdvanceForm(env, type, row = {}, id = null, errors = []) {
  const employees = await all(env, "SELECT * FROM employees WHERE active=1 ORDER BY full_name");
  const fields = [
    selectInput("employee_id", "Employee", employees, row.employee_id || "", (r) => choiceLabel("employee", r)),
    textInput("date_granted", "Date granted", row.date_granted || todayISO(), 'type="date" required'),
    numberInput("amount", "Amount", row.amount ?? 0),
    ...(type === "vale" ? [numberInput("installment_amount", "Installment amount", row.installment_amount ?? 0)] : [selectInput("applied", "Applied", [{ id: "0", name: "No" }, { id: "1", name: "Yes" }], row.applied ? "1" : "0", (r) => r.name, "")]),
    numberInput("balance", "Balance", row.balance ?? row.amount ?? 0),
    selectInput("status", "Status", ADVANCE_STATUSES.map((status) => ({ id: status, name: status })), row.status || "Open", (r) => r.name, ""),
    textareaInput("notes", "Notes", row.notes || "", 'rows="2"'),
  ];
  const spec = ADVANCE_SPECS[type];
  const errorBox = errors.length ? `<section class="panel"><ul class="error">${errors.map((err) => `<li>${esc(err)}</li>`).join("")}</ul></section>` : "";
  const deleteForm = id ? `<form method="post" action="/advances/${type}/${id}/delete" class="delete-form" onsubmit="return confirm('Delete this ${esc(spec.title)} record?');"><button class="danger">Delete</button></form>` : "";
  return `${errorBox}${formPanel(id ? `/advances/${type}/${id}/edit` : `/advances/${type}/new`, fields, `Save ${spec.title}`)}${deleteForm}`;
}

function advanceWhere(query, alias = "v") {
  if (!query) return { sql: "", params: [] };
  return {
    sql: ` WHERE e.full_name LIKE ? OR e.employee_code LIKE ? OR ${alias}.status LIKE ? OR ${alias}.notes LIKE ?`,
    params: Array(4).fill(`%${query}%`),
  };
}

async function advancesPage(request, env, user, path) {
  const access = requireView(user, "Vale / Cash Advance");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const valePage = Math.max(1, Number(url.searchParams.get("vale_page") || 1) || 1);
  const cashPage = Math.max(1, Number(url.searchParams.get("cash_page") || 1) || 1);
  const valeWhere = advanceWhere(query, "v");
  const cashWhere = advanceWhere(query, "c");
  const [valeCount, cashCount, valeRows, cashRows] = await Promise.all([
    first(env, `SELECT COUNT(*) AS total FROM vale_records v LEFT JOIN employees e ON e.id=v.employee_id${valeWhere.sql}`, valeWhere.params),
    first(env, `SELECT COUNT(*) AS total FROM cash_advances c LEFT JOIN employees e ON e.id=c.employee_id${cashWhere.sql}`, cashWhere.params),
    all(env, `SELECT v.*, e.full_name AS employee_name, e.employee_code FROM vale_records v LEFT JOIN employees e ON e.id=v.employee_id${valeWhere.sql} ORDER BY v.date_granted DESC, v.id DESC LIMIT 25 OFFSET ?`, [...valeWhere.params, (valePage - 1) * 25]),
    all(env, `SELECT c.*, e.full_name AS employee_name, e.employee_code FROM cash_advances c LEFT JOIN employees e ON e.id=c.employee_id${cashWhere.sql} ORDER BY c.date_granted DESC, c.id DESC LIMIT 25 OFFSET ?`, [...cashWhere.params, (cashPage - 1) * 25]),
  ]);
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const toolbar = `<div class="toolbar"><form><input name="q" value="${esc(query)}" placeholder="Search advances"><button>Search</button></form><div>${canEdit(user, "Vale / Cash Advance") ? `<a class="button" href="/advances/vale/new">New Vale</a> <a class="button" href="/advances/cash/new">New Cash Advance</a>` : ""}</div></div>`;
  const valeBody = valeRows.map((row) => `<tr><td>${canEdit(user, "Vale / Cash Advance") ? `<a href="/advances/vale/${row.id}/edit">${esc(row.employee_name || "")}</a>` : esc(row.employee_name || "")}</td><td>${esc(row.date_granted)}</td>${moneyCell(row.amount)}${moneyCell(row.installment_amount)}${moneyCell(row.balance)}<td><span class="status">${esc(row.status)}</span></td><td>${canEdit(user, "Vale / Cash Advance") ? `<a href="/advances/vale/${row.id}/edit">Edit</a>` : `<span class="muted">Read only</span>`}</td></tr>`);
  const cashBody = cashRows.map((row) => `<tr><td>${canEdit(user, "Vale / Cash Advance") ? `<a href="/advances/cash/${row.id}/edit">${esc(row.employee_name || "")}</a>` : esc(row.employee_name || "")}</td><td>${esc(row.date_granted)}</td>${moneyCell(row.amount)}${moneyCell(row.balance)}<td>${row.applied ? "Yes" : "No"}</td><td><span class="status">${esc(row.status)}</span></td><td>${canEdit(user, "Vale / Cash Advance") ? `<a href="/advances/cash/${row.id}/edit">Edit</a>` : `<span class="muted">Read only</span>`}</td></tr>`);
  const content = `${messagePanel(url)}<section class="panel">${toolbar}</section><section class="panel"><div class="toolbar"><h3>Vale</h3><a class="button secondary" href="${esc(`/advances/vale/export.csv${params.toString() ? `?${params.toString()}` : ""}`)}">Export Vale CSV</a></div></section>${table(["Employee", "Date", "Amount", "Installment", "Balance", "Status", "Actions"], valeBody, { empty: "No vale records found." })}${paginationWithPageParam("/advances", new URLSearchParams([...params, ["cash_page", String(cashPage)]]), "vale_page", valePage, Number(valeCount?.total || 0))}<section class="panel"><div class="toolbar"><h3>Cash Advance</h3><a class="button secondary" href="${esc(`/advances/cash/export.csv${params.toString() ? `?${params.toString()}` : ""}`)}">Export Cash CSV</a></div></section>${table(["Employee", "Date", "Amount", "Balance", "Applied", "Status", "Actions"], cashBody, { empty: "No cash advances found." })}${paginationWithPageParam("/advances", new URLSearchParams([...params, ["vale_page", String(valePage)]]), "cash_page", cashPage, Number(cashCount?.total || 0))}`;
  return html(layout({ title: "Vale / Cash Advance", user, path, content }));
}

async function advanceFormPage(request, env, user, path, type, id = null) {
  const spec = ADVANCE_SPECS[type];
  if (!spec) return html("Not found", 404);
  const access = requireEdit(user, spec.page);
  if (access) return errorResponse(access, user, path);
  const row = id ? await first(env, `SELECT * FROM ${spec.table} WHERE id=?`, [id]) : { date_granted: todayISO(), status: "Open" };
  if (id && !row) return html("Not found", 404);
  if (request.method === "POST") {
    const values = advanceValues(await parseForm(request), type);
    const errors = validateAdvance(values, type);
    if (errors.length) return html(layout({ title: `${id ? "Edit" : "New"} ${spec.title}`, user, path, content: await renderAdvanceForm(env, type, values, id, errors) }), 400);
    const fields = Object.keys(values);
    try {
      if (id) await run(env, `UPDATE ${spec.table} SET ${fields.map((field) => `${field}=?`).join(", ")} WHERE id=?`, [...fields.map((field) => values[field]), id]);
      else await run(env, `INSERT INTO ${spec.table} (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`, fields.map((field) => values[field]));
      return redirect(`/advances?ok=${encodeURIComponent(`${spec.title} ${id ? "updated" : "saved"}.`)}`);
    } catch (error) {
      return html(layout({ title: `${id ? "Edit" : "New"} ${spec.title}`, user, path, content: await renderAdvanceForm(env, type, values, id, [`Could not save ${spec.title}: ${error.message || error}`]) }), 400);
    }
  }
  return html(layout({ title: `${id ? "Edit" : "New"} ${spec.title}`, user, path, content: await renderAdvanceForm(env, type, row, id) }));
}

async function advanceDeletePage(request, env, user, path, type, id) {
  const spec = ADVANCE_SPECS[type];
  if (!spec) return html("Not found", 404);
  const access = requireEdit(user, spec.page);
  if (access) return errorResponse(access, user, path);
  if (request.method !== "POST") return html(layout({ title: "Method Not Allowed", user, path, content: `<section class="panel"><p class="error">Delete requires POST.</p></section>` }), 405);
  await run(env, `DELETE FROM ${spec.table} WHERE id=?`, [id]);
  return redirect(`/advances?ok=${encodeURIComponent(`${spec.title} deleted.`)}`);
}

async function advanceExportPage(request, env, user, path, type) {
  const spec = ADVANCE_SPECS[type];
  if (!spec) return html("Not found", 404);
  const access = requireView(user, spec.page);
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const alias = type === "vale" ? "v" : "c";
  const where = advanceWhere((url.searchParams.get("q") || "").trim(), alias);
  const rows = await all(env, `SELECT ${alias}.*, e.full_name AS employee_name, e.employee_code FROM ${spec.table} ${alias} LEFT JOIN employees e ON e.id=${alias}.employee_id${where.sql} ORDER BY ${alias}.id`, where.params);
  const lines = [type === "vale" ? "ID,Employee,Date,Amount,Installment Amount,Balance,Status" : "ID,Employee,Date,Amount,Balance,Applied,Status"];
  for (const row of rows) {
    lines.push(type === "vale"
      ? quotedCsvRow([row.id, row.employee_name || "", row.date_granted, row.amount, row.installment_amount, row.balance, row.status])
      : quotedCsvRow([row.id, row.employee_name || "", row.date_granted, row.amount, row.balance, row.applied ? "Yes" : "No", row.status]));
  }
  return csv(lines.join("\n"), `${spec.table}.csv`);
}

async function reportList(env, user, path) {
  const access = requireView(user, "Reports");
  if (access) return errorResponse(access, user, path);
  const trips = await all(env, "SELECT trip_ticket_no, trip_date, status, base_trip_rate FROM trips ORDER BY trip_date DESC LIMIT 50");
  const body = trips.map((t) => `<tr><td>${esc(t.trip_ticket_no)}</td><td>${esc(t.trip_date)}</td><td>${esc(t.status)}</td>${moneyCell(t.base_trip_rate)}</tr>`);
  return html(layout({ title: "Reports", user, path, content: `<section class="panel"><p>Initial Cloudflare report shell. Full 12-report parity ports in later phases.</p></section>${table(["Trip Ticket / Waybill", "Date", "Status", "Base Rate"], body)}` }));
}

async function placeholder(title, user, path, page) {
  const access = requireView(user, page);
  if (access) return errorResponse(access, user, path);
  return html(layout({ title, user, path, content: `<section class="panel"><p>${esc(title)} route is wired for the Cloudflare rewrite. Full workflow parity will be ported from Django in the matching migration phase.</p></section>` }));
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (path === "/health") return json({ ok: true, runtime: "cloudflare", database: Boolean(env.DB) });
  if (path === "/login") return login(request, env);
  if (path === "/logout" && request.method === "POST") return redirectWithHeaders("/login", clearSessionHeaders());

  const user = await readSession(request, env);
  if (!user) return redirect("/login");

  if (path === "/") return dashboardPage(env, user, path);
  for (const [base, spec] of Object.entries(MASTER)) {
    if (path === base) return masterList(request, env, user, path, spec);
    if (path === `${base}/new`) return masterForm(request, env, user, base, spec);
    const edit = path.match(new RegExp(`^${base}/(\\d+)/edit$`));
    if (edit) return masterForm(request, env, user, base, spec, Number(edit[1]));
    const del = path.match(new RegExp(`^${base}/(\\d+)/delete$`));
    if (del) return masterDelete(request, env, user, base, spec, Number(del[1]));
    if (path === `${base}/export.csv`) return masterExport(request, env, user, base, spec);
  }
  let match;
  if (path === "/recurring-trips") return recurringListPage(request, env, user, path);
  if (path === "/recurring-trips/new") return recurringFormPage(request, env, user, path);
  match = path.match(/^\/recurring-trips\/(\d+)\/edit$/);
  if (match) return recurringFormPage(request, env, user, path, Number(match[1]));
  match = path.match(/^\/recurring-trips\/(\d+)\/delete$/);
  if (match) return recurringDeletePage(request, env, user, path, Number(match[1]));
  if (path === "/recurring-trips/export.csv") return recurringExportPage(request, env, user, path);
  if (path === "/trips") return tripListPage(request, env, user, path);
  if (path === "/trips/new") return tripFormPage(request, env, user, path);
  if (path === "/trips/export.csv") return tripExportPage(request, env, user, path);
  match = path.match(/^\/trips\/(\d+)\/print$/);
  if (match) return tripDetailPage(request, env, user, path, Number(match[1]), true);
  match = path.match(/^\/trips\/(\d+)\/edit$/);
  if (match) return tripFormPage(request, env, user, path, Number(match[1]));
  match = path.match(/^\/trips\/(\d+)\/delete$/);
  if (match) return tripDeletePage(request, env, user, path, Number(match[1]));
  match = path.match(/^\/trips\/(\d+)$/);
  if (match) return tripDetailPage(request, env, user, path, Number(match[1]));
  if (path === "/repairs") return repairsPage(request, env, user, path);
  if (path === "/repairs/new") return repairFormPage(request, env, user, path);
  if (path === "/repairs/export.csv") return repairExportPage(request, env, user, path);
  match = path.match(/^\/repairs\/(\d+)\/edit$/);
  if (match) return repairFormPage(request, env, user, path, Number(match[1]));
  match = path.match(/^\/repairs\/(\d+)\/delete$/);
  if (match) return repairDeletePage(request, env, user, path, Number(match[1]));
  if (path === "/payables") return payablesPage(request, env, user, path);
  if (path === "/payables/new") return payableFormPage(request, env, user, path);
  if (path === "/payables/export.csv") return payableExportPage(request, env, user, path);
  match = path.match(/^\/payables\/(\d+)\/edit$/);
  if (match) return payableFormPage(request, env, user, path, Number(match[1]));
  match = path.match(/^\/payables\/(\d+)\/delete$/);
  if (match) return payableDeletePage(request, env, user, path, Number(match[1]));
  if (path === "/advances") return advancesPage(request, env, user, path);
  if (path === "/advances/vale/new") return advanceFormPage(request, env, user, path, "vale");
  if (path === "/advances/cash/new") return advanceFormPage(request, env, user, path, "cash");
  if (path === "/advances/vale/export.csv") return advanceExportPage(request, env, user, path, "vale");
  if (path === "/advances/cash/export.csv") return advanceExportPage(request, env, user, path, "cash");
  match = path.match(/^\/advances\/(vale|cash)\/(\d+)\/edit$/);
  if (match) return advanceFormPage(request, env, user, path, match[1], Number(match[2]));
  match = path.match(/^\/advances\/(vale|cash)\/(\d+)\/delete$/);
  if (match) return advanceDeletePage(request, env, user, path, match[1], Number(match[2]));
  if (path === "/reports") return reportList(env, user, path);
  if (path === "/payroll") return placeholder("Payroll", user, path, "Payroll");
  if (path === "/billing") return placeholder("Billing", user, path, "Billing");
  if (path === "/collections") return placeholder("Collections", user, path, "Collections");
  if (path === "/users") return placeholder("User Management", user, path, "User Management");
  return html(layout({ title: "Not Found", user, path, content: `<section class="panel"><p>Route not found.</p></section>` }), 404);
}
