import { canEdit, requireEdit, requireView } from "./access.mjs";
import { createSession, clearSessionHeaders, readSession, sessionHeaders, verifyPassword } from "./auth.mjs";
import { all, dashboard, first, run } from "./db.mjs";
import { cards, formPanel, layout, loginPage, moneyCell, numberInput, selectInput, table, textInput } from "./html.mjs";
import { choiceLabel, nextTripTicketNo, tripBillableTotal, tripExtraTotal } from "./services.mjs";
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
  if (path === "/recurring-trips") return recurringList(env, user, path);
  if (path === "/trips") return tripList(env, user, path);
  if (path === "/trips/new") return tripForm(request, env, user, path);
  let match = path.match(/^\/trips\/(\d+)\/print$/);
  if (match) return tripDetail(env, user, path, Number(match[1]), true);
  match = path.match(/^\/trips\/(\d+)$/);
  if (match) return tripDetail(env, user, path, Number(match[1]));
  if (path === "/reports") return reportList(env, user, path);
  if (path === "/repairs") return placeholder("Repairs", user, path, "Repairs");
  if (path === "/payables") return placeholder("Payables", user, path, "Payables");
  if (path === "/advances") return placeholder("Vale / Cash Advance", user, path, "Vale / Cash Advance");
  if (path === "/payroll") return placeholder("Payroll", user, path, "Payroll");
  if (path === "/billing") return placeholder("Billing", user, path, "Billing");
  if (path === "/collections") return placeholder("Collections", user, path, "Collections");
  if (path === "/users") return placeholder("User Management", user, path, "User Management");
  return html(layout({ title: "Not Found", user, path, content: `<section class="panel"><p>Route not found.</p></section>` }), 404);
}
