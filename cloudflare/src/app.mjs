import { canEdit, requireEdit, requireView } from "./access.mjs";
import { createSession, clearSessionHeaders, readSession, sessionHeaders, verifyPassword } from "./auth.mjs";
import { all, dashboard, first, run } from "./db.mjs";
import { cards, formPanel, layout, loginPage, moneyCell, numberInput, selectInput, table, textareaInput, textInput } from "./html.mjs";
import { EXTRA_FIELDS, HELPER_LIMITS, applyVat, billingStatus, calculateNet, choiceLabel, nextTripTicketNo, outstandingBalance, tripBillableTotal, tripExtraTotal } from "./services.mjs";
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

const PAYROLL_DEDUCTION_FIELDS = [
  "vale_deduction", "cash_advance_deduction", "sss", "philhealth", "pagibig",
  "withholding_tax", "change_deduction", "other_deduction",
];

function payrollWhere(query) {
  if (!query) return { sql: "", params: [] };
  return {
    sql: " WHERE e.full_name LIKE ? OR e.employee_code LIKE ? OR p.employee_type LIKE ? OR p.remarks LIKE ?",
    params: Array(4).fill(`%${query}%`),
  };
}

function payrollMoneyValues(data) {
  const values = {
    days_count: numericText(data.days_count),
    gross_pay: numericText(data.gross_pay),
    additional_pay: numericText(data.additional_pay),
  };
  for (const field of PAYROLL_DEDUCTION_FIELDS) values[field] = numericText(data[field]);
  return values;
}

function deductionTotal(row) {
  return PAYROLL_DEDUCTION_FIELDS.reduce((sum, field) => sum + numeric(row?.[field]), 0);
}

function periodStartToday() {
  return `${todayISO().slice(0, 8)}01`;
}

function parseExpectedIds(raw) {
  try {
    return JSON.parse(raw || "[]").map((value) => Number(value)).filter(Boolean);
  } catch {
    return [];
  }
}

async function payrollEmployees(env) {
  return await all(env, "SELECT * FROM employees WHERE active=1 ORDER BY full_name, id");
}

async function loadPayrollEmployee(env, id) {
  if (!id) return null;
  return await first(env, "SELECT * FROM employees WHERE id=? AND active=1", [id]);
}

async function payrollTripItems(env, tripId, employeeType) {
  return await all(env, "SELECT * FROM trip_employee_pay_items WHERE trip_id=? AND employee_type=? ORDER BY sort_order, id", [tripId, employeeType]);
}

async function payrollEligibleTrips(env, employee, periodFrom, periodTo) {
  if (!employee || !periodFrom || !periodTo) return [];
  if (employee.employee_type === "Driver") {
    return await all(env, `SELECT t.*, a.asset_code, (SELECT COUNT(*) FROM trip_helpers th WHERE th.trip_id=t.id) AS helper_count FROM trips t LEFT JOIN assets a ON a.id=t.asset_id WHERE t.trip_date BETWEEN ? AND ? AND t.status IN ('Completed','Billed','Paid') AND t.driver_id=? AND NOT EXISTS (SELECT 1 FROM payroll_trips pt WHERE pt.trip_id=t.id AND pt.employee_id=?) ORDER BY t.trip_date, t.trip_ticket_no, t.id`, [periodFrom, periodTo, employee.id, employee.id]);
  }
  if (employee.employee_type === "Helper") {
    return await all(env, `SELECT t.*, a.asset_code, (SELECT COUNT(*) FROM trip_helpers th2 WHERE th2.trip_id=t.id) AS helper_count FROM trips t JOIN trip_helpers th ON th.trip_id=t.id LEFT JOIN assets a ON a.id=t.asset_id WHERE t.trip_date BETWEEN ? AND ? AND t.status IN ('Completed','Billed','Paid') AND th.employee_id=? AND NOT EXISTS (SELECT 1 FROM payroll_trips pt WHERE pt.trip_id=t.id AND pt.employee_id=?) ORDER BY t.trip_date, t.trip_ticket_no, t.id`, [periodFrom, periodTo, employee.id, employee.id]);
  }
  return [];
}

async function payrollAdvancePlan(env, table, employeeId) {
  return await all(env, `SELECT * FROM ${table} WHERE employee_id=? AND status='Open' AND balance>0 ORDER BY date_granted, id`, [employeeId]);
}

async function payrollPreview(env, employeeId, periodFrom, periodTo) {
  const employee = await loadPayrollEmployee(env, employeeId);
  if (!employee) return null;
  const trips = await payrollEligibleTrips(env, employee, periodFrom, periodTo);
  let gross = 0;
  const lineTotals = new Map();
  const tripRows = [];
  for (const trip of trips) {
    const helperCount = Math.max(0, Number(trip.helper_count || 0));
    const baseAmount = employee.employee_type === "Driver" ? numeric(trip.driver_pay_rate) : helperCount ? numeric(trip.helper_pay_rate) / helperCount : 0;
    gross += baseAmount;
    tripRows.push({ ...trip, payroll_amount: baseAmount });
    const items = await payrollTripItems(env, trip.id, employee.employee_type);
    if (items.length) {
      for (const item of items) {
        const amount = employee.employee_type === "Helper" ? (helperCount ? numeric(item.amount) / helperCount : 0) : numeric(item.amount);
        if (amount > 0) lineTotals.set(item.label, numeric(lineTotals.get(item.label)) + amount);
      }
    } else {
      const fallback = employee.employee_type === "Driver" ? numeric(trip.driver_additional_pay) : numeric(trip.helper_additional_pay);
      const amount = employee.employee_type === "Helper" ? (helperCount ? fallback / helperCount : 0) : fallback;
      if (amount > 0) lineTotals.set(employee.employee_type === "Driver" ? "Driver Pay Item" : "Helper Pay Item", numeric(lineTotals.get(employee.employee_type === "Driver" ? "Driver Pay Item" : "Helper Pay Item")) + amount);
    }
  }
  const additionalLines = [...lineTotals.entries()].map(([label, amount], index) => ({ employee_type: employee.employee_type, label, amount, sort_order: index + 1 }));
  const additionalPay = additionalLines.reduce((sum, line) => sum + numeric(line.amount), 0);
  const valePlan = await payrollAdvancePlan(env, "vale_records", employee.id);
  const cashPlan = await payrollAdvancePlan(env, "cash_advances", employee.id);
  const valeDeduction = valePlan.reduce((sum, row) => sum + Math.min(numeric(row.balance), numeric(row.installment_amount) || numeric(row.balance)), 0);
  const cashDeduction = cashPlan.reduce((sum, row) => sum + numeric(row.balance), 0);
  let unitDescription = "Manual payroll entry";
  if (employee.employee_type === "Driver") unitDescription = `${trips.length} trip(s)`;
  else if (employee.employee_type === "Helper") unitDescription = `${trips.length} helper trip(s)`;
  else if (employee.employee_type === "Operator" || employee.payroll_basis === "Per Day") unitDescription = "Enter days worked manually or override amount";
  return {
    employee,
    employee_type: employee.employee_type,
    payroll_basis: employee.payroll_basis || "Manual",
    period_from: periodFrom,
    period_to: periodTo,
    unit_description: unitDescription,
    trips,
    tripRows,
    trips_count: trips.length,
    gross_pay: gross,
    additional_pay: additionalPay,
    driver_trip_additional_pay: employee.employee_type === "Driver" ? additionalPay : 0,
    helper_trip_additional_pay: employee.employee_type === "Helper" ? additionalPay : 0,
    additionalLines,
    valePlan,
    cashPlan,
    vale_deduction: valeDeduction,
    cash_advance_deduction: cashDeduction,
  };
}

function payrollTripTable(preview) {
  const rows = (preview?.tripRows || []).map((row) => `<tr><td>${esc(row.trip_date)}</td><td><a href="/trips/${row.id}">${esc(row.trip_ticket_no)}</a></td><td>${esc(row.asset_code || "")}</td><td>${esc(row.origin || "")} → ${esc(row.destination || "")}</td><td>${esc(row.job_description || "")}</td>${moneyCell(row.payroll_amount)}</tr>`);
  return table(["Date", "Trip Ticket / Waybill", "Unit", "Route", "Item / Job", "Base Pay"], rows, { empty: "No eligible trip rows. Enter Per-Day or Manual earnings above." });
}

function payrollFormContent(employees, selection, preview, values = {}, errors = []) {
  const employeeId = selection.employee || values.employee || "";
  const periodFrom = selection.period_from || values.period_from || periodStartToday();
  const periodTo = selection.period_to || values.period_to || todayISO();
  const selector = `<section class="panel payroll-selector"><h3>1. Select Employee & Period</h3><form method="get" class="selector-row"><label>Employee<select name="employee" required><option value="">Select employee</option>${employees.map((employee) => `<option value="${esc(employee.id)}"${String(employeeId) === String(employee.id) ? " selected" : ""}>${esc(choiceLabel("employee", employee))}</option>`).join("")}</select></label><label>Period From<input type="date" name="period_from" value="${esc(periodFrom)}" required></label><label>Period To<input type="date" name="period_to" value="${esc(periodTo)}" required></label><button>Preview Payroll</button></form></section>`;
  const errorBox = errors.length ? `<section class="panel"><ul class="error">${errors.map((err) => `<li>${esc(err)}</li>`).join("")}</ul></section>` : "";
  if (!preview) return `${errorBox}${selector}<section class="panel empty-workspace"><p>Select an employee and period, then choose <strong>Preview Payroll</strong>.</p></section>`;
  const formValues = {
    pay_date: todayISO(),
    unit_description: preview.unit_description,
    days_count: 0,
    gross_pay: preview.gross_pay,
    additional_pay: preview.additional_pay,
    vale_deduction: preview.vale_deduction,
    cash_advance_deduction: preview.cash_advance_deduction,
    sss: 0, philhealth: 0, pagibig: 0, withholding_tax: 0, change_deduction: 0, other_deduction: 0,
    remarks: "",
    ...values,
  };
  const hidden = `<input type="hidden" name="employee" value="${esc(preview.employee.id)}"><input type="hidden" name="period_from" value="${esc(periodFrom)}"><input type="hidden" name="period_to" value="${esc(periodTo)}"><input type="hidden" name="expected_trip_ids" value="${esc(JSON.stringify(preview.trips.map((trip) => trip.id)))}">`;
  const fields = [
    textInput("pay_date", "Pay date", formValues.pay_date, 'type="date" required'),
    textInput("unit_description", "Unit description", formValues.unit_description),
    numberInput("days_count", "Days count", formValues.days_count),
    numberInput("gross_pay", "Gross pay", formValues.gross_pay),
    numberInput("additional_pay", "Additional pay", formValues.additional_pay),
    numberInput("vale_deduction", "Vale deduction", formValues.vale_deduction),
    numberInput("cash_advance_deduction", "Cash advance deduction", formValues.cash_advance_deduction),
    numberInput("sss", "SSS", formValues.sss),
    numberInput("philhealth", "PhilHealth", formValues.philhealth),
    numberInput("pagibig", "Pag-IBIG", formValues.pagibig),
    numberInput("withholding_tax", "Withholding tax", formValues.withholding_tax),
    numberInput("change_deduction", "Change deduction", formValues.change_deduction),
    numberInput("other_deduction", "Other deduction", formValues.other_deduction),
    textareaInput("remarks", "Remarks", formValues.remarks, 'rows="3"'),
  ];
  const previewSummary = `<section class="panel">${cards([["Employee", preview.employee.full_name], ["Type / Basis", `${preview.employee_type} / ${preview.payroll_basis}`], ["Eligible Trips", String(preview.trips_count)], ["Preview Gross", peso(preview.gross_pay)]])}<dl class="payroll-limits"><dt>Remaining Vale</dt><dd>${esc(peso(preview.vale_deduction))}</dd><dt>Remaining Cash Advance</dt><dd>${esc(peso(preview.cash_advance_deduction))}</dd></dl></section>`;
  const additional = preview.additionalLines.length ? `<section class="panel"><h3>Trip Pay Items</h3>${preview.additionalLines.map((line) => `<div class="detail-pay-row"><span>${esc(line.label)}</span><strong>${esc(peso(line.amount))}</strong></div>`).join("")}</section>` : "";
  return `${errorBox}${selector}${previewSummary}<form method="post" action="/payroll/new" class="panel">${hidden}<div class="grid">${fields.join("")}</div><p><button>Save Payroll</button> <a class="button secondary" href="/payroll">Cancel</a></p></form><section class="panel payroll-preview-table"><h3>Eligible Trip Earnings</h3></section>${payrollTripTable(preview)}${additional}`;
}

function payrollCleaned(data, preview) {
  const amounts = payrollMoneyValues(data);
  const deductions = Object.fromEntries(PAYROLL_DEDUCTION_FIELDS.map((field) => [field, amounts[field]]));
  return {
    employee_id: data.employee,
    period_from: data.period_from,
    period_to: data.period_to,
    pay_date: data.pay_date || todayISO(),
    unit_description: (data.unit_description || preview?.unit_description || "").trim(),
    days_count: amounts.days_count,
    gross_pay: amounts.gross_pay,
    additional_pay: amounts.additional_pay,
    deductions,
    remarks: (data.remarks || "").trim(),
    expected_trip_ids: parseExpectedIds(data.expected_trip_ids),
  };
}

function validatePayroll(cleaned, preview) {
  const errors = [];
  if (!cleaned.employee_id || !cleaned.period_from || !cleaned.period_to) errors.push("Employee and payroll period are required.");
  if (cleaned.period_from && cleaned.period_to && cleaned.period_from > cleaned.period_to) errors.push("Period end must be on or after period start.");
  for (const field of ["days_count", "gross_pay", ...PAYROLL_DEDUCTION_FIELDS]) {
    const value = field in cleaned ? cleaned[field] : cleaned.deductions[field];
    if (numeric(value) < 0) errors.push(`${field.replaceAll("_", " ")} cannot be negative.`);
  }
  if (preview) {
    if (numeric(cleaned.deductions.vale_deduction) > numeric(preview.vale_deduction)) errors.push("Deduction cannot exceed the remaining Vale total.");
    if (numeric(cleaned.deductions.cash_advance_deduction) > numeric(preview.cash_advance_deduction)) errors.push("Deduction cannot exceed the remaining Cash Advance balance.");
    const freshIds = preview.trips.map((trip) => Number(trip.id));
    if (JSON.stringify(freshIds) !== JSON.stringify(cleaned.expected_trip_ids)) errors.push("Payroll eligibility changed. Preview the period again before saving.");
  }
  return errors;
}

async function createdPayrollId(env, values) {
  const row = await first(env, "SELECT id FROM payroll_entries WHERE employee_id=? AND pay_date=? ORDER BY id DESC LIMIT 1", [values.employee_id, values.pay_date]);
  return row?.id;
}

async function applyAdvancePlan(env, table, plan, requested, { cash = false } = {}) {
  let remaining = numeric(requested);
  for (const row of plan) {
    if (remaining <= 0) break;
    const applied = Math.min(remaining, numeric(row.balance));
    const balance = Math.max(0, numeric(row.balance) - applied);
    const status = balance <= 0 ? "Paid" : "Open";
    if (cash) await run(env, `UPDATE ${table} SET balance=?, status=?, applied=? WHERE id=?`, [String(balance), status, balance <= 0 ? "1" : "0", row.id]);
    else await run(env, `UPDATE ${table} SET balance=?, status=? WHERE id=?`, [String(balance), status, row.id]);
    remaining -= applied;
  }
  if (remaining > 0) throw new Error("The requested advance deduction is greater than the available open balance.");
}

async function savePayroll(env, cleaned, preview) {
  const manualAdditional = numeric(cleaned.additional_pay) - numeric(preview.additional_pay);
  const netPay = calculateNet(cleaned.gross_pay, cleaned.additional_pay, cleaned.deductions);
  const values = {
    pay_date: cleaned.pay_date,
    period_from: cleaned.period_from,
    period_to: cleaned.period_to,
    employee_id: cleaned.employee_id,
    employee_type: preview.employee_type,
    payroll_basis: preview.payroll_basis,
    unit_description: cleaned.unit_description || preview.unit_description,
    trips_count: String(preview.trips.length),
    days_count: cleaned.days_count,
    gross_pay: cleaned.gross_pay,
    additional_pay: cleaned.additional_pay,
    driver_trip_additional_pay: String(preview.driver_trip_additional_pay),
    helper_trip_additional_pay: String(preview.helper_trip_additional_pay),
    ...cleaned.deductions,
    net_pay: String(netPay),
    remarks: cleaned.remarks,
  };
  const fields = Object.keys(values);
  const result = await run(env, `INSERT INTO payroll_entries (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`, fields.map((field) => values[field]));
  const payrollId = result?.meta?.last_row_id || await createdPayrollId(env, values);
  for (const trip of preview.trips) await run(env, "INSERT INTO payroll_trips (payroll_id, trip_id, employee_id) VALUES (?,?,?)", [payrollId, trip.id, cleaned.employee_id]);
  const lines = [...preview.additionalLines];
  if (manualAdditional) lines.push({ employee_type: "Manual", label: "Manual Additional Pay", amount: manualAdditional, sort_order: lines.length + 1 });
  for (const line of lines.filter((line) => numeric(line.amount))) {
    await run(env, "INSERT INTO payroll_additional_lines (payroll_id, employee_type, label, amount, sort_order) VALUES (?,?,?,?,?)", [payrollId, line.employee_type, line.label, String(line.amount), line.sort_order]);
  }
  await applyAdvancePlan(env, "vale_records", preview.valePlan, cleaned.deductions.vale_deduction);
  await applyAdvancePlan(env, "cash_advances", preview.cashPlan, cleaned.deductions.cash_advance_deduction, { cash: true });
  return payrollId;
}

async function payrollListPage(request, env, user, path) {
  const access = requireView(user, "Payroll");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const where = payrollWhere(query);
  const countRow = await first(env, `SELECT COUNT(*) AS total FROM payroll_entries p LEFT JOIN employees e ON e.id=p.employee_id${where.sql}`, where.params);
  const rows = await all(env, `SELECT p.*, e.full_name, e.employee_code FROM payroll_entries p LEFT JOIN employees e ON e.id=p.employee_id${where.sql} ORDER BY p.pay_date DESC, p.id DESC LIMIT 25 OFFSET ?`, [...where.params, (page - 1) * 25]);
  const body = rows.map((row) => `<tr><td>${esc(row.pay_date)}</td><td>${esc(row.period_from)} – ${esc(row.period_to)}</td><td><a href="/payroll/${row.id}">${esc(row.full_name || "")}</a><small class="cell-detail">${esc(row.employee_code || "")}</small></td><td>${esc(row.employee_type)}<small class="cell-detail">${esc(row.payroll_basis)}</small></td><td>${esc(row.trips_count)}</td><td>${esc(row.days_count)}</td>${moneyCell(row.gross_pay)}${moneyCell(row.additional_pay)}${moneyCell(deductionTotal(row))}<td class="num"><strong>${esc(peso(row.net_pay))}</strong></td><td><a href="/payroll/${row.id}">View</a> <a href="/payroll/${row.id}/print" target="_blank">Print</a></td></tr>`);
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const toolbar = `<div class="toolbar"><form><input name="q" value="${esc(query)}" placeholder="Search employee, type, or remarks"><button>Search</button></form><div>${canEdit(user, "Payroll") ? `<a class="button" href="/payroll/new">New Payroll</a>` : ""} <a class="button secondary" href="${esc(`/payroll/export.csv${params.toString() ? `?${params.toString()}` : ""}`)}">Export CSV</a></div></div>`;
  const content = `${messagePanel(url)}<section class="panel">${toolbar}</section>${table(["Pay Date", "Period", "Employee", "Type / Basis", "Trips", "Days", "Gross", "Additional", "Deductions", "Net", "Actions"], body, { empty: "No payroll entries found." })}${paginationWithParams("/payroll", params, page, Number(countRow?.total || 0))}`;
  return html(layout({ title: "Payroll", user, path, content }));
}

async function payrollNewPage(request, env, user, path) {
  const access = requireEdit(user, "Payroll");
  if (access) return errorResponse(access, user, path);
  const employees = await payrollEmployees(env);
  const source = request.method === "POST" ? await parseForm(request) : Object.fromEntries(new URL(request.url).searchParams.entries());
  const selection = {
    employee: source.employee || "",
    period_from: source.period_from || periodStartToday(),
    period_to: source.period_to || todayISO(),
  };
  const preview = selection.employee ? await payrollPreview(env, selection.employee, selection.period_from, selection.period_to) : null;
  if (request.method === "POST") {
    const cleaned = payrollCleaned(source, preview);
    const errors = preview ? validatePayroll(cleaned, preview) : ["Employee or payroll period is invalid. Preview the period again."];
    if (errors.length) return html(layout({ title: "New Payroll", user, path, content: payrollFormContent(employees, selection, preview, source, errors) }), 400);
    try {
      const id = await savePayroll(env, cleaned, preview);
      return redirect(`/payroll/${id}?ok=${encodeURIComponent("Payroll entry saved and advance deductions applied.")}`);
    } catch (error) {
      return html(layout({ title: "New Payroll", user, path, content: payrollFormContent(employees, selection, preview, source, [error.message || String(error)]) }), 400);
    }
  }
  return html(layout({ title: "New Payroll", user, path, content: payrollFormContent(employees, selection, preview) }));
}

async function loadPayrollEntry(env, id) {
  const entry = await first(env, "SELECT p.*, e.full_name, e.employee_code FROM payroll_entries p LEFT JOIN employees e ON e.id=p.employee_id WHERE p.id=?", [id]);
  if (!entry) return null;
  entry.trips = await all(env, `SELECT pt.*, t.trip_date, t.trip_ticket_no, t.origin, t.destination, t.job_description, t.driver_pay_rate, t.helper_pay_rate, t.driver_additional_pay, t.helper_additional_pay, a.asset_code, (SELECT COUNT(*) FROM trip_helpers th WHERE th.trip_id=t.id) AS helper_count FROM payroll_trips pt JOIN trips t ON t.id=pt.trip_id LEFT JOIN assets a ON a.id=t.asset_id WHERE pt.payroll_id=? ORDER BY t.trip_date, t.trip_ticket_no, t.id`, [id]);
  entry.lines = await all(env, "SELECT * FROM payroll_additional_lines WHERE payroll_id=? ORDER BY sort_order, id", [id]);
  entry.remaining_vale = (await all(env, "SELECT balance FROM vale_records WHERE employee_id=? AND balance>0", [entry.employee_id])).reduce((sum, row) => sum + numeric(row.balance), 0);
  entry.remaining_cash = (await all(env, "SELECT balance FROM cash_advances WHERE employee_id=? AND balance>0", [entry.employee_id])).reduce((sum, row) => sum + numeric(row.balance), 0);
  return entry;
}

function payrollTripAmount(entry, trip) {
  if (entry.employee_type === "Driver") return numeric(trip.driver_pay_rate);
  if (entry.employee_type === "Helper") return numeric(trip.helper_count) ? numeric(trip.helper_pay_rate) / numeric(trip.helper_count) : 0;
  return 0;
}

function payrollDetailContent(entry, user, print = false) {
  const deductions = [
    ["Vale", entry.vale_deduction], ["Cash Advance", entry.cash_advance_deduction],
    ["SSS", entry.sss], ["PhilHealth", entry.philhealth], ["Pag-IBIG", entry.pagibig],
    ["Withholding Tax", entry.withholding_tax], ["Change Deduction", entry.change_deduction], ["Other Deduction", entry.other_deduction],
  ];
  const tripRows = (entry.trips || []).map((trip) => ({ ...trip, payroll_amount: payrollTripAmount(entry, trip) }));
  if (print) {
    const rows = tripRows.map((row) => `<tr><td>${esc(row.trip_date)}</td><td class="center">1</td><td class="num">${esc(money(row.payroll_amount))}</td><td>${esc(row.trip_ticket_no)}</td><td>${esc(row.origin || "")} to ${esc(row.destination || "")}</td><td>${esc(row.job_description || "")}</td><td class="num">${esc(money(row.payroll_amount))}</td></tr>`).join("") || `<tr><td colspan="7" class="center">No trip-level payroll detail captured for this entry.</td></tr>`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>Payroll #${esc(entry.id)}</title><style>@page{size:A5 landscape;margin:8mm}body{font:12px Arial,sans-serif;color:#111;margin:0}.sheet{padding:2mm 4mm 24mm}.print-button{margin-bottom:8px}.top{display:flex;justify-content:space-between;gap:12px}.top h1{font-size:20px;margin:0 0 5px}.top h2{font-size:16px;margin:0;text-align:right}.meta{font-size:14px;margin:3px 0}table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border:1px solid #222;padding:5px 6px;vertical-align:top}th{background:#f0f0f0}.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.center{text-align:center}.summary{display:grid;grid-template-columns:1fr 1.1fr 1.05fr;gap:10px;align-items:start}.net{text-align:right;font-size:18px;font-weight:bold;margin-top:8px}.remarks-box{min-height:78px;white-space:pre-wrap}.remaining-balances{margin-top:8px}.signature{position:fixed;right:12mm;bottom:8mm;width:240px;border-top:1px solid #111;text-align:center;padding-top:6px;background:#fff}@media print{.print-button{display:none}}</style></head><body><div class="sheet"><button class="print-button" onclick="window.print()">Print</button><div class="top"><div><h1>Payroll for ${esc(entry.period_from)} to ${esc(entry.period_to)}</h1><div class="meta"><strong>Payroll ID:</strong> ${esc(entry.id)}</div><div class="meta"><strong>Name of ${esc(entry.employee_type)}:</strong> ${esc(entry.full_name || "")}</div><div class="meta"><strong>Work:</strong> ${esc(entry.unit_description || "")}</div></div><h2>${esc(entry.pay_date)}</h2></div><table><thead><tr><th>Date</th><th>Trips</th><th>Rate</th><th>Trip Ticket / Waybill</th><th>Origin-Destination</th><th>Item / Job</th><th>Amount</th></tr></thead><tbody>${rows}<tr><td></td><td class="center"><strong>${esc(entry.trips_count)}</strong></td><td colspan="4" class="num"><strong>Gross Pay</strong></td><td class="num"><strong>${esc(peso(entry.gross_pay))}</strong></td></tr></tbody></table><div class="summary"><table><tr><th colspan="2">Payroll Summary</th></tr><tr><td>Days Count</td><td>${esc(entry.days_count)}</td></tr><tr><td>Additional Pay</td><td class="num">${esc(peso(entry.additional_pay))}</td></tr></table><div><table><tr><th>Remarks</th></tr><tr><td class="remarks-box">${esc(entry.remarks || "")}</td></tr></table><table class="remaining-balances"><tr><td>Remaining Vale</td><td class="num">${esc(peso(entry.remaining_vale))}</td></tr><tr><td>Remaining Cash Advance</td><td class="num">${esc(peso(entry.remaining_cash))}</td></tr></table></div><div><table><tr><th colspan="2">Deductions</th></tr>${deductions.map(([label, amount]) => `<tr><td>${esc(label)}</td><td class="num">${numeric(amount) ? esc(peso(amount)) : ""}</td></tr>`).join("")}</table><div class="net">Net Pay: ${esc(peso(entry.net_pay))}</div></div></div><div class="signature">Received by: / Employee Signature</div></div></body></html>`;
  }
  const tripBody = tripRows.map((row) => `<tr><td>${esc(row.trip_date)}</td><td><a href="/trips/${row.trip_id}">${esc(row.trip_ticket_no)}</a></td><td>${esc(row.asset_code || "")}</td><td>${esc(row.origin || "")} → ${esc(row.destination || "")}</td><td>${esc(row.job_description || "")}</td>${moneyCell(row.payroll_amount)}</tr>`);
  const lines = (entry.lines || []).map((line) => `<div class="detail-pay-row"><span>${esc(line.label)} <small>${esc(line.employee_type)}</small></span><strong>${esc(peso(line.amount))}</strong></div>`).join("") || `<p class="muted">No additional lines.</p>`;
  const main = `<section class="panel detail-hero"><div><span class="dialog-kicker">Payroll #${esc(entry.id)}</span><h3>${esc(entry.full_name || "")}</h3><p>${esc(entry.period_from)} – ${esc(entry.period_to)} · ${esc(entry.employee_type)} / ${esc(entry.payroll_basis)}</p></div><strong>${esc(peso(entry.net_pay))}</strong></section><div class="detail-grid"><section class="panel"><h3>Payroll Summary</h3><dl class="detail-list"><dt>Pay Date</dt><dd>${esc(entry.pay_date)}</dd><dt>Work</dt><dd>${esc(entry.unit_description)}</dd><dt>Trips</dt><dd>${esc(entry.trips_count)}</dd><dt>Gross</dt><dd>${esc(peso(entry.gross_pay))}</dd><dt>Additional</dt><dd>${esc(peso(entry.additional_pay))}</dd><dt>Deductions</dt><dd>${esc(peso(deductionTotal(entry)))}</dd><dt class="detail-total">Net Pay</dt><dd class="detail-total">${esc(peso(entry.net_pay))}</dd></dl></section><section class="panel"><h3>Deductions</h3><dl class="detail-list">${deductions.map(([label, amount]) => `<dt>${esc(label)}</dt><dd>${esc(peso(amount))}</dd>`).join("")}</dl></section><section class="panel"><h3>Remarks</h3><p>${esc(entry.remarks || "")}</p><dl class="detail-list"><dt>Remaining Vale</dt><dd>${esc(peso(entry.remaining_vale))}</dd><dt>Remaining Cash Advance</dt><dd>${esc(peso(entry.remaining_cash))}</dd></dl></section><section class="panel"><h3>Additional Lines</h3>${lines}</section></div><section class="panel"><h3>Claimed Trips</h3></section>${table(["Date", "Trip Ticket / Waybill", "Unit", "Route", "Item / Job", "Amount"], tripBody, { empty: "No trip-level payroll detail captured for this entry." })}`;
  const actions = `<div class="detail-toolbar"><a class="button secondary" href="/payroll">← Payroll List</a><div><a class="button secondary" href="/payroll/${entry.id}/print" target="_blank">Printable Payroll</a></div></div>`;
  const deleteForm = canEdit(user, "Payroll") ? `<section class="detail-danger"><form method="post" action="/payroll/${entry.id}/delete" onsubmit="return confirm('Delete this payroll? Claimed trips will be released and advance deductions restored.');"><button class="danger-button">Delete and Reverse Payroll</button></form></section>` : "";
  return `${actions}${main}${deleteForm}`;
}

async function payrollDetailPage(request, env, user, path, id, print = false) {
  const access = requireView(user, "Payroll");
  if (access) return errorResponse(access, user, path);
  const entry = await loadPayrollEntry(env, id);
  if (!entry) return html("Not found", 404);
  if (print) return html(payrollDetailContent(entry, user, true));
  return html(layout({ title: "Payroll Details", user, path, content: `${messagePanel(new URL(request.url))}${payrollDetailContent(entry, user)}` }));
}

async function restoreAdvances(env, table, employeeId, amount, { cash = false } = {}) {
  let remaining = numeric(amount);
  const rows = await all(env, `SELECT * FROM ${table} WHERE employee_id=? ORDER BY date_granted DESC, id DESC`, [employeeId]);
  for (const row of rows) {
    if (remaining <= 0) break;
    const room = Math.max(0, numeric(row.amount) - numeric(row.balance));
    const restored = Math.min(room, remaining);
    if (restored <= 0) continue;
    const balance = numeric(row.balance) + restored;
    if (cash) await run(env, `UPDATE ${table} SET balance=?, status='Open', applied=0 WHERE id=?`, [String(balance), row.id]);
    else await run(env, `UPDATE ${table} SET balance=?, status='Open' WHERE id=?`, [String(balance), row.id]);
    remaining -= restored;
  }
  return remaining;
}

async function payrollDeletePage(request, env, user, path, id) {
  const access = requireEdit(user, "Payroll");
  if (access) return errorResponse(access, user, path);
  if (request.method !== "POST") return html(layout({ title: "Method Not Allowed", user, path, content: `<section class="panel"><p class="error">Delete requires POST.</p></section>` }), 405);
  const entry = await first(env, "SELECT * FROM payroll_entries WHERE id=?", [id]);
  if (!entry) return redirect("/payroll?error=Payroll%20entry%20not%20found.");
  await restoreAdvances(env, "vale_records", entry.employee_id, entry.vale_deduction);
  await restoreAdvances(env, "cash_advances", entry.employee_id, entry.cash_advance_deduction, { cash: true });
  await run(env, "DELETE FROM payroll_entries WHERE id=?", [id]);
  return redirect(`/payroll?ok=${encodeURIComponent("Payroll deleted; Vale and Cash Advance deductions were restored.")}`);
}

async function payrollExportPage(request, env, user, path) {
  const access = requireView(user, "Payroll");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const where = payrollWhere((url.searchParams.get("q") || "").trim());
  const rows = await all(env, `SELECT p.*, e.employee_code, e.full_name FROM payroll_entries p LEFT JOIN employees e ON e.id=p.employee_id${where.sql} ORDER BY p.pay_date DESC, p.id DESC`, where.params);
  const lines = ["Payroll ID,Pay Date,Period From,Period To,Employee Code,Employee Name,Employee Type,Gross Pay,Additional Pay,Deductions,Net Pay,Remarks"];
  for (const row of rows) lines.push(quotedCsvRow([row.id, row.pay_date, row.period_from, row.period_to, row.employee_code || "", row.full_name || "", row.employee_type, row.gross_pay, row.additional_pay, deductionTotal(row), row.net_pay, row.remarks || ""]));
  return csv(lines.join("\n"), "payroll.csv");
}

function billingWhere(query) {
  if (!query) return { sql: "", params: [] };
  return {
    sql: " WHERE b.billing_no LIKE ? OR c.client_name LIKE ? OR b.status LIKE ? OR b.notes LIKE ?",
    params: Array(4).fill(`%${query}%`),
  };
}

function collectionWhere(query) {
  if (!query) return { sql: "", params: [] };
  return {
    sql: " WHERE co.reference_no LIKE ? OR co.payment_method LIKE ? OR co.notes LIKE ? OR c.client_name LIKE ? OR b.billing_no LIKE ?",
    params: Array(5).fill(`%${query}%`),
  };
}

function nextBillingNoFrom(last, dateValue) {
  const year = String(dateValue || todayISO()).slice(0, 4);
  const lastNo = String(last?.billing_no || "");
  const match = lastNo.match(/(\d+)$/);
  return `BILL-${year}-${String((match ? Number(match[1]) : 0) + 1).padStart(6, "0")}`;
}

async function billingClients(env) {
  return await all(env, "SELECT * FROM clients ORDER BY client_name, id");
}

async function billingChoices(env) {
  return await all(env, "SELECT b.*, c.client_name, c.client_code, COALESCE((SELECT SUM(amount_paid) FROM collections co WHERE co.billing_id=b.id),0) AS paid_amount FROM billing_statements b LEFT JOIN clients c ON c.id=b.client_id ORDER BY b.billing_date DESC, b.id DESC");
}

async function billingEligibleTrips(env, clientId, periodFrom, periodTo) {
  if (!clientId || !periodFrom || !periodTo) return [];
  return await all(env, `SELECT t.*, c.client_name, a.asset_code, e.full_name AS driver_name FROM trips t LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN assets a ON a.id=t.asset_id LEFT JOIN employees e ON e.id=t.driver_id WHERE t.client_id=? AND t.trip_date BETWEEN ? AND ? AND t.status IN ('Completed','Billed','Paid') AND NOT EXISTS (SELECT 1 FROM billing_lines bl WHERE bl.trip_id=t.id) ORDER BY t.trip_date, t.trip_ticket_no, t.id`, [clientId, periodFrom, periodTo]);
}

function billingTotals(trips, values) {
  const base = trips.reduce((sum, trip) => sum + numeric(trip.base_trip_rate), 0);
  const extra = trips.reduce((sum, trip) => sum + tripExtraTotal(trip), 0);
  const gross = base + extra;
  const vat = applyVat(gross, values.vat_enabled);
  const additions = numeric(values.addition_amount);
  const deductions = numeric(values.deduction_amount);
  const grand = gross + vat + additions - deductions;
  return {
    base_charges_total: base,
    extra_charges_total: extra,
    gross_total: gross,
    vat_amount: vat,
    additions_total: additions,
    deductions_total: deductions,
    grand_total: grand,
  };
}

function billingCleaned(data) {
  return {
    client_id: data.client || data.client_id || "",
    billing_date: data.billing_date || todayISO(),
    period_from: data.period_from || "",
    period_to: data.period_to || "",
    vat_enabled: data.vat_enabled === "1" || data.vat_enabled === "on" ? 1 : 0,
    addition_label: (data.addition_label || "").trim(),
    addition_amount: numericText(data.addition_amount),
    deduction_label: (data.deduction_label || "").trim(),
    deduction_amount: numericText(data.deduction_amount),
    notes: (data.notes || "").trim(),
    expected_trip_ids: parseExpectedIds(data.expected_trip_ids),
  };
}

function validateBilling(cleaned, trips, totals) {
  const errors = [];
  if (!cleaned.client_id) errors.push("Client is required.");
  if (!cleaned.billing_date) errors.push("Billing date is required.");
  if (!cleaned.period_from || !cleaned.period_to) errors.push("Billing period is required.");
  if (cleaned.period_from && cleaned.period_to && cleaned.period_from > cleaned.period_to) errors.push("Period end must be on or after period start.");
  if (numeric(cleaned.addition_amount) < 0) errors.push("addition amount cannot be negative.");
  if (numeric(cleaned.deduction_amount) < 0) errors.push("deduction amount cannot be negative.");
  if (totals && totals.grand_total < 0) errors.push("Grand total cannot be negative.");
  if (!trips?.length) errors.push("At least one eligible trip is required.");
  const freshIds = (trips || []).map((trip) => Number(trip.id));
  if (JSON.stringify(freshIds) !== JSON.stringify(cleaned.expected_trip_ids)) errors.push("Billing eligibility changed. Preview the period again before saving.");
  return errors;
}

function billingTripRows(trips) {
  const rows = trips.map((trip) => `<tr><td>${esc(trip.trip_date)}</td><td><a href="/trips/${trip.id}">${esc(trip.trip_ticket_no)}</a><small class="cell-detail">Ref. No.: ${esc(trip.reference_no || "—")}</small></td><td>${esc(trip.job_description || "")}</td><td>${esc(trip.origin || "")} → ${esc(trip.destination || "")}</td><td>${esc(trip.asset_code || "")}</td>${moneyCell(trip.base_trip_rate)}${moneyCell(tripExtraTotal(trip))}${moneyCell(tripBillableTotal(trip))}</tr>`);
  return table(["Date", "Trip Ticket / Waybill", "Item / Job", "Route", "Unit", "Base", "Extras", "Total"], rows, { empty: "No eligible unbilled trips for this client and period." });
}

function billingFormContent(clients, selection, trips, values = {}, errors = []) {
  const clientId = selection.client || values.client || values.client_id || "";
  const periodFrom = selection.period_from || values.period_from || `${todayISO().slice(0, 8)}01`;
  const periodTo = selection.period_to || values.period_to || todayISO();
  const cleaned = billingCleaned({ client: clientId, period_from: periodFrom, period_to: periodTo, ...values });
  const totals = billingTotals(trips || [], cleaned);
  const selector = `<section class="panel"><h3>1. Select Client & Period</h3><form method="get" class="selector-row">${selectInput("client", "Client", clients, clientId, (client) => choiceLabel("client", client), "Select client")}<label>Period From<input type="date" name="period_from" value="${esc(periodFrom)}" required></label><label>Period To<input type="date" name="period_to" value="${esc(periodTo)}" required></label><button>Preview Billing</button></form></section>`;
  const errorBox = errors.length ? `<section class="panel"><ul class="error">${errors.map((err) => `<li>${esc(err)}</li>`).join("")}</ul></section>` : "";
  if (!clientId) return `${errorBox}${selector}<section class="panel empty-workspace"><p>Select a client and billing period to preview eligible trips.</p></section>`;
  const hidden = `<input type="hidden" name="client" value="${esc(clientId)}"><input type="hidden" name="period_from" value="${esc(periodFrom)}"><input type="hidden" name="period_to" value="${esc(periodTo)}"><input type="hidden" name="expected_trip_ids" value="${esc(JSON.stringify((trips || []).map((trip) => trip.id)))}">`;
  const fields = [
    textInput("billing_date", "Billing date", values.billing_date || todayISO(), 'type="date" required'),
    `<label>VAT<input type="checkbox" name="vat_enabled" value="1"${cleaned.vat_enabled ? " checked" : ""}> Add 12% VAT</label>`,
    textInput("addition_label", "Addition label", values.addition_label || ""),
    numberInput("addition_amount", "Addition amount", values.addition_amount ?? 0),
    textInput("deduction_label", "Deduction label", values.deduction_label || ""),
    numberInput("deduction_amount", "Deduction amount", values.deduction_amount ?? 0),
    textareaInput("notes", "Notes", values.notes || "", 'rows="3"'),
  ];
  const summary = `<section class="panel">${cards([["Eligible Trips", String((trips || []).length)], ["Gross", peso(totals.gross_total)], ["VAT", peso(totals.vat_amount)], ["Grand Total", peso(totals.grand_total)]])}</section>`;
  return `${errorBox}${selector}${summary}<form method="post" action="/billing/new" class="panel">${hidden}<div class="grid">${fields.join("")}</div><p><button>Save Billing</button> <a class="button secondary" href="/billing">Cancel</a></p></form><section class="panel"><h3>Eligible Trips</h3></section>${billingTripRows(trips || [])}`;
}

async function createdBillingId(env, billingNo) {
  const row = await first(env, "SELECT id FROM billing_statements WHERE billing_no=? LIMIT 1", [billingNo]);
  return row?.id;
}

async function saveBilling(env, cleaned, trips) {
  const totals = billingTotals(trips, cleaned);
  const last = await first(env, "SELECT billing_no FROM billing_statements WHERE billing_no LIKE ? ORDER BY billing_no DESC LIMIT 1", [`BILL-${String(cleaned.billing_date).slice(0, 4)}-%`]);
  const billingNo = nextBillingNoFrom(last, cleaned.billing_date);
  await run(env, "INSERT INTO billing_statements (billing_no, client_id, billing_date, period_from, period_to, base_charges_total, extra_charges_total, gross_total, vat_enabled, vat_amount, additions_total, deductions_total, grand_total, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
    billingNo, cleaned.client_id, cleaned.billing_date, cleaned.period_from, cleaned.period_to,
    String(totals.base_charges_total), String(totals.extra_charges_total), String(totals.gross_total), cleaned.vat_enabled,
    String(totals.vat_amount), String(totals.additions_total), String(totals.deductions_total), String(totals.grand_total), "Open", cleaned.notes,
  ]);
  const billingId = await createdBillingId(env, billingNo);
  for (const trip of trips) {
    await run(env, "INSERT INTO billing_lines (billing_id, trip_id, amount_base, amount_extra, amount_total) VALUES (?,?,?,?,?)", [billingId, trip.id, String(numeric(trip.base_trip_rate)), String(tripExtraTotal(trip)), String(tripBillableTotal(trip))]);
    await run(env, "UPDATE trips SET status='Billed' WHERE id=?", [trip.id]);
  }
  if (numeric(cleaned.addition_amount)) await run(env, "INSERT INTO billing_adjustments (billing_id, line_type, label, amount, sort_order) VALUES (?,?,?,?,?)", [billingId, "Addition", cleaned.addition_label || "Addition", cleaned.addition_amount, 1]);
  if (numeric(cleaned.deduction_amount)) await run(env, "INSERT INTO billing_adjustments (billing_id, line_type, label, amount, sort_order) VALUES (?,?,?,?,?)", [billingId, "Deduction", cleaned.deduction_label || "Deduction", cleaned.deduction_amount, 2]);
  return billingId;
}

async function loadBillingEntry(env, id) {
  const entry = await first(env, "SELECT b.*, c.client_name, c.client_code, c.billing_address, c.contact_person FROM billing_statements b LEFT JOIN clients c ON c.id=b.client_id WHERE b.id=?", [id]);
  if (!entry) return null;
  entry.lines = await all(env, `SELECT bl.*, t.trip_date, t.trip_ticket_no, t.reference_no, t.job_description, t.origin, t.destination, a.asset_code FROM billing_lines bl JOIN trips t ON t.id=bl.trip_id LEFT JOIN assets a ON a.id=t.asset_id WHERE bl.billing_id=? ORDER BY t.trip_date, t.trip_ticket_no, t.id`, [id]);
  entry.adjustments = await all(env, "SELECT * FROM billing_adjustments WHERE billing_id=? ORDER BY sort_order, id", [id]);
  entry.collections = await all(env, "SELECT * FROM collections WHERE billing_id=? ORDER BY collection_date, id", [id]);
  entry.paid_amount = entry.collections.reduce((sum, row) => sum + numeric(row.amount_paid), 0);
  entry.balance = outstandingBalance(entry.grand_total, entry.paid_amount);
  entry.current_status = billingStatus(entry.grand_total, entry.paid_amount);
  return entry;
}

function billingDetailContent(entry, user, print = false) {
  const lineRows = (entry.lines || []).map((line) => `<tr><td>${esc(line.trip_date)}</td><td>${esc(line.trip_ticket_no)}<small class="cell-detail">Ref. No.: ${esc(line.reference_no || "—")}</small></td><td>${esc(line.job_description || "")}</td><td>${esc(line.origin || "")} → ${esc(line.destination || "")}</td><td>${esc(line.asset_code || "")}</td><td class="num">${esc(peso(line.amount_base))}</td><td class="num">${esc(peso(line.amount_extra))}</td><td class="num">${esc(peso(line.amount_total))}</td></tr>`);
  const adjustmentRows = (entry.adjustments || []).map((row) => `<tr><td>${esc(row.line_type)}</td><td>${esc(row.label)}</td><td class="num">${esc(peso(row.amount))}</td></tr>`);
  const collectionRows = (entry.collections || []).map((row) => `<tr><td>${esc(row.collection_date)}</td><td>${esc(row.reference_no || "")}</td><td>${esc(row.payment_method || "")}</td><td class="num">${esc(peso(row.amount_paid))}</td></tr>`);
  if (print) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(entry.billing_no)} · Billing</title><style>@page{size:A4 portrait;margin:12mm}body{font-family:Arial,sans-serif;font-size:12px;color:#111}.top{display:flex;justify-content:space-between;gap:24px}h1,h2{margin:0 0 6px}.muted{color:#555}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border:1px solid #222;padding:6px;vertical-align:top}th{background:#f1f1f1}.num{text-align:right;white-space:nowrap}.totals{margin-left:auto;width:320px}.signatures{display:grid;grid-template-columns:1fr 1fr;gap:60px;margin-top:48px}.sig{border-top:1px solid #111;text-align:center;padding-top:6px}.print-button{margin-bottom:10px}@media print{.print-button{display:none}}</style></head><body><button class="print-button" onclick="window.print()">Print</button><div class="top"><div><h1>GMT Trucking</h1><h2>Billing Statement</h2><p><strong>Client:</strong> ${esc(entry.client_name || "")}<br><strong>Address:</strong> ${esc(entry.billing_address || "")}<br><strong>Period:</strong> ${esc(entry.period_from || "")} to ${esc(entry.period_to || "")}</p></div><div><h2>${esc(entry.billing_no)}</h2><p><strong>Date:</strong> ${esc(entry.billing_date)}<br><strong>Status:</strong> ${esc(entry.current_status)}</p></div></div><table><thead><tr><th>Date</th><th>Trip Ticket / Waybill</th><th>Item / Job</th><th>Route</th><th>Unit</th><th>Base</th><th>Extras</th><th>Total</th></tr></thead><tbody>${lineRows.join("")}</tbody></table>${adjustmentRows.length ? `<table><thead><tr><th>Type</th><th>Adjustment</th><th>Amount</th></tr></thead><tbody>${adjustmentRows.join("")}</tbody></table>` : ""}<table class="totals"><tr><td>Gross</td><td class="num">${esc(peso(entry.gross_total))}</td></tr><tr><td>VAT</td><td class="num">${esc(peso(entry.vat_amount))}</td></tr><tr><td>Additions</td><td class="num">${esc(peso(entry.additions_total))}</td></tr><tr><td>Deductions</td><td class="num">${esc(peso(entry.deductions_total))}</td></tr><tr><th>Grand Total</th><th class="num">${esc(peso(entry.grand_total))}</th></tr><tr><td>Payments</td><td class="num">${esc(peso(entry.paid_amount))}</td></tr><tr><th>Balance</th><th class="num">${esc(peso(entry.balance))}</th></tr></table><div class="signatures"><div class="sig">Prepared by</div><div class="sig">Received by / Conforme</div></div></body></html>`;
  }
  const actions = `<div class="detail-toolbar"><a class="button secondary" href="/billing">← Billing List</a><div><a class="button secondary" href="/billing/${entry.id}/print" target="_blank">Print Billing</a></div></div>`;
  const hero = `<section class="panel detail-hero"><div><span class="dialog-kicker">Billing Statement</span><h3>${esc(entry.billing_no)}</h3><p>${esc(entry.client_name || "")} · ${esc(entry.billing_date)} · ${esc(entry.period_from || "")} to ${esc(entry.period_to || "")}</p></div><strong>${esc(peso(entry.balance))}</strong></section>`;
  const summary = `<section class="panel">${cards([["Gross", peso(entry.gross_total)], ["VAT", peso(entry.vat_amount)], ["Grand Total", peso(entry.grand_total)], ["Paid", peso(entry.paid_amount)], ["Balance", peso(entry.balance)], ["Status", entry.current_status]])}</section>`;
  const deleteForm = canEdit(user, "Billing") ? `<section class="detail-danger"><form method="post" action="/billing/${entry.id}/delete" onsubmit="return confirm('Delete this billing statement? This is blocked when collections exist.');"><button class="danger-button">Delete Billing</button></form></section>` : "";
  return `${actions}${hero}${summary}<section class="panel"><h3>Trips</h3></section>${table(["Date", "Trip Ticket / Waybill", "Item / Job", "Route", "Unit", "Base", "Extras", "Total"], lineRows, { empty: "No billing lines." })}<section class="panel"><h3>Adjustments</h3></section>${table(["Type", "Label", "Amount"], adjustmentRows, { empty: "No adjustments." })}<section class="panel"><h3>Collections</h3></section>${table(["Date", "Reference", "Method", "Amount"], collectionRows, { empty: "No collections recorded." })}${entry.notes ? `<section class="panel"><h3>Notes</h3><p>${esc(entry.notes)}</p></section>` : ""}${deleteForm}`;
}

async function billingListPage(request, env, user, path) {
  const access = requireView(user, "Billing");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const where = billingWhere(query);
  const countRow = await first(env, `SELECT COUNT(*) AS total FROM billing_statements b LEFT JOIN clients c ON c.id=b.client_id${where.sql}`, where.params);
  const rows = await all(env, `SELECT b.*, c.client_name, COALESCE((SELECT SUM(amount_paid) FROM collections co WHERE co.billing_id=b.id),0) AS paid_amount FROM billing_statements b LEFT JOIN clients c ON c.id=b.client_id${where.sql} ORDER BY b.billing_date DESC, b.id DESC LIMIT 25 OFFSET ?`, [...where.params, (page - 1) * 25]);
  const body = rows.map((row) => {
    const paid = numeric(row.paid_amount);
    const balance = outstandingBalance(row.grand_total, paid);
    const status = billingStatus(row.grand_total, paid);
    return `<tr><td><a href="/billing/${row.id}">${esc(row.billing_no)}</a></td><td>${esc(row.billing_date)}</td><td>${esc(row.client_name || "")}</td><td>${esc(row.period_from || "")} – ${esc(row.period_to || "")}</td>${moneyCell(row.grand_total)}${moneyCell(paid)}${moneyCell(balance)}<td><span class="status">${esc(status)}</span></td><td><a href="/billing/${row.id}">View</a> <a href="/billing/${row.id}/print" target="_blank">Print</a></td></tr>`;
  });
  const toolbar = `<div class="toolbar"><form><input name="q" value="${esc(query)}" placeholder="Search billing"><button>Search</button></form><div><a class="button secondary" href="/billing/soa">Statement of Account</a> ${canEdit(user, "Billing") ? `<a class="button" href="/billing/new">New Billing</a>` : ""} <a class="button secondary" href="${esc(`/billing/export.csv${params.toString() ? `?${params.toString()}` : ""}`)}">Export CSV</a></div></div>`;
  const content = `${messagePanel(url)}<section class="panel">${toolbar}</section>${table(["Billing No.", "Date", "Client", "Period", "Grand Total", "Paid", "Balance", "Status", "Actions"], body, { empty: "No billing statements found." })}${paginationWithParams("/billing", params, page, Number(countRow?.total || 0))}`;
  return html(layout({ title: "Billing", user, path, content }));
}

async function billingNewPage(request, env, user, path) {
  const access = requireEdit(user, "Billing");
  if (access) return errorResponse(access, user, path);
  const clients = await billingClients(env);
  const source = request.method === "POST" ? await parseForm(request) : Object.fromEntries(new URL(request.url).searchParams.entries());
  const selection = { client: source.client || "", period_from: source.period_from || `${todayISO().slice(0, 8)}01`, period_to: source.period_to || todayISO() };
  const trips = selection.client ? await billingEligibleTrips(env, selection.client, selection.period_from, selection.period_to) : [];
  if (request.method === "POST") {
    const cleaned = billingCleaned(source);
    const totals = billingTotals(trips, cleaned);
    const errors = validateBilling(cleaned, trips, totals);
    if (errors.length) return html(layout({ title: "New Billing", user, path, content: billingFormContent(clients, selection, trips, source, errors) }), 400);
    const id = await saveBilling(env, cleaned, trips);
    return redirect(`/billing/${id}?ok=${encodeURIComponent("Billing statement saved and trips marked as billed.")}`);
  }
  return html(layout({ title: "New Billing", user, path, content: billingFormContent(clients, selection, trips) }));
}

async function billingDetailPage(request, env, user, path, id, print = false) {
  const access = requireView(user, "Billing");
  if (access) return errorResponse(access, user, path);
  const entry = await loadBillingEntry(env, id);
  if (!entry) return html("Not found", 404);
  if (print) return html(billingDetailContent(entry, user, true));
  return html(layout({ title: "Billing Details", user, path, content: `${messagePanel(new URL(request.url))}${billingDetailContent(entry, user)}` }));
}

async function billingDeletePage(request, env, user, path, id) {
  const access = requireEdit(user, "Billing");
  if (access) return errorResponse(access, user, path);
  if (request.method !== "POST") return html(layout({ title: "Method Not Allowed", user, path, content: `<section class="panel"><p class="error">Delete requires POST.</p></section>` }), 405);
  const collections = await first(env, "SELECT COUNT(*) AS total FROM collections WHERE billing_id=?", [id]);
  if (Number(collections?.total || 0)) return redirect(`/billing/${id}?error=${encodeURIComponent("Billing has collections and cannot be deleted.")}`);
  const lines = await all(env, "SELECT trip_id FROM billing_lines WHERE billing_id=?", [id]);
  for (const line of lines) await run(env, "UPDATE trips SET status='Completed' WHERE id=?", [line.trip_id]);
  await run(env, "DELETE FROM billing_statements WHERE id=?", [id]);
  return redirect(`/billing?ok=${encodeURIComponent("Billing deleted and trips restored to Completed.")}`);
}

async function billingExportPage(request, env, user, path) {
  const access = requireView(user, "Billing");
  if (access) return errorResponse(access, user, path);
  const where = billingWhere((new URL(request.url).searchParams.get("q") || "").trim());
  const rows = await all(env, `SELECT b.*, c.client_name, COALESCE((SELECT SUM(amount_paid) FROM collections co WHERE co.billing_id=b.id),0) AS paid_amount FROM billing_statements b LEFT JOIN clients c ON c.id=b.client_id${where.sql} ORDER BY b.billing_date DESC, b.id DESC`, where.params);
  const lines = ["Billing No.,Billing Date,Client,Period From,Period To,Gross,VAT,Additions,Deductions,Grand Total,Paid,Balance,Status,Notes"];
  for (const row of rows) {
    const paid = numeric(row.paid_amount);
    lines.push(quotedCsvRow([row.billing_no, row.billing_date, row.client_name || "", row.period_from, row.period_to, row.gross_total, row.vat_amount, row.additions_total, row.deductions_total, row.grand_total, paid, outstandingBalance(row.grand_total, paid), billingStatus(row.grand_total, paid), row.notes || ""]));
  }
  return csv(lines.join("\n"), "billing.csv");
}

function soaFilters(url) {
  return {
    client_id: url.searchParams.get("client") || "",
    mode: url.searchParams.get("mode") === "all" ? "all" : "outstanding",
    as_of: url.searchParams.get("as_of") || todayISO(),
    date_from: url.searchParams.get("date_from") || "",
    date_to: url.searchParams.get("date_to") || "",
  };
}

function soaParams(filters) {
  const params = new URLSearchParams();
  if (filters.client_id) params.set("client", filters.client_id);
  params.set("mode", filters.mode);
  params.set("as_of", filters.as_of);
  if (filters.date_from) params.set("date_from", filters.date_from);
  if (filters.date_to) params.set("date_to", filters.date_to);
  return params;
}

async function soaClient(env, id) {
  if (!id) return null;
  return await first(env, "SELECT * FROM clients WHERE id=?", [id]);
}

async function soaRows(env, filters) {
  if (!filters.client_id) return [];
  const clauses = ["b.client_id=?"];
  const params = [filters.client_id];
  if (filters.date_from) {
    clauses.push("b.billing_date>=?");
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    clauses.push("b.billing_date<=?");
    params.push(filters.date_to);
  }
  const rows = await all(env, `SELECT b.*, COALESCE((SELECT SUM(amount_paid) FROM collections co WHERE co.billing_id=b.id AND co.collection_date<=?),0) AS paid_as_of FROM billing_statements b WHERE ${clauses.join(" AND ")} ORDER BY b.billing_date, b.billing_no, b.id`, [filters.as_of, ...params]);
  const mapped = rows.map((row) => {
    const paid = numeric(row.paid_as_of);
    const balance = outstandingBalance(row.grand_total, paid);
    return { ...row, paid_as_of: paid, balance_as_of: balance, status_as_of: billingStatus(row.grand_total, paid) };
  });
  return filters.mode === "outstanding" ? mapped.filter((row) => numeric(row.balance_as_of) !== 0) : mapped;
}

function soaTotals(rows) {
  return rows.reduce((totals, row) => ({
    billed: totals.billed + numeric(row.grand_total),
    paid: totals.paid + numeric(row.paid_as_of),
    balance: totals.balance + numeric(row.balance_as_of),
  }), { billed: 0, paid: 0, balance: 0 });
}

function soaFilterForm(clients, filters) {
  return `<section class="panel"><h3>Statement of Account</h3><form class="selector-row" method="get" action="/billing/soa">${selectInput("client", "Client", clients, filters.client_id, (client) => choiceLabel("client", client), "Select client")}<label>Mode<select name="mode"><option value="outstanding"${filters.mode === "outstanding" ? " selected" : ""}>Outstanding Only</option><option value="all"${filters.mode === "all" ? " selected" : ""}>All Activity</option></select></label><label>As-of date<input type="date" name="as_of" value="${esc(filters.as_of)}" required></label><label>Date from<input type="date" name="date_from" value="${esc(filters.date_from)}"></label><label>Date to<input type="date" name="date_to" value="${esc(filters.date_to)}"></label><button>Generate SOA</button></form></section>`;
}

function soaRowsTable(rows, { links = true } = {}) {
  const body = rows.map((row) => `<tr><td>${links ? `<a href="/billing/${row.id}">${esc(row.billing_no)}</a>` : esc(row.billing_no)}</td><td>${esc(row.billing_date)}</td><td>${esc(row.period_from || "")} – ${esc(row.period_to || "")}</td>${moneyCell(row.grand_total)}${moneyCell(row.paid_as_of)}${moneyCell(row.balance_as_of)}<td>${esc(row.status_as_of)}</td></tr>`);
  return table(["Billing No.", "Billing Date", "Billing Period", "Grand Total", "Payments", "Balance", "Status"], body, { empty: "No SOA rows found for the selected filters." });
}

function soaContent(clients, client, filters, rows) {
  const params = soaParams(filters);
  const totals = soaTotals(rows);
  const period = `${filters.date_from || "Beginning"} to ${filters.date_to || "Current"}`;
  const actions = filters.client_id ? `<section class="panel"><div class="toolbar"><div><a class="button secondary" href="/billing">← Billing List</a></div><div><a class="button secondary" href="/billing/soa/print?${esc(params.toString())}" target="_blank">Printable SOA</a> <a class="button secondary" href="/billing/soa/export.csv?${esc(params.toString())}">Export CSV</a></div></div></section>` : "";
  const summary = client ? `<section class="panel detail-hero"><div><span class="dialog-kicker">Statement of Account</span><h3>${esc(client.client_name || "")}</h3><p>${esc(client.client_code || "")} · ${esc(client.billing_address || "")}</p><p>As of ${esc(filters.as_of)} · Period: ${esc(period)} · ${filters.mode === "all" ? "All Activity" : "Outstanding Only"}</p></div><strong>${esc(peso(totals.balance))}</strong></section><section class="panel">${cards([["Total Billed", peso(totals.billed)], ["Total Payments", peso(totals.paid)], ["Total Balance", peso(totals.balance)]])}</section>` : "";
  return `${soaFilterForm(clients, filters)}${actions}${summary}${client ? soaRowsTable(rows) : ""}`;
}

function soaPrintable(client, filters, rows) {
  const totals = soaTotals(rows);
  const period = `${filters.date_from || "Beginning"} to ${filters.date_to || "Current"}`;
  const body = rows.map((row) => `<tr><td>${esc(row.billing_no)}</td><td>${esc(row.billing_date)}</td><td>${esc(row.period_from || "")} to ${esc(row.period_to || "")}</td><td class="num">${esc(peso(row.grand_total))}</td><td class="num">${esc(peso(row.paid_as_of))}</td><td class="num">${esc(peso(row.balance_as_of))}</td><td>${esc(row.status_as_of)}</td></tr>`).join("") || `<tr><td colspan="7">No SOA rows found for the selected filters.</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Statement of Account · GMT</title><style>@page{size:A4 portrait;margin:12mm}body{font-family:Arial,sans-serif;font-size:12px;color:#111}.top{display:flex;justify-content:space-between;gap:24px}h1,h2{margin:0 0 6px}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #222;padding:6px;vertical-align:top}th{background:#f1f1f1}.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.totals{margin-left:auto;width:330px}.signatures{display:grid;grid-template-columns:1fr 1fr 1fr;gap:32px;margin-top:56px}.sig{border-top:1px solid #111;text-align:center;padding-top:6px}.print-button{margin-bottom:10px}@media print{.print-button{display:none}}</style></head><body><button class="print-button" onclick="window.print()">Print</button><div class="top"><div><h1>GMT Trucking</h1><h2>Statement of Account</h2><p><strong>Client:</strong> ${esc(client?.client_name || "")}<br><strong>Code:</strong> ${esc(client?.client_code || "")}<br><strong>Address:</strong> ${esc(client?.billing_address || "")}</p></div><div><p><strong>As-of date:</strong> ${esc(filters.as_of)}<br><strong>Period:</strong> ${esc(period)}<br><strong>Mode:</strong> ${filters.mode === "all" ? "All Activity" : "Outstanding Only"}</p></div></div><table><thead><tr><th>Billing No.</th><th>Billing Date</th><th>Billing Period</th><th>Grand Total</th><th>Payments</th><th>Balance</th><th>Status</th></tr></thead><tbody>${body}</tbody></table><table class="totals"><tr><td>Total Billed</td><td class="num">${esc(peso(totals.billed))}</td></tr><tr><td>Total Payments</td><td class="num">${esc(peso(totals.paid))}</td></tr><tr><th>Total Balance</th><th class="num">${esc(peso(totals.balance))}</th></tr></table><div class="signatures"><div class="sig">Prepared by</div><div class="sig">Checked by</div><div class="sig">Received/Conforme</div></div></body></html>`;
}

async function soaPage(request, env, user, path, { print = false, exportCsv = false } = {}) {
  const access = requireView(user, "Billing");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const filters = soaFilters(url);
  const clients = await billingClients(env);
  const client = await soaClient(env, filters.client_id);
  const rows = client ? await soaRows(env, filters) : [];
  if (exportCsv) {
    const lines = ["Billing No.,Billing Date,Billing Period,Grand Total,Payments,Balance,Status"];
    for (const row of rows) lines.push(quotedCsvRow([row.billing_no, row.billing_date, `${row.period_from || ""} to ${row.period_to || ""}`, row.grand_total, row.paid_as_of, row.balance_as_of, row.status_as_of]));
    return csv(lines.join("\n"), "statement-of-account.csv");
  }
  if (print) return html(soaPrintable(client, filters, rows));
  return html(layout({ title: "Statement of Account", user, path, content: soaContent(clients, client, filters, rows) }));
}

async function recalcBillingStatus(env, billingId) {
  const row = await first(env, "SELECT grand_total, COALESCE((SELECT SUM(amount_paid) FROM collections WHERE billing_id=?),0) AS paid_amount FROM billing_statements WHERE id=?", [billingId, billingId]);
  if (!row) return null;
  const status = billingStatus(row.grand_total, row.paid_amount);
  await run(env, "UPDATE billing_statements SET status=? WHERE id=?", [status, billingId]);
  return status;
}

function collectionValues(data) {
  return {
    collection_date: data.collection_date || todayISO(),
    billing_id: data.billing_id || "",
    client_id: data.client_id || "",
    amount_paid: numericText(data.amount_paid),
    reference_no: (data.reference_no || "").trim(),
    payment_method: (data.payment_method || "").trim(),
    notes: (data.notes || "").trim(),
  };
}

async function collectionFormContent(env, row, errors = [], id = null) {
  const billings = await billingChoices(env);
  const selectedBilling = billings.find((billing) => String(billing.id) === String(row.billing_id));
  const paidExcludingCurrent = selectedBilling ? Math.max(0, numeric(selectedBilling.paid_amount) - numeric(row.original_amount_paid)) : 0;
  const outstanding = selectedBilling ? outstandingBalance(selectedBilling.grand_total, paidExcludingCurrent) : 0;
  const errorBox = errors.length ? `<section class="panel"><ul class="error">${errors.map((err) => `<li>${esc(err)}</li>`).join("")}</ul></section>` : "";
  const billingSelect = `<label>Billing Statement<select name="billing_id" required><option value="">Select billing</option>${billings.map((billing) => {
    const paid = numeric(billing.paid_amount);
    const label = `${billing.billing_no} — ${billing.client_name || ""} — ${billing.billing_date} — ${peso(outstandingBalance(billing.grand_total, paid))} / ${billingStatus(billing.grand_total, paid)}`;
    return `<option value="${esc(billing.id)}"${String(row.billing_id) === String(billing.id) ? " selected" : ""}>${esc(label)}</option>`;
  }).join("")}</select></label>`;
  const fields = [
    textInput("collection_date", "Collection date", row.collection_date || todayISO(), 'type="date" required'),
    billingSelect,
    numberInput("amount_paid", "Amount paid", row.amount_paid ?? 0),
    textInput("reference_no", "Reference no.", row.reference_no || ""),
    textInput("payment_method", "Payment method", row.payment_method || ""),
    textareaInput("notes", "Notes", row.notes || "", 'rows="3"'),
  ];
  const summary = selectedBilling ? `<section class="panel">${cards([["Billing", selectedBilling.billing_no], ["Client", selectedBilling.client_name || ""], ["Available Balance", peso(outstanding)], ["Status", billingStatus(selectedBilling.grand_total, selectedBilling.paid_amount)]])}</section>` : "";
  const deleteForm = id ? `<section class="detail-danger"><form method="post" action="/collections/${id}/delete" onsubmit="return confirm('Delete this collection and recalculate billing balance?');"><button class="danger-button">Delete Collection</button></form></section>` : "";
  return `${errorBox}${summary}${formPanel(id ? `/collections/${id}/edit` : "/collections/new", fields, "Save Collection")}${deleteForm}`;
}

async function validateCollection(env, values, id = null, original = null) {
  const errors = [];
  if (!values.billing_id) errors.push("Billing statement is required.");
  if (!values.collection_date) errors.push("Collection date is required.");
  if (numeric(values.amount_paid) <= 0) errors.push("amount paid must be positive.");
  const billing = values.billing_id ? await first(env, "SELECT b.*, COALESCE((SELECT SUM(amount_paid) FROM collections WHERE billing_id=b.id),0) AS paid_amount FROM billing_statements b WHERE b.id=?", [values.billing_id]) : null;
  if (!billing) errors.push("Billing statement is invalid.");
  if (billing) {
    const paidExcludingCurrent = numeric(billing.paid_amount) - numeric(original?.amount_paid);
    const available = outstandingBalance(billing.grand_total, paidExcludingCurrent);
    if (numeric(values.amount_paid) > available) errors.push("Payment cannot exceed outstanding balance.");
  }
  return { errors, billing };
}

async function collectionsPage(request, env, user, path) {
  const access = requireView(user, "Collections");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const where = collectionWhere(query);
  const countRow = await first(env, `SELECT COUNT(*) AS total FROM collections co LEFT JOIN billing_statements b ON b.id=co.billing_id LEFT JOIN clients c ON c.id=co.client_id${where.sql}`, where.params);
  const rows = await all(env, `SELECT co.*, b.billing_no, c.client_name FROM collections co LEFT JOIN billing_statements b ON b.id=co.billing_id LEFT JOIN clients c ON c.id=co.client_id${where.sql} ORDER BY co.collection_date DESC, co.id DESC LIMIT 25 OFFSET ?`, [...where.params, (page - 1) * 25]);
  const body = rows.map((row) => `<tr><td>${esc(row.collection_date)}</td><td><a href="/billing/${row.billing_id}">${esc(row.billing_no || "")}</a></td><td>${esc(row.client_name || "")}</td>${moneyCell(row.amount_paid)}<td>${esc(row.reference_no || "")}</td><td>${esc(row.payment_method || "")}</td><td>${canEdit(user, "Collections") ? `<a href="/collections/${row.id}/edit">Edit</a>` : "—"}</td></tr>`);
  const toolbar = `<div class="toolbar"><form><input name="q" value="${esc(query)}" placeholder="Search collections"><button>Search</button></form><div>${canEdit(user, "Collections") ? `<a class="button" href="/collections/new">New Collection</a>` : ""} <a class="button secondary" href="${esc(`/collections/export.csv${params.toString() ? `?${params.toString()}` : ""}`)}">Export CSV</a></div></div>`;
  const content = `${messagePanel(url)}<section class="panel">${toolbar}</section>${table(["Date", "Billing No.", "Client", "Amount", "Reference", "Method", "Actions"], body, { empty: "No collections found." })}${paginationWithParams("/collections", params, page, Number(countRow?.total || 0))}`;
  return html(layout({ title: "Collections", user, path, content }));
}

async function collectionFormPage(request, env, user, path, id = null) {
  const access = requireEdit(user, "Collections");
  if (access) return errorResponse(access, user, path);
  const original = id ? await first(env, "SELECT * FROM collections WHERE id=?", [id]) : null;
  if (id && !original) return html("Not found", 404);
  const source = request.method === "POST" ? await parseForm(request) : { ...(original || {}), original_amount_paid: original?.amount_paid || 0 };
  const values = collectionValues(source);
  values.original_amount_paid = original?.amount_paid || 0;
  if (request.method === "POST") {
    const { errors, billing } = await validateCollection(env, values, id, original);
    if (errors.length) return html(layout({ title: id ? "Edit Collection" : "New Collection", user, path, content: await collectionFormContent(env, { ...source, ...values }, errors, id) }), 400);
    values.client_id = billing.client_id;
    if (id) await run(env, "UPDATE collections SET collection_date=?, client_id=?, billing_id=?, amount_paid=?, reference_no=?, payment_method=?, notes=? WHERE id=?", [values.collection_date, values.client_id, values.billing_id, values.amount_paid, values.reference_no, values.payment_method, values.notes, id]);
    else await run(env, "INSERT INTO collections (collection_date, client_id, billing_id, amount_paid, reference_no, payment_method, notes) VALUES (?,?,?,?,?,?,?)", [values.collection_date, values.client_id, values.billing_id, values.amount_paid, values.reference_no, values.payment_method, values.notes]);
    await recalcBillingStatus(env, values.billing_id);
    if (id && original.billing_id && String(original.billing_id) !== String(values.billing_id)) await recalcBillingStatus(env, original.billing_id);
    return redirect(`/collections?ok=${encodeURIComponent("Collection saved and billing balance recalculated.")}`);
  }
  return html(layout({ title: id ? "Edit Collection" : "New Collection", user, path, content: await collectionFormContent(env, source, [], id) }));
}

async function collectionDeletePage(request, env, user, path, id) {
  const access = requireEdit(user, "Collections");
  if (access) return errorResponse(access, user, path);
  if (request.method !== "POST") return html(layout({ title: "Method Not Allowed", user, path, content: `<section class="panel"><p class="error">Delete requires POST.</p></section>` }), 405);
  const row = await first(env, "SELECT * FROM collections WHERE id=?", [id]);
  if (!row) return redirect("/collections?error=Collection%20not%20found.");
  await run(env, "DELETE FROM collections WHERE id=?", [id]);
  await recalcBillingStatus(env, row.billing_id);
  return redirect(`/collections?ok=${encodeURIComponent("Collection deleted and billing balance recalculated.")}`);
}

async function collectionExportPage(request, env, user, path) {
  const access = requireView(user, "Collections");
  if (access) return errorResponse(access, user, path);
  const where = collectionWhere((new URL(request.url).searchParams.get("q") || "").trim());
  const rows = await all(env, `SELECT co.*, b.billing_no, c.client_name FROM collections co LEFT JOIN billing_statements b ON b.id=co.billing_id LEFT JOIN clients c ON c.id=co.client_id${where.sql} ORDER BY co.collection_date DESC, co.id DESC`, where.params);
  const lines = ["Collection ID,Collection Date,Billing No.,Client,Amount Paid,Reference No.,Payment Method,Notes"];
  for (const row of rows) lines.push(quotedCsvRow([row.id, row.collection_date, row.billing_no || "", row.client_name || "", row.amount_paid, row.reference_no || "", row.payment_method || "", row.notes || ""]));
  return csv(lines.join("\n"), "collections.csv");
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
  if (path === "/payroll") return payrollListPage(request, env, user, path);
  if (path === "/payroll/new") return payrollNewPage(request, env, user, path);
  if (path === "/payroll/export.csv") return payrollExportPage(request, env, user, path);
  match = path.match(/^\/payroll\/(\d+)\/print$/);
  if (match) return payrollDetailPage(request, env, user, path, Number(match[1]), true);
  match = path.match(/^\/payroll\/(\d+)\/delete$/);
  if (match) return payrollDeletePage(request, env, user, path, Number(match[1]));
  match = path.match(/^\/payroll\/(\d+)$/);
  if (match) return payrollDetailPage(request, env, user, path, Number(match[1]));
  if (path === "/billing") return billingListPage(request, env, user, path);
  if (path === "/billing/new") return billingNewPage(request, env, user, path);
  if (path === "/billing/export.csv") return billingExportPage(request, env, user, path);
  if (path === "/billing/soa") return soaPage(request, env, user, path);
  if (path === "/billing/soa/print") return soaPage(request, env, user, path, { print: true });
  if (path === "/billing/soa/export.csv") return soaPage(request, env, user, path, { exportCsv: true });
  match = path.match(/^\/billing\/(\d+)\/print$/);
  if (match) return billingDetailPage(request, env, user, path, Number(match[1]), true);
  match = path.match(/^\/billing\/(\d+)\/delete$/);
  if (match) return billingDeletePage(request, env, user, path, Number(match[1]));
  match = path.match(/^\/billing\/(\d+)$/);
  if (match) return billingDetailPage(request, env, user, path, Number(match[1]));
  if (path === "/collections") return collectionsPage(request, env, user, path);
  if (path === "/collections/new") return collectionFormPage(request, env, user, path);
  if (path === "/collections/export.csv") return collectionExportPage(request, env, user, path);
  match = path.match(/^\/collections\/(\d+)\/edit$/);
  if (match) return collectionFormPage(request, env, user, path, Number(match[1]));
  match = path.match(/^\/collections\/(\d+)\/delete$/);
  if (match) return collectionDeletePage(request, env, user, path, Number(match[1]));
  if (path === "/reports") return reportList(env, user, path);
  if (path === "/users") return placeholder("User Management", user, path, "User Management");
  return html(layout({ title: "Not Found", user, path, content: `<section class="panel"><p>Route not found.</p></section>` }), 404);
}
