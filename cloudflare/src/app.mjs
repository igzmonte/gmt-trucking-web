import { canEdit, canView, requireEdit, requireView } from "./access.mjs";
import { createSession, clearSessionHeaders, hashPassword, readSession, sessionHeaders, verifyPassword } from "./auth.mjs";
import { all, first, run } from "./db.mjs";
import { appHead, cards, dialogShell, formPanel, layout, loginPage, moneyCell, numberInput, selectInput, table, textareaInput, textInput } from "./html.mjs";
import { EXTRA_FIELDS, HELPER_LIMITS, applyVat, billingStatus, calculateNet, choiceLabel, nextTripTicketNo, outstandingBalance, projectEmployeeBasePay, projectExtraTotal, tripBillableTotal, tripExtraTotal } from "./services.mjs";
import { handleProjects } from "./projects.mjs";
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
    numeric: ["daily_rate", "trip_rate", "active"],
    filters: {
      employee_type: { sql: "employee_type", label: "Employee type", options: ["Driver", "Helper", "Operator", "Mechanic"] },
      payroll_basis: { sql: "payroll_basis", label: "Payroll basis", options: ["Per Trip", "Per Day", "Manual"] },
      employment_status: { sql: "employment_status", label: "Employment status", options: ["Active", "Inactive"] },
      active: { sql: "active", label: "Record state", options: [{ value: "1", label: "Active" }, { value: "0", label: "Inactive" }] },
    },
    defaults: { employment_status: "Active", payroll_basis: "Per Trip", daily_rate: 0, trip_rate: 0, active: 1 },
    deleteRefs: [
      ["assets", "assigned_employee_id", "assigned fleet/equipment"],
      ["recurring_trip_masters", "default_driver_id", "recurring trips"],
      ["trips", "driver_id", "trips"],
      ["trip_helpers", "employee_id", "trip helper assignments"],
      ["vale_records", "employee_id", "vale records"],
      ["cash_advances", "employee_id", "cash advances"],
      ["payroll_entries", "employee_id", "payroll entries"],
      ["payroll_trips", "employee_id", "payroll trip claims"],
      ["projects", "primary_employee_id", "equipment projects"],
      ["project_helpers", "employee_id", "project helper assignments"],
      ["project_work_entries", "primary_employee_id", "project work entries"],
      ["project_work_helpers", "employee_id", "project-work helper snapshots"],
    ],
    fields: [
      ["employee_code", "Employee code"], ["full_name", "Full name"], ["employee_type", "Employee type"],
      ["contact_no", "Contact no"], ["address", "Address"], ["date_hired", "Date hired", "date"],
      ["employment_status", "Employment status"], ["payroll_basis", "Payroll basis"],
      ["daily_rate", "Daily rate", "number"], ["trip_rate", "Trip rate", "number"], ["active", "Active", "boolean"], ["notes", "Notes", "textarea"],
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
      ["projects", "asset_id", "equipment projects"],
      ["project_work_entries", "asset_id_snapshot", "project work snapshots"],
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
      ["projects", "client_id", "equipment projects"],
      ["project_work_entries", "client_id_snapshot", "project work snapshots"],
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

MASTER["/fleet"].filters = {
  asset_type: { sql: "asset_type", label: "Asset type", options: ["Dump Truck", "Backhoe", "Truck", "Trailer", "Other"] },
  status: { sql: "status", label: "Status", options: ["Available", "In Use", "Under Maintenance", "Inactive"] },
};

const SEARCHABLE_SELECT = { searchable: true };

function quickSelect(kind, context = "", label = "") {
  return { searchable: true, quickCreate: { kind, context, label } };
}

function errorResponse(error, user, path = "/") {
  if (error?.redirect) return redirect(error.redirect);
  return html(layout({ title: "Forbidden", user, path, content: `<section class="panel"><p class="error">${esc(error?.message || "Forbidden")}</p></section>` }), error?.status || 403);
}

async function login(request, env) {
  const appName = env.GMT_APP_NAME || "GMT Trucking";
  if (request.method === "GET") return html(loginPage("", appName));
  const data = await parseForm(request);
  let user;
  try {
    user = await first(env, "SELECT * FROM users WHERE username=? AND active=1", [data.username || ""]);
  } catch (error) {
    if (String(error?.message || error).toLowerCase().includes("users")) {
      return html(loginPage("Database is not initialized yet. Run the D1 setup SQL scripts first.", appName), 503);
    }
    throw error;
  }
  if (!user || !(await verifyPassword(data.password || "", user.password_hash))) {
    return html(loginPage("Invalid username or password.", appName), 401);
  }
  const token = await createSession(user, env.GMT_SESSION_SECRET || "development-secret");
  return redirectWithHeaders("/", sessionHeaders(token));
}

function redirectWithHeaders(location, headers) {
  return new Response(null, { status: 303, headers: { Location: location, ...headers } });
}

const SETTINGS_FIELDS = [
  ["company_name", "Company name", "text"],
  ["company_address", "Address", "textarea"],
  ["company_contact_no", "Contact no.", "text"],
  ["company_email", "Email", "text"],
  ["company_tax_info", "TIN / VAT registration", "text"],
  ["default_vat_enabled", "Default VAT enabled", "checkbox"],
  ["prepared_by_default", "Prepared by default", "text"],
  ["checked_by_default", "Checked by default", "text"],
  ["billing_footer_note", "Billing footer note", "textarea"],
  ["soa_footer_note", "SOA footer note", "textarea"],
];

const COMPANY_LOGO_KEY = "company_logo_data_url";
const COMPANY_LOGO_MAX_BYTES = 250 * 1024;
const COMPANY_LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const DEFAULT_SETTINGS = Object.fromEntries(SETTINGS_FIELDS.map(([key]) => [key, ""]));
DEFAULT_SETTINGS.company_name = "GMT Trucking";
DEFAULT_SETTINGS.default_vat_enabled = "0";
DEFAULT_SETTINGS[COMPANY_LOGO_KEY] = "";

async function loadSettings(env) {
  const settings = { ...DEFAULT_SETTINGS };
  try {
    const rows = await all(env, "SELECT key, value FROM system_settings");
    for (const row of rows) {
      if (row.key in settings) settings[row.key] = String(row.value ?? "");
    }
  } catch {
    // Missing settings table should not break first-run views; migrations create it.
  }
  return settings;
}

function cleanSettings(data) {
  const values = {};
  for (const [key, , kind] of SETTINGS_FIELDS) {
    values[key] = kind === "checkbox" ? (data[key] ? "1" : "0") : String(data[key] || "").trim();
  }
  if (!values.company_name) values.company_name = DEFAULT_SETTINGS.company_name;
  return values;
}

function isUploadedFile(value) {
  return value && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.size === "number";
}

function base64FromBytes(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function logoDataUrl(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return `data:${file.type};base64,${base64FromBytes(bytes)}`;
}

async function settingsValuesFromRequest(request, currentSettings) {
  const form = await request.formData();
  const raw = Object.fromEntries([...form.entries()].filter(([, value]) => !isUploadedFile(value)).map(([key, value]) => [key, String(value)]));
  const values = cleanSettings(raw);
  const errors = values.company_email && !values.company_email.includes("@") ? ["Email must contain @ when provided."] : [];
  let logo = currentSettings.company_logo_data_url || "";
  if (raw.remove_company_logo) logo = "";
  const file = form.get("company_logo");
  if (isUploadedFile(file) && file.size > 0) {
    if (!COMPANY_LOGO_TYPES.has(file.type)) errors.push("Company logo must be a PNG, JPEG, WebP, or SVG file.");
    if (file.size > COMPANY_LOGO_MAX_BYTES) errors.push("Company logo must be 250 KB or smaller.");
    if (!errors.length) logo = await logoDataUrl(file);
  }
  values.company_logo_data_url = logo;
  return { values, errors };
}

function companyName(settings) {
  return settings?.company_name || DEFAULT_SETTINGS.company_name;
}

function companyLines(settings) {
  return [
    settings.company_address,
    [settings.company_contact_no, settings.company_email].filter(Boolean).join(" · "),
    settings.company_tax_info,
  ].filter(Boolean);
}

function companyHeader(settings, title = "", { logo = true } = {}) {
  const lines = companyLines(settings).map((line) => `<br>${esc(line)}`).join("");
  const logoMarkup = logo && settings?.company_logo_data_url ? `<img class="company-logo" src="${esc(settings.company_logo_data_url)}" alt="Company logo" style="max-width:76px;max-height:54px;object-fit:contain;flex:0 0 auto;">` : "";
  return `<div class="company-header" style="display:flex;gap:10px;align-items:flex-start;">${logoMarkup}<div class="company-text"><h1>${esc(companyName(settings))}</h1>${title ? `<h2>${esc(title)}</h2>` : ""}${lines ? `<p class="company-lines">${lines}</p>` : ""}</div></div>`;
}

function signatureLabel(value, fallback) {
  return value ? `${value}<br>${fallback}` : fallback;
}

function customerPrintStyles(page = "A4 portrait") {
  return `@page{size:${page};margin:12mm}body{font-family:Arial,sans-serif;font-size:12px;color:#111;margin:0}.print-button{margin-bottom:10px}.document-sheet{padding:0}.document-header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:12px}.company-header{display:flex;gap:10px;align-items:flex-start}.company-logo{max-width:76px;max-height:54px;object-fit:contain;flex:0 0 auto}.company-text h1,h1{margin:0 0 3px;font-size:22px}.company-text h2,h2{margin:2px 0 4px;font-size:15px}.company-lines{margin:4px 0 0;line-height:1.35}.document-meta{text-align:right;line-height:1.45}.muted{color:#555}.footer-note{margin-top:18px;white-space:pre-wrap}table{width:100%;border-collapse:collapse;margin-top:10px}td,th{border:1px solid #222;padding:6px;vertical-align:top}th{background:#f1f1f1}.label{font-weight:bold;width:22%;background:#f3f3f3}.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.totals{margin-left:auto;width:330px}.signatures{display:grid;gap:48px;margin-top:52px}.signatures.two{grid-template-columns:1fr 1fr}.signatures.three{grid-template-columns:repeat(3,1fr)}.sig,.signatures div{border-top:1px solid #111;text-align:center;padding-top:6px}@media print{.print-button{display:none}}`;
}

const DASHBOARD_DEPARTMENTS = [
  { key: "overview", label: "Overview", roles: ["admin", "viewer"] },
  { key: "operations", label: "Operations", roles: ["admin", "encoder", "viewer"] },
  { key: "finance", label: "Finance", roles: ["admin", "accounting", "viewer"] },
  { key: "maintenance", label: "Maintenance", roles: ["admin", "encoder", "viewer"] },
  { key: "workforce", label: "Workforce", roles: ["admin", "encoder", "accounting", "viewer"] },
];

function dashboardFilters(url) {
  const current = currentMonthBounds();
  const dateFrom = url.searchParams.get("date_from") || current.start;
  const dateTo = url.searchParams.get("date_to") || current.end;
  const invalidDateRange = dateFrom > dateTo;
  return {
    date_from: invalidDateRange ? current.start : dateFrom,
    date_to: invalidDateRange ? current.end : dateTo,
    requested_tab: url.searchParams.get("tab") || "",
    invalidDateRange,
  };
}

function dashboardDepartmentsFor(user) {
  return DASHBOARD_DEPARTMENTS.filter((department) => department.roles.includes(user.role));
}

function dashboardDefaultDepartment(user) {
  if (user.role === "encoder") return "operations";
  if (user.role === "accounting") return "finance";
  return "overview";
}

function dashboardDepartment(user, filters) {
  const permitted = new Set(dashboardDepartmentsFor(user).map((department) => department.key));
  return permitted.has(filters.requested_tab) ? filters.requested_tab : dashboardDefaultDepartment(user);
}

function dashboardParams(filters, tab = filters.requested_tab) {
  const params = new URLSearchParams({ date_from: filters.date_from, date_to: filters.date_to });
  if (tab) params.set("tab", tab);
  return params;
}

function dashboardHref(filters, tab) {
  return `/?${dashboardParams(filters, tab).toString()}`;
}

function dashboardRange(rows, field, filters) {
  return (rows || []).filter((row) => {
    const value = String(row[field] || "").slice(0, 10);
    return value && value >= filters.date_from && value <= filters.date_to;
  });
}

function dashboardCurrent(rows, status = "Open") {
  return (rows || []).filter((row) => String(row.status || "") === status);
}

function dashboardSum(rows, field) {
  return (rows || []).reduce((total, row) => total + numeric(row[field]), 0);
}

function dashboardCountBy(rows, key, fallback = "Unspecified") {
  const counts = new Map();
  for (const row of rows || []) {
    const label = String(row[key] || fallback);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].map(([label, value]) => ({ label, value }));
}

function dashboardMoneyBy(rows, key, amount, fallback = "Unspecified") {
  const totals = new Map();
  for (const row of rows || []) {
    const label = String(row[key] || fallback);
    totals.set(label, (totals.get(label) || 0) + numeric(row[amount]));
  }
  return [...totals.entries()].map(([label, value]) => ({ label, value }));
}

function dashboardKpis(items) {
  return `<section class="dashboard-kpis" aria-label="Key performance indicators">${items.map((item) => {
    const content = `<span class="dashboard-kpi-label">${esc(item.label)}</span><strong>${esc(item.value)}</strong>${item.detail ? `<small>${esc(item.detail)}</small>` : ""}`;
    return item.href
      ? `<a class="dashboard-kpi dashboard-kpi-${esc(item.tone || "blue")}" href="${esc(item.href)}">${content}</a>`
      : `<article class="dashboard-kpi dashboard-kpi-${esc(item.tone || "blue")}">${content}</article>`;
  }).join("")}</section>`;
}

function dashboardVisual(title, subtitle, body, className = "") {
  return `<section class="dashboard-visual ${esc(className)}"><header><div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}</div></header>${body}</section>`;
}

function dashboardTrend(title, subtitle, series, href = "") {
  const points = new Map();
  for (const item of series) {
    for (const point of item.points) points.set(point.label, true);
  }
  const labels = [...points.keys()].sort().slice(-31);
  const max = Math.max(1, ...labels.flatMap((label) => series.map((item) => numeric(item.points.find((point) => point.label === label)?.value))));
  const body = labels.length
    ? `<div class="trend-legend">${series.map((item) => `<span><i class="legend-dot ${esc(item.color)}"></i>${esc(item.label)}</span>`).join("")}</div><div class="trend-chart" role="img" aria-label="${esc(`${title}: ${subtitle}`)}">${labels.map((label) => {
      const bars = series.map((item) => {
        const value = numeric(item.points.find((point) => point.label === label)?.value);
        const height = value ? Math.max(5, Math.round((value / max) * 100)) : 0;
        return `<i class="trend-bar ${esc(item.color)}" style="height:${height}%" title="${esc(`${item.label}: ${value}`)}"></i>`;
      }).join("");
      const labelText = label.length > 7 ? label.slice(5) : label;
      const column = `<span class="trend-bars">${bars}</span><small>${esc(labelText)}</small>`;
      return href ? `<a class="trend-column" href="${esc(href)}" aria-label="${esc(`${label}: open details`)}">${column}</a>` : `<span class="trend-column">${column}</span>`;
    }).join("")}</div>`
    : `<p class="dashboard-empty">No activity in this period.</p>`;
  return dashboardVisual(title, subtitle, body, "dashboard-visual-primary");
}

function dashboardStatusChart(title, subtitle, entries, hrefFor = () => "") {
  const visible = entries.filter((entry) => numeric(entry.value) > 0);
  const total = visible.reduce((sum, entry) => sum + numeric(entry.value), 0);
  const colors = ["blue", "green", "gold", "purple", "slate", "red"];
  const body = total
    ? `<div class="status-stack" role="img" aria-label="${esc(`${title}: ${visible.map((entry) => `${entry.label} ${entry.value}`).join(", ")}`)}">${visible.map((entry, index) => {
      const href = hrefFor(entry.label);
      const segment = `<span class="status-segment ${colors[index % colors.length]}" style="flex:${numeric(entry.value)}" title="${esc(`${entry.label}: ${entry.value}`)}"></span>`;
      return href ? `<a href="${esc(href)}" aria-label="${esc(`${entry.label}: ${entry.value}. Open details.`)}">${segment}</a>` : segment;
    }).join("")}</div><div class="status-legend">${visible.map((entry, index) => {
      const href = hrefFor(entry.label);
      const content = `<i class="legend-dot ${colors[index % colors.length]}"></i><span>${esc(entry.label)}</span><strong>${esc(entry.value)}</strong>`;
      return href ? `<a href="${esc(href)}">${content}</a>` : `<span>${content}</span>`;
    }).join("")}</div>`
    : `<p class="dashboard-empty">No records in this period.</p>`;
  return dashboardVisual(title, subtitle, body);
}

function dashboardBarChart(title, subtitle, entries, { moneyValues = false, hrefFor = () => "" } = {}) {
  const visible = [...entries].filter((entry) => numeric(entry.value) > 0).sort((a, b) => numeric(b.value) - numeric(a.value)).slice(0, 6);
  const max = Math.max(1, ...visible.map((entry) => numeric(entry.value)));
  const body = visible.length
    ? `<div class="ranked-bars">${visible.map((entry) => {
      const href = hrefFor(entry);
      const content = `<span>${esc(entry.label)}</span><i><b style="width:${Math.max(3, Math.round((numeric(entry.value) / max) * 100))}%"></b></i><strong>${esc(moneyValues ? peso(entry.value) : entry.value)}</strong>`;
      return href ? `<a href="${esc(href)}">${content}</a>` : `<div>${content}</div>`;
    }).join("")}</div>`
    : `<p class="dashboard-empty">No records in this period.</p>`;
  return dashboardVisual(title, subtitle, body);
}

function dashboardAttention(title, items) {
  const body = items.length
    ? `<ul class="dashboard-alerts">${items.slice(0, 6).map((item) => `<li class="${esc(item.tone || "warning")}"><a href="${esc(item.href)}"><span>${esc(item.label)}</span><strong>${esc(item.value)}</strong><small>${esc(item.detail || "")}</small></a></li>`).join("")}</ul>`
    : `<p class="dashboard-empty">Nothing needs attention right now.</p>`;
  return dashboardVisual(title, "Items that need a follow-up", body, "dashboard-attention");
}

function dashboardRecentActivity(items) {
  const rows = [...items].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 7)
    .map((item) => `<tr><td>${esc(item.date)}</td><td><span class="activity-type">${esc(item.type)}</span></td><td><a href="${esc(item.href)}">${esc(item.reference)}</a><span class="cell-detail">${esc(item.detail)}</span></td><td><span class="status">${esc(item.status || "")}</span></td></tr>`);
  return dashboardVisual("Recent Activity", "Most recent permitted records", table(["Date", "Area", "Record", "Status"], rows, { empty: "No recent activity in this period.", bare: true }), "dashboard-recent");
}

function dashboardWorkPoints(rows, field, amount = () => 1) {
  const values = new Map();
  for (const row of rows || []) {
    const label = String(row[field] || "").slice(0, 10);
    if (label) values.set(label, (values.get(label) || 0) + numeric(amount(row)));
  }
  return [...values.entries()].map(([label, value]) => ({ label, value }));
}

async function dashboardData(env, filters) {
  const [trips, allTrips, projectWork, projects, assets, employees, repairs, payables, vale, cash, billings, collections, payroll, billingLines, billingProjectLines] = await Promise.all([
    all(env, "SELECT t.*, c.client_name, a.asset_code FROM trips t LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN assets a ON a.id=t.asset_id WHERE t.trip_date>=? AND t.trip_date<=? ORDER BY t.trip_date DESC, t.id DESC", [filters.date_from, filters.date_to]),
    all(env, "SELECT id, trip_date, status FROM trips"),
    all(env, "SELECT w.*, p.project_no, c.client_name, a.asset_code FROM project_work_entries w JOIN projects p ON p.id=w.project_id LEFT JOIN clients c ON c.id=w.client_id_snapshot LEFT JOIN assets a ON a.id=w.asset_id_snapshot WHERE w.work_date>=? AND w.work_date<=? ORDER BY w.work_date DESC, w.id DESC", [filters.date_from, filters.date_to]),
    all(env, "SELECT p.*, c.client_name, a.asset_code FROM projects p LEFT JOIN clients c ON c.id=p.client_id LEFT JOIN assets a ON a.id=p.asset_id ORDER BY p.start_date DESC, p.id DESC"),
    all(env, "SELECT * FROM assets ORDER BY asset_code, id"),
    all(env, "SELECT * FROM employees ORDER BY full_name, id"),
    all(env, "SELECT r.*, a.asset_code, s.supplier_name FROM repairs r LEFT JOIN assets a ON a.id=r.asset_id LEFT JOIN suppliers s ON s.id=r.supplier_id ORDER BY r.repair_date DESC, r.id DESC"),
    all(env, "SELECT p.*, s.supplier_name FROM payables p LEFT JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.payable_date DESC, p.id DESC"),
    all(env, "SELECT v.*, e.full_name, e.employee_code FROM vale_records v LEFT JOIN employees e ON e.id=v.employee_id ORDER BY v.date_granted DESC, v.id DESC"),
    all(env, "SELECT c.*, e.full_name, e.employee_code FROM cash_advances c LEFT JOIN employees e ON e.id=c.employee_id ORDER BY c.date_granted DESC, c.id DESC"),
    all(env, "SELECT b.*, c.client_name FROM billing_statements b LEFT JOIN clients c ON c.id=b.client_id ORDER BY b.billing_date DESC, b.id DESC"),
    all(env, "SELECT co.*, b.billing_no, c.client_name FROM collections co LEFT JOIN billing_statements b ON b.id=co.billing_id LEFT JOIN clients c ON c.id=co.client_id ORDER BY co.collection_date DESC, co.id DESC"),
    all(env, "SELECT p.*, e.full_name FROM payroll_entries p LEFT JOIN employees e ON e.id=p.employee_id ORDER BY p.pay_date DESC, p.id DESC"),
    all(env, "SELECT trip_id FROM billing_lines"),
    all(env, "SELECT work_entry_id FROM billing_project_lines"),
  ]);
  return {
    trips: dashboardRange(trips, "trip_date", filters),
    allTrips,
    projectWork: dashboardRange(projectWork, "work_date", filters),
    projects,
    assets,
    employees,
    repairs,
    payables,
    vale,
    cash,
    billings,
    collections,
    payroll: dashboardRange(payroll, "pay_date", filters),
    billingLines,
    billingProjectLines,
  };
}

function dashboardModel(data, filters) {
  const billedTripIds = new Set(data.billingLines.map((row) => Number(row.trip_id)));
  const billedProjectIds = new Set(data.billingProjectLines.map((row) => Number(row.work_entry_id)));
  const periodBillings = dashboardRange(data.billings, "billing_date", filters);
  const periodCollections = dashboardRange(data.collections, "collection_date", filters);
  const paidByBilling = new Map();
  for (const collection of data.collections) {
    paidByBilling.set(Number(collection.billing_id), (paidByBilling.get(Number(collection.billing_id)) || 0) + numeric(collection.amount_paid));
  }
  const billingBalances = data.billings.map((billing) => ({ ...billing, paid_amount: paidByBilling.get(Number(billing.id)) || 0, balance: outstandingBalance(billing.grand_total, paidByBilling.get(Number(billing.id)) || 0) }));
  const completedTrips = data.trips.filter((row) => ["Completed", "Billed", "Paid"].includes(row.status));
  const completedProjectWork = data.projectWork.filter((row) => ["Completed", "Billed"].includes(row.status));
  const unbilledTrips = data.trips.filter((row) => row.status === "Completed" && !billedTripIds.has(Number(row.id)));
  const unbilledProjectWork = data.projectWork.filter((row) => row.status === "Completed" && !billedProjectIds.has(Number(row.id)));
  const openPayables = data.payables.filter((row) => ["Open", "Partial"].includes(row.status));
  const openVale = dashboardCurrent(data.vale);
  const openCash = dashboardCurrent(data.cash);
  const activeProjects = data.projects.filter((row) => row.status === "Active");
  const activeEmployees = data.employees.filter((row) => Number(row.active) !== 0 && row.employment_status !== "Inactive");
  const assetsInMaintenance = data.assets.filter((row) => /maintenance|repair/i.test(String(row.status || "")));
  const linkedRepairIds = new Set(data.payables.filter((row) => row.linked_repair_id).map((row) => Number(row.linked_repair_id)));
  const completedWork = [...completedTrips, ...completedProjectWork];
  return {
    ...data,
    filters,
    periodBillings,
    periodCollections,
    billingBalances,
    completedTrips,
    completedProjectWork,
    completedWork,
    unbilledTrips,
    unbilledProjectWork,
    unbilledWork: [...unbilledTrips, ...unbilledProjectWork],
    openPayables,
    openVale,
    openCash,
    ongoingTrips: data.allTrips.filter((row) => row.status === "Ongoing"),
    periodRepairs: dashboardRange(data.repairs, "repair_date", filters),
    openRepairs: data.repairs.filter((row) => row.status === "Open"),
    activeProjects,
    activeEmployees,
    assetsInMaintenance,
    linkedRepairIds,
  };
}

function dashboardOperations(model, user) {
  const operationalStatus = dashboardCountBy([
    ...model.trips.map((row) => ({ status: row.status })),
    ...model.projectWork.map((row) => ({ status: row.status })),
  ], "status");
  const topClients = dashboardCountBy([
    ...model.trips.map((row) => ({ client_name: row.client_name })),
    ...model.projectWork.map((row) => ({ client_name: row.client_name })),
  ], "client_name");
  const aging = model.trips.filter((row) => ["Planned", "Ongoing"].includes(row.status) && row.trip_date < model.filters.date_to);
  const kpis = [
    { label: "Total Work", value: String(model.trips.length + model.projectWork.length), detail: "Selected period", href: "/trips" },
    { label: "Ongoing Trips", value: String(model.ongoingTrips.length), detail: "Current", href: "/trips?status=Ongoing", tone: "gold" },
    { label: "Completed Work", value: String(model.completedWork.length), detail: "Selected period", href: "/trips?status=Completed", tone: "green" },
    { label: "Active Projects", value: String(model.activeProjects.length), detail: "Current", href: "/projects", tone: "purple" },
    { label: "Unbilled Work", value: String(model.unbilledWork.length), detail: "Ready for billing", href: canView(user, "Billing") ? "/billing/new" : "", tone: "red" },
    { label: "Utilized Units", value: String(new Set([...model.trips.map((row) => row.asset_id), ...model.projectWork.map((row) => row.asset_id_snapshot)].filter(Boolean)).size), detail: "Selected period", href: "/fleet" },
  ];
  const visuals = `<div class="dashboard-visual-grid"><div>${dashboardTrend("Work Activity", "Trips and project entries by date", [
    { label: "Trips", color: "blue", points: dashboardWorkPoints(model.trips, "trip_date") },
    { label: "Project entries", color: "purple", points: dashboardWorkPoints(model.projectWork, "work_date") },
  ], "/trips")}</div><div>${dashboardStatusChart("Work Status", "Selected period", operationalStatus, (status) => `/trips?status=${encodeURIComponent(status)}`)}</div><div>${dashboardBarChart("Top Clients", "Work volume in the selected period", topClients, { hrefFor: (entry) => `/trips?q=${encodeURIComponent(entry.label)}` })}</div><div>${dashboardAttention("Attention Needed", [
    { label: "Completed work not yet billed", value: `${model.unbilledWork.length}`, detail: "Open Billing to process eligible work", href: canView(user, "Billing") ? "/billing/new" : "/trips?status=Completed", tone: "warning" },
    { label: "Planned or ongoing trips before this period end", value: `${aging.length}`, detail: "Review and update the trip status", href: "/trips?status=Ongoing", tone: aging.length ? "warning" : "success" },
  ])}</div></div>`;
  return `${dashboardKpis(kpis)}${visuals}`;
}

function dashboardFinance(model, user) {
  const receivables = model.billingBalances.filter((row) => numeric(row.balance) > 0);
  const financeStatus = dashboardCountBy(model.billingBalances, "status");
  const clients = model.billingBalances.map((row) => ({ ...row, client_name: row.client_name || "Unspecified", outstanding: row.balance })).filter((row) => numeric(row.outstanding) > 0);
  const canSeeAdvances = canView(user, "Vale / Cash Advance");
  const kpis = [
    { label: "Billed", value: peso(dashboardSum(model.periodBillings, "grand_total")), detail: "Selected period", href: "/billing" },
    { label: "Collections", value: peso(dashboardSum(model.periodCollections, "amount_paid")), detail: "Selected period", href: "/collections", tone: "green" },
    { label: "Receivables", value: peso(dashboardSum(receivables, "balance")), detail: "Current", href: "/billing/soa", tone: "gold" },
    { label: "Payroll", value: peso(dashboardSum(model.payroll, "net_pay")), detail: "Selected period", href: "/payroll", tone: "purple" },
    { label: "Open Payables", value: peso(dashboardSum(model.openPayables, "amount")), detail: "Current", href: "/payables", tone: "red" },
    canSeeAdvances
      ? { label: "Open Advances", value: peso(dashboardSum(model.openVale, "balance") + dashboardSum(model.openCash, "balance")), detail: "Current", href: "/advances", tone: "blue" }
      : { label: "Outstanding Billings", value: String(receivables.length), detail: "Current", href: "/billing/soa", tone: "blue" },
  ];
  const alerts = [
    { label: "Outstanding client billings", value: `${receivables.length}`, detail: "Review Statement of Account balances", href: "/billing/soa", tone: receivables.length ? "warning" : "success" },
    { label: "Open or partial payables", value: `${model.openPayables.length}`, detail: "Review supplier obligations", href: "/payables", tone: model.openPayables.length ? "warning" : "success" },
    { label: "Completed work waiting for billing", value: `${model.unbilledWork.length}`, detail: "Create a billing statement", href: "/billing/new", tone: model.unbilledWork.length ? "warning" : "success" },
  ];
  return `${dashboardKpis(kpis)}<div class="dashboard-visual-grid"><div>${dashboardTrend("Billed vs Collected", "Amounts by date in the selected period", [
    { label: "Billed", color: "blue", points: dashboardWorkPoints(model.periodBillings, "billing_date", (row) => row.grand_total) },
    { label: "Collected", color: "green", points: dashboardWorkPoints(model.periodCollections, "collection_date", (row) => row.amount_paid) },
  ], "/billing")}</div><div>${dashboardStatusChart("Billing Status", "Current billing statements", financeStatus, (status) => `/billing?status=${encodeURIComponent(status)}`)}</div><div>${dashboardBarChart("Receivables by Client", "Current outstanding balances", dashboardMoneyBy(clients, "client_name", "outstanding"), { moneyValues: true, hrefFor: () => "/billing/soa" })}</div><div>${dashboardAttention("Attention Needed", alerts)}</div></div>`;
}

function dashboardMaintenance(model) {
  const repairStatus = dashboardCountBy(model.periodRepairs, "status");
  const repairsByAsset = dashboardMoneyBy(model.periodRepairs, "asset_code", "total_cost");
  const openRepairs = model.openRepairs;
  const linked = model.periodRepairs.filter((row) => model.linkedRepairIds.has(Number(row.id))).length;
  const kpis = [
    { label: "Open Repairs", value: String(openRepairs.length), detail: "Current period", href: "/repairs?status=Open", tone: "gold" },
    { label: "Repair Cost", value: peso(dashboardSum(model.periodRepairs, "total_cost")), detail: "Selected period", href: "/repairs", tone: "red" },
    { label: "Repaired Units", value: String(new Set(model.periodRepairs.map((row) => row.asset_id).filter(Boolean)).size), detail: "Selected period", href: "/fleet" },
    { label: "Assets in Maintenance", value: String(model.assetsInMaintenance.length), detail: "Current", href: "/fleet", tone: "gold" },
    { label: "Payable-linked Repairs", value: String(linked), detail: "Selected period", href: "/payables", tone: "purple" },
  ];
  return `${dashboardKpis(kpis)}<div class="dashboard-visual-grid"><div>${dashboardTrend("Repair Cost Trend", "Repair cost by date", [{ label: "Repair cost", color: "red", points: dashboardWorkPoints(model.periodRepairs, "repair_date", (row) => row.total_cost) }], "/repairs")}</div><div>${dashboardStatusChart("Repair Status", "Selected period", repairStatus, (status) => `/repairs?status=${encodeURIComponent(status)}`)}</div><div>${dashboardBarChart("Cost by Unit", "Highest repair cost in the selected period", repairsByAsset, { moneyValues: true, hrefFor: () => "/repairs" })}</div><div>${dashboardAttention("Attention Needed", [
    { label: "Open repairs", value: `${openRepairs.length}`, detail: "Review repair progress and status", href: "/repairs?status=Open", tone: openRepairs.length ? "warning" : "success" },
    { label: "Assets marked for maintenance", value: `${model.assetsInMaintenance.length}`, detail: "Check fleet availability", href: "/fleet", tone: model.assetsInMaintenance.length ? "warning" : "success" },
  ])}</div></div>`;
}

function dashboardWorkforce(model, user) {
  const canPayroll = canView(user, "Payroll");
  const canAdvances = canView(user, "Vale / Cash Advance");
  const employeeTypes = dashboardCountBy(canView(user, "Employees") ? model.activeEmployees : model.payroll, "employee_type");
  const recentRows = canPayroll
    ? model.payroll.map((row) => ({ date: row.pay_date, type: "Payroll", reference: row.full_name || "Payroll entry", detail: row.employee_type || "", status: peso(row.net_pay), href: `/payroll/${row.id}` }))
    : [...model.openVale.map((row) => ({ date: row.date_granted, type: "Vale", reference: row.full_name || row.employee_code || "Employee", detail: "Open balance", status: peso(row.balance), href: "/advances" })), ...model.openCash.map((row) => ({ date: row.date_granted, type: "Cash Advance", reference: row.full_name || row.employee_code || "Employee", detail: "Open balance", status: peso(row.balance), href: "/advances" }))];
  const kpis = [
    ...(canView(user, "Employees") ? [{ label: "Active Employees", value: String(model.activeEmployees.length), detail: "Current", href: "/employees" }] : []),
    ...(canPayroll ? [{ label: "Payroll Total", value: peso(dashboardSum(model.payroll, "net_pay")), detail: "Selected period", href: "/payroll", tone: "purple" }, { label: "Payroll Entries", value: String(model.payroll.length), detail: "Selected period", href: "/payroll" }] : []),
    ...(canAdvances ? [{ label: "Open Vale", value: peso(dashboardSum(model.openVale, "balance")), detail: "Current", href: "/advances", tone: "gold" }, { label: "Open Cash Advance", value: peso(dashboardSum(model.openCash, "balance")), detail: "Current", href: "/advances", tone: "red" }] : []),
  ];
  const primaryVisual = canPayroll
    ? dashboardTrend("Payroll Trend", "Net pay by pay date", [{ label: "Net pay", color: "purple", points: dashboardWorkPoints(model.payroll, "pay_date", (row) => row.net_pay) }], "/payroll")
    : dashboardBarChart("Employees by Designation", "Current active employees", employeeTypes, { hrefFor: () => "/employees" });
  const secondaryVisual = canAdvances
    ? dashboardBarChart("Open Advances", "Current employee balances", [{ label: "Vale", value: dashboardSum(model.openVale, "balance") }, { label: "Cash Advance", value: dashboardSum(model.openCash, "balance") }], { moneyValues: true, hrefFor: () => "/advances" })
    : dashboardBarChart("Employees Paid", "Payroll entries by employee type", dashboardCountBy(model.payroll, "employee_type"), { hrefFor: () => "/payroll" });
  return `${dashboardKpis(kpis)}<div class="dashboard-visual-grid"><div>${primaryVisual}</div><div>${dashboardStatusChart(canView(user, "Employees") ? "Employee Distribution" : "Payroll by Employee Type", canView(user, "Employees") ? "Current active workforce" : "Selected period", employeeTypes, () => canView(user, "Employees") ? "/employees" : "/payroll")}</div><div>${secondaryVisual}</div><div>${dashboardRecentActivity(recentRows)}</div></div>`;
}

function dashboardOverview(model, user) {
  const finance = canView(user, "Billing");
  const recent = [
    ...model.trips.map((row) => ({ date: row.trip_date, type: "Trip", reference: row.trip_ticket_no, detail: row.client_name || row.origin || "", status: row.status, href: `/trips/${row.id}` })),
    ...model.projectWork.map((row) => ({ date: row.work_date, type: "Project Work", reference: row.project_no || row.work_no, detail: row.client_name || "", status: row.status, href: `/projects/${row.project_id}` })),
    ...(finance ? model.periodBillings.map((row) => ({ date: row.billing_date, type: "Billing", reference: row.billing_no, detail: row.client_name || "", status: row.status, href: `/billing/${row.id}` })) : []),
    ...(canView(user, "Collections") ? model.periodCollections.map((row) => ({ date: row.collection_date, type: "Collection", reference: row.billing_no || row.reference_no || "Collection", detail: row.client_name || "", status: peso(row.amount_paid), href: "/collections" })) : []),
    ...(canView(user, "Payroll") ? model.payroll.map((row) => ({ date: row.pay_date, type: "Payroll", reference: row.full_name || "Payroll entry", detail: row.employee_type || "", status: peso(row.net_pay), href: `/payroll/${row.id}` })) : []),
  ];
  const kpis = finance
    ? [
      { label: "Ongoing Trips", value: String(model.ongoingTrips.length), detail: "Current", href: "/trips?status=Ongoing", tone: "gold" },
      { label: "Completed Work", value: String(model.completedWork.length), detail: "Selected period", href: "/trips?status=Completed", tone: "green" },
      { label: "Active Projects", value: String(model.activeProjects.length), detail: "Current", href: "/projects", tone: "purple" },
      { label: "Receivables", value: peso(dashboardSum(model.billingBalances.filter((row) => numeric(row.balance) > 0), "balance")), detail: "Current", href: "/billing/soa", tone: "gold" },
      { label: "Open Payables", value: peso(dashboardSum(model.openPayables, "amount")), detail: "Current", href: "/payables", tone: "red" },
      { label: "Open Advances", value: peso(dashboardSum(model.openVale, "balance") + dashboardSum(model.openCash, "balance")), detail: "Current", href: canView(user, "Vale / Cash Advance") ? "/advances" : "", tone: "blue" },
    ]
    : [
      { label: "Total Work", value: String(model.trips.length + model.projectWork.length), detail: "Selected period", href: "/trips" },
      { label: "Ongoing Trips", value: String(model.trips.filter((row) => row.status === "Ongoing").length), detail: "Current", href: "/trips?status=Ongoing", tone: "gold" },
      { label: "Active Projects", value: String(model.activeProjects.length), detail: "Current", href: "/projects", tone: "purple" },
      { label: "Completed Work", value: String(model.completedWork.length), detail: "Selected period", href: "/trips?status=Completed", tone: "green" },
      { label: "Active Employees", value: String(model.activeEmployees.length), detail: "Current", href: "/employees" },
      { label: "Open Repairs", value: String(model.openRepairs.length), detail: "Current", href: "/repairs?status=Open", tone: "red" },
    ];
  return `${dashboardKpis(kpis)}<div class="dashboard-visual-grid dashboard-overview-grid"><div>${dashboardTrend("Work Activity", "Trips and project entries by date", [
    { label: "Trips", color: "blue", points: dashboardWorkPoints(model.trips, "trip_date") },
    { label: "Project entries", color: "purple", points: dashboardWorkPoints(model.projectWork, "work_date") },
  ], "/trips")}</div><div>${dashboardStatusChart("Work Status", "Selected period", dashboardCountBy([...model.trips, ...model.projectWork], "status"), (status) => `/trips?status=${encodeURIComponent(status)}`)}</div><div>${dashboardRecentActivity(recent)}</div><div>${dashboardAttention("Attention Needed", [
    { label: "Completed work waiting for billing", value: `${model.unbilledWork.length}`, detail: "Open Billing to process eligible work", href: finance ? "/billing/new" : "/trips?status=Completed", tone: model.unbilledWork.length ? "warning" : "success" },
    { label: "Open repairs", value: `${model.openRepairs.length}`, detail: "Review maintenance progress", href: "/repairs?status=Open", tone: model.openRepairs.length ? "warning" : "success" },
  ])}</div></div>`;
}

function dashboardFilterBar(filters, department, departments) {
  const tabs = departments.map((item) => `<a class="dashboard-tab${department === item.key ? " active" : ""}" href="${esc(dashboardHref(filters, item.key))}"${department === item.key ? ' aria-current="page"' : ""}>${esc(item.label)}</a>`).join("");
  const rangeMessage = filters.invalidDateRange ? `<p class="error dashboard-filter-error">Date From must not be after Date To. The current month is displayed instead.</p>` : "";
  return `<section class="dashboard-controls"><div class="dashboard-tabs" aria-label="Dashboard departments">${tabs}</div><details class="dashboard-mobile-filters" open><summary>Period filters</summary><form method="get" class="dashboard-filter-form"><input type="hidden" name="tab" value="${esc(department)}"><label>From<input type="date" name="date_from" value="${esc(filters.date_from)}"></label><label>To<input type="date" name="date_to" value="${esc(filters.date_to)}"></label><button>Apply</button><a class="button secondary" href="${esc(dashboardHref({ ...filters, ...currentMonthBounds() }, department))}">Current Month</a><a class="button quiet" href="/">Clear</a></form></details>${rangeMessage}</section>`;
}

async function dashboardPage(request, env, user, path) {
  const url = new URL(request.url);
  const filters = dashboardFilters(url);
  const department = dashboardDepartment(user, filters);
  filters.requested_tab = department;
  const model = dashboardModel(await dashboardData(env, filters), filters);
  const body = department === "operations"
    ? dashboardOperations(model, user)
    : department === "finance"
      ? dashboardFinance(model, user)
      : department === "maintenance"
        ? dashboardMaintenance(model, user)
        : department === "workforce"
          ? dashboardWorkforce(model, user)
          : dashboardOverview(model, user);
  const content = `${dashboardFilterBar(filters, department, dashboardDepartmentsFor(user))}<section class="dashboard-canvas"><header class="dashboard-heading"><div><span>Department Dashboard</span><h2>${esc(DASHBOARD_DEPARTMENTS.find((item) => item.key === department)?.label || "Overview")}</h2></div><p>${esc(`${filters.date_from} to ${filters.date_to}`)}</p></header>${body}</section>`;
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

function listSort(url, options, fallback, { sortName = "sort", dirName = "dir" } = {}) {
  const key = String(url.searchParams.get(sortName) || "");
  const option = options[key];
  if (!option) return { key: "", dir: "", order: fallback };
  const requested = String(url.searchParams.get(dirName) || "").toLowerCase();
  const dir = requested === "asc" || requested === "desc" ? requested : (option.defaultDir || "asc");
  return { key, dir, order: `${option.sql} ${dir.toUpperCase()}${option.tie ? `, ${option.tie}` : ""}` };
}

function listParams(url, names, { includePage = false, sort = null, sortName = "sort", dirName = "dir" } = {}) {
  const params = new URLSearchParams();
  for (const name of names) {
    if (name === sortName || name === dirName) continue;
    const value = String(url.searchParams.get(name) || "").trim();
    if (value) params.set(name, value);
  }
  if (sort?.key) {
    params.set(sortName, sort.key);
    params.set(dirName, sort.dir);
  }
  if (includePage) {
    const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
    if (page > 1) params.set("page", String(page));
  }
  return params;
}

function sortableHeaders(columns, sort, params, { sortName = "sort", dirName = "dir" } = {}) {
  return columns.map((column) => {
    if (!column.sort) return column.label;
    const next = new URLSearchParams(params);
    const selected = sort.key === column.sort;
    const dir = selected && sort.dir === "asc" ? "desc" : "asc";
    next.set(sortName, column.sort);
    next.set(dirName, dir);
    next.delete("page");
    const indicator = selected ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
    const state = selected ? `, sorted ${sort.dir === "asc" ? "ascending" : "descending"}` : "";
    return { mobileLabel: column.label, html: `<a class="sort-link${selected ? " is-sorted" : ""}" href="?${esc(next.toString())}" aria-label="Sort by ${esc(column.label)}${state}">${esc(column.label)}<span aria-hidden="true">${indicator}</span></a>` };
  });
}

function mergeWhere(where, clauses = [], params = []) {
  const existing = String(where?.sql || "").replace(/^\s*WHERE\s+/i, "");
  const allClauses = [...(existing ? [existing] : []), ...clauses.filter(Boolean)];
  return { sql: allClauses.length ? ` WHERE ${allClauses.join(" AND ")}` : "", params: [...(where?.params || []), ...params] };
}

function safeId(value) {
  return /^\d+$/.test(String(value || "")) ? String(Number(value)) : "";
}

function safeDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";
}

function enumParam(url, name, values) {
  const value = String(url.searchParams.get(name) || "").trim();
  return values.includes(value) ? value : "";
}

function idParam(url, name) {
  return safeId(url.searchParams.get(name));
}

function rangeParams(url, fromName = "date_from", toName = "date_to") {
  return { from: safeDate(url.searchParams.get(fromName)), to: safeDate(url.searchParams.get(toName)) };
}

function addEqualityFilters(clauses, params, filters) {
  for (const [column, value] of filters) {
    if (value) {
      clauses.push(`${column}=?`);
      params.push(value);
    }
  }
}

function addDateRange(clauses, params, column, range) {
  if (range.from) { clauses.push(`${column}>=?`); params.push(range.from); }
  if (range.to) { clauses.push(`${column}<=?`); params.push(range.to); }
}

function selectFilter(name, label, options, selected = "") {
  return `<label>${esc(label)}<select name="${esc(name)}"><option value="">All</option>${options.map((option) => `<option value="${esc(option.value ?? option.id ?? option)}"${String(option.value ?? option.id ?? option) === String(selected) ? " selected" : ""}>${esc(option.label ?? option.name ?? option)}</option>`).join("")}</select></label>`;
}

function dateFilter(name, label, value = "") {
  return `<label>${esc(label)}<input type="date" name="${esc(name)}" value="${esc(value)}"></label>`;
}

function listToolbar({ query, placeholder, filters = "", clearHref, actions = "" }) {
  return `<div class="toolbar list-toolbar"><form method="get" class="list-query-form"><div class="list-search-row"><input name="q" value="${esc(query)}" placeholder="${esc(placeholder)}"><button>Search</button></div>${filters ? `<details class="list-filters"><summary>Filters</summary><div class="list-filter-grid">${filters}</div><div class="list-filter-actions"><button>Apply filters</button><a class="button secondary" href="${esc(clearHref)}">Clear</a></div></details>` : ""}</form><div class="toolbar-actions">${actions}</div></div>`;
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

function masterListFilters(url, spec) {
  const values = {};
  const clauses = [];
  const params = [];
  for (const [key, filter] of Object.entries(spec.filters || {})) {
    const value = String(url.searchParams.get(key) || "").trim();
    const allowed = filter.options.map((option) => String(option.value ?? option));
    if (!allowed.includes(value)) continue;
    values[key] = value;
    clauses.push(`${filter.sql}=?`);
    params.push(value);
  }
  return { values, clauses, params };
}

function masterSortOptions(spec) {
  return Object.fromEntries(spec.columns.map((column) => [column, { sql: column, defaultDir: spec.order.startsWith(column) ? "asc" : "asc", tie: "id" }]));
}

function renderMasterForm(user, path, spec, row, id, errors = []) {
  const renderField = ([name, label, kind]) => {
    const value = row[name] ?? spec.defaults?.[name] ?? "";
    if (kind === "number") return numberInput(name, label, value);
    if (kind === "date") return textInput(name, label, value, 'type="date"');
    if (kind === "boolean") return selectInput(name, label, [{ id: "1", name: "Active" }, { id: "0", name: "Inactive" }], String(value), (item) => item.name, "");
    if (kind === "textarea") return textareaInput(name, label, value, 'rows="2"');
    return textInput(name, label, value);
  };
  const fields = spec.fields.map(renderField);
  const deleteForm = id ? `<form method="post" action="${path}/${id}/delete" class="delete-form" onsubmit="return confirm('Delete this ${esc(spec.title)} record? This is blocked when related records exist.');"><button class="danger">Delete</button><span class="muted">Deletion is guarded when this record is used by trips, billing, payroll, or related records.</span></form>` : "";
  const errorBox = errors.length ? `<section class="panel"><ul class="error">${errors.map((err) => `<li>${esc(err)}</li>`).join("")}</ul></section>` : "";
  let form;
  if (spec.page === "Employees") {
    const groups = [
      ["Identity", fields.slice(0, 3)], ["Contact", fields.slice(3, 5)],
      ["Employment", fields.slice(5, 9)], ["Compensation", fields.slice(9)],
    ];
    form = `<form method="post" action="${id ? `${path}/${id}/edit` : `${path}/new`}" class="app-form"><div class="grid-2">${groups.map(([title, items]) => `<section class="workspace-card"><h3>${title}</h3><div class="field-grid">${items.join("")}</div></section>`).join("")}</div><div class="form-actions"><button>Save Employee</button><a class="button secondary" href="${path}">Cancel</a></div></form>`;
  } else {
    form = formPanel(id ? `${path}/${id}/edit` : `${path}/new`, fields, "Save", { cancelHref: path });
  }
  return `${errorBox}${form}${deleteForm}`;
}

async function masterListContent(request, env, user, path, spec) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const offset = (page - 1) * 25;
  const filterState = masterListFilters(url, spec);
  const where = mergeWhere(predicate(spec, query), filterState.clauses, filterState.params);
  const sort = listSort(url, masterSortOptions(spec), spec.order);
  const countRow = await first(env, `SELECT COUNT(*) AS total FROM ${spec.table}${where.sql}`, where.params);
  const rows = await all(env, `SELECT * FROM ${spec.table}${where.sql} ORDER BY ${sort.order} LIMIT 25 OFFSET ?`, [...where.params, offset]);
  const bodyRows = rows.map((row) => `<tr>${spec.columns.map((col, index) => index === 0 ? `<td>${canEdit(user, spec.page) ? `<a href="${path}/${row.id}/edit">${esc(row[col])}</a>` : esc(row[col])}</td>` : `<td>${esc(row[col])}</td>`).join("")}<td>${canEdit(user, spec.page) ? `<a href="${path}/${row.id}/edit">Edit</a>` : ""}</td></tr>`);
  const filterNames = Object.keys(spec.filters || {});
  const params = listParams(url, ["q", ...filterNames], { sort });
  const filterMarkup = Object.entries(spec.filters || {}).map(([key, filter]) => selectFilter(key, filter.label, filter.options, filterState.values[key] || "")).join("");
  const toolbar = listToolbar({ query, placeholder: `Search ${spec.title}`, filters: filterMarkup, clearHref: path, actions: `${canEdit(user, spec.page) ? `<a class="button" href="${path}/new">New Record</a>` : ""} <a class="button secondary" href="${path}/export.csv${params.toString() ? `?${params.toString()}` : ""}">Export CSV</a>` });
  const headers = [...sortableHeaders(spec.columns.map((column, index) => ({ label: spec.labels[index], sort: column })), sort, params), "Actions"];
  return `${messagePanel(url)}<section class="panel">${toolbar}</section>${table(headers, bodyRows, { empty: `No ${spec.title.toLowerCase()} found.` })}${paginationWithParams(path, params, page, Number(countRow?.total || 0))}`;
}

async function masterList(request, env, user, path, spec) {
  const access = requireView(user, spec.page);
  if (access) return errorResponse(access, user, path);
  return html(layout({ title: spec.title, user, path, content: await masterListContent(request, env, user, path, spec) }));
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
    if (errors.length) {
      const list = await masterListContent(request, env, user, path, spec);
      const dialog = dialogShell({ title: `${id ? "Edit" : "New"} ${spec.title}`, subtitle: id ? "Update record" : "Create record", body: renderMasterForm(user, path, spec, valuesByField, id, errors), closeHref: path });
      return html(layout({ title: spec.title, user, path, content: `${list}${dialog}` }), 400);
    }
    const fields = spec.fields.map(([name]) => name);
    const values = fields.map((name) => valuesByField[name]);
    if (id) {
      try {
        await run(env, `UPDATE ${spec.table} SET ${fields.map((field) => `${field}=?`).join(", ")} WHERE id=?`, [...values, id]);
      } catch (error) {
        const list = await masterListContent(request, env, user, path, spec);
        return html(layout({ title: spec.title, user, path, content: `${list}${dialogShell({ title: `Edit ${spec.title}`, subtitle: "Update record", body: renderMasterForm(user, path, spec, valuesByField, id, [`Could not save record: ${error.message || error}`]), closeHref: path })}` }), 400);
      }
      return redirect(`${path}?ok=${encodeURIComponent(`${spec.title} updated.`)}`);
    } else {
      try {
        await run(env, `INSERT INTO ${spec.table} (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`, values);
      } catch (error) {
        const list = await masterListContent(request, env, user, path, spec);
        return html(layout({ title: spec.title, user, path, content: `${list}${dialogShell({ title: `New ${spec.title}`, subtitle: "Create record", body: renderMasterForm(user, path, spec, valuesByField, id, [`Could not save record: ${error.message || error}`]), closeHref: path })}` }), 400);
      }
      return redirect(`${path}?ok=${encodeURIComponent(`${spec.title} created.`)}`);
    }
  }
  const list = await masterListContent(request, env, user, path, spec);
  const dialog = dialogShell({ title: `${id ? "Edit" : "New"} ${spec.title}`, subtitle: id ? "Update record" : "Create record", body: renderMasterForm(user, path, spec, row, id), closeHref: path });
  return html(layout({ title: spec.title, user, path, content: `${list}${dialog}` }));
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
  const filterState = masterListFilters(url, spec);
  const where = mergeWhere(predicate(spec, query), filterState.clauses, filterState.params);
  const sort = listSort(url, masterSortOptions(spec), spec.order);
  const rows = await all(env, `SELECT ${spec.columns.join(", ")} FROM ${spec.table}${where.sql} ORDER BY ${sort.order}`, where.params);
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

const QUICK_CREATE_PAGES = {
  client: "Clients",
  employee: "Employees",
  asset: "Fleet / Equipment",
  supplier: "Suppliers",
  recurring: "Recurring Trips",
};

function quickCreateAccess(user) {
  if (!user) return { redirect: "/login" };
  if (!["admin", "encoder"].includes(user.role)) return { status: 403, message: "You do not have permission to create related records." };
  return null;
}

function quickCreateError(error) {
  if (error?.redirect) return redirect(error.redirect);
  return json({ ok: false, error: error?.message || "Quick create is not available." }, error?.status || 403);
}

function quickEmployeeType(context, data = {}) {
  if (context === "driver") return "Driver";
  if (context === "helper") return "Helper";
  if (context === "primary") return ["Driver", "Operator"].includes(data.employee_type) ? data.employee_type : "Driver";
  return ["Driver", "Helper", "Operator", "Mechanic"].includes(data.employee_type) ? data.employee_type : "Driver";
}

function quickCreatePrefill(kind, text) {
  const value = String(text || "").trim().slice(0, 100);
  if (!value) return {};
  if (kind === "client") return { client_name: value };
  if (kind === "employee") return { full_name: value };
  if (kind === "asset") return { asset_code: value };
  if (kind === "supplier") return { supplier_name: value };
  if (kind === "recurring") return { master_code: value };
  return {};
}

function quickCreateValues(kind, data, context = "") {
  if (kind === "recurring") return recurringValues(data);
  const path = { client: "/clients", employee: "/employees", asset: "/fleet", supplier: "/suppliers" }[kind];
  const spec = MASTER[path];
  const values = masterValues(spec, data);
  if (kind === "employee") {
    values.employee_type = quickEmployeeType(context, data);
    values.employment_status = data.employment_status === "Inactive" ? "Inactive" : "Active";
    values.payroll_basis = ["Per Trip", "Per Day", "Manual"].includes(data.payroll_basis) ? data.payroll_basis : "Per Trip";
    values.active = data.active === "0" ? "0" : "1";
  }
  if (kind === "asset") values.status = data.status || "Available";
  if (kind === "client") values.active = "1";
  return values;
}

async function quickCreateChoices(env) {
  const [clients, assets, drivers] = await Promise.all([
    all(env, "SELECT * FROM clients WHERE active=1 ORDER BY client_name, id"),
    all(env, "SELECT * FROM assets ORDER BY asset_code, id"),
    all(env, "SELECT * FROM employees WHERE active=1 AND employee_type='Driver' ORDER BY full_name, id"),
  ]);
  return { clients, assets, drivers };
}

function quickCreateDialog(kind, context = "", values = {}, errors = [], choices = {}) {
  const title = { client: "Add Client", employee: `Add ${context === "driver" ? "Driver" : context === "helper" ? "Helper" : context === "primary" ? "Primary Employee" : "Employee"}`, asset: "Add Fleet / Equipment", supplier: "Add Supplier", recurring: "Add Recurring Trip Template" }[kind] || "Add Record";
  const errorBox = errors.length ? `<section class="quick-create-errors"><ul>${errors.map((error) => `<li>${esc(error)}</li>`).join("")}</ul></section>` : "";
  const employeeType = quickEmployeeType(context, values);
  let fields = "";
  if (kind === "client") fields = `${textInput("client_code", "Client code", values.client_code || "")} ${textInput("client_name", "Client name", values.client_name || "", "required")} ${textareaInput("billing_address", "Billing address", values.billing_address || "", 'rows="2"')} ${textInput("contact_person", "Contact person", values.contact_person || "")} ${textInput("contact_no", "Contact no.", values.contact_no || "")} ${numberInput("terms_days", "Terms days", values.terms_days ?? 30)}`;
  if (kind === "employee") {
    const typeControl = ["driver", "helper"].includes(context)
      ? `${textInput("employee_type_display", "Position / designation", employeeType, "readonly")}<input type="hidden" name="employee_type" value="${esc(employeeType)}">`
      : selectInput("employee_type", "Position / designation", (context === "primary" ? ["Driver", "Operator"] : ["Driver", "Helper", "Operator", "Mechanic"]).map((name) => ({ id: name, name })), employeeType, (row) => row.name, "");
    fields = `${textInput("employee_code", "Employee code", values.employee_code || "")} ${textInput("full_name", "Full name", values.full_name || "", "required")} ${typeControl} ${selectInput("payroll_basis", "Payroll basis", ["Per Trip", "Per Day", "Manual"].map((name) => ({ id: name, name })), values.payroll_basis || "Per Trip", (row) => row.name, "")} ${numberInput("trip_rate", "Trip / hourly rate", values.trip_rate ?? 0)} ${numberInput("daily_rate", "Daily rate", values.daily_rate ?? 0)} ${selectInput("employment_status", "Employment status", ["Active", "Inactive"].map((name) => ({ id: name, name })), values.employment_status || "Active", (row) => row.name, "")}`;
  }
  if (kind === "asset") fields = `${textInput("asset_code", "Asset code", values.asset_code || "", "required")} ${textInput("asset_type", "Asset type", values.asset_type || "", "required")} ${textInput("plate_no", "Plate no.", values.plate_no || "")} ${textInput("make_model", "Make / model", values.make_model || "")} ${selectInput("status", "Status", ["Available", "In Use", "Under Maintenance", "Inactive"].map((name) => ({ id: name, name })), values.status || "Available", (row) => row.name, "")}`;
  if (kind === "supplier") fields = `${textInput("supplier_name", "Supplier name", values.supplier_name || "", "required")} ${textInput("contact_person", "Contact person", values.contact_person || "")} ${textInput("contact_no", "Contact no.", values.contact_no || "")}`;
  if (kind === "recurring") fields = `${textInput("master_code", "Template code", values.master_code || "", "required")} ${selectInput("client_id", "Client", choices.clients || [], values.client_id || "", (row) => choiceLabel("client", row), "---------", SEARCHABLE_SELECT)} ${textareaInput("job_description", "Item / Job", values.job_description || "", 'rows="2"')} ${textInput("origin", "Origin", values.origin || "")} ${textInput("destination", "Destination", values.destination || "")} ${selectInput("default_asset_id", "Default asset", choices.assets || [], values.default_asset_id || "", (row) => choiceLabel("asset", row), "---------", SEARCHABLE_SELECT)} ${selectInput("default_driver_id", "Default driver", choices.drivers || [], values.default_driver_id || "", (row) => choiceLabel("employee", row), "---------", SEARCHABLE_SELECT)} ${numberInput("default_helper_count", "Helper count", values.default_helper_count ?? 0)} ${numberInput("standard_base_rate", "Base rate", values.standard_base_rate ?? 0)} ${numberInput("driver_pay_rate", "Driver pay", values.driver_pay_rate ?? 0)} ${numberInput("helper_pay_rate", "Helper pay", values.helper_pay_rate ?? 0)} ${selectInput("active", "Active", [{ id: "1", name: "Active" }, { id: "0", name: "Inactive" }], values.active ?? "1", (row) => row.name, "")}`;
  return `<div class="quick-create-overlay" data-quick-create-overlay><dialog class="app-dialog app-dialog-wide quick-create-dialog" open data-quick-create-dialog aria-modal="true"><div class="dialog-header"><div><span class="dialog-kicker">Quick create</span><h2>${esc(title)}</h2></div><button class="dialog-close" type="button" data-quick-create-close aria-label="Close">×</button></div><div class="dialog-body">${errorBox}<form method="post" action="/quick-create/${esc(kind)}${context ? `?context=${encodeURIComponent(context)}` : ""}" class="app-form quick-create-form" data-quick-create-form><input type="hidden" name="context" value="${esc(context)}"><div class="form-grid quick-create-grid">${fields}</div><div class="form-actions"><button>Create and use</button><button type="button" class="button secondary" data-quick-create-close>Cancel</button></div></form></div></dialog></div>`;
}

async function quickCreatePage(request, env, user, kind, context = "") {
  const access = quickCreateAccess(user);
  if (access) return quickCreateError(access);
  if (!QUICK_CREATE_PAGES[kind]) return json({ ok: false, error: "Unsupported quick-create record." }, 404);
  const normalizedContext = ["driver", "helper", "primary", "employee"].includes(context) ? context : "";
  const choices = kind === "recurring" ? await quickCreateChoices(env) : {};
  if (request.method === "GET") {
    const prefill = new URL(request.url).searchParams.get("prefill") || "";
    return html(quickCreateDialog(kind, normalizedContext, quickCreatePrefill(kind, prefill), [], choices));
  }
  if (request.method !== "POST") return json({ ok: false, error: "Quick create requires POST." }, 405);
  const data = await parseForm(request);
  const values = quickCreateValues(kind, data, normalizedContext);
  const errors = kind === "recurring"
    ? await validateRecurring(env, values)
    : await validateMaster(env, MASTER[{ client: "/clients", employee: "/employees", asset: "/fleet", supplier: "/suppliers" }[kind]], values);
  if (errors.length) return json({ ok: false, dialog: quickCreateDialog(kind, normalizedContext, values, errors, choices) }, 422);
  try {
    let result;
    let tableName;
    if (kind === "recurring") {
      const fields = Object.keys(values);
      result = await run(env, `INSERT INTO recurring_trip_masters (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`, fields.map((field) => values[field]));
      tableName = "recurring_trip_masters";
    } else {
      const spec = MASTER[{ client: "/clients", employee: "/employees", asset: "/fleet", supplier: "/suppliers" }[kind]];
      const fields = spec.fields.map(([name]) => name);
      if (kind === "client") fields.push("active");
      result = await run(env, `INSERT INTO ${spec.table} (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`, fields.map((field) => values[field]));
      tableName = spec.table;
    }
    const id = result?.meta?.last_row_id;
    if (!id) throw new Error("The record was saved, but its new ID was not returned.");
    const record = await first(env, `SELECT * FROM ${tableName} WHERE id=?`, [id]);
    const label = choiceLabel(kind === "recurring" ? "recurring" : kind === "asset" ? "asset" : kind, record || { ...values, id });
    const payload = { id, label, kind };
    if (kind === "recurring") payload.autofill = { id, client_id: values.client_id || "", job_description: values.job_description || "", origin: values.origin || "", destination: values.destination || "", asset_id: values.default_asset_id || "", driver_id: values.default_driver_id || "", helper_count: Number(values.default_helper_count || 0), base_trip_rate: values.standard_base_rate || 0, driver_pay_rate: values.driver_pay_rate || 0, helper_pay_rate: values.helper_pay_rate || 0, default_extra_note: values.default_extra_note || "", remarks: values.remarks || "" };
    return json({ ok: true, record: payload }, 201);
  } catch (error) {
    return json({ ok: false, dialog: quickCreateDialog(kind, normalizedContext, values, [`Could not create record: ${error.message || error}`], choices) }, 400);
  }
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
    selectInput("client_id", "Client", clients, row.client_id || "", (r) => choiceLabel("client", r), "---------", quickSelect("client")),
    textareaInput("job_description", "Item / Job", row.job_description || "", 'rows="2"'),
    textInput("origin", "Origin", row.origin || ""),
    textInput("destination", "Destination", row.destination || ""),
    selectInput("default_asset_id", "Default asset", assets, row.default_asset_id || "", (r) => choiceLabel("asset", r), "---------", quickSelect("asset")),
    selectInput("default_driver_id", "Default driver", drivers, row.default_driver_id || "", (r) => choiceLabel("employee", r), "---------", quickSelect("employee", "driver")),
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
  const filters = { active: enumParam(url, "active", ["0", "1"]), client_id: idParam(url, "client_id"), asset_id: idParam(url, "asset_id"), driver_id: idParam(url, "driver_id") };
  const clauses = [];
  const filterParams = [];
  addEqualityFilters(clauses, filterParams, [["r.active", filters.active], ["r.client_id", filters.client_id], ["r.default_asset_id", filters.asset_id], ["r.default_driver_id", filters.driver_id]]);
  const where = mergeWhere(recurringWhere(query), clauses, filterParams);
  const sort = listSort(url, { code: { sql: "r.master_code", tie: "r.id ASC" }, client: { sql: "c.client_name", tie: "r.id ASC" }, route: { sql: "r.origin", tie: "r.id ASC" }, asset: { sql: "a.asset_code", tie: "r.id ASC" }, driver: { sql: "e.full_name", tie: "r.id ASC" }, helpers: { sql: "r.default_helper_count", defaultDir: "desc", tie: "r.id DESC" }, base: { sql: "r.standard_base_rate", defaultDir: "desc", tie: "r.id DESC" }, driver_pay: { sql: "r.driver_pay_rate", defaultDir: "desc", tie: "r.id DESC" }, helper_pay: { sql: "r.helper_pay_rate", defaultDir: "desc", tie: "r.id DESC" } }, "r.master_code, r.id");
  const countRow = await first(env, `SELECT COUNT(*) AS total FROM recurring_trip_masters r LEFT JOIN clients c ON c.id=r.client_id${where.sql}`, where.params);
  const rows = await all(env, `SELECT r.*, c.client_name, a.asset_code, e.full_name AS driver_name FROM recurring_trip_masters r LEFT JOIN clients c ON c.id=r.client_id LEFT JOIN assets a ON a.id=r.default_asset_id LEFT JOIN employees e ON e.id=r.default_driver_id${where.sql} ORDER BY ${sort.order} LIMIT 25 OFFSET ?`, [...where.params, (page - 1) * 25]);
  const body = rows.map((r) => `<tr><td>${canEdit(user, "Recurring Trips") ? `<a href="/recurring-trips/${r.id}/edit">${esc(r.master_code)}</a>` : esc(r.master_code)}</td><td>${esc(r.client_name || "")}</td><td>${esc(r.origin)} → ${esc(r.destination)}</td><td>${esc(r.asset_code || "")}</td><td>${esc(r.driver_name || "")}</td><td class="num">${esc(r.default_helper_count || 0)}</td><td class="num">${money(r.standard_base_rate)}</td><td class="num">${money(r.driver_pay_rate)}</td><td class="num">${money(r.helper_pay_rate)}</td><td>${canEdit(user, "Recurring Trips") ? `<a href="/recurring-trips/${r.id}/edit">Edit</a>` : `<span class="muted">Read only</span>`}</td></tr>`);
  const params = listParams(url, ["q", "active", "client_id", "asset_id", "driver_id"], { sort });
  const [clients, assets, drivers] = await Promise.all([all(env, "SELECT id,client_code,client_name FROM clients ORDER BY client_name"), all(env, "SELECT id,asset_code,plate_no,asset_type FROM assets ORDER BY asset_code"), all(env, "SELECT id,employee_code,full_name,employee_type FROM employees WHERE active=1 ORDER BY full_name")]);
  const filterMarkup = [selectFilter("active", "Template state", [{ value: "1", label: "Active" }, { value: "0", label: "Inactive" }], filters.active), selectFilter("client_id", "Client", clients.map((row) => ({ value: row.id, label: choiceLabel("client", row) })), filters.client_id), selectFilter("asset_id", "Unit", assets.map((row) => ({ value: row.id, label: choiceLabel("asset", row) })), filters.asset_id), selectFilter("driver_id", "Driver", drivers.map((row) => ({ value: row.id, label: choiceLabel("employee", row) })), filters.driver_id)].join("");
  const toolbar = listToolbar({ query, placeholder: "Search recurring trips", filters: filterMarkup, clearHref: "/recurring-trips", actions: `${canEdit(user, "Recurring Trips") ? `<a class="button" href="/recurring-trips/new">New Template</a>` : ""} <a class="button secondary" href="/recurring-trips/export.csv${params.toString() ? `?${params.toString()}` : ""}">Export CSV</a>` });
  const headers = [...sortableHeaders([{ label: "Code", sort: "code" }, { label: "Client", sort: "client" }, { label: "Route", sort: "route" }, { label: "Asset", sort: "asset" }, { label: "Driver", sort: "driver" }, { label: "Helpers", sort: "helpers" }, { label: "Base Rate", sort: "base" }, { label: "Driver Pay", sort: "driver_pay" }, { label: "Helper Pay", sort: "helper_pay" }], sort, params), "Actions"];
  const content = `${messagePanel(url)}<section class="panel">${toolbar}</section>${table(headers, body, { empty: "No recurring trip templates found." })}${paginationWithParams("/recurring-trips", params, page, Number(countRow?.total || 0))}`;
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
  const filters = { active: enumParam(url, "active", ["0", "1"]), client_id: idParam(url, "client_id"), asset_id: idParam(url, "asset_id"), driver_id: idParam(url, "driver_id") };
  const clauses = [];
  const params = [];
  addEqualityFilters(clauses, params, [["r.active", filters.active], ["r.client_id", filters.client_id], ["r.default_asset_id", filters.asset_id], ["r.default_driver_id", filters.driver_id]]);
  const where = mergeWhere(recurringWhere((url.searchParams.get("q") || "").trim()), clauses, params);
  const sort = listSort(url, { code: { sql: "r.master_code", tie: "r.id ASC" }, client: { sql: "c.client_name", tie: "r.id ASC" }, route: { sql: "r.origin", tie: "r.id ASC" }, asset: { sql: "a.asset_code", tie: "r.id ASC" }, driver: { sql: "e.full_name", tie: "r.id ASC" }, helpers: { sql: "r.default_helper_count", defaultDir: "desc", tie: "r.id DESC" }, base: { sql: "r.standard_base_rate", defaultDir: "desc", tie: "r.id DESC" }, driver_pay: { sql: "r.driver_pay_rate", defaultDir: "desc", tie: "r.id DESC" }, helper_pay: { sql: "r.helper_pay_rate", defaultDir: "desc", tie: "r.id DESC" } }, "r.master_code, r.id");
  const rows = await all(env, `SELECT r.*, c.client_name, a.asset_code, e.full_name AS driver_name FROM recurring_trip_masters r LEFT JOIN clients c ON c.id=r.client_id LEFT JOIN assets a ON a.id=r.default_asset_id LEFT JOIN employees e ON e.id=r.default_driver_id${where.sql} ORDER BY ${sort.order}`, where.params);
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
    selectInput("recurring_master_id", "Recurring master", masters, "", (r) => choiceLabel("recurring", r), "---------", quickSelect("recurring")),
    selectInput("client_id", "Client", clients, "", (r) => choiceLabel("client", r), "---------", quickSelect("client")),
    textInput("job_description", "Item / Job"),
    textInput("origin", "Origin"),
    textInput("destination", "Destination"),
    selectInput("asset_id", "Asset", assets, "", (r) => choiceLabel("asset", r), "---------", quickSelect("asset")),
    selectInput("driver_id", "Driver", drivers, "", (r) => choiceLabel("employee", r), "---------", quickSelect("employee", "driver")),
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
const SYSTEM_TRIP_STATUSES = ["Billed", "Paid"];

function tripStatusSlug(status) {
  return String(status || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function safeTripsReturnPath(value) {
  try {
    const parsed = new URL(String(value || "/trips"), "https://gmt.local");
    if (parsed.origin !== "https://gmt.local" || parsed.pathname !== "/trips") return "/trips";
    const clean = new URLSearchParams();
    for (const name of ["q", "status", "page"]) {
      const item = parsed.searchParams.get(name);
      if (item) clean.set(name, item);
    }
    return `/trips${clean.toString() ? `?${clean.toString()}` : ""}`;
  } catch {
    return "/trips";
  }
}

function tripReturnWithMessage(returnPath, kind, message) {
  const parsed = new URL(safeTripsReturnPath(returnPath), "https://gmt.local");
  parsed.searchParams.set(kind, message);
  return `${parsed.pathname}?${parsed.searchParams.toString()}`;
}

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

function tripListFilters(url) {
  const status = enumParam(url, "status", [...TRIP_STATUSES, ...SYSTEM_TRIP_STATUSES]);
  const tripType = enumParam(url, "trip_type", ["Spot Trip", "Recurring Trip"]);
  return {
    status,
    trip_type: tripType,
    client_id: idParam(url, "client_id"),
    asset_id: idParam(url, "asset_id"),
    driver_id: idParam(url, "driver_id"),
    ...rangeParams(url),
  };
}

function tripValues(data, preservedStatus = "") {
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
    status: preservedStatus || (TRIP_STATUSES.includes(data.status) ? data.status : "Planned"),
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

async function tripStatusLock(env, trip) {
  if (!trip) return "Trip not found.";
  if (SYSTEM_TRIP_STATUSES.includes(trip.status)) return `${trip.status} is controlled by Billing and cannot be changed manually.`;
  const [billing, payroll] = await Promise.all([
    first(env, "SELECT COUNT(*) AS total FROM billing_lines WHERE trip_id=?", [trip.id]),
    first(env, "SELECT COUNT(*) AS total FROM payroll_trips WHERE trip_id=?", [trip.id]),
  ]);
  const links = [];
  if (Number(billing?.total || 0) > 0) links.push("Billing");
  if (Number(payroll?.total || 0) > 0) links.push("Payroll");
  return links.length ? `This trip is already linked to ${links.join(" and ")}; its status is locked.` : "";
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

function browserJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

async function renderTripForm(env, row = {}, id = null, errors = [], statusLock = "") {
  const existingHelpers = row.helpers || [];
  const [clients, assets, drivers, helpers, masters] = await tripChoices(env, row.recurring_master_id || "");
  const errorBox = errors.length ? `<section class="panel"><ul class="error">${errors.map((err) => `<li>${esc(err)}</li>`).join("")}</ul></section>` : "";
  const tripFormData = {
    assets: assets.map((asset) => ({ id: asset.id, asset_code: asset.asset_code, asset_type: asset.asset_type, helper_limit: HELPER_LIMITS[asset.asset_type] ?? 3 })),
    masters: masters.map((master) => ({
      id: master.id,
      client_id: master.client_id,
      job_description: master.job_description || "",
      origin: master.origin || "",
      destination: master.destination || "",
      asset_id: master.default_asset_id || "",
      driver_id: master.default_driver_id || "",
      helper_count: Number(master.default_helper_count || 0),
      base_trip_rate: master.standard_base_rate ?? 0,
      driver_pay_rate: master.driver_pay_rate ?? 0,
      helper_pay_rate: master.helper_pay_rate ?? 0,
      default_extra_note: master.default_extra_note || "",
      remarks: master.remarks || "",
    })),
  };
  const action = id ? `/trips/${id}/edit` : "/trips/new";
  const statusControl = statusLock
    ? `<label>Status<input value="${esc(row.status || "Planned")}" disabled><input type="hidden" name="status" value="${esc(row.status || "Planned")}"><small class="field-help">${esc(statusLock)}</small></label>`
    : selectInput("status", "Status", TRIP_STATUSES.map((status) => ({ id: status, name: status })), row.status || "Planned", (r) => r.name, "");
  const overview = [
    `<div>${textInput("trip_ticket_no", "Trip Ticket / Waybill", row.trip_ticket_no || "")}</div>`,
    `<div>${textInput("reference_no", "Ref. No.", row.reference_no || "")}</div>`,
    `<div>${textInput("trip_date", "Trip date", row.trip_date || todayISO(), 'type="date" required')}</div>`,
    `<div>${selectInput("trip_type", "Trip type", [{ id: "Spot Trip", name: "Spot Trip" }, { id: "Recurring Trip", name: "Recurring Trip" }], row.trip_type || "Spot Trip", (r) => r.name, "")}</div>`,
    `<div class="field-span-2 trip-recurring-field">${selectInput("recurring_master_id", "Recurring master", masters, row.recurring_master_id || "", (r) => choiceLabel("recurring", r), "---------", quickSelect("recurring"))}</div>`,
    `<div class="field-span-2 trip-status-field">${statusControl}</div>`,
  ];
  const route = [selectInput("client_id", "Client", clients, row.client_id || "", (r) => choiceLabel("client", r), "---------", quickSelect("client")), textareaInput("job_description", "Item / Job", row.job_description || "", 'rows="2"'), textInput("origin", "Origin", row.origin || ""), textInput("destination", "Destination", row.destination || ""), textInput("dispatch_time", "Dispatch time", row.dispatch_time || "", 'type="time"'), textInput("arrival_time", "Arrival time", row.arrival_time || "", 'type="time"'), textareaInput("notes", "Notes", row.notes || "", 'rows="2"')];
  const crew = [selectInput("asset_id", "Asset", assets, row.asset_id || "", (r) => choiceLabel("asset", r), "---------", quickSelect("asset")), selectInput("driver_id", "Driver", drivers, row.driver_id || "", (r) => choiceLabel("employee", r), "---------", quickSelect("employee", "driver")), selectInput("helper_1", "Helper 1", helpers, existingHelpers[0]?.employee_id || row.helper_1 || "", (r) => choiceLabel("employee", r), "---------", quickSelect("employee", "helper")), selectInput("helper_2", "Helper 2", helpers, existingHelpers[1]?.employee_id || row.helper_2 || "", (r) => choiceLabel("employee", r), "---------", quickSelect("employee", "helper")), selectInput("helper_3", "Helper 3", helpers, existingHelpers[2]?.employee_id || row.helper_3 || "", (r) => choiceLabel("employee", r), "---------", quickSelect("employee", "helper"))];
  const driverJson = row.driver_pay_items ?? payItemsJson(row.pay_items, "Driver");
  const helperJson = row.helper_pay_items ?? payItemsJson(row.pay_items, "Helper");
  const charges = EXTRA_FIELDS.map((field) => numberInput(field, field.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()), row[field] ?? 0)).join("");
  const form = `<section data-trip-form><form method="post" action="${action}" class="app-form trip-workspace"><div class="workspace-grid trip-top"><section class="workspace-card trip-overview-card"><h3>Trip Overview</h3><div class="field-grid trip-overview-grid">${overview.join("")}</div></section><section class="workspace-card trip-route-card"><h3>Route &amp; Schedule</h3><div class="field-grid">${route.join("")}</div></section><section class="workspace-card"><h3>Unit &amp; Crew</h3><div class="field-grid">${crew.join("")}<p class="trip-crew-guidance muted" data-trip-crew-guidance aria-live="polite">Select an asset to see its helper allowance.</p></div></section></div><div class="workspace-grid trip-rates"><section class="workspace-card"><h3>Employee Pay Rates</h3><div class="field-grid one">${numberInput("driver_pay_rate", "Driver pay rate", row.driver_pay_rate ?? 0)}${numberInput("helper_pay_rate", "Helper pay rate", row.helper_pay_rate ?? 0)}</div></section><section class="workspace-card"><h3>Trip / Unit Charges</h3><div class="charge-grid">${numberInput("base_trip_rate", "Base trip rate", row.base_trip_rate ?? 0)}${charges}</div></section></div><section class="workspace-card pay-items-card"><h3>Pay Items</h3><input type="hidden" name="driver_pay_items" value="${esc(driverJson)}"><input type="hidden" name="helper_pay_items" value="${esc(helperJson)}"><div class="pay-items-area"><div class="pay-item-group" data-pay-items="driver"><div class="pay-item-header"><h4>Driver Pay Items</h4><button type="button" data-add-pay-item>Add Driver Item</button></div><div data-pay-item-rows></div></div><div class="pay-item-group" data-pay-items="helper"><div class="pay-item-header"><h4>Helper Pay Items</h4><button type="button" data-add-pay-item>Add Helper Item</button></div><div data-pay-item-rows></div></div></div><div class="trip-summary-bar"><div><span>Base</span><strong data-trip-base>0.00</strong></div><div><span>Extras</span><strong data-trip-extras>0.00</strong></div><div><span>Total</span><strong data-trip-total>0.00</strong></div></div></section><div class="sticky-actions"><a class="button secondary" href="/trips">Cancel</a><button>Save Trip</button></div></form></section>`;
  return `${errorBox}${form}<script id="trip-form-data" type="application/json">${browserJson(tripFormData)}</script>`;
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

function tripStatusBadge(trip, user, returnPath) {
  const status = trip.status || "Planned";
  const className = `status status-${tripStatusSlug(status)}`;
  if (canEdit(user, "Trips") && TRIP_STATUSES.includes(status)) {
    return `<a class="${className} status-link" href="/trips/${trip.id}/status?next=${encodeURIComponent(returnPath)}" aria-label="Change status for ${esc(trip.trip_ticket_no)}">${esc(status)}</a>`;
  }
  return `<span class="${className}">${esc(status)}</span>`;
}

function tripQuickComplete(trip, user, returnPath) {
  if (!canEdit(user, "Trips") || !["Planned", "Ongoing"].includes(trip.status)) return "";
  return `<form method="post" action="/trips/${trip.id}/status" class="inline-status-form" onsubmit="return confirm('Mark this trip as Completed? Completed trips become eligible for Payroll and Billing.');"><input type="hidden" name="status" value="Completed"><input type="hidden" name="next" value="${esc(returnPath)}"><button class="status-action">Mark Complete</button></form>`;
}

async function tripListContent(request, env, user) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const filters = tripListFilters(url);
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const filterClauses = [];
  const filterParams = [];
  addEqualityFilters(filterClauses, filterParams, [["t.trip_type", filters.trip_type], ["t.client_id", filters.client_id], ["t.asset_id", filters.asset_id], ["t.driver_id", filters.driver_id]]);
  addDateRange(filterClauses, filterParams, "t.trip_date", filters);
  const where = mergeWhere(tripWhere(query, filters.status), filterClauses, filterParams);
  const sort = listSort(url, {
    ticket: { sql: "t.trip_ticket_no", tie: "t.id ASC" }, reference: { sql: "t.reference_no", tie: "t.id ASC" }, date: { sql: "t.trip_date", defaultDir: "desc", tie: "t.id DESC" }, client: { sql: "c.client_name", tie: "t.id ASC" }, route: { sql: "t.origin", tie: "t.id ASC" }, driver: { sql: "e.full_name", tie: "t.id ASC" }, asset: { sql: "a.asset_code", tie: "t.id ASC" }, status: { sql: "t.status", tie: "t.id ASC" }, base: { sql: "t.base_trip_rate", defaultDir: "desc", tie: "t.id DESC" }, extra: { sql: "(t.fuel_surcharge+t.loading_fee+t.unloading_fee+t.waiting_fee+t.tolls+t.additional_stop_charge+t.special_handling_fee+t.other_charges)", defaultDir: "desc", tie: "t.id DESC" }, total: { sql: "(t.base_trip_rate+t.fuel_surcharge+t.loading_fee+t.unloading_fee+t.waiting_fee+t.tolls+t.additional_stop_charge+t.special_handling_fee+t.other_charges)", defaultDir: "desc", tie: "t.id DESC" },
  }, "t.trip_date DESC, t.id DESC");
  const countRow = await first(env, `SELECT COUNT(*) AS total FROM trips t LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN assets a ON a.id=t.asset_id LEFT JOIN employees e ON e.id=t.driver_id${where.sql}`, where.params);
  const rows = await all(env, `SELECT t.*, c.client_name, a.asset_code, e.full_name AS driver_name, (SELECT GROUP_CONCAT(full_name, '; ') FROM (SELECT he.full_name FROM trip_helpers th JOIN employees he ON he.id=th.employee_id WHERE th.trip_id=t.id ORDER BY th.helper_order, th.id)) AS helper_names FROM trips t LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN assets a ON a.id=t.asset_id LEFT JOIN employees e ON e.id=t.driver_id${where.sql} ORDER BY ${sort.order} LIMIT 25 OFFSET ?`, [...where.params, (page - 1) * 25]);
  const params = listParams(url, ["q", "status", "trip_type", "client_id", "asset_id", "driver_id", "date_from", "date_to"], { includePage: true, sort });
  const returnPath = `/trips${params.toString() ? `?${params.toString()}` : ""}`;
  const body = rows.map((t) => `<tr><td><a href="/trips/${t.id}">${esc(t.trip_ticket_no)}</a></td><td>${esc(t.reference_no || "—")}</td><td>${esc(t.trip_date)}</td><td>${esc(t.client_name || "")}</td><td>${esc(t.origin)} → ${esc(t.destination)}</td><td>${esc(t.driver_name || "")}${t.helper_names ? `<small class="cell-detail">${esc(t.helper_names)}</small>` : ""}</td><td>${esc(t.asset_code || "")}</td><td>${tripStatusBadge(t, user, returnPath)}</td>${moneyCell(t.base_trip_rate)}${moneyCell(tripExtraTotal(t))}${moneyCell(tripBillableTotal(t))}<td><a href="/trips/${t.id}">View</a> <a href="/trips/${t.id}/print" target="_blank">Print</a>${canEdit(user, "Trips") ? ` <a href="/trips/${t.id}/edit">Edit</a>` : ""}${tripQuickComplete(t, user, returnPath)}</td></tr>`);
  const [clients, assets, drivers] = await Promise.all([
    all(env, "SELECT id,client_code,client_name FROM clients ORDER BY client_name"),
    all(env, "SELECT id,asset_code,plate_no,asset_type FROM assets ORDER BY asset_code"),
    all(env, "SELECT id,employee_code,full_name,employee_type FROM employees WHERE active=1 ORDER BY full_name"),
  ]);
  const filterMarkup = [
    selectFilter("status", "Status", [...TRIP_STATUSES, ...SYSTEM_TRIP_STATUSES], filters.status),
    selectFilter("trip_type", "Trip type", ["Spot Trip", "Recurring Trip"], filters.trip_type),
    selectFilter("client_id", "Client", clients.map((row) => ({ value: row.id, label: choiceLabel("client", row) })), filters.client_id),
    selectFilter("asset_id", "Unit", assets.map((row) => ({ value: row.id, label: choiceLabel("asset", row) })), filters.asset_id),
    selectFilter("driver_id", "Driver", drivers.map((row) => ({ value: row.id, label: choiceLabel("employee", row) })), filters.driver_id),
    dateFilter("date_from", "Date from", filters.from), dateFilter("date_to", "Date to", filters.to),
  ].join("");
  const exportParams = new URLSearchParams(params);
  exportParams.delete("page");
  const exportHref = `/trips/export.csv${exportParams.toString() ? `?${exportParams.toString()}` : ""}`;
  const toolbar = listToolbar({ query, placeholder: "Search trips", filters: filterMarkup, clearHref: "/trips", actions: `${canEdit(user, "Trips") ? `<a class="button" href="/trips/new">New Trip</a>` : ""} <a class="button secondary" href="${esc(exportHref)}">Export CSV</a>` });
  const paginationParams = new URLSearchParams(params);
  paginationParams.delete("page");
  const headers = [...sortableHeaders([
    { label: "Trip Ticket / Waybill", sort: "ticket" }, { label: "Ref. No.", sort: "reference" }, { label: "Date", sort: "date" }, { label: "Client", sort: "client" }, { label: "Route", sort: "route" }, { label: "Driver / Helpers", sort: "driver" }, { label: "Unit", sort: "asset" }, { label: "Status", sort: "status" }, { label: "Base", sort: "base" }, { label: "Extra", sort: "extra" }, { label: "Total", sort: "total" },
  ], sort, paginationParams), "Actions"];
  return `${messagePanel(url)}<section class="panel">${toolbar}</section>${table(headers, body, { empty: "No trips found." })}${paginationWithParams("/trips", paginationParams, page, Number(countRow?.total || 0))}`;
}

async function tripListPage(request, env, user, path) {
  const access = requireView(user, "Trips");
  if (access) return errorResponse(access, user, path);
  return html(layout({ title: "Trips List", user, path, content: await tripListContent(request, env, user) }));
}

function tripStatusDialog(trip, returnPath, lockMessage = "") {
  const currentBadge = `<span class="status status-${tripStatusSlug(trip.status)}">${esc(trip.status)}</span>`;
  const summary = `<dl class="trip-status-summary"><dt>Trip Ticket / Waybill</dt><dd>${esc(trip.trip_ticket_no)}</dd><dt>Client</dt><dd>${esc(trip.client_name || "—")}</dd><dt>Route</dt><dd>${esc(trip.origin || "—")} → ${esc(trip.destination || "—")}</dd><dt>Current Status</dt><dd>${currentBadge}</dd></dl>`;
  if (lockMessage) {
    return `${summary}<div class="status-warning"><strong>Status locked</strong><p>${esc(lockMessage)}</p></div><div class="form-actions"><a class="button secondary" href="${esc(returnPath)}">Close</a></div>`;
  }
  const choices = TRIP_STATUSES.filter((status) => status !== trip.status).map((status) => ({ id: status, name: status }));
  return `${summary}<form method="post" action="/trips/${trip.id}/status" class="app-form status-update-form" onsubmit="if(this.status.value === 'Completed') return confirm('Mark this trip as Completed? Completed trips become eligible for Payroll and Billing.');"><input type="hidden" name="next" value="${esc(returnPath)}">${selectInput("status", "New status", choices, "", (row) => row.name, "Select status")}<div class="status-warning"><strong>Before you continue</strong><p>Completed trips become eligible for Payroll and Billing. This update changes only the trip status.</p></div><div class="form-actions"><button>Update Status</button><a class="button secondary" href="${esc(returnPath)}">Cancel</a></div></form>`;
}

async function tripStatusPage(request, env, user, path, id) {
  const access = requireEdit(user, "Trips");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const submitted = request.method === "POST" ? await parseForm(request) : null;
  const returnPath = safeTripsReturnPath(submitted?.next || url.searchParams.get("next") || "/trips");
  const trip = await loadTrip(env, id);
  if (!trip) return redirect(tripReturnWithMessage(returnPath, "error", "Trip not found."));
  const lockMessage = await tripStatusLock(env, trip);

  if (request.method === "POST") {
    const status = String(submitted.status || "").trim();
    if (!TRIP_STATUSES.includes(status)) {
      return redirect(tripReturnWithMessage(returnPath, "error", "Select a valid operational trip status."));
    }
    if (lockMessage) return redirect(tripReturnWithMessage(returnPath, "error", lockMessage));
    if (status !== trip.status) await run(env, "UPDATE trips SET status=? WHERE id=?", [status, id]);
    const message = status === trip.status ? `Trip ${trip.trip_ticket_no} is already ${status}.` : `Trip ${trip.trip_ticket_no} status changed to ${status}.`;
    return redirect(tripReturnWithMessage(returnPath, "ok", message));
  }
  if (request.method !== "GET") return html("Method Not Allowed", 405);

  const listUrl = new URL(returnPath, request.url);
  const listRequest = new Request(listUrl, { headers: request.headers });
  const content = await tripListContent(listRequest, env, user);
  const modal = dialogShell({
    title: "Update Trip Status",
    subtitle: "Trip workflow",
    body: tripStatusDialog(trip, returnPath, lockMessage),
    closeHref: returnPath,
    wide: false,
  });
  return html(layout({ title: "Trips List", user, path: "/trips", content: `${content}${modal}` }));
}

async function tripFormPage(request, env, user, path, id = null) {
  const access = requireEdit(user, "Trips");
  if (access) return errorResponse(access, user, path);
  const row = id ? await loadTrip(env, id) : { trip_date: todayISO(), trip_type: "Spot Trip", status: "Planned" };
  if (id && !row) return html("Not found", 404);
  const statusLock = id ? await tripStatusLock(env, row) : "";
  if (request.method === "POST") {
    const data = await parseForm(request);
    const values = tripValues(data, statusLock ? row.status : "");
    const helpers = [data.helper_1 || "", data.helper_2 || "", data.helper_3 || ""];
    const driverPay = parsePayItems(data.driver_pay_items, "Driver");
    const helperPay = parsePayItems(data.helper_pay_items, "Helper");
    const payItems = [...driverPay.items, ...helperPay.items];
    if (!values.trip_ticket_no && values.trip_date) values.trip_ticket_no = await nextTicket(env, values.trip_date);
    const errors = [...driverPay.errors, ...helperPay.errors, ...(await validateTrip(env, values, helpers, payItems, id))];
    if (errors.length) return html(layout({ title: `${id ? "Edit" : "New"} Trip Details`, user, path, content: await renderTripForm(env, { ...values, ...data, status: values.status }, id, errors, statusLock) }), 400);
    try {
      const tripId = await saveTrip(env, values, helpers, payItems, id);
      return redirect(`/trips/${tripId}?ok=${encodeURIComponent(id ? "Trip record updated." : "Trip record saved.")}`);
    } catch (error) {
      return html(layout({ title: `${id ? "Edit" : "New"} Trip Details`, user, path, content: await renderTripForm(env, { ...values, ...data, status: values.status }, id, [`Could not save trip: ${error.message || error}`], statusLock) }), 400);
    }
  }
  return html(layout({ title: `${id ? "Edit" : "New"} Trip Details`, user, path, content: await renderTripForm(env, row, id, [], statusLock) }));
}

function tripPrintable(trip, helperNames, settings) {
  const extraTable = EXTRA_FIELDS.filter((field) => Number(trip[field] || 0)).map((field) => `<tr><td>${esc(field.replaceAll("_", " "))}</td><td class="num">${esc(peso(trip[field]))}</td></tr>`).join("");
  const payTable = (trip.pay_items || []).map((item) => `<tr><td>${esc(item.label)}</td><td>${esc(item.employee_type)}</td><td class="num">${esc(peso(item.amount))}</td></tr>`).join("") || `<tr><td colspan="3">No additional employee pay items.</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(trip.trip_ticket_no)}</title><style>@page{size:A4 portrait;margin:12mm}body{font:12px Arial,sans-serif;color:#111}button{margin-bottom:10px}.header{display:flex;justify-content:space-between;border-bottom:2px solid #111;margin-bottom:14px;padding-bottom:8px}.company-header{display:flex;gap:10px;align-items:flex-start}.company-logo{max-width:76px;max-height:54px;object-fit:contain}.company-text h1,h1{margin:0;font-size:22px}.company-text h2,h2{margin:2px 0 0;font-size:15px}.company-lines{margin:4px 0 0;line-height:1.35}table{width:100%;border-collapse:collapse;margin:10px 0}td,th{border:1px solid #333;padding:6px;vertical-align:top}.label{font-weight:bold;width:22%;background:#f3f3f3}.num{text-align:right}.signatures{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;margin-top:70px}.signatures div{border-top:1px solid #111;text-align:center;padding-top:6px}@media print{button{display:none}}</style></head><body><button onclick="window.print()">Print</button><div class="header"><div>${companyHeader(settings, "Trip Ticket / Waybill")}</div><div><strong>${esc(trip.trip_ticket_no)}</strong><br>${esc(trip.trip_date)}</div></div><table><tr><td class="label">Trip Ticket / Waybill</td><td>${esc(trip.trip_ticket_no)}</td><td class="label">Ref. No.</td><td>${esc(trip.reference_no || "—")}</td></tr><tr><td class="label">Date</td><td>${esc(trip.trip_date)}</td><td class="label">Type / Status</td><td>${esc(trip.trip_type)} / ${esc(trip.status)}</td></tr><tr><td class="label">Client</td><td colspan="3">${esc(trip.client_name || "")}</td></tr><tr><td class="label">Item / Job</td><td colspan="3">${esc(trip.job_description || "")}</td></tr><tr><td class="label">Origin</td><td>${esc(trip.origin || "")}</td><td class="label">Destination</td><td>${esc(trip.destination || "")}</td></tr><tr><td class="label">Unit</td><td>${esc([trip.asset_code, trip.plate_no].filter(Boolean).join(" · "))}</td><td class="label">Driver</td><td>${esc(trip.driver_name || "")}</td></tr><tr><td class="label">Helpers</td><td colspan="3">${esc(helperNames)}</td></tr><tr><td class="label">Dispatch</td><td>${esc(trip.dispatch_time || "")}</td><td class="label">Arrival</td><td>${esc(trip.arrival_time || "")}</td></tr></table><table><thead><tr><th>Charge</th><th class="num">Amount</th></tr></thead><tbody><tr><td>Base Trip Rate</td><td class="num">${esc(peso(trip.base_trip_rate))}</td></tr>${extraTable}<tr><th>Total</th><th class="num">${esc(peso(tripBillableTotal(trip)))}</th></tr></tbody></table><table><thead><tr><th>Employee Pay Item</th><th>Type</th><th class="num">Amount</th></tr></thead><tbody>${payTable}</tbody></table>${trip.notes ? `<p><strong>Notes:</strong><br>${esc(trip.notes)}</p>` : ""}<div class="signatures"><div>${signatureLabel(settings.prepared_by_default, "Prepared By")}</div><div>Driver</div><div>Client / Receiver</div></div></body></html>`;
}

function tripPrintableDocument(trip, helperNames, settings) {
  const extraTable = EXTRA_FIELDS.filter((field) => Number(trip[field] || 0)).map((field) => `<tr><td>${esc(field.replaceAll("_", " "))}</td><td class="num">${esc(peso(trip[field]))}</td></tr>`).join("");
  const payTable = (trip.pay_items || []).map((item) => `<tr><td>${esc(item.label)}</td><td>${esc(item.employee_type)}</td><td class="num">${esc(peso(item.amount))}</td></tr>`).join("") || `<tr><td colspan="3">No additional employee pay items.</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(trip.trip_ticket_no)}</title><style>${customerPrintStyles("A4 portrait")}</style></head><body><button class="print-button" onclick="window.print()">Print</button><div class="document-sheet"><div class="document-header"><div>${companyHeader(settings, "Trip Ticket / Waybill")}</div><div class="document-meta"><strong>${esc(trip.trip_ticket_no)}</strong><br>${esc(trip.trip_date)}</div></div><table><tr><td class="label">Trip Ticket / Waybill</td><td>${esc(trip.trip_ticket_no)}</td><td class="label">Ref. No.</td><td>${esc(trip.reference_no || "—")}</td></tr><tr><td class="label">Date</td><td>${esc(trip.trip_date)}</td><td class="label">Type / Status</td><td>${esc(trip.trip_type)} / ${esc(trip.status)}</td></tr><tr><td class="label">Client</td><td colspan="3">${esc(trip.client_name || "")}</td></tr><tr><td class="label">Item / Job</td><td colspan="3">${esc(trip.job_description || "")}</td></tr><tr><td class="label">Origin</td><td>${esc(trip.origin || "")}</td><td class="label">Destination</td><td>${esc(trip.destination || "")}</td></tr><tr><td class="label">Unit</td><td>${esc([trip.asset_code, trip.plate_no].filter(Boolean).join(" · "))}</td><td class="label">Driver</td><td>${esc(trip.driver_name || "")}</td></tr><tr><td class="label">Helpers</td><td colspan="3">${esc(helperNames)}</td></tr><tr><td class="label">Dispatch</td><td>${esc(trip.dispatch_time || "")}</td><td class="label">Arrival</td><td>${esc(trip.arrival_time || "")}</td></tr></table><table><thead><tr><th>Charge</th><th class="num">Amount</th></tr></thead><tbody><tr><td>Base Trip Rate</td><td class="num">${esc(peso(trip.base_trip_rate))}</td></tr>${extraTable}<tr><th>Total</th><th class="num">${esc(peso(tripBillableTotal(trip)))}</th></tr></tbody></table><table><thead><tr><th>Employee Pay Item</th><th>Type</th><th class="num">Amount</th></tr></thead><tbody>${payTable}</tbody></table>${trip.notes ? `<p><strong>Notes:</strong><br>${esc(trip.notes)}</p>` : ""}<div class="signatures three"><div>${signatureLabel(settings.prepared_by_default, "Prepared By")}</div><div>Driver</div><div>Client / Receiver</div></div></div></body></html>`;
}

async function tripDetailPage(request, env, user, path, id, print = false) {
  const access = requireView(user, "Trips");
  if (access) return errorResponse(access, user, path);
  const trip = await loadTrip(env, id);
  if (!trip) return html("Not found", 404);
  const helperNames = (trip.helpers || []).map((row) => row.full_name).join("; ") || "None";
  const extraRows = EXTRA_FIELDS.filter((field) => Number(trip[field] || 0)).map((field) => `<dt>${esc(field.replaceAll("_", " "))}</dt><dd>${esc(peso(trip[field]))}</dd>`).join("");
  const payRows = (trip.pay_items || []).map((item) => `<div class="detail-pay-row"><span>${esc(item.label)} <small>${esc(item.employee_type)}</small></span><strong>${esc(peso(item.amount))}</strong></div>`).join("") || `<p class="muted">No additional pay items.</p>`;
  if (print) return html(tripPrintableDocument(trip, helperNames, await loadSettings(env)));
  const main = `<section class="panel detail-hero"><div><span class="dialog-kicker">${esc(trip.trip_type)} · Trip Ticket / Waybill</span><h3>${esc(trip.trip_ticket_no)}</h3><p>${esc(trip.client_name || "No client")} · ${esc(trip.trip_date)} · Ref. No.: ${esc(trip.reference_no || "—")}</p></div><span class="status detail-status">${esc(trip.status)}</span></section><div class="detail-grid"><section class="panel"><h3>Route & Schedule</h3><dl class="detail-list"><dt>Item / Job</dt><dd>${esc(trip.job_description || "—")}</dd><dt>Origin</dt><dd>${esc(trip.origin || "—")}</dd><dt>Destination</dt><dd>${esc(trip.destination || "—")}</dd><dt>Dispatch</dt><dd>${esc(trip.dispatch_time || "—")}</dd><dt>Arrival</dt><dd>${esc(trip.arrival_time || "—")}</dd><dt>Recurring Master</dt><dd>${esc(trip.recurring_code || "—")}</dd></dl></section><section class="panel"><h3>Unit & Crew</h3><dl class="detail-list"><dt>Asset</dt><dd>${esc([trip.asset_code, trip.plate_no].filter(Boolean).join(" · ") || "—")}</dd><dt>Driver</dt><dd>${esc(trip.driver_name || "—")}</dd><dt>Helpers</dt><dd>${esc(helperNames)}</dd><dt>Driver Pay Rate</dt><dd>${esc(peso(trip.driver_pay_rate))}</dd><dt>Helper Pay Pool</dt><dd>${esc(peso(trip.helper_pay_rate))}</dd></dl></section><section class="panel"><h3>Billing Breakdown</h3><dl class="detail-list"><dt>Base Trip Rate</dt><dd>${esc(peso(trip.base_trip_rate))}</dd>${extraRows}<dt class="detail-total">Billable Total</dt><dd class="detail-total">${esc(peso(tripBillableTotal(trip)))}</dd></dl></section><section class="panel"><h3>Employee Pay Items</h3>${payRows}</section></div>${trip.notes ? `<section class="panel"><h3>Notes</h3><p>${esc(trip.notes)}</p></section>` : ""}`;
  if (print) {
    const settings = await loadSettings(env);
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
  const filters = tripListFilters(url);
  const clauses = [];
  const params = [];
  addEqualityFilters(clauses, params, [["t.trip_type", filters.trip_type], ["t.client_id", filters.client_id], ["t.asset_id", filters.asset_id], ["t.driver_id", filters.driver_id]]);
  addDateRange(clauses, params, "t.trip_date", filters);
  const where = mergeWhere(tripWhere((url.searchParams.get("q") || "").trim(), filters.status), clauses, params);
  const sort = listSort(url, { ticket: { sql: "t.trip_ticket_no", tie: "t.id ASC" }, reference: { sql: "t.reference_no", tie: "t.id ASC" }, date: { sql: "t.trip_date", defaultDir: "desc", tie: "t.id DESC" }, client: { sql: "c.client_name", tie: "t.id ASC" }, route: { sql: "t.origin", tie: "t.id ASC" }, driver: { sql: "e.full_name", tie: "t.id ASC" }, asset: { sql: "a.asset_code", tie: "t.id ASC" }, status: { sql: "t.status", tie: "t.id ASC" }, base: { sql: "t.base_trip_rate", defaultDir: "desc", tie: "t.id DESC" }, extra: { sql: "(t.fuel_surcharge+t.loading_fee+t.unloading_fee+t.waiting_fee+t.tolls+t.additional_stop_charge+t.special_handling_fee+t.other_charges)", defaultDir: "desc", tie: "t.id DESC" }, total: { sql: "(t.base_trip_rate+t.fuel_surcharge+t.loading_fee+t.unloading_fee+t.waiting_fee+t.tolls+t.additional_stop_charge+t.special_handling_fee+t.other_charges)", defaultDir: "desc", tie: "t.id DESC" } }, "t.trip_date DESC, t.id DESC");
  const rows = await all(env, `SELECT t.*, c.client_name, a.asset_code, e.full_name AS driver_name, (SELECT GROUP_CONCAT(full_name, '; ') FROM (SELECT he.full_name FROM trip_helpers th JOIN employees he ON he.id=th.employee_id WHERE th.trip_id=t.id ORDER BY th.helper_order, th.id)) AS helper_names FROM trips t LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN assets a ON a.id=t.asset_id LEFT JOIN employees e ON e.id=t.driver_id${where.sql} ORDER BY ${sort.order}`, where.params);
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
  const errorBox = errors.length ? `<section class="panel"><ul class="error">${errors.map((err) => `<li>${esc(err)}</li>`).join("")}</ul></section>` : "";
  const deleteForm = id ? `<form method="post" action="/repairs/${id}/delete" class="delete-form" onsubmit="return confirm('Delete this repair?');"><button class="danger">Delete</button></form>` : "";
  const action = id ? `/repairs/${id}/edit` : "/repairs/new";
  return `${errorBox}<form method="post" action="${action}" class="app-form" data-repair-form><div class="workspace-grid repair-layout"><div><section class="workspace-card"><h3>Repair Information</h3><div class="field-grid">${textInput("repair_date", "Repair date", row.repair_date || todayISO(), 'type="date" required')}${textareaInput("repair_description", "Description", row.repair_description || "", 'rows="2" required')}${textInput("meter_value", "Meter value", row.meter_value || "")}${selectInput("status", "Status", REPAIR_STATUSES.map((status) => ({ id: status, name: status })), row.status || "Open", (r) => r.name, "")}</div></section><section class="workspace-card"><h3>Supplier / Unit</h3><div class="field-grid">${selectInput("asset_id", "Asset", assets, row.asset_id || "", (r) => choiceLabel("asset", r), "---------", quickSelect("asset"))}${selectInput("supplier_id", "Supplier", suppliers, row.supplier_id || "", (r) => choiceLabel("supplier", r), "---------", quickSelect("supplier"))}</div></section></div><div><section class="workspace-card"><h3>Cost Breakdown</h3><div class="cost-grid">${numberInput("parts_cost", "Parts cost", row.parts_cost ?? 0)}${numberInput("labor_cost", "Labor cost", row.labor_cost ?? 0)}${numberInput("other_cost", "Other cost", row.other_cost ?? 0)}</div><div class="calculated-total"><span>Total Cost</span><strong>₱ <span data-repair-total>0.00</span></strong></div></section><section class="workspace-card"><h3>Payable Options &amp; Notes</h3><div class="field-grid">${selectInput("auto_generate_payable", "Auto-generate payable", [{ id: "0", name: "No" }, { id: "1", name: "Yes" }], row.auto_generate_payable ? "1" : "0", (r) => r.name, "")}${textareaInput("notes", "Notes", row.notes || "", 'rows="3"')}</div></section></div></div><div class="form-actions"><a class="button secondary" href="/repairs">Cancel</a><button>Save Repair</button></div></form>${deleteForm}`;
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
  const filters = { status: enumParam(url, "status", REPAIR_STATUSES), asset_id: idParam(url, "asset_id"), supplier_id: idParam(url, "supplier_id"), ...rangeParams(url) };
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const clauses = [];
  const filterParams = [];
  addEqualityFilters(clauses, filterParams, [["r.asset_id", filters.asset_id], ["r.supplier_id", filters.supplier_id]]);
  addDateRange(clauses, filterParams, "r.repair_date", filters);
  const where = mergeWhere(repairWhere(query, filters.status), clauses, filterParams);
  const sort = listSort(url, { date: { sql: "r.repair_date", defaultDir: "desc", tie: "r.id DESC" }, asset: { sql: "a.asset_code", tie: "r.id ASC" }, description: { sql: "r.repair_description", tie: "r.id ASC" }, supplier: { sql: "s.supplier_name", tie: "r.id ASC" }, meter: { sql: "r.meter_value", defaultDir: "desc", tie: "r.id DESC" }, total: { sql: "r.total_cost", defaultDir: "desc", tie: "r.id DESC" }, status: { sql: "r.status", tie: "r.id ASC" }, payable: { sql: "p.reference_no", tie: "r.id ASC" } }, "r.repair_date DESC, r.id DESC");
  const countRow = await first(env, `SELECT COUNT(*) AS total FROM repairs r LEFT JOIN assets a ON a.id=r.asset_id LEFT JOIN suppliers s ON s.id=r.supplier_id${where.sql}`, where.params);
  const rows = await all(env, `SELECT r.*, a.asset_code, a.plate_no, s.supplier_name, p.reference_no AS payable_ref FROM repairs r LEFT JOIN assets a ON a.id=r.asset_id LEFT JOIN suppliers s ON s.id=r.supplier_id LEFT JOIN payables p ON p.linked_repair_id=r.id${where.sql} ORDER BY ${sort.order} LIMIT 25 OFFSET ?`, [...where.params, (page - 1) * 25]);
  const body = rows.map((row) => `<tr><td>${esc(row.repair_date)}</td><td>${esc(row.asset_code || "")}<small class="cell-detail">${esc(row.plate_no || "")}</small></td><td>${canEdit(user, "Repairs") ? `<a href="/repairs/${row.id}/edit">${esc(row.repair_description)}</a>` : esc(row.repair_description)}</td><td>${esc(row.supplier_name || "")}</td><td>${esc(row.meter_value || "")}</td>${moneyCell(row.total_cost)}<td><span class="status">${esc(row.status)}</span></td><td>${esc(row.payable_ref || "")}</td><td>${canEdit(user, "Repairs") ? `<a href="/repairs/${row.id}/edit">Edit</a>` : `<span class="muted">Read only</span>`}</td></tr>`);
  const params = listParams(url, ["q", "status", "asset_id", "supplier_id", "date_from", "date_to"], { sort });
  const [assets, suppliers] = await repairChoices(env);
  const filterMarkup = [selectFilter("status", "Status", REPAIR_STATUSES, filters.status), selectFilter("asset_id", "Asset", assets.map((row) => ({ value: row.id, label: choiceLabel("asset", row) })), filters.asset_id), selectFilter("supplier_id", "Supplier", suppliers.map((row) => ({ value: row.id, label: choiceLabel("supplier", row) })), filters.supplier_id), dateFilter("date_from", "Repair date from", filters.from), dateFilter("date_to", "Repair date to", filters.to)].join("");
  const toolbar = listToolbar({ query, placeholder: "Search repairs", filters: filterMarkup, clearHref: "/repairs", actions: `${canEdit(user, "Repairs") ? `<a class="button" href="/repairs/new">New Repair</a>` : ""} <a class="button secondary" href="${esc(`/repairs/export.csv${params.toString() ? `?${params.toString()}` : ""}`)}">Export CSV</a>` });
  const headers = [...sortableHeaders([{ label: "Date", sort: "date" }, { label: "Asset", sort: "asset" }, { label: "Description", sort: "description" }, { label: "Supplier", sort: "supplier" }, { label: "Meter", sort: "meter" }, { label: "Total Cost", sort: "total" }, { label: "Status", sort: "status" }, { label: "Payable", sort: "payable" }], sort, params), "Actions"];
  const content = `${messagePanel(url)}<section class="panel">${toolbar}</section>${table(headers, body, { empty: "No repairs found." })}${paginationWithParams("/repairs", params, page, Number(countRow?.total || 0))}`;
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
  const filters = { status: enumParam(url, "status", REPAIR_STATUSES), asset_id: idParam(url, "asset_id"), supplier_id: idParam(url, "supplier_id"), ...rangeParams(url) };
  const clauses = [];
  const params = [];
  addEqualityFilters(clauses, params, [["r.asset_id", filters.asset_id], ["r.supplier_id", filters.supplier_id]]);
  addDateRange(clauses, params, "r.repair_date", filters);
  const where = mergeWhere(repairWhere((url.searchParams.get("q") || "").trim(), filters.status), clauses, params);
  const sort = listSort(url, { date: { sql: "r.repair_date", defaultDir: "desc", tie: "r.id DESC" }, asset: { sql: "a.asset_code", tie: "r.id ASC" }, description: { sql: "r.repair_description", tie: "r.id ASC" }, supplier: { sql: "s.supplier_name", tie: "r.id ASC" }, meter: { sql: "r.meter_value", defaultDir: "desc", tie: "r.id DESC" }, total: { sql: "r.total_cost", defaultDir: "desc", tie: "r.id DESC" }, status: { sql: "r.status", tie: "r.id ASC" }, payable: { sql: "p.reference_no", tie: "r.id ASC" } }, "r.repair_date DESC, r.id DESC");
  const rows = await all(env, `SELECT r.*, a.asset_code, s.supplier_name, p.reference_no AS payable_ref FROM repairs r LEFT JOIN assets a ON a.id=r.asset_id LEFT JOIN suppliers s ON s.id=r.supplier_id LEFT JOIN payables p ON p.linked_repair_id=r.id${where.sql} ORDER BY ${sort.order}`, where.params);
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
    selectInput("supplier_id", "Supplier", suppliers, row.supplier_id || "", (r) => choiceLabel("supplier", r), "---------", quickSelect("supplier")),
    textInput("source_type", "Source type", row.source_type || "Manual"),
    textInput("reference_no", "Reference no.", row.reference_no || ""),
    textareaInput("description", "Description", row.description || "", 'rows="2" required'),
    numberInput("amount", "Amount", row.amount ?? 0),
    textInput("due_date", "Due date", row.due_date || "", 'type="date"'),
    selectInput("status", "Status", PAYABLE_STATUSES.map((status) => ({ id: status, name: status })), row.status || "Open", (r) => r.name, ""),
    selectInput("linked_repair_id", "Linked repair", repairs, row.linked_repair_id || "", (r) => choiceLabel("repair", r), "---------", SEARCHABLE_SELECT),
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
  const filters = { status: enumParam(url, "status", PAYABLE_STATUSES), supplier_id: idParam(url, "supplier_id"), source_type: String(url.searchParams.get("source_type") || "").trim(), ...rangeParams(url, "due_from", "due_to") };
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const sourceTypes = ["Manual", "Repair"];
  if (!sourceTypes.includes(filters.source_type)) filters.source_type = "";
  const clauses = [];
  const filterParams = [];
  addEqualityFilters(clauses, filterParams, [["p.supplier_id", filters.supplier_id], ["p.source_type", filters.source_type]]);
  addDateRange(clauses, filterParams, "p.due_date", filters);
  const where = mergeWhere(payableWhere(query, filters.status), clauses, filterParams);
  const sort = listSort(url, { date: { sql: "p.payable_date", defaultDir: "desc", tie: "p.id DESC" }, reference: { sql: "p.reference_no", tie: "p.id ASC" }, supplier: { sql: "s.supplier_name", tie: "p.id ASC" }, source: { sql: "p.source_type", tie: "p.id ASC" }, description: { sql: "p.description", tie: "p.id ASC" }, amount: { sql: "p.amount", defaultDir: "desc", tie: "p.id DESC" }, due: { sql: "p.due_date", defaultDir: "desc", tie: "p.id DESC" }, status: { sql: "p.status", tie: "p.id ASC" } }, "p.payable_date DESC, p.id DESC");
  const countRow = await first(env, `SELECT COUNT(*) AS total FROM payables p LEFT JOIN suppliers s ON s.id=p.supplier_id${where.sql}`, where.params);
  const rows = await all(env, `SELECT p.*, s.supplier_name FROM payables p LEFT JOIN suppliers s ON s.id=p.supplier_id${where.sql} ORDER BY ${sort.order} LIMIT 25 OFFSET ?`, [...where.params, (page - 1) * 25]);
  const body = rows.map((row) => `<tr><td>${esc(row.payable_date)}</td><td>${canEdit(user, "Payables") ? `<a href="/payables/${row.id}/edit">${esc(row.reference_no || `PAY-${row.id}`)}</a>` : esc(row.reference_no || `PAY-${row.id}`)}</td><td>${esc(row.supplier_name || "")}</td><td>${esc(row.source_type || "")}</td><td>${esc(row.description || "")}</td>${moneyCell(row.amount)}<td>${esc(row.due_date || "")}</td><td><span class="status">${esc(row.status)}</span></td><td>${row.linked_repair_id ? `Repair #${esc(row.linked_repair_id)}` : ""}</td><td>${canEdit(user, "Payables") ? `<a href="/payables/${row.id}/edit">Edit</a>` : `<span class="muted">Read only</span>`}</td></tr>`);
  const params = listParams(url, ["q", "status", "supplier_id", "source_type", "due_from", "due_to"], { sort });
  const [suppliers] = await payableChoices(env);
  const filterMarkup = [selectFilter("status", "Status", PAYABLE_STATUSES, filters.status), selectFilter("supplier_id", "Supplier", suppliers.map((row) => ({ value: row.id, label: choiceLabel("supplier", row) })), filters.supplier_id), selectFilter("source_type", "Source", sourceTypes, filters.source_type), dateFilter("due_from", "Due from", filters.from), dateFilter("due_to", "Due to", filters.to)].join("");
  const toolbar = listToolbar({ query, placeholder: "Search payables", filters: filterMarkup, clearHref: "/payables", actions: `${canEdit(user, "Payables") ? `<a class="button" href="/payables/new">New Payable</a>` : ""} <a class="button secondary" href="${esc(`/payables/export.csv${params.toString() ? `?${params.toString()}` : ""}`)}">Export CSV</a>` });
  const headers = [...sortableHeaders([{ label: "Date", sort: "date" }, { label: "Ref. No.", sort: "reference" }, { label: "Supplier", sort: "supplier" }, { label: "Source", sort: "source" }, { label: "Description", sort: "description" }, { label: "Amount", sort: "amount" }, { label: "Due", sort: "due" }, { label: "Status", sort: "status" }, { label: "Linked Repair" }], sort, params), "Actions"];
  const content = `${messagePanel(url)}<section class="panel">${toolbar}</section>${table(headers, body, { empty: "No payables found." })}${paginationWithParams("/payables", params, page, Number(countRow?.total || 0))}`;
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
  const filters = { status: enumParam(url, "status", PAYABLE_STATUSES), supplier_id: idParam(url, "supplier_id"), source_type: enumParam(url, "source_type", ["Manual", "Repair"]), ...rangeParams(url, "due_from", "due_to") };
  const clauses = [];
  const params = [];
  addEqualityFilters(clauses, params, [["p.supplier_id", filters.supplier_id], ["p.source_type", filters.source_type]]);
  addDateRange(clauses, params, "p.due_date", filters);
  const where = mergeWhere(payableWhere((url.searchParams.get("q") || "").trim(), filters.status), clauses, params);
  const sort = listSort(url, { date: { sql: "p.payable_date", defaultDir: "desc", tie: "p.id DESC" }, reference: { sql: "p.reference_no", tie: "p.id ASC" }, supplier: { sql: "s.supplier_name", tie: "p.id ASC" }, source: { sql: "p.source_type", tie: "p.id ASC" }, description: { sql: "p.description", tie: "p.id ASC" }, amount: { sql: "p.amount", defaultDir: "desc", tie: "p.id DESC" }, due: { sql: "p.due_date", defaultDir: "desc", tie: "p.id DESC" }, status: { sql: "p.status", tie: "p.id ASC" } }, "p.payable_date DESC, p.id DESC");
  const rows = await all(env, `SELECT p.*, s.supplier_name FROM payables p LEFT JOIN suppliers s ON s.id=p.supplier_id${where.sql} ORDER BY ${sort.order}`, where.params);
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
    selectInput("employee_id", "Employee", employees, row.employee_id || "", (r) => choiceLabel("employee", r), "---------", quickSelect("employee", "employee")),
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
  return `${errorBox}${formPanel(id ? `/advances/${type}/${id}/edit` : `/advances/${type}/new`, fields, `Save ${spec.title}`, { cancelHref: "/advances" })}${deleteForm}`;
}

function advanceWhere(query, alias = "v") {
  if (!query) return { sql: "", params: [] };
  return {
    sql: ` WHERE e.full_name LIKE ? OR e.employee_code LIKE ? OR ${alias}.status LIKE ? OR ${alias}.notes LIKE ?`,
    params: Array(4).fill(`%${query}%`),
  };
}

function advanceListFilters(url) {
  return { employee_id: idParam(url, "employee_id"), status: enumParam(url, "status", ADVANCE_STATUSES), ...rangeParams(url) };
}

async function advancesListContent(request, env, user, path) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const filters = advanceListFilters(url);
  const valePage = Math.max(1, Number(url.searchParams.get("vale_page") || 1) || 1);
  const cashPage = Math.max(1, Number(url.searchParams.get("cash_page") || 1) || 1);
  const filterClauses = [];
  const filterParams = [];
  addEqualityFilters(filterClauses, filterParams, [["employee_id", filters.employee_id], ["status", filters.status]]);
  addDateRange(filterClauses, filterParams, "date_granted", filters);
  const valeWhere = mergeWhere(advanceWhere(query, "v"), filterClauses.map((clause) => clause.replace(/^(employee_id|status|date_granted)/, "v.$1")), filterParams);
  const cashWhere = mergeWhere(advanceWhere(query, "c"), filterClauses.map((clause) => clause.replace(/^(employee_id|status|date_granted)/, "c.$1")), filterParams);
  const valeSort = listSort(url, { employee: { sql: "e.full_name", tie: "v.id ASC" }, date: { sql: "v.date_granted", defaultDir: "desc", tie: "v.id DESC" }, amount: { sql: "v.amount", defaultDir: "desc", tie: "v.id DESC" }, installment: { sql: "v.installment_amount", defaultDir: "desc", tie: "v.id DESC" }, balance: { sql: "v.balance", defaultDir: "desc", tie: "v.id DESC" }, status: { sql: "v.status", tie: "v.id ASC" } }, "v.date_granted DESC, v.id DESC", { sortName: "vale_sort", dirName: "vale_dir" });
  const cashSort = listSort(url, { employee: { sql: "e.full_name", tie: "c.id ASC" }, date: { sql: "c.date_granted", defaultDir: "desc", tie: "c.id DESC" }, amount: { sql: "c.amount", defaultDir: "desc", tie: "c.id DESC" }, balance: { sql: "c.balance", defaultDir: "desc", tie: "c.id DESC" }, applied: { sql: "c.applied", tie: "c.id ASC" }, status: { sql: "c.status", tie: "c.id ASC" } }, "c.date_granted DESC, c.id DESC", { sortName: "cash_sort", dirName: "cash_dir" });
  const [valeCount, cashCount, valeRows, cashRows] = await Promise.all([
    first(env, `SELECT COUNT(*) AS total FROM vale_records v LEFT JOIN employees e ON e.id=v.employee_id${valeWhere.sql}`, valeWhere.params),
    first(env, `SELECT COUNT(*) AS total FROM cash_advances c LEFT JOIN employees e ON e.id=c.employee_id${cashWhere.sql}`, cashWhere.params),
    all(env, `SELECT v.*, e.full_name AS employee_name, e.employee_code FROM vale_records v LEFT JOIN employees e ON e.id=v.employee_id${valeWhere.sql} ORDER BY ${valeSort.order} LIMIT 25 OFFSET ?`, [...valeWhere.params, (valePage - 1) * 25]),
    all(env, `SELECT c.*, e.full_name AS employee_name, e.employee_code FROM cash_advances c LEFT JOIN employees e ON e.id=c.employee_id${cashWhere.sql} ORDER BY ${cashSort.order} LIMIT 25 OFFSET ?`, [...cashWhere.params, (cashPage - 1) * 25]),
  ]);
  const params = listParams(url, ["q", "employee_id", "status", "date_from", "date_to"]);
  if (valeSort.key) { params.set("vale_sort", valeSort.key); params.set("vale_dir", valeSort.dir); }
  if (cashSort.key) { params.set("cash_sort", cashSort.key); params.set("cash_dir", cashSort.dir); }
  const employees = await all(env, "SELECT id,employee_code,full_name,employee_type FROM employees WHERE active=1 ORDER BY full_name");
  const filterMarkup = [selectFilter("employee_id", "Employee", employees.map((row) => ({ value: row.id, label: choiceLabel("employee", row) })), filters.employee_id), selectFilter("status", "Status", ADVANCE_STATUSES, filters.status), dateFilter("date_from", "Date from", filters.from), dateFilter("date_to", "Date to", filters.to)].join("");
  const toolbar = listToolbar({ query, placeholder: "Search advances", filters: filterMarkup, clearHref: "/advances", actions: canEdit(user, "Vale / Cash Advance") ? `<a class="button" href="/advances/vale/new">New Vale</a> <a class="button" href="/advances/cash/new">New Cash Advance</a>` : "" });
  const valeBody = valeRows.map((row) => `<tr><td>${canEdit(user, "Vale / Cash Advance") ? `<a href="/advances/vale/${row.id}/edit">${esc(row.employee_name || "")}</a>` : esc(row.employee_name || "")}</td><td>${esc(row.date_granted)}</td>${moneyCell(row.amount)}${moneyCell(row.installment_amount)}${moneyCell(row.balance)}<td><span class="status">${esc(row.status)}</span></td><td>${canEdit(user, "Vale / Cash Advance") ? `<a href="/advances/vale/${row.id}/edit">Edit</a>` : `<span class="muted">Read only</span>`}</td></tr>`);
  const cashBody = cashRows.map((row) => `<tr><td>${canEdit(user, "Vale / Cash Advance") ? `<a href="/advances/cash/${row.id}/edit">${esc(row.employee_name || "")}</a>` : esc(row.employee_name || "")}</td><td>${esc(row.date_granted)}</td>${moneyCell(row.amount)}${moneyCell(row.balance)}<td>${row.applied ? "Yes" : "No"}</td><td><span class="status">${esc(row.status)}</span></td><td>${canEdit(user, "Vale / Cash Advance") ? `<a href="/advances/cash/${row.id}/edit">Edit</a>` : `<span class="muted">Read only</span>`}</td></tr>`);
  const valeHeaders = [...sortableHeaders([{ label: "Employee", sort: "employee" }, { label: "Date", sort: "date" }, { label: "Amount", sort: "amount" }, { label: "Installment", sort: "installment" }, { label: "Balance", sort: "balance" }, { label: "Status", sort: "status" }], valeSort, params, { sortName: "vale_sort", dirName: "vale_dir" }), "Actions"];
  const cashHeaders = [...sortableHeaders([{ label: "Employee", sort: "employee" }, { label: "Date", sort: "date" }, { label: "Amount", sort: "amount" }, { label: "Balance", sort: "balance" }, { label: "Applied", sort: "applied" }, { label: "Status", sort: "status" }], cashSort, params, { sortName: "cash_sort", dirName: "cash_dir" }), "Actions"];
  return `${messagePanel(url)}<section class="panel">${toolbar}</section><section class="panel"><div class="toolbar"><h3>Vale</h3><a class="button secondary" href="${esc(`/advances/vale/export.csv${params.toString() ? `?${params.toString()}` : ""}`)}">Export Vale CSV</a></div>${table(valeHeaders, valeBody, { empty: "No vale records found.", bare: true })}${paginationWithPageParam("/advances", new URLSearchParams([...params, ["cash_page", String(cashPage)]]), "vale_page", valePage, Number(valeCount?.total || 0))}</section><section class="panel"><div class="toolbar"><h3>Cash Advance</h3><a class="button secondary" href="${esc(`/advances/cash/export.csv${params.toString() ? `?${params.toString()}` : ""}`)}">Export Cash CSV</a></div>${table(cashHeaders, cashBody, { empty: "No cash advances found.", bare: true })}${paginationWithPageParam("/advances", new URLSearchParams([...params, ["vale_page", String(valePage)]]), "cash_page", cashPage, Number(cashCount?.total || 0))}</section>`;
}

async function advancesPage(request, env, user, path) {
  const access = requireView(user, "Vale / Cash Advance");
  if (access) return errorResponse(access, user, path);
  return html(layout({ title: "Vale / Cash Advance", user, path, content: await advancesListContent(request, env, user, path) }));
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
    if (errors.length) return html(layout({ title: "Vale / Cash Advance", user, path, content: `${await advancesListContent(request, env, user, path)}${dialogShell({ title: `${id ? "Edit" : "New"} ${spec.title}`, subtitle: "Advance record", body: await renderAdvanceForm(env, type, values, id, errors), closeHref: "/advances", wide: false })}` }), 400);
    const fields = Object.keys(values);
    try {
      if (id) await run(env, `UPDATE ${spec.table} SET ${fields.map((field) => `${field}=?`).join(", ")} WHERE id=?`, [...fields.map((field) => values[field]), id]);
      else await run(env, `INSERT INTO ${spec.table} (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`, fields.map((field) => values[field]));
      return redirect(`/advances?ok=${encodeURIComponent(`${spec.title} ${id ? "updated" : "saved"}.`)}`);
    } catch (error) {
      return html(layout({ title: "Vale / Cash Advance", user, path, content: `${await advancesListContent(request, env, user, path)}${dialogShell({ title: `${id ? "Edit" : "New"} ${spec.title}`, subtitle: "Advance record", body: await renderAdvanceForm(env, type, values, id, [`Could not save ${spec.title}: ${error.message || error}`]), closeHref: "/advances", wide: false })}` }), 400);
    }
  }
  return html(layout({ title: "Vale / Cash Advance", user, path, content: `${await advancesListContent(request, env, user, path)}${dialogShell({ title: `${id ? "Edit" : "New"} ${spec.title}`, subtitle: "Advance record", body: await renderAdvanceForm(env, type, row, id), closeHref: "/advances", wide: false })}` }));
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
  const filters = advanceListFilters(url);
  const clauses = [];
  const params = [];
  addEqualityFilters(clauses, params, [[`${alias}.employee_id`, filters.employee_id], [`${alias}.status`, filters.status]]);
  addDateRange(clauses, params, `${alias}.date_granted`, filters);
  const where = mergeWhere(advanceWhere((url.searchParams.get("q") || "").trim(), alias), clauses, params);
  const sort = listSort(url, type === "vale" ? { employee: { sql: "e.full_name", tie: "v.id ASC" }, date: { sql: "v.date_granted", defaultDir: "desc", tie: "v.id DESC" }, amount: { sql: "v.amount", defaultDir: "desc", tie: "v.id DESC" }, installment: { sql: "v.installment_amount", defaultDir: "desc", tie: "v.id DESC" }, balance: { sql: "v.balance", defaultDir: "desc", tie: "v.id DESC" }, status: { sql: "v.status", tie: "v.id ASC" } } : { employee: { sql: "e.full_name", tie: "c.id ASC" }, date: { sql: "c.date_granted", defaultDir: "desc", tie: "c.id DESC" }, amount: { sql: "c.amount", defaultDir: "desc", tie: "c.id DESC" }, balance: { sql: "c.balance", defaultDir: "desc", tie: "c.id DESC" }, applied: { sql: "c.applied", tie: "c.id ASC" }, status: { sql: "c.status", tie: "c.id ASC" } }, `${alias}.date_granted DESC, ${alias}.id DESC`, { sortName: type === "vale" ? "vale_sort" : "cash_sort", dirName: type === "vale" ? "vale_dir" : "cash_dir" });
  const rows = await all(env, `SELECT ${alias}.*, e.full_name AS employee_name, e.employee_code FROM ${spec.table} ${alias} LEFT JOIN employees e ON e.id=${alias}.employee_id${where.sql} ORDER BY ${sort.order}`, where.params);
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

async function payrollEligibleProjectWork(env, employee, periodFrom, periodTo) {
  if (!employee || !periodFrom || !periodTo) return [];
  return await all(
    env,
    `SELECT w.*, p.project_no, a.asset_code,
            (SELECT COUNT(*) FROM project_work_helpers wh2 WHERE wh2.work_entry_id=w.id) AS helper_count,
            CASE WHEN w.primary_employee_id=? THEN 'Primary' ELSE 'Helper' END AS project_role
       FROM project_work_entries w
       JOIN projects p ON p.id=w.project_id
       LEFT JOIN assets a ON a.id=w.asset_id_snapshot
      WHERE w.work_date BETWEEN ? AND ?
        AND w.status IN ('Completed','Billed')
        AND (w.primary_employee_id=? OR EXISTS (
          SELECT 1 FROM project_work_helpers wh
           WHERE wh.work_entry_id=w.id AND wh.employee_id=?
        ))
        AND NOT EXISTS (
          SELECT 1 FROM payroll_project_entries ppe
           WHERE ppe.work_entry_id=w.id AND ppe.employee_id=?
        )
      ORDER BY w.work_date,p.project_no,w.id`,
    [employee.id, periodFrom, periodTo, employee.id, employee.id, employee.id],
  );
}

async function payrollProjectItems(env, workId, employeeType) {
  return await all(
    env,
    "SELECT * FROM project_work_pay_items WHERE work_entry_id=? AND employee_type=? ORDER BY sort_order,id",
    [workId, employeeType],
  );
}

async function payrollAdvancePlan(env, table, employeeId) {
  return await all(env, `SELECT * FROM ${table} WHERE employee_id=? AND status='Open' AND balance>0 ORDER BY date_granted, id`, [employeeId]);
}

async function payrollPreview(env, employeeId, periodFrom, periodTo) {
  const employee = await loadPayrollEmployee(env, employeeId);
  if (!employee) return null;
  const trips = await payrollEligibleTrips(env, employee, periodFrom, periodTo);
  const projectEntries = await payrollEligibleProjectWork(env, employee, periodFrom, periodTo);
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
  const projectRows = [];
  for (const work of projectEntries) {
    const helperCount = Math.max(0, numeric(work.helper_count));
    const role = work.project_role === "Primary" ? "primary" : "helper";
    const baseAmount = projectEmployeeBasePay(work, role, helperCount);
    gross += baseAmount;
    projectRows.push({ ...work, payroll_amount: baseAmount });
    const type = role === "primary" ? "Primary" : "Helper";
    const items = await payrollProjectItems(env, work.id, type);
    for (const item of items) {
      const amount = role === "helper" ? (helperCount ? numeric(item.amount) / helperCount : 0) : numeric(item.amount);
      if (amount > 0) lineTotals.set(item.label, numeric(lineTotals.get(item.label)) + amount);
    }
  }
  const additionalLines = [...lineTotals.entries()].map(([label, amount], index) => ({ employee_type: employee.employee_type, label, amount, sort_order: index + 1 }));
  const additionalPay = additionalLines.reduce((sum, line) => sum + numeric(line.amount), 0);
  const valePlan = await payrollAdvancePlan(env, "vale_records", employee.id);
  const cashPlan = await payrollAdvancePlan(env, "cash_advances", employee.id);
  const valeDeduction = valePlan.reduce((sum, row) => sum + Math.min(numeric(row.balance), numeric(row.installment_amount) || numeric(row.balance)), 0);
  const cashDeduction = cashPlan.reduce((sum, row) => sum + numeric(row.balance), 0);
  let unitDescription = "Manual payroll entry";
  if (employee.employee_type === "Driver") unitDescription = `${trips.length} trip(s), ${projectEntries.length} project work entr${projectEntries.length === 1 ? "y" : "ies"}`;
  else if (employee.employee_type === "Helper") unitDescription = `${trips.length} helper trip(s), ${projectEntries.length} project work entr${projectEntries.length === 1 ? "y" : "ies"}`;
  else if (projectEntries.length) unitDescription = `${projectEntries.length} project work entr${projectEntries.length === 1 ? "y" : "ies"}`;
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
    projectEntries,
    projectRows,
    trips_count: trips.length + projectEntries.length,
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

function payrollProjectTable(preview) {
  const rows = (preview?.projectRows || []).map((row) => `<tr><td>${esc(row.work_date)}</td><td><a href="/projects/${row.project_id}">${esc(row.project_no)}</a></td><td>${esc(row.asset_code || "")}</td><td>${esc(row.billing_quantity)} ${esc(row.billing_unit)}</td><td>${esc(row.project_role)}</td><td>${esc(row.job_description_snapshot || "")}</td>${moneyCell(row.payroll_amount)}</tr>`);
  return table(["Date", "Project No.", "Unit", "Quantity", "Role", "Item / Job", "Base Pay"], rows, { empty: "No eligible completed project work entries. Open the Project, record Daily Work, then Mark Complete. The work date must be within this payroll period and the employee must be the Primary or a Helper." });
}

function payrollFormContent(employees, selection, preview, values = {}, errors = []) {
  const employeeId = selection.employee || values.employee || "";
  const periodFrom = selection.period_from || values.period_from || periodStartToday();
  const periodTo = selection.period_to || values.period_to || todayISO();
  const employeeSelect = selectInput("employee", "Employee", employees, employeeId, (employee) => choiceLabel("employee", employee), "Select employee", { searchable: true, attrs: "required", quickCreate: { kind: "employee", context: "employee" } });
  const selector = `<section class="panel payroll-selector"><h3>1. Select Employee & Period</h3><form method="get" class="selector-row">${employeeSelect}<label>Period From<input type="date" name="period_from" value="${esc(periodFrom)}" required></label><label>Period To<input type="date" name="period_to" value="${esc(periodTo)}" required></label><button>Preview Payroll</button></form></section>`;
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
  const hidden = `<input type="hidden" name="employee" value="${esc(preview.employee.id)}"><input type="hidden" name="period_from" value="${esc(periodFrom)}"><input type="hidden" name="period_to" value="${esc(periodTo)}"><input type="hidden" name="expected_trip_ids" value="${esc(JSON.stringify(preview.trips.map((trip) => trip.id)))}"><input type="hidden" name="expected_project_entry_ids" value="${esc(JSON.stringify(preview.projectEntries.map((entry) => entry.id)))}">`;
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
  const previewSummary = `<section class="panel">${cards([["Employee", preview.employee.full_name], ["Type / Basis", `${preview.employee_type} / ${preview.payroll_basis}`], ["Eligible Work", String(preview.trips_count)], ["Preview Gross", peso(preview.gross_pay)]])}<dl class="payroll-limits"><dt>Remaining Vale</dt><dd>${esc(peso(preview.vale_deduction))}</dd><dt>Remaining Cash Advance</dt><dd>${esc(peso(preview.cash_advance_deduction))}</dd></dl></section>`;
  const additional = preview.additionalLines.length ? `<section class="panel"><h3>Trip Pay Items</h3>${preview.additionalLines.map((line) => `<div class="detail-pay-row"><span>${esc(line.label)}</span><strong>${esc(peso(line.amount))}</strong></div>`).join("")}</section>` : "";
  return `${errorBox}${selector}${previewSummary}<form method="post" action="/payroll/new" class="panel">${hidden}<div class="grid">${fields.join("")}</div><p><button>Save Payroll</button> <a class="button secondary" href="/payroll">Cancel</a></p></form><section class="panel payroll-preview-table"><h3>Eligible Trip Earnings</h3></section>${payrollTripTable(preview)}<section class="panel payroll-preview-table"><h3>Eligible Project Work Earnings</h3></section>${payrollProjectTable(preview)}${additional}`;
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
    expected_project_entry_ids: parseExpectedIds(data.expected_project_entry_ids),
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
    const freshProjectIds = preview.projectEntries.map((entry) => Number(entry.id));
    if (JSON.stringify(freshProjectIds) !== JSON.stringify(cleaned.expected_project_entry_ids)) errors.push("Project work eligibility changed. Preview the period again before saving.");
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
    trips_count: String(preview.trips.length + preview.projectEntries.length),
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
  for (const work of preview.projectEntries) {
    await run(env, "INSERT INTO payroll_project_entries (payroll_id,work_entry_id,employee_id,employee_role,pay_basis,pay_quantity,pay_rate,base_amount) VALUES (?,?,?,?,?,?,?,?)", [
      payrollId,
      work.id,
      cleaned.employee_id,
      work.project_role,
      work.project_role === "Primary" ? work.primary_pay_basis : work.helper_pay_basis,
      work.project_role === "Primary" ? work.primary_pay_quantity : work.helper_pay_quantity,
      work.project_role === "Primary" ? work.primary_pay_rate : work.helper_pay_rate,
      projectEmployeeBasePay(work, work.project_role === "Primary" ? "primary" : "helper", numeric(work.helper_count)),
    ]);
  }
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
  const filters = { employee_id: idParam(url, "employee_id"), employee_type: enumParam(url, "employee_type", ["Driver", "Helper", "Operator", "Mechanic"]), payroll_basis: enumParam(url, "payroll_basis", ["Per Trip", "Per Day", "Manual"]), ...rangeParams(url) };
  const clauses = [];
  const filterParams = [];
  addEqualityFilters(clauses, filterParams, [["p.employee_id", filters.employee_id], ["p.employee_type", filters.employee_type], ["p.payroll_basis", filters.payroll_basis]]);
  addDateRange(clauses, filterParams, "p.pay_date", filters);
  const where = mergeWhere(payrollWhere(query), clauses, filterParams);
  const sort = listSort(url, { date: { sql: "p.pay_date", defaultDir: "desc", tie: "p.id DESC" }, employee: { sql: "e.full_name", tie: "p.id ASC" }, type: { sql: "p.employee_type", tie: "p.id ASC" }, trips: { sql: "p.trips_count", defaultDir: "desc", tie: "p.id DESC" }, days: { sql: "p.days_count", defaultDir: "desc", tie: "p.id DESC" }, gross: { sql: "p.gross_pay", defaultDir: "desc", tie: "p.id DESC" }, additional: { sql: "p.additional_pay", defaultDir: "desc", tie: "p.id DESC" }, deductions: { sql: "(p.vale_deduction+p.cash_advance_deduction+p.sss+p.philhealth+p.pagibig+p.withholding_tax+p.change_deduction+p.other_deduction)", defaultDir: "desc", tie: "p.id DESC" }, net: { sql: "p.net_pay", defaultDir: "desc", tie: "p.id DESC" } }, "p.pay_date DESC, p.id DESC");
  const countRow = await first(env, `SELECT COUNT(*) AS total FROM payroll_entries p LEFT JOIN employees e ON e.id=p.employee_id${where.sql}`, where.params);
  const rows = await all(env, `SELECT p.*, e.full_name, e.employee_code FROM payroll_entries p LEFT JOIN employees e ON e.id=p.employee_id${where.sql} ORDER BY ${sort.order} LIMIT 25 OFFSET ?`, [...where.params, (page - 1) * 25]);
  const body = rows.map((row) => `<tr><td>${esc(row.pay_date)}</td><td>${esc(row.period_from)} – ${esc(row.period_to)}</td><td><a href="/payroll/${row.id}">${esc(row.full_name || "")}</a><small class="cell-detail">${esc(row.employee_code || "")}</small></td><td>${esc(row.employee_type)}<small class="cell-detail">${esc(row.payroll_basis)}</small></td><td>${esc(row.trips_count)}</td><td>${esc(row.days_count)}</td>${moneyCell(row.gross_pay)}${moneyCell(row.additional_pay)}${moneyCell(deductionTotal(row))}<td class="num"><strong>${esc(peso(row.net_pay))}</strong></td><td><a href="/payroll/${row.id}">View</a> <a href="/payroll/${row.id}/print" target="_blank">Print</a></td></tr>`);
  const params = listParams(url, ["q", "employee_id", "employee_type", "payroll_basis", "date_from", "date_to"], { sort });
  const employees = await payrollEmployees(env);
  const filterMarkup = [selectFilter("employee_id", "Employee", employees.map((row) => ({ value: row.id, label: choiceLabel("employee", row) })), filters.employee_id), selectFilter("employee_type", "Employee type", ["Driver", "Helper", "Operator", "Mechanic"], filters.employee_type), selectFilter("payroll_basis", "Payroll basis", ["Per Trip", "Per Day", "Manual"], filters.payroll_basis), dateFilter("date_from", "Pay date from", filters.from), dateFilter("date_to", "Pay date to", filters.to)].join("");
  const toolbar = listToolbar({ query, placeholder: "Search employee, type, or remarks", filters: filterMarkup, clearHref: "/payroll", actions: `${canEdit(user, "Payroll") ? `<a class="button" href="/payroll/new">New Payroll</a>` : ""} <a class="button secondary" href="${esc(`/payroll/export.csv${params.toString() ? `?${params.toString()}` : ""}`)}">Export CSV</a>` });
  const headers = [...sortableHeaders([{ label: "Pay Date", sort: "date" }, { label: "Period" }, { label: "Employee", sort: "employee" }, { label: "Type / Basis", sort: "type" }, { label: "Trips", sort: "trips" }, { label: "Days", sort: "days" }, { label: "Gross", sort: "gross" }, { label: "Additional", sort: "additional" }, { label: "Deductions", sort: "deductions" }, { label: "Net", sort: "net" }], sort, params), "Actions"];
  const content = `${messagePanel(url)}<section class="panel">${toolbar}</section>${table(headers, body, { empty: "No payroll entries found." })}${paginationWithParams("/payroll", params, page, Number(countRow?.total || 0))}`;
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
  entry.project_entries = await all(env, `SELECT ppe.*, w.project_id, w.work_date, w.billing_unit, w.billing_quantity, w.job_description_snapshot, w.origin_snapshot, w.destination_snapshot, p.project_no, a.asset_code FROM payroll_project_entries ppe JOIN project_work_entries w ON w.id=ppe.work_entry_id JOIN projects p ON p.id=w.project_id LEFT JOIN assets a ON a.id=w.asset_id_snapshot WHERE ppe.payroll_id=? ORDER BY w.work_date,p.project_no,w.id`, [id]);
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

function payrollDetailContent(entry, user, print = false, settings = DEFAULT_SETTINGS) {
  const deductions = [
    ["Vale", entry.vale_deduction], ["Cash Advance", entry.cash_advance_deduction],
    ["SSS", entry.sss], ["PhilHealth", entry.philhealth], ["Pag-IBIG", entry.pagibig],
    ["Withholding Tax", entry.withholding_tax], ["Change Deduction", entry.change_deduction], ["Other Deduction", entry.other_deduction],
  ];
  const tripRows = (entry.trips || []).map((trip) => ({ ...trip, payroll_amount: payrollTripAmount(entry, trip) }));
  const projectRows = (entry.project_entries || []).map((row) => ({ ...row, payroll_amount: numeric(row.base_amount) }));
  if (print) {
    const rows = [...tripRows.map((row) => `<tr><td>${esc(row.trip_date)}</td><td class="center">1</td><td class="num">${esc(money(row.payroll_amount))}</td><td>${esc(row.trip_ticket_no)}</td><td>${esc(row.origin || "")} to ${esc(row.destination || "")}</td><td>${esc(row.job_description || "")}</td><td class="num">${esc(money(row.payroll_amount))}</td></tr>`), ...projectRows.map((row) => `<tr><td>${esc(row.work_date)}</td><td class="center">${esc(row.pay_quantity)}</td><td class="num">${esc(money(row.pay_rate))}</td><td>${esc(row.project_no)}</td><td>${esc([row.origin_snapshot, row.destination_snapshot].filter(Boolean).join(" to ") || row.pay_basis)}</td><td>${esc(`${row.job_description_snapshot || ""} (${row.billing_quantity} ${row.billing_unit})`)}</td><td class="num">${esc(money(row.payroll_amount))}</td></tr>`)].join("") || `<tr><td colspan="7" class="center">No trip or project-work detail captured for this entry.</td></tr>`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>Payroll #${esc(entry.id)}</title><style>@page{size:A5 landscape;margin:8mm}body{font:12px Arial,sans-serif;color:#111;margin:0}.sheet{padding:2mm 4mm 24mm}.print-button{margin-bottom:8px}.top{display:flex;justify-content:space-between;gap:12px}.top h1{font-size:20px;margin:0 0 5px}.top h2{font-size:16px;margin:0;text-align:right}.company h1{font-size:18px;margin:0}.company-lines{margin:3px 0 6px;line-height:1.25}.meta{font-size:14px;margin:3px 0}table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border:1px solid #222;padding:5px 6px;vertical-align:top}th{background:#f0f0f0}.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.center{text-align:center}.summary{display:grid;grid-template-columns:1fr 1.1fr 1.05fr;gap:10px;align-items:start}.net{text-align:right;font-size:18px;font-weight:bold;margin-top:8px}.remarks-box{min-height:78px;white-space:pre-wrap}.remaining-balances{margin-top:8px}.signature{position:fixed;right:12mm;bottom:8mm;width:240px;border-top:1px solid #111;text-align:center;padding-top:6px;background:#fff}@media print{.print-button{display:none}}</style></head><body><div class="sheet"><button class="print-button" onclick="window.print()">Print</button><div class="top"><div><div class="company">${companyHeader(settings, "", { logo: false })}</div><h1>Payroll for ${esc(entry.period_from)} to ${esc(entry.period_to)}</h1><div class="meta"><strong>Payroll ID:</strong> ${esc(entry.id)}</div><div class="meta"><strong>Name of ${esc(entry.employee_type)}:</strong> ${esc(entry.full_name || "")}</div><div class="meta"><strong>Work:</strong> ${esc(entry.unit_description || "")}</div></div><h2>${esc(entry.pay_date)}</h2></div><table><thead><tr><th>Date</th><th>Trips</th><th>Rate</th><th>Trip Ticket / Waybill</th><th>Origin-Destination</th><th>Item / Job</th><th>Amount</th></tr></thead><tbody>${rows}<tr><td></td><td class="center"><strong>${esc(entry.trips_count)}</strong></td><td colspan="4" class="num"><strong>Gross Pay</strong></td><td class="num"><strong>${esc(peso(entry.gross_pay))}</strong></td></tr></tbody></table><div class="summary"><table><tr><th colspan="2">Payroll Summary</th></tr><tr><td>Days Count</td><td>${esc(entry.days_count)}</td></tr><tr><td>Additional Pay</td><td class="num">${esc(peso(entry.additional_pay))}</td></tr></table><div><table><tr><th>Remarks</th></tr><tr><td class="remarks-box">${esc(entry.remarks || "")}</td></tr></table><table class="remaining-balances"><tr><td>Remaining Vale</td><td class="num">${esc(peso(entry.remaining_vale))}</td></tr><tr><td>Remaining Cash Advance</td><td class="num">${esc(peso(entry.remaining_cash))}</td></tr></table></div><div><table><tr><th colspan="2">Deductions</th></tr>${deductions.map(([label, amount]) => `<tr><td>${esc(label)}</td><td class="num">${numeric(amount) ? esc(peso(amount)) : ""}</td></tr>`).join("")}</table><div class="net">Net Pay: ${esc(peso(entry.net_pay))}</div></div></div><div class="signature">Received by: / Employee Signature</div></div></body></html>`;
  }
  const tripBody = tripRows.map((row) => `<tr><td>${esc(row.trip_date)}</td><td><a href="/trips/${row.trip_id}">${esc(row.trip_ticket_no)}</a></td><td>${esc(row.asset_code || "")}</td><td>${esc(row.origin || "")} → ${esc(row.destination || "")}</td><td>${esc(row.job_description || "")}</td>${moneyCell(row.payroll_amount)}</tr>`);
  const projectBody = projectRows.map((row) => `<tr><td>${esc(row.work_date)}</td><td><a href="/projects/${row.project_id}">${esc(row.project_no)}</a></td><td>${esc(row.asset_code || "")}</td><td>${esc(`${row.pay_basis} · ${row.pay_quantity}`)}</td><td>${esc(`${row.job_description_snapshot || ""} (${row.billing_quantity} ${row.billing_unit})`)}</td>${moneyCell(row.payroll_amount)}</tr>`);
  const lines = (entry.lines || []).map((line) => `<div class="detail-pay-row"><span>${esc(line.label)} <small>${esc(line.employee_type)}</small></span><strong>${esc(peso(line.amount))}</strong></div>`).join("") || `<p class="muted">No additional lines.</p>`;
  const main = `<section class="panel detail-hero"><div><span class="dialog-kicker">Payroll #${esc(entry.id)}</span><h3>${esc(entry.full_name || "")}</h3><p>${esc(entry.period_from)} – ${esc(entry.period_to)} · ${esc(entry.employee_type)} / ${esc(entry.payroll_basis)}</p></div><strong>${esc(peso(entry.net_pay))}</strong></section><div class="detail-grid"><section class="panel"><h3>Payroll Summary</h3><dl class="detail-list"><dt>Pay Date</dt><dd>${esc(entry.pay_date)}</dd><dt>Work</dt><dd>${esc(entry.unit_description)}</dd><dt>Trips</dt><dd>${esc(entry.trips_count)}</dd><dt>Gross</dt><dd>${esc(peso(entry.gross_pay))}</dd><dt>Additional</dt><dd>${esc(peso(entry.additional_pay))}</dd><dt>Deductions</dt><dd>${esc(peso(deductionTotal(entry)))}</dd><dt class="detail-total">Net Pay</dt><dd class="detail-total">${esc(peso(entry.net_pay))}</dd></dl></section><section class="panel"><h3>Deductions</h3><dl class="detail-list">${deductions.map(([label, amount]) => `<dt>${esc(label)}</dt><dd>${esc(peso(amount))}</dd>`).join("")}</dl></section><section class="panel"><h3>Remarks</h3><p>${esc(entry.remarks || "")}</p><dl class="detail-list"><dt>Remaining Vale</dt><dd>${esc(peso(entry.remaining_vale))}</dd><dt>Remaining Cash Advance</dt><dd>${esc(peso(entry.remaining_cash))}</dd></dl></section><section class="panel"><h3>Additional Lines</h3>${lines}</section></div><section class="panel"><h3>Claimed Trips</h3></section>${table(["Date", "Trip Ticket / Waybill", "Unit", "Route", "Item / Job", "Amount"], tripBody, { empty: "No trip-level payroll detail captured for this entry." })}`;
  const actions = `<div class="detail-toolbar"><a class="button secondary" href="/payroll">← Payroll List</a><div><a class="button secondary" href="/payroll/${entry.id}/print" target="_blank">Printable Payroll</a></div></div>`;
  const projectSection = `<section class="panel"><h3>Claimed Project Work</h3></section>${table(["Date", "Project No.", "Unit", "Pay Basis / Quantity", "Item / Job", "Amount"], projectBody, { empty: "No project-work claims in this payroll." })}`;
  const deleteForm = canEdit(user, "Payroll") ? `<section class="detail-danger"><form method="post" action="/payroll/${entry.id}/delete" onsubmit="return confirm('Delete this payroll? Claimed trips and project work will be released and advance deductions restored.');"><button class="danger-button">Delete and Reverse Payroll</button></form></section>` : "";
  return `${actions}${main}${projectSection}${deleteForm}`;
}

async function payrollDetailPage(request, env, user, path, id, print = false) {
  const access = requireView(user, "Payroll");
  if (access) return errorResponse(access, user, path);
  const entry = await loadPayrollEntry(env, id);
  if (!entry) return html("Not found", 404);
  if (print) return html(payrollDetailContent(entry, user, true, await loadSettings(env)));
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
  const filters = { employee_id: idParam(url, "employee_id"), employee_type: enumParam(url, "employee_type", ["Driver", "Helper", "Operator", "Mechanic"]), payroll_basis: enumParam(url, "payroll_basis", ["Per Trip", "Per Day", "Manual"]), ...rangeParams(url) };
  const clauses = [];
  const params = [];
  addEqualityFilters(clauses, params, [["p.employee_id", filters.employee_id], ["p.employee_type", filters.employee_type], ["p.payroll_basis", filters.payroll_basis]]);
  addDateRange(clauses, params, "p.pay_date", filters);
  const where = mergeWhere(payrollWhere((url.searchParams.get("q") || "").trim()), clauses, params);
  const sort = listSort(url, { date: { sql: "p.pay_date", defaultDir: "desc", tie: "p.id DESC" }, employee: { sql: "e.full_name", tie: "p.id ASC" }, type: { sql: "p.employee_type", tie: "p.id ASC" }, trips: { sql: "p.trips_count", defaultDir: "desc", tie: "p.id DESC" }, days: { sql: "p.days_count", defaultDir: "desc", tie: "p.id DESC" }, gross: { sql: "p.gross_pay", defaultDir: "desc", tie: "p.id DESC" }, additional: { sql: "p.additional_pay", defaultDir: "desc", tie: "p.id DESC" }, deductions: { sql: "(p.vale_deduction+p.cash_advance_deduction+p.sss+p.philhealth+p.pagibig+p.withholding_tax+p.change_deduction+p.other_deduction)", defaultDir: "desc", tie: "p.id DESC" }, net: { sql: "p.net_pay", defaultDir: "desc", tie: "p.id DESC" } }, "p.pay_date DESC, p.id DESC");
  const rows = await all(env, `SELECT p.*, e.employee_code, e.full_name FROM payroll_entries p LEFT JOIN employees e ON e.id=p.employee_id${where.sql} ORDER BY ${sort.order}`, where.params);
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

async function billingEligibleProjectWork(env, clientId, periodFrom, periodTo) {
  if (!clientId || !periodFrom || !periodTo) return [];
  return await all(env, `SELECT w.*,p.project_no,a.asset_code FROM project_work_entries w JOIN projects p ON p.id=w.project_id LEFT JOIN assets a ON a.id=w.asset_id_snapshot WHERE w.client_id_snapshot=? AND w.work_date BETWEEN ? AND ? AND w.status IN ('Completed','Billed') AND NOT EXISTS (SELECT 1 FROM billing_project_lines bpl WHERE bpl.work_entry_id=w.id) ORDER BY w.work_date,p.project_no,w.id`, [clientId, periodFrom, periodTo]);
}

function billingTotals(trips, values, projectEntries = []) {
  const base = trips.reduce((sum, trip) => sum + numeric(trip.base_trip_rate), 0) + projectEntries.reduce((sum, entry) => sum + numeric(entry.base_charge), 0);
  const extra = trips.reduce((sum, trip) => sum + tripExtraTotal(trip), 0) + projectEntries.reduce((sum, entry) => sum + numeric(entry.extra_total), 0);
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
    expected_project_entry_ids: parseExpectedIds(data.expected_project_entry_ids),
  };
}

function validateBilling(cleaned, trips, projectEntries, totals) {
  const errors = [];
  if (!cleaned.client_id) errors.push("Client is required.");
  if (!cleaned.billing_date) errors.push("Billing date is required.");
  if (!cleaned.period_from || !cleaned.period_to) errors.push("Billing period is required.");
  if (cleaned.period_from && cleaned.period_to && cleaned.period_from > cleaned.period_to) errors.push("Period end must be on or after period start.");
  if (numeric(cleaned.addition_amount) < 0) errors.push("addition amount cannot be negative.");
  if (numeric(cleaned.deduction_amount) < 0) errors.push("deduction amount cannot be negative.");
  if (totals && totals.grand_total < 0) errors.push("Grand total cannot be negative.");
  if (!(trips?.length || projectEntries?.length)) errors.push("At least one eligible trip or completed project work entry is required.");
  const freshIds = (trips || []).map((trip) => Number(trip.id));
  if (JSON.stringify(freshIds) !== JSON.stringify(cleaned.expected_trip_ids)) errors.push("Billing eligibility changed. Preview the period again before saving.");
  const freshProjectIds = (projectEntries || []).map((entry) => Number(entry.id));
  if (JSON.stringify(freshProjectIds) !== JSON.stringify(cleaned.expected_project_entry_ids)) errors.push("Project work billing eligibility changed. Preview the period again before saving.");
  return errors;
}

function billingTripRows(trips) {
  const rows = trips.map((trip) => `<tr><td>${esc(trip.trip_date)}</td><td><a href="/trips/${trip.id}">${esc(trip.trip_ticket_no)}</a><small class="cell-detail">Ref. No.: ${esc(trip.reference_no || "—")}</small></td><td>${esc(trip.job_description || "")}</td><td>${esc(trip.origin || "")} → ${esc(trip.destination || "")}</td><td>${esc(trip.asset_code || "")}</td>${moneyCell(trip.base_trip_rate)}${moneyCell(tripExtraTotal(trip))}${moneyCell(tripBillableTotal(trip))}</tr>`);
  return table(["Date", "Trip Ticket / Waybill", "Item / Job", "Route", "Unit", "Base", "Extras", "Total"], rows, { empty: "No eligible unbilled trips for this client and period." });
}

function billingProjectRows(entries) {
  const rows = entries.map((entry) => `<tr><td>${esc(entry.work_date)}</td><td><a href="/projects/${entry.project_id}">${esc(entry.project_no)}</a><small class="cell-detail">Ref. No.: ${esc(entry.reference_no || "—")}</small></td><td>${esc(entry.job_description_snapshot || "")}</td><td>${esc(`${entry.billing_quantity} ${entry.billing_unit}`)}</td><td>${esc(entry.asset_code || "")}</td>${moneyCell(entry.client_unit_rate)}${moneyCell(entry.base_charge)}${moneyCell(entry.extra_total)}${moneyCell(entry.total_charge)}</tr>`);
  return table(["Work Date", "Project No.", "Item / Job", "Quantity", "Unit", "Rate", "Base", "Extras", "Total"], rows, { empty: "No eligible completed project work for this client and period. Open the Project, record Daily Work, then Mark Complete. The work date and client must match this billing period." });
}

function billingFormContent(clients, selection, trips, projectEntries = [], values = {}, errors = []) {
  const clientId = selection.client || values.client || values.client_id || "";
  const periodFrom = selection.period_from || values.period_from || `${todayISO().slice(0, 8)}01`;
  const periodTo = selection.period_to || values.period_to || todayISO();
  const cleaned = billingCleaned({ client: clientId, period_from: periodFrom, period_to: periodTo, ...values });
  const totals = billingTotals(trips || [], cleaned, projectEntries || []);
  const selector = `<section class="panel"><h3>1. Select Client & Period</h3><form method="get" class="selector-row">${selectInput("client", "Client", clients, clientId, (client) => choiceLabel("client", client), "Select client", { searchable: true, attrs: "required", quickCreate: { kind: "client" } })}<label>Period From<input type="date" name="period_from" value="${esc(periodFrom)}" required></label><label>Period To<input type="date" name="period_to" value="${esc(periodTo)}" required></label><button>Preview Billing</button></form></section>`;
  const errorBox = errors.length ? `<section class="panel"><ul class="error">${errors.map((err) => `<li>${esc(err)}</li>`).join("")}</ul></section>` : "";
  if (!clientId) return `${errorBox}${selector}<section class="panel empty-workspace"><p>Select a client and billing period to preview eligible trips.</p></section>`;
  const hidden = `<input type="hidden" name="client" value="${esc(clientId)}"><input type="hidden" name="period_from" value="${esc(periodFrom)}"><input type="hidden" name="period_to" value="${esc(periodTo)}"><input type="hidden" name="expected_trip_ids" value="${esc(JSON.stringify((trips || []).map((trip) => trip.id)))}"><input type="hidden" name="expected_project_entry_ids" value="${esc(JSON.stringify((projectEntries || []).map((entry) => entry.id)))}">`;
  const fields = [
    textInput("billing_date", "Billing date", values.billing_date || todayISO(), 'type="date" required'),
    `<label>VAT<input type="checkbox" name="vat_enabled" value="1"${cleaned.vat_enabled ? " checked" : ""}> Add 12% VAT</label>`,
    textInput("addition_label", "Addition label", values.addition_label || ""),
    numberInput("addition_amount", "Addition amount", values.addition_amount ?? 0),
    textInput("deduction_label", "Deduction label", values.deduction_label || ""),
    numberInput("deduction_amount", "Deduction amount", values.deduction_amount ?? 0),
    textareaInput("notes", "Notes", values.notes || "", 'rows="3"'),
  ];
  const summary = `<section class="panel">${cards([["Eligible Trips", String((trips || []).length)], ["Project Work", String((projectEntries || []).length)], ["Gross", peso(totals.gross_total)], ["VAT", peso(totals.vat_amount)], ["Grand Total", peso(totals.grand_total)]])}</section>`;
  return `${errorBox}${selector}${summary}<form method="post" action="/billing/new" class="panel">${hidden}<div class="grid">${fields.join("")}</div><p><button>Save Billing</button> <a class="button secondary" href="/billing">Cancel</a></p></form><section class="panel"><h3>Eligible Trips</h3></section>${billingTripRows(trips || [])}<section class="panel"><h3>Eligible Project Work</h3></section>${billingProjectRows(projectEntries || [])}`;
}

async function createdBillingId(env, billingNo) {
  const row = await first(env, "SELECT id FROM billing_statements WHERE billing_no=? LIMIT 1", [billingNo]);
  return row?.id;
}

async function saveBilling(env, cleaned, trips, projectEntries = []) {
  const totals = billingTotals(trips, cleaned, projectEntries);
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
  for (const entry of projectEntries) {
    await run(env, "INSERT INTO billing_project_lines (billing_id,work_entry_id,amount_base,amount_extra,amount_total) VALUES (?,?,?,?,?)", [billingId, entry.id, String(numeric(entry.base_charge)), String(numeric(entry.extra_total)), String(numeric(entry.total_charge))]);
    await run(env, "UPDATE project_work_entries SET status='Billed' WHERE id=?", [entry.id]);
  }
  if (numeric(cleaned.addition_amount)) await run(env, "INSERT INTO billing_adjustments (billing_id, line_type, label, amount, sort_order) VALUES (?,?,?,?,?)", [billingId, "Addition", cleaned.addition_label || "Addition", cleaned.addition_amount, 1]);
  if (numeric(cleaned.deduction_amount)) await run(env, "INSERT INTO billing_adjustments (billing_id, line_type, label, amount, sort_order) VALUES (?,?,?,?,?)", [billingId, "Deduction", cleaned.deduction_label || "Deduction", cleaned.deduction_amount, 2]);
  return billingId;
}

async function loadBillingEntry(env, id) {
  const entry = await first(env, "SELECT b.*, c.client_name, c.client_code, c.billing_address, c.contact_person FROM billing_statements b LEFT JOIN clients c ON c.id=b.client_id WHERE b.id=?", [id]);
  if (!entry) return null;
  entry.lines = await all(env, `SELECT bl.*, t.trip_date, t.trip_ticket_no, t.reference_no, t.job_description, t.origin, t.destination, a.asset_code FROM billing_lines bl JOIN trips t ON t.id=bl.trip_id LEFT JOIN assets a ON a.id=t.asset_id WHERE bl.billing_id=? ORDER BY t.trip_date, t.trip_ticket_no, t.id`, [id]);
  entry.project_lines = await all(env, `SELECT bpl.*,w.project_id,w.work_date,w.reference_no,w.billing_unit,w.billing_quantity,w.client_unit_rate,w.job_description_snapshot,w.origin_snapshot,w.destination_snapshot,p.project_no,a.asset_code FROM billing_project_lines bpl JOIN project_work_entries w ON w.id=bpl.work_entry_id JOIN projects p ON p.id=w.project_id LEFT JOIN assets a ON a.id=w.asset_id_snapshot WHERE bpl.billing_id=? ORDER BY w.work_date,p.project_no,w.id`, [id]);
  entry.adjustments = await all(env, "SELECT * FROM billing_adjustments WHERE billing_id=? ORDER BY sort_order, id", [id]);
  entry.collections = await all(env, "SELECT * FROM collections WHERE billing_id=? ORDER BY collection_date, id", [id]);
  entry.paid_amount = entry.collections.reduce((sum, row) => sum + numeric(row.amount_paid), 0);
  entry.balance = outstandingBalance(entry.grand_total, entry.paid_amount);
  entry.current_status = billingStatus(entry.grand_total, entry.paid_amount);
  return entry;
}

function billingDetailContent(entry, user, print = false) {
  const lineRows = (entry.lines || []).map((line) => `<tr><td>${esc(line.trip_date)}</td><td>${esc(line.trip_ticket_no)}<small class="cell-detail">Ref. No.: ${esc(line.reference_no || "—")}</small></td><td>${esc(line.job_description || "")}</td><td>${esc(line.origin || "")} → ${esc(line.destination || "")}</td><td>${esc(line.asset_code || "")}</td><td class="num">${esc(peso(line.amount_base))}</td><td class="num">${esc(peso(line.amount_extra))}</td><td class="num">${esc(peso(line.amount_total))}</td></tr>`);
  const projectLineRows = (entry.project_lines || []).map((line) => `<tr><td>${esc(line.work_date)}</td><td><a href="/projects/${line.project_id}">${esc(line.project_no)}</a><small class="cell-detail">Ref. No.: ${esc(line.reference_no || "—")}</small></td><td>${esc(line.job_description_snapshot || "")}</td><td>${esc(`${line.billing_quantity} ${line.billing_unit}`)}</td><td>${esc(line.asset_code || "")}</td><td class="num">${esc(peso(line.amount_base))}</td><td class="num">${esc(peso(line.amount_extra))}</td><td class="num">${esc(peso(line.amount_total))}</td></tr>`);
  const adjustmentRows = (entry.adjustments || []).map((row) => `<tr><td>${esc(row.line_type)}</td><td>${esc(row.label)}</td><td class="num">${esc(peso(row.amount))}</td></tr>`);
  const collectionRows = (entry.collections || []).map((row) => `<tr><td>${esc(row.collection_date)}</td><td>${esc(row.reference_no || "")}</td><td>${esc(row.payment_method || "")}</td><td class="num">${esc(peso(row.amount_paid))}</td></tr>`);
  if (print) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(entry.billing_no)} · Billing</title><style>@page{size:A4 portrait;margin:12mm}body{font-family:Arial,sans-serif;font-size:12px;color:#111}.top{display:flex;justify-content:space-between;gap:24px}h1,h2{margin:0 0 6px}.muted{color:#555}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border:1px solid #222;padding:6px;vertical-align:top}th{background:#f1f1f1}.num{text-align:right;white-space:nowrap}.totals{margin-left:auto;width:320px}.signatures{display:grid;grid-template-columns:1fr 1fr;gap:60px;margin-top:48px}.sig{border-top:1px solid #111;text-align:center;padding-top:6px}.print-button{margin-bottom:10px}@media print{.print-button{display:none}}</style></head><body><button class="print-button" onclick="window.print()">Print</button><div class="top"><div><h1>GMT Trucking</h1><h2>Billing Statement</h2><p><strong>Client:</strong> ${esc(entry.client_name || "")}<br><strong>Address:</strong> ${esc(entry.billing_address || "")}<br><strong>Period:</strong> ${esc(entry.period_from || "")} to ${esc(entry.period_to || "")}</p></div><div><h2>${esc(entry.billing_no)}</h2><p><strong>Date:</strong> ${esc(entry.billing_date)}<br><strong>Status:</strong> ${esc(entry.current_status)}</p></div></div><table><thead><tr><th>Date</th><th>Trip Ticket / Waybill</th><th>Item / Job</th><th>Route</th><th>Unit</th><th>Base</th><th>Extras</th><th>Total</th></tr></thead><tbody>${lineRows.join("")}</tbody></table>${adjustmentRows.length ? `<table><thead><tr><th>Type</th><th>Adjustment</th><th>Amount</th></tr></thead><tbody>${adjustmentRows.join("")}</tbody></table>` : ""}<table class="totals"><tr><td>Gross</td><td class="num">${esc(peso(entry.gross_total))}</td></tr><tr><td>VAT</td><td class="num">${esc(peso(entry.vat_amount))}</td></tr><tr><td>Additions</td><td class="num">${esc(peso(entry.additions_total))}</td></tr><tr><td>Deductions</td><td class="num">${esc(peso(entry.deductions_total))}</td></tr><tr><th>Grand Total</th><th class="num">${esc(peso(entry.grand_total))}</th></tr><tr><td>Payments</td><td class="num">${esc(peso(entry.paid_amount))}</td></tr><tr><th>Balance</th><th class="num">${esc(peso(entry.balance))}</th></tr></table><div class="signatures"><div class="sig">Prepared by</div><div class="sig">Received by / Conforme</div></div></body></html>`;
  }
  const actions = `<div class="detail-toolbar"><a class="button secondary" href="/billing">← Billing List</a><div><a class="button secondary" href="/billing/${entry.id}/print" target="_blank">Print Billing</a></div></div>`;
  const hero = `<section class="panel detail-hero"><div><span class="dialog-kicker">Billing Statement</span><h3>${esc(entry.billing_no)}</h3><p>${esc(entry.client_name || "")} · ${esc(entry.billing_date)} · ${esc(entry.period_from || "")} to ${esc(entry.period_to || "")}</p></div><strong>${esc(peso(entry.balance))}</strong></section>`;
  const summary = `<section class="panel">${cards([["Gross", peso(entry.gross_total)], ["VAT", peso(entry.vat_amount)], ["Grand Total", peso(entry.grand_total)], ["Paid", peso(entry.paid_amount)], ["Balance", peso(entry.balance)], ["Status", entry.current_status]])}</section>`;
  const projectSection = `<section class="panel"><h3>Project Work</h3></section>${table(["Work Date", "Project No.", "Item / Job", "Quantity", "Unit", "Base", "Extras", "Total"], projectLineRows, { empty: "No project-work billing lines." })}`;
  const deleteForm = `${projectSection}${canEdit(user, "Billing") ? `<section class="detail-danger"><form method="post" action="/billing/${entry.id}/delete" onsubmit="return confirm('Delete this billing statement? This is blocked when collections exist.');"><button class="danger-button">Delete Billing</button></form></section>` : ""}`;
  return `${actions}${hero}${summary}<section class="panel"><h3>Trips</h3></section>${table(["Date", "Trip Ticket / Waybill", "Item / Job", "Route", "Unit", "Base", "Extras", "Total"], lineRows, { empty: "No billing lines." })}<section class="panel"><h3>Adjustments</h3></section>${table(["Type", "Label", "Amount"], adjustmentRows, { empty: "No adjustments." })}<section class="panel"><h3>Collections</h3></section>${table(["Date", "Reference", "Method", "Amount"], collectionRows, { empty: "No collections recorded." })}${entry.notes ? `<section class="panel"><h3>Notes</h3><p>${esc(entry.notes)}</p></section>` : ""}${deleteForm}`;
}

function billingPrintable(entry, settings) {
  const lineRows = (entry.lines || []).map((line) => `<tr><td>${esc(line.trip_date)}</td><td>${esc(line.trip_ticket_no)}<br><small>Ref. No.: ${esc(line.reference_no || "—")}</small></td><td>${esc(line.job_description || "")}</td><td>${esc(line.origin || "")} → ${esc(line.destination || "")}</td><td>${esc(line.asset_code || "")}</td><td class="num">${esc(peso(line.amount_base))}</td><td class="num">${esc(peso(line.amount_extra))}</td><td class="num">${esc(peso(line.amount_total))}</td></tr>`).join("") || `<tr><td colspan="8">No billing lines.</td></tr>`;
  const adjustmentRows = (entry.adjustments || []).map((row) => `<tr><td>${esc(row.line_type)}</td><td>${esc(row.label)}</td><td class="num">${esc(peso(row.amount))}</td></tr>`).join("");
  const printableProjectRows = (entry.project_lines || []).map((line) => `<tr><td>${esc(line.work_date)}</td><td>${esc(line.project_no)}</td><td>${esc(line.reference_no || "—")}</td><td>${esc(line.job_description_snapshot || "")}</td><td>${esc(`${line.billing_quantity} ${line.billing_unit}`)}</td><td>${esc(line.asset_code || "")}</td><td class="num">${esc(peso(line.amount_base))}</td><td class="num">${esc(peso(line.amount_extra))}</td><td class="num">${esc(peso(line.amount_total))}</td></tr>`).join("");
  const printableProjectTable = printableProjectRows ? `<h3>Equipment Project Work</h3><table><thead><tr><th>Work Date</th><th>Project No.</th><th>Ref. No.</th><th>Item / Job</th><th>Quantity</th><th>Unit</th><th>Base</th><th>Extras</th><th>Total</th></tr></thead><tbody>${printableProjectRows}</tbody></table>` : "";
  const footer = `${printableProjectTable}${settings.billing_footer_note ? `<p class="footer-note">${esc(settings.billing_footer_note)}</p>` : ""}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(entry.billing_no)} · Billing</title><style>@page{size:A4 portrait;margin:12mm}body{font-family:Arial,sans-serif;font-size:12px;color:#111}.top{display:flex;justify-content:space-between;gap:24px}h1,h2{margin:0 0 6px}.company-lines{margin:4px 0 0;line-height:1.35}.muted{color:#555}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border:1px solid #222;padding:6px;vertical-align:top}th{background:#f1f1f1}.num{text-align:right;white-space:nowrap}.totals{margin-left:auto;width:320px}.footer-note{margin-top:18px;white-space:pre-wrap}.signatures{display:grid;grid-template-columns:1fr 1fr;gap:60px;margin-top:48px}.sig{border-top:1px solid #111;text-align:center;padding-top:6px}.print-button{margin-bottom:10px}@media print{.print-button{display:none}}</style></head><body><button class="print-button" onclick="window.print()">Print</button><div class="top"><div>${companyHeader(settings, "Billing Statement")}<p><strong>Client:</strong> ${esc(entry.client_name || "")}<br><strong>Address:</strong> ${esc(entry.billing_address || "")}<br><strong>Period:</strong> ${esc(entry.period_from || "")} to ${esc(entry.period_to || "")}</p></div><div><h2>${esc(entry.billing_no)}</h2><p><strong>Date:</strong> ${esc(entry.billing_date)}<br><strong>Status:</strong> ${esc(entry.current_status)}</p></div></div><table><thead><tr><th>Date</th><th>Trip Ticket / Waybill</th><th>Item / Job</th><th>Route</th><th>Unit</th><th>Base</th><th>Extras</th><th>Total</th></tr></thead><tbody>${lineRows}</tbody></table>${adjustmentRows ? `<table><thead><tr><th>Type</th><th>Adjustment</th><th>Amount</th></tr></thead><tbody>${adjustmentRows}</tbody></table>` : ""}<table class="totals"><tr><td>Gross</td><td class="num">${esc(peso(entry.gross_total))}</td></tr><tr><td>VAT</td><td class="num">${esc(peso(entry.vat_amount))}</td></tr><tr><td>Additions</td><td class="num">${esc(peso(entry.additions_total))}</td></tr><tr><td>Deductions</td><td class="num">${esc(peso(entry.deductions_total))}</td></tr><tr><th>Grand Total</th><th class="num">${esc(peso(entry.grand_total))}</th></tr><tr><td>Payments</td><td class="num">${esc(peso(entry.paid_amount))}</td></tr><tr><th>Balance</th><th class="num">${esc(peso(entry.balance))}</th></tr></table>${footer}<div class="signatures"><div class="sig">${signatureLabel(settings.prepared_by_default, "Prepared by")}</div><div class="sig">Received by / Conforme</div></div></body></html>`;
}

function billingPrintableDocument(entry, settings) {
  const lineRows = (entry.lines || []).map((line) => `<tr><td>${esc(line.trip_date)}</td><td>${esc(line.trip_ticket_no)}</td><td>${esc(line.reference_no || "—")}</td><td>${esc(line.job_description || "")}</td><td>${esc(line.origin || "")} → ${esc(line.destination || "")}</td><td>${esc(line.asset_code || "")}</td><td class="num">${esc(peso(line.amount_base))}</td><td class="num">${esc(peso(line.amount_extra))}</td><td class="num">${esc(peso(line.amount_total))}</td></tr>`).join("") || `<tr><td colspan="9">No billing lines.</td></tr>`;
  const adjustmentRows = (entry.adjustments || []).map((row) => `<tr><td>${esc(row.line_type)}</td><td>${esc(row.label)}</td><td class="num">${esc(peso(row.amount))}</td></tr>`).join("");
  const printableProjectRows = (entry.project_lines || []).map((line) => `<tr><td>${esc(line.work_date)}</td><td>${esc(line.project_no)}</td><td>${esc(line.reference_no || "—")}</td><td>${esc(line.job_description_snapshot || "")}</td><td>${esc(`${line.billing_quantity} ${line.billing_unit}`)}</td><td>${esc(line.asset_code || "")}</td><td class="num">${esc(peso(line.amount_base))}</td><td class="num">${esc(peso(line.amount_extra))}</td><td class="num">${esc(peso(line.amount_total))}</td></tr>`).join("");
  const printableProjectTable = printableProjectRows ? `<h3>Equipment Project Work</h3><table><thead><tr><th>Work Date</th><th>Project No.</th><th>Ref. No.</th><th>Item / Job</th><th>Quantity</th><th>Unit</th><th>Base</th><th>Extras</th><th>Total</th></tr></thead><tbody>${printableProjectRows}</tbody></table>` : "";
  const footer = settings.billing_footer_note ? `<p class="footer-note">${esc(settings.billing_footer_note)}</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(entry.billing_no)} · Billing</title><style>${customerPrintStyles("A4 portrait")}</style></head><body><button class="print-button" onclick="window.print()">Print</button><div class="document-sheet"><div class="document-header"><div>${companyHeader(settings, "Billing Statement")}<p><strong>Client:</strong> ${esc(entry.client_name || "")}<br><strong>Address:</strong> ${esc(entry.billing_address || "")}<br><strong>Period:</strong> ${esc(entry.period_from || "")} to ${esc(entry.period_to || "")}</p></div><div class="document-meta"><h2>${esc(entry.billing_no)}</h2><p><strong>Date:</strong> ${esc(entry.billing_date)}<br><strong>Status:</strong> ${esc(entry.current_status)}</p></div></div><table><thead><tr><th>Date</th><th>Trip Ticket / Waybill</th><th>Ref. No.</th><th>Item / Job</th><th>Route</th><th>Unit</th><th>Base</th><th>Extras</th><th>Total</th></tr></thead><tbody>${lineRows}</tbody></table>${printableProjectTable}${adjustmentRows ? `<table><thead><tr><th>Type</th><th>Adjustment</th><th>Amount</th></tr></thead><tbody>${adjustmentRows}</tbody></table>` : ""}<table class="totals"><tr><td>Gross</td><td class="num">${esc(peso(entry.gross_total))}</td></tr><tr><td>VAT</td><td class="num">${esc(peso(entry.vat_amount))}</td></tr><tr><td>Additions</td><td class="num">${esc(peso(entry.additions_total))}</td></tr><tr><td>Deductions</td><td class="num">${esc(peso(entry.deductions_total))}</td></tr><tr><th>Grand Total</th><th class="num">${esc(peso(entry.grand_total))}</th></tr><tr><td>Payments</td><td class="num">${esc(peso(entry.paid_amount))}</td></tr><tr><th>Balance</th><th class="num">${esc(peso(entry.balance))}</th></tr></table>${footer}<div class="signatures two"><div>${signatureLabel(settings.prepared_by_default, "Prepared by")}</div><div>Received by / Conforme</div></div></div></body></html>`;
}

async function billingListPage(request, env, user, path) {
  const access = requireView(user, "Billing");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const filters = { client_id: idParam(url, "client_id"), status: enumParam(url, "status", ["Open", "Partially Paid", "Paid"]), ...rangeParams(url) };
  const clauses = [];
  const filterParams = [];
  addEqualityFilters(clauses, filterParams, [["b.client_id", filters.client_id], ["b.status", filters.status]]);
  addDateRange(clauses, filterParams, "b.billing_date", filters);
  const where = mergeWhere(billingWhere(query), clauses, filterParams);
  const sort = listSort(url, { billing: { sql: "b.billing_no", tie: "b.id ASC" }, date: { sql: "b.billing_date", defaultDir: "desc", tie: "b.id DESC" }, client: { sql: "c.client_name", tie: "b.id ASC" }, total: { sql: "b.grand_total", defaultDir: "desc", tie: "b.id DESC" }, paid: { sql: "paid_amount", defaultDir: "desc", tie: "b.id DESC" }, balance: { sql: "(b.grand_total-COALESCE((SELECT SUM(amount_paid) FROM collections co WHERE co.billing_id=b.id),0)", defaultDir: "desc", tie: "b.id DESC" }, status: { sql: "b.status", tie: "b.id ASC" } }, "b.billing_date DESC, b.id DESC");
  const countRow = await first(env, `SELECT COUNT(*) AS total FROM billing_statements b LEFT JOIN clients c ON c.id=b.client_id${where.sql}`, where.params);
  const rows = await all(env, `SELECT b.*, c.client_name, COALESCE((SELECT SUM(amount_paid) FROM collections co WHERE co.billing_id=b.id),0) AS paid_amount FROM billing_statements b LEFT JOIN clients c ON c.id=b.client_id${where.sql} ORDER BY ${sort.order} LIMIT 25 OFFSET ?`, [...where.params, (page - 1) * 25]);
  const body = rows.map((row) => {
    const paid = numeric(row.paid_amount);
    const balance = outstandingBalance(row.grand_total, paid);
    const status = billingStatus(row.grand_total, paid);
    return `<tr><td><a href="/billing/${row.id}">${esc(row.billing_no)}</a></td><td>${esc(row.billing_date)}</td><td>${esc(row.client_name || "")}</td><td>${esc(row.period_from || "")} – ${esc(row.period_to || "")}</td>${moneyCell(row.grand_total)}${moneyCell(paid)}${moneyCell(balance)}<td><span class="status">${esc(status)}</span></td><td><a href="/billing/${row.id}">View</a> <a href="/billing/${row.id}/print" target="_blank">Print</a></td></tr>`;
  });
  const params = listParams(url, ["q", "client_id", "status", "date_from", "date_to"], { sort });
  const clients = await billingClients(env);
  const filterMarkup = [selectFilter("client_id", "Client", clients.map((row) => ({ value: row.id, label: choiceLabel("client", row) })), filters.client_id), selectFilter("status", "Status", ["Open", "Partially Paid", "Paid"], filters.status), dateFilter("date_from", "Billing date from", filters.from), dateFilter("date_to", "Billing date to", filters.to)].join("");
  const toolbar = listToolbar({ query, placeholder: "Search billing", filters: filterMarkup, clearHref: "/billing", actions: `<a class="button secondary" href="/billing/soa">Statement of Account</a> ${canEdit(user, "Billing") ? `<a class="button" href="/billing/new">New Billing</a>` : ""} <a class="button secondary" href="${esc(`/billing/export.csv${params.toString() ? `?${params.toString()}` : ""}`)}">Export CSV</a>` });
  const headers = [...sortableHeaders([{ label: "Billing No.", sort: "billing" }, { label: "Date", sort: "date" }, { label: "Client", sort: "client" }, { label: "Period" }, { label: "Grand Total", sort: "total" }, { label: "Paid", sort: "paid" }, { label: "Balance", sort: "balance" }, { label: "Status", sort: "status" }], sort, params), "Actions"];
  const content = `${messagePanel(url)}<section class="panel">${toolbar}</section>${table(headers, body, { empty: "No billing statements found." })}${paginationWithParams("/billing", params, page, Number(countRow?.total || 0))}`;
  return html(layout({ title: "Billing", user, path, content }));
}

async function billingNewPage(request, env, user, path) {
  const access = requireEdit(user, "Billing");
  if (access) return errorResponse(access, user, path);
  const clients = await billingClients(env);
  const settings = await loadSettings(env);
  const source = request.method === "POST" ? await parseForm(request) : Object.fromEntries(new URL(request.url).searchParams.entries());
  const selection = { client: source.client || "", period_from: source.period_from || `${todayISO().slice(0, 8)}01`, period_to: source.period_to || todayISO() };
  const trips = selection.client ? await billingEligibleTrips(env, selection.client, selection.period_from, selection.period_to) : [];
  const projectEntries = selection.client ? await billingEligibleProjectWork(env, selection.client, selection.period_from, selection.period_to) : [];
  const initialValues = request.method === "POST" ? source : { vat_enabled: settings.default_vat_enabled === "1" ? "1" : "" };
  if (request.method === "POST") {
    const cleaned = billingCleaned(source);
    const totals = billingTotals(trips, cleaned, projectEntries);
    const errors = validateBilling(cleaned, trips, projectEntries, totals);
    if (errors.length) return html(layout({ title: "New Billing", user, path, content: billingFormContent(clients, selection, trips, projectEntries, source, errors) }), 400);
    const id = await saveBilling(env, cleaned, trips, projectEntries);
    return redirect(`/billing/${id}?ok=${encodeURIComponent("Billing statement saved; trips and project work were marked billed.")}`);
  }
  return html(layout({ title: "New Billing", user, path, content: billingFormContent(clients, selection, trips, projectEntries, initialValues) }));
}

async function billingDetailPage(request, env, user, path, id, print = false) {
  const access = requireView(user, "Billing");
  if (access) return errorResponse(access, user, path);
  const entry = await loadBillingEntry(env, id);
  if (!entry) return html("Not found", 404);
  if (print) return html(billingPrintableDocument(entry, await loadSettings(env)));
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
  const projectLines = await all(env, "SELECT work_entry_id FROM billing_project_lines WHERE billing_id=?", [id]);
  for (const line of projectLines) await run(env, "UPDATE project_work_entries SET status='Completed' WHERE id=?", [line.work_entry_id]);
  await run(env, "DELETE FROM billing_statements WHERE id=?", [id]);
  return redirect(`/billing?ok=${encodeURIComponent("Billing deleted; trips and project work were restored to Completed.")}`);
}

async function billingExportPage(request, env, user, path) {
  const access = requireView(user, "Billing");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const filters = { client_id: idParam(url, "client_id"), status: enumParam(url, "status", ["Open", "Partially Paid", "Paid"]), ...rangeParams(url) };
  const clauses = [];
  const params = [];
  addEqualityFilters(clauses, params, [["b.client_id", filters.client_id], ["b.status", filters.status]]);
  addDateRange(clauses, params, "b.billing_date", filters);
  const where = mergeWhere(billingWhere((url.searchParams.get("q") || "").trim()), clauses, params);
  const sort = listSort(url, { billing: { sql: "b.billing_no", tie: "b.id ASC" }, date: { sql: "b.billing_date", defaultDir: "desc", tie: "b.id DESC" }, client: { sql: "c.client_name", tie: "b.id ASC" }, total: { sql: "b.grand_total", defaultDir: "desc", tie: "b.id DESC" }, paid: { sql: "paid_amount", defaultDir: "desc", tie: "b.id DESC" }, balance: { sql: "(b.grand_total-COALESCE((SELECT SUM(amount_paid) FROM collections co WHERE co.billing_id=b.id),0)", defaultDir: "desc", tie: "b.id DESC" }, status: { sql: "b.status", tie: "b.id ASC" } }, "b.billing_date DESC, b.id DESC");
  const rows = await all(env, `SELECT b.*, c.client_name, COALESCE((SELECT SUM(amount_paid) FROM collections co WHERE co.billing_id=b.id),0) AS paid_amount FROM billing_statements b LEFT JOIN clients c ON c.id=b.client_id${where.sql} ORDER BY ${sort.order}`, where.params);
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
  return `<section class="panel"><h3>Statement of Account</h3><form class="selector-row" method="get" action="/billing/soa">${selectInput("client", "Client", clients, filters.client_id, (client) => choiceLabel("client", client), "Select client", { searchable: true, attrs: "required", quickCreate: { kind: "client" } })}<label>Mode<select name="mode"><option value="outstanding"${filters.mode === "outstanding" ? " selected" : ""}>Outstanding Only</option><option value="all"${filters.mode === "all" ? " selected" : ""}>All Activity</option></select></label><label>As-of date<input type="date" name="as_of" value="${esc(filters.as_of)}" required></label><label>Date from<input type="date" name="date_from" value="${esc(filters.date_from)}"></label><label>Date to<input type="date" name="date_to" value="${esc(filters.date_to)}"></label><button>Generate SOA</button></form></section>`;
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

function soaPrintableWithSettings(client, filters, rows, settings) {
  const totals = soaTotals(rows);
  const period = `${filters.date_from || "Beginning"} to ${filters.date_to || "Current"}`;
  const body = rows.map((row) => `<tr><td>${esc(row.billing_no)}</td><td>${esc(row.billing_date)}</td><td>${esc(row.period_from || "")} to ${esc(row.period_to || "")}</td><td class="num">${esc(peso(row.grand_total))}</td><td class="num">${esc(peso(row.paid_as_of))}</td><td class="num">${esc(peso(row.balance_as_of))}</td><td>${esc(row.status_as_of)}</td></tr>`).join("") || `<tr><td colspan="7">No SOA rows found for the selected filters.</td></tr>`;
  const footer = settings.soa_footer_note ? `<p class="footer-note">${esc(settings.soa_footer_note)}</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Statement of Account · GMT</title><style>@page{size:A4 portrait;margin:12mm}body{font-family:Arial,sans-serif;font-size:12px;color:#111}.top{display:flex;justify-content:space-between;gap:24px}h1,h2{margin:0 0 6px}.company-lines{margin:4px 0 0;line-height:1.35}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #222;padding:6px;vertical-align:top}th{background:#f1f1f1}.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.totals{margin-left:auto;width:330px}.footer-note{margin-top:18px;white-space:pre-wrap}.signatures{display:grid;grid-template-columns:1fr 1fr 1fr;gap:32px;margin-top:56px}.sig{border-top:1px solid #111;text-align:center;padding-top:6px}.print-button{margin-bottom:10px}@media print{.print-button{display:none}}</style></head><body><button class="print-button" onclick="window.print()">Print</button><div class="top"><div>${companyHeader(settings, "Statement of Account")}<p><strong>Client:</strong> ${esc(client?.client_name || "")}<br><strong>Code:</strong> ${esc(client?.client_code || "")}<br><strong>Address:</strong> ${esc(client?.billing_address || "")}</p></div><div><p><strong>As-of date:</strong> ${esc(filters.as_of)}<br><strong>Period:</strong> ${esc(period)}<br><strong>Mode:</strong> ${filters.mode === "all" ? "All Activity" : "Outstanding Only"}</p></div></div><table><thead><tr><th>Billing No.</th><th>Billing Date</th><th>Billing Period</th><th>Grand Total</th><th>Payments</th><th>Balance</th><th>Status</th></tr></thead><tbody>${body}</tbody></table><table class="totals"><tr><td>Total Billed</td><td class="num">${esc(peso(totals.billed))}</td></tr><tr><td>Total Payments</td><td class="num">${esc(peso(totals.paid))}</td></tr><tr><th>Total Balance</th><th class="num">${esc(peso(totals.balance))}</th></tr></table>${footer}<div class="signatures"><div class="sig">${signatureLabel(settings.prepared_by_default, "Prepared by")}</div><div class="sig">${signatureLabel(settings.checked_by_default, "Checked by")}</div><div class="sig">Received/Conforme</div></div></body></html>`;
}

function soaPrintableDocument(client, filters, rows, settings) {
  const totals = soaTotals(rows);
  const period = `${filters.date_from || "Beginning"} to ${filters.date_to || "Current"}`;
  const body = rows.map((row) => `<tr><td>${esc(row.billing_no)}</td><td>${esc(row.billing_date)}</td><td>${esc(row.period_from || "")} to ${esc(row.period_to || "")}</td><td class="num">${esc(peso(row.grand_total))}</td><td class="num">${esc(peso(row.paid_as_of))}</td><td class="num">${esc(peso(row.balance_as_of))}</td><td>${esc(row.status_as_of)}</td></tr>`).join("") || `<tr><td colspan="7">No SOA rows found for the selected filters.</td></tr>`;
  const footer = settings.soa_footer_note ? `<p class="footer-note">${esc(settings.soa_footer_note)}</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Statement of Account · GMT</title><style>${customerPrintStyles("A4 portrait")}</style></head><body><button class="print-button" onclick="window.print()">Print</button><div class="document-sheet"><div class="document-header"><div>${companyHeader(settings, "Statement of Account")}<p><strong>Client:</strong> ${esc(client?.client_name || "")}<br><strong>Code:</strong> ${esc(client?.client_code || "")}<br><strong>Address:</strong> ${esc(client?.billing_address || "")}</p></div><div class="document-meta"><p><strong>As-of date:</strong> ${esc(filters.as_of)}<br><strong>Period:</strong> ${esc(period)}<br><strong>Mode:</strong> ${filters.mode === "all" ? "All Activity" : "Outstanding Only"}</p></div></div><table><thead><tr><th>Billing No.</th><th>Billing Date</th><th>Billing Period</th><th>Grand Total</th><th>Payments</th><th>Balance</th><th>Status</th></tr></thead><tbody>${body}</tbody></table><table class="totals"><tr><td>Total Billed</td><td class="num">${esc(peso(totals.billed))}</td></tr><tr><td>Total Payments</td><td class="num">${esc(peso(totals.paid))}</td></tr><tr><th>Total Balance</th><th class="num">${esc(peso(totals.balance))}</th></tr></table>${footer}<div class="signatures three"><div>${signatureLabel(settings.prepared_by_default, "Prepared by")}</div><div>${signatureLabel(settings.checked_by_default, "Checked by")}</div><div>Received/Conforme</div></div></div></body></html>`;
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
  if (print) return html(soaPrintableDocument(client, filters, rows, await loadSettings(env)));
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
  const billingSelect = selectInput("billing_id", "Billing Statement", billings, row.billing_id || "", (billing) => choiceLabel("billing", {
    ...billing,
    status: billingStatus(billing.grand_total, numeric(billing.paid_amount)),
  }), "Select billing", { searchable: true, attrs: "required" });
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
  return `${errorBox}${summary}${formPanel(id ? `/collections/${id}/edit` : "/collections/new", fields, "Save Collection", { cancelHref: "/collections" })}${deleteForm}`;
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

async function collectionsListContent(request, env, user, path) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const filters = { client_id: idParam(url, "client_id"), billing_id: idParam(url, "billing_id"), payment_method: String(url.searchParams.get("payment_method") || "").trim(), ...rangeParams(url) };
  const methods = ["Cash", "Check", "Bank Transfer", "Online Transfer", "Other"];
  if (!methods.includes(filters.payment_method)) filters.payment_method = "";
  const clauses = [];
  const filterParams = [];
  addEqualityFilters(clauses, filterParams, [["co.client_id", filters.client_id], ["co.billing_id", filters.billing_id], ["co.payment_method", filters.payment_method]]);
  addDateRange(clauses, filterParams, "co.collection_date", filters);
  const where = mergeWhere(collectionWhere(query), clauses, filterParams);
  const sort = listSort(url, { date: { sql: "co.collection_date", defaultDir: "desc", tie: "co.id DESC" }, billing: { sql: "b.billing_no", tie: "co.id ASC" }, client: { sql: "c.client_name", tie: "co.id ASC" }, amount: { sql: "co.amount_paid", defaultDir: "desc", tie: "co.id DESC" }, reference: { sql: "co.reference_no", tie: "co.id ASC" }, method: { sql: "co.payment_method", tie: "co.id ASC" } }, "co.collection_date DESC, co.id DESC");
  const countRow = await first(env, `SELECT COUNT(*) AS total FROM collections co LEFT JOIN billing_statements b ON b.id=co.billing_id LEFT JOIN clients c ON c.id=co.client_id${where.sql}`, where.params);
  const rows = await all(env, `SELECT co.*, b.billing_no, c.client_name FROM collections co LEFT JOIN billing_statements b ON b.id=co.billing_id LEFT JOIN clients c ON c.id=co.client_id${where.sql} ORDER BY ${sort.order} LIMIT 25 OFFSET ?`, [...where.params, (page - 1) * 25]);
  const body = rows.map((row) => `<tr><td>${esc(row.collection_date)}</td><td><a href="/billing/${row.billing_id}">${esc(row.billing_no || "")}</a></td><td>${esc(row.client_name || "")}</td>${moneyCell(row.amount_paid)}<td>${esc(row.reference_no || "")}</td><td>${esc(row.payment_method || "")}</td><td>${canEdit(user, "Collections") ? `<a href="/collections/${row.id}/edit">Edit</a>` : "—"}</td></tr>`);
  const params = listParams(url, ["q", "client_id", "billing_id", "payment_method", "date_from", "date_to"], { sort });
  const [clients, billings] = await Promise.all([billingClients(env), billingChoices(env)]);
  const filterMarkup = [selectFilter("client_id", "Client", clients.map((row) => ({ value: row.id, label: choiceLabel("client", row) })), filters.client_id), selectFilter("billing_id", "Billing", billings.map((row) => ({ value: row.id, label: choiceLabel("billing", row) })), filters.billing_id), selectFilter("payment_method", "Method", methods, filters.payment_method), dateFilter("date_from", "Date from", filters.from), dateFilter("date_to", "Date to", filters.to)].join("");
  const toolbar = listToolbar({ query, placeholder: "Search collections", filters: filterMarkup, clearHref: "/collections", actions: `${canEdit(user, "Collections") ? `<a class="button" href="/collections/new">New Collection</a>` : ""} <a class="button secondary" href="${esc(`/collections/export.csv${params.toString() ? `?${params.toString()}` : ""}`)}">Export CSV</a>` });
  const headers = [...sortableHeaders([{ label: "Date", sort: "date" }, { label: "Billing No.", sort: "billing" }, { label: "Client", sort: "client" }, { label: "Amount", sort: "amount" }, { label: "Reference", sort: "reference" }, { label: "Method", sort: "method" }], sort, params), "Actions"];
  return `${messagePanel(url)}<section class="panel">${toolbar}</section>${table(headers, body, { empty: "No collections found." })}${paginationWithParams("/collections", params, page, Number(countRow?.total || 0))}`;
}

async function collectionsPage(request, env, user, path) {
  const access = requireView(user, "Collections");
  if (access) return errorResponse(access, user, path);
  return html(layout({ title: "Collections", user, path, content: await collectionsListContent(request, env, user, path) }));
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
    if (errors.length) return html(layout({ title: "Collections", user, path, content: `${await collectionsListContent(request, env, user, path)}${dialogShell({ title: id ? "Edit Collection" : "New Collection", subtitle: "Payment record", body: await collectionFormContent(env, { ...source, ...values }, errors, id), closeHref: "/collections", wide: false })}` }), 400);
    values.client_id = billing.client_id;
    if (id) await run(env, "UPDATE collections SET collection_date=?, client_id=?, billing_id=?, amount_paid=?, reference_no=?, payment_method=?, notes=? WHERE id=?", [values.collection_date, values.client_id, values.billing_id, values.amount_paid, values.reference_no, values.payment_method, values.notes, id]);
    else await run(env, "INSERT INTO collections (collection_date, client_id, billing_id, amount_paid, reference_no, payment_method, notes) VALUES (?,?,?,?,?,?,?)", [values.collection_date, values.client_id, values.billing_id, values.amount_paid, values.reference_no, values.payment_method, values.notes]);
    await recalcBillingStatus(env, values.billing_id);
    if (id && original.billing_id && String(original.billing_id) !== String(values.billing_id)) await recalcBillingStatus(env, original.billing_id);
    return redirect(`/collections?ok=${encodeURIComponent("Collection saved and billing balance recalculated.")}`);
  }
  return html(layout({ title: "Collections", user, path, content: `${await collectionsListContent(request, env, user, path)}${dialogShell({ title: id ? "Edit Collection" : "New Collection", subtitle: "Payment record", body: await collectionFormContent(env, source, [], id), closeHref: "/collections", wide: false })}` }));
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
  const url = new URL(request.url);
  const filters = { client_id: idParam(url, "client_id"), billing_id: idParam(url, "billing_id"), payment_method: enumParam(url, "payment_method", ["Cash", "Check", "Bank Transfer", "Online Transfer", "Other"]), ...rangeParams(url) };
  const clauses = [];
  const params = [];
  addEqualityFilters(clauses, params, [["co.client_id", filters.client_id], ["co.billing_id", filters.billing_id], ["co.payment_method", filters.payment_method]]);
  addDateRange(clauses, params, "co.collection_date", filters);
  const where = mergeWhere(collectionWhere((url.searchParams.get("q") || "").trim()), clauses, params);
  const sort = listSort(url, { date: { sql: "co.collection_date", defaultDir: "desc", tie: "co.id DESC" }, billing: { sql: "b.billing_no", tie: "co.id ASC" }, client: { sql: "c.client_name", tie: "co.id ASC" }, amount: { sql: "co.amount_paid", defaultDir: "desc", tie: "co.id DESC" }, reference: { sql: "co.reference_no", tie: "co.id ASC" }, method: { sql: "co.payment_method", tie: "co.id ASC" } }, "co.collection_date DESC, co.id DESC");
  const rows = await all(env, `SELECT co.*, b.billing_no, c.client_name FROM collections co LEFT JOIN billing_statements b ON b.id=co.billing_id LEFT JOIN clients c ON c.id=co.client_id${where.sql} ORDER BY ${sort.order}`, where.params);
  const lines = ["Collection ID,Collection Date,Billing No.,Client,Amount Paid,Reference No.,Payment Method,Notes"];
  for (const row of rows) lines.push(quotedCsvRow([row.id, row.collection_date, row.billing_no || "", row.client_name || "", row.amount_paid, row.reference_no || "", row.payment_method || "", row.notes || ""]));
  return csv(lines.join("\n"), "collections.csv");
}

const REPORTS = [
  ["this_month_trips", "This Month's Trips", "Trips within the current month, or the selected date range."],
  ["ongoing_trips", "Ongoing Trips", "Trips currently marked Ongoing."],
  ["completed_trips", "Completed Trips", "Completed trips, including their base rates."],
  ["unbilled_trips", "Unbilled Trips", "Completed trips that have not been claimed by billing."],
  ["billing_summary", "Billing Summary", "Saved billing statements and their current statuses."],
  ["receivables_summary", "Receivables Summary", "Billing totals compared with remaining receivable balances."],
  ["payables_summary", "Payables Summary", "Supplier obligations, due dates, and payment statuses."],
  ["vale_balance", "Vale Balance Report", "Vale amounts, payroll installments, and remaining balances."],
  ["cash_advance_balance", "Cash Advance Balance Report", "Cash advances and their remaining payroll balances."],
  ["payroll_summary", "Payroll Summary", "Saved employee payroll totals."],
  ["repair_summary", "Repair / Maintenance Summary", "Repair and maintenance costs by unit."],
  ["equipment_project_work_summary", "Equipment Project Work Summary", "Completed and billed equipment-project work by date, unit, quantity, and charge."],
  ["fleet_utilization", "Fleet Utilization", "Trip volume and charges grouped by fleet unit."],
];
const REPORT_LABELS = Object.fromEntries(REPORTS.map(([slug, label]) => [slug, label]));
const REPORT_DESCRIPTIONS = Object.fromEntries(REPORTS.map(([slug, , description]) => [slug, description]));
const REPORT_STATUSES = ["Draft", "Active", "Planned", "Ongoing", "Completed", "Cancelled", "Billed", "Paid", "Open", "Partially Paid", "Closed", "Settled", "Partial"];

function reportFilters(url) {
  return {
    report: REPORT_LABELS[url.searchParams.get("report")] ? url.searchParams.get("report") : REPORTS[0][0],
    q: (url.searchParams.get("q") || "").trim(),
    date_from: url.searchParams.get("date_from") || "",
    date_to: url.searchParams.get("date_to") || "",
    status: url.searchParams.get("status") || "",
  };
}

function reportParams(filters) {
  const params = new URLSearchParams();
  params.set("report", filters.report);
  if (filters.q) params.set("q", filters.q);
  if (filters.date_from) params.set("date_from", filters.date_from);
  if (filters.date_to) params.set("date_to", filters.date_to);
  if (filters.status) params.set("status", filters.status);
  return params;
}

function currentMonthBounds() {
  const today = todayISO();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start: `${today.slice(0, 8)}01`, end: lastDay };
}

function matchText(row, query, fields) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return fields.some((field) => String(row[field] ?? "").toLowerCase().includes(needle));
}

function matchDate(row, field, filters) {
  const value = row[field] || "";
  if (filters.date_from && value < filters.date_from) return false;
  if (filters.date_to && value > filters.date_to) return false;
  return true;
}

function reportResult(slug, columns, rows) {
  const totals = columns.map(([label, kind], index) => {
    if (kind === "money" || kind === "number") return { value: rows.reduce((sum, row) => sum + numeric(row[index]), 0), kind };
    return { value: index === 0 ? "Totals" : "", kind };
  });
  return {
    slug,
    label: REPORT_LABELS[slug],
    description: REPORT_DESCRIPTIONS[slug],
    columns: columns.map(([label, kind]) => ({ label, kind })),
    raw_rows: rows,
    rows: rows.map((row) => row.map((value, index) => ({ value, kind: columns[index][1] }))),
    totals,
    row_count: rows.length,
  };
}

function formatReportCell(cell) {
  if (cell.kind === "money") return esc(peso(cell.value));
  return esc(cell.value);
}

async function buildReport(env, filters) {
  const slug = filters.report;
  if (slug === "this_month_trips") {
    const bounds = currentMonthBounds();
    const effective = { ...filters, date_from: filters.date_from || bounds.start, date_to: filters.date_to || bounds.end };
    const trips = (await all(env, "SELECT t.*, c.client_name FROM trips t LEFT JOIN clients c ON c.id=t.client_id ORDER BY t.trip_date, t.id"))
      .filter((row) => matchDate(row, "trip_date", effective))
      .filter((row) => matchText(row, filters.q, ["trip_ticket_no", "reference_no", "client_name", "origin", "destination"]))
      .filter((row) => !filters.status || row.status === filters.status);
    return reportResult(slug, [["Trip Ticket / Waybill", "text"], ["Date", "date"], ["Status", "text"], ["Base Rate", "money"]], trips.map((row) => [row.trip_ticket_no, row.trip_date, row.status, row.base_trip_rate]));
  }

  if (["ongoing_trips", "completed_trips", "unbilled_trips"].includes(slug)) {
    const fixedStatus = slug === "ongoing_trips" ? "Ongoing" : "Completed";
    const billedLines = await all(env, "SELECT trip_id FROM billing_lines");
    const billedIds = new Set(billedLines.map((line) => Number(line.trip_id)));
    const trips = (await all(env, "SELECT t.*, c.client_name FROM trips t LEFT JOIN clients c ON c.id=t.client_id ORDER BY t.trip_date DESC, t.id"))
      .filter((row) => matchDate(row, "trip_date", filters))
      .filter((row) => matchText(row, filters.q, ["trip_ticket_no", "reference_no", "client_name", "origin", "destination"]))
      .filter((row) => row.status === (filters.status || fixedStatus))
      .filter((row) => slug !== "unbilled_trips" || !billedIds.has(Number(row.id)));
    if (slug === "ongoing_trips") return reportResult(slug, [["Trip Ticket / Waybill", "text"], ["Date", "date"], ["Client", "text"], ["Route", "text"]], trips.map((row) => [row.trip_ticket_no, row.trip_date, row.client_name || "", `${row.origin || ""} -> ${row.destination || ""}`]));
    if (slug === "completed_trips") return reportResult(slug, [["Trip Ticket / Waybill", "text"], ["Date", "date"], ["Status", "text"], ["Base Rate", "money"]], trips.map((row) => [row.trip_ticket_no, row.trip_date, row.status, row.base_trip_rate]));
    return reportResult(slug, [["Trip Ticket / Waybill", "text"], ["Date", "date"], ["Client", "text"], ["Base Rate", "money"]], trips.map((row) => [row.trip_ticket_no, row.trip_date, row.client_name || "", row.base_trip_rate]));
  }

  if (["billing_summary", "receivables_summary"].includes(slug)) {
    const collections = await all(env, "SELECT * FROM collections");
    const paidByBilling = new Map();
    for (const row of collections) paidByBilling.set(Number(row.billing_id), numeric(paidByBilling.get(Number(row.billing_id))) + numeric(row.amount_paid));
    const billings = (await all(env, "SELECT b.*, c.client_name FROM billing_statements b LEFT JOIN clients c ON c.id=b.client_id ORDER BY b.billing_date DESC, b.id"))
      .filter((row) => matchDate(row, "billing_date", filters))
      .filter((row) => matchText(row, filters.q, ["billing_no", "client_name", "notes"]))
      .filter((row) => !filters.status || row.status === filters.status);
    if (slug === "billing_summary") return reportResult(slug, [["Billing No", "text"], ["Date", "date"], ["Client", "text"], ["Grand Total", "money"], ["Status", "text"]], billings.map((row) => [row.billing_no, row.billing_date, row.client_name || "", row.grand_total, row.status]));
    return reportResult(slug, [["Billing No", "text"], ["Client", "text"], ["Grand Total", "money"], ["Outstanding", "money"], ["Status", "text"]], billings.map((row) => [row.billing_no, row.client_name || "", row.grand_total, outstandingBalance(row.grand_total, paidByBilling.get(Number(row.id))), billingStatus(row.grand_total, paidByBilling.get(Number(row.id)))]));
  }

  if (slug === "payables_summary") {
    const rows = (await all(env, "SELECT p.*, s.supplier_name FROM payables p LEFT JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.payable_date DESC, p.id"))
      .filter((row) => matchDate(row, "payable_date", filters))
      .filter((row) => matchText(row, filters.q, ["description", "reference_no", "supplier_name", "notes"]))
      .filter((row) => !filters.status || row.status === filters.status);
    return reportResult(slug, [["Date", "date"], ["Description", "text"], ["Amount", "money"], ["Due Date", "date"], ["Status", "text"]], rows.map((row) => [row.payable_date, row.description, row.amount, row.due_date || "", row.status]));
  }

  if (["vale_balance", "cash_advance_balance"].includes(slug)) {
    const isVale = slug === "vale_balance";
    const rows = (await all(env, isVale ? "SELECT v.*, e.full_name, e.employee_code FROM vale_records v LEFT JOIN employees e ON e.id=v.employee_id ORDER BY v.date_granted DESC, v.id" : "SELECT c.*, e.full_name, e.employee_code FROM cash_advances c LEFT JOIN employees e ON e.id=c.employee_id ORDER BY c.date_granted DESC, c.id"))
      .filter((row) => matchDate(row, "date_granted", filters))
      .filter((row) => matchText(row, filters.q, ["full_name", "employee_code", "notes"]))
      .filter((row) => !filters.status || row.status === filters.status);
    if (isVale) return reportResult(slug, [["Employee", "text"], ["Date Granted", "date"], ["Amount", "money"], ["Installment", "money"], ["Balance", "money"], ["Status", "text"]], rows.map((row) => [row.full_name || row.employee_name || "", row.date_granted, row.amount, row.installment_amount, row.balance, row.status]));
    return reportResult(slug, [["Employee", "text"], ["Date Granted", "date"], ["Amount", "money"], ["Balance", "money"], ["Status", "text"]], rows.map((row) => [row.full_name || row.employee_name || "", row.date_granted, row.amount, row.balance, row.status]));
  }

  if (slug === "payroll_summary") {
    const rows = (await all(env, "SELECT p.*, e.full_name, e.employee_code FROM payroll_entries p LEFT JOIN employees e ON e.id=p.employee_id ORDER BY p.pay_date DESC, p.id"))
      .filter((row) => matchDate(row, "pay_date", filters))
      .filter((row) => matchText(row, filters.q, ["full_name", "employee_code", "employee_type", "remarks"]));
    return reportResult(slug, [["Pay Date", "date"], ["Employee", "text"], ["Type", "text"], ["Gross Pay", "money"], ["Additional Pay", "money"], ["Net Pay", "money"]], rows.map((row) => [row.pay_date, row.full_name || "", row.employee_type, row.gross_pay, row.additional_pay, row.net_pay]));
  }

  if (slug === "repair_summary") {
    const rows = (await all(env, "SELECT r.*, a.asset_code, s.supplier_name FROM repairs r LEFT JOIN assets a ON a.id=r.asset_id LEFT JOIN suppliers s ON s.id=r.supplier_id ORDER BY r.repair_date DESC, r.id"))
      .filter((row) => matchDate(row, "repair_date", filters))
      .filter((row) => matchText(row, filters.q, ["asset_code", "repair_description", "supplier_name", "notes"]))
      .filter((row) => !filters.status || row.status === filters.status);
    return reportResult(slug, [["Date", "date"], ["Asset", "text"], ["Description", "text"], ["Total Cost", "money"], ["Status", "text"]], rows.map((row) => [row.repair_date, row.asset_code || "", row.repair_description, row.total_cost, row.status]));
  }

  if (slug === "equipment_project_work_summary") {
    const rows = (await all(env, "SELECT w.*,p.project_no,c.client_name,a.asset_code FROM project_work_entries w JOIN projects p ON p.id=w.project_id LEFT JOIN clients c ON c.id=w.client_id_snapshot LEFT JOIN assets a ON a.id=w.asset_id_snapshot ORDER BY w.work_date DESC,w.id"))
      .filter((row) => matchDate(row, "work_date", filters))
      .filter((row) => matchText(row, filters.q, ["project_no", "reference_no", "client_name", "asset_code", "job_description_snapshot", "project_location_snapshot"]))
      .filter((row) => !filters.status || row.status === filters.status);
    return reportResult(slug, [["Project No.", "text"], ["Work Date", "date"], ["Client", "text"], ["Asset", "text"], ["Unit", "text"], ["Quantity", "number"], ["Base", "money"], ["Extras", "money"], ["Total", "money"], ["Status", "text"]], rows.map((row) => [row.project_no, row.work_date, row.client_name || "", row.asset_code || "", row.billing_unit, row.billing_quantity, row.base_charge, row.extra_total, row.total_charge, row.status]));
  }

  const trips = (await all(env, "SELECT * FROM trips")).filter((row) => matchDate(row, "trip_date", filters)).filter((row) => !filters.status || row.status === filters.status);
  const projectWork = (await all(env, "SELECT * FROM project_work_entries")).filter((row) => matchDate(row, "work_date", filters)).filter((row) => !filters.status || row.status === filters.status);
  const assets = (await all(env, "SELECT * FROM assets ORDER BY asset_code, id")).filter((row) => matchText(row, filters.q, ["asset_code", "asset_type", "plate_no", "make_model"]));
  const rows = assets.map((asset) => {
    const assetTrips = trips.filter((trip) => Number(trip.asset_id) === Number(asset.id));
    const assetProjectWork = projectWork.filter((work) => Number(work.asset_id_snapshot) === Number(asset.id));
    return [asset.asset_code, asset.asset_type, assetTrips.length, assetProjectWork.length, assetTrips.reduce((sum, trip) => sum + numeric(trip.base_trip_rate), 0) + assetProjectWork.reduce((sum, work) => sum + numeric(work.base_charge), 0), assetTrips.reduce((sum, trip) => sum + tripExtraTotal(trip), 0) + assetProjectWork.reduce((sum, work) => sum + numeric(work.extra_total), 0)];
  });
  return reportResult(slug, [["Asset", "text"], ["Type", "text"], ["Trips", "number"], ["Project Entries", "number"], ["Base Charges", "money"], ["Extra Charges", "money"]], rows);
}

function reportForm(filters) {
  const params = reportParams(filters);
  const options = REPORTS.map(([slug, label]) => `<option value="${esc(slug)}"${filters.report === slug ? " selected" : ""}>${esc(label)}</option>`).join("");
  const statusOptions = `<option value="">All statuses</option>${REPORT_STATUSES.map((status) => `<option value="${esc(status)}"${filters.status === status ? " selected" : ""}>${esc(status)}</option>`).join("")}`;
  return `<section class="panel report-filter-panel"><form method="get" class="report-filters"><label>Report<select name="report">${options}</select></label><label>Search<input name="q" value="${esc(filters.q)}" placeholder="Search report"></label><label>Date From<input type="date" name="date_from" value="${esc(filters.date_from)}"></label><label>Date To<input type="date" name="date_to" value="${esc(filters.date_to)}"></label><label>Status<select name="status">${statusOptions}</select></label><div class="report-actions"><button>Load Report</button><a class="button secondary" href="/reports/print?${esc(params.toString())}" target="_blank">Print</a><a class="button secondary" href="/reports/export.csv?${esc(params.toString())}">Export CSV</a></div></form></section>`;
}

function reportTable(result) {
  const body = result.rows.map((row) => `<tr>${row.map((cell) => `<td${cell.kind === "money" || cell.kind === "number" ? ' class="num"' : ""}>${formatReportCell(cell)}</td>`).join("")}</tr>`);
  const totals = result.rows.length ? `<tfoot><tr>${result.totals.map((cell) => `<td${cell.kind === "money" || cell.kind === "number" ? ' class="num"' : ""}>${formatReportCell(cell)}</td>`).join("")}</tr></tfoot>` : "";
  return `<div class="panel"><table><thead><tr>${result.columns.map((column) => `<th${column.kind === "money" || column.kind === "number" ? ' class="num"' : ""}>${esc(column.label)}</th>`).join("")}</tr></thead><tbody>${body.length ? body.join("") : `<tr><td colspan="${result.columns.length}" class="report-empty">No rows match this report and its filters.</td></tr>`}</tbody>${totals}</table></div>`;
}

function reportFilterBad(filters) {
  return filters.date_from && filters.date_to && filters.date_from > filters.date_to;
}

function reportPrintable(result, filters, settings) {
  const activeFilters = [["Report", result.label], ["Search", filters.q], ["Date From", filters.date_from], ["Date To", filters.date_to], ["Status", filters.status]].filter(([, value]) => value);
  const filterTags = activeFilters.length ? activeFilters.map(([label, value]) => `<span class="filter"><strong>${esc(label)}:</strong> ${esc(value)}</span>`).join("") : `<span class="filter">No filters applied</span>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(result.label)}</title><style>${customerPrintStyles("A4 landscape")}.filters{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 10px}.filter{border:1px solid #bbb;border-radius:12px;padding:3px 8px;font-size:9pt}.report-empty{text-align:center;padding:18px}tfoot td{font-weight:bold;background:#f7f7f7}</style></head><body><button class="print-button" onclick="window.print()">Print</button><div class="document-sheet"><div class="document-header"><div>${companyHeader(settings)}<h2>${esc(result.label)}</h2><div class="muted">${esc(result.description)}</div></div><div class="document-meta"><div><strong>Generated:</strong> ${esc(new Date().toISOString())}</div><div><strong>Rows:</strong> ${esc(result.row_count)}</div></div></div><div class="filters">${filterTags}</div>${reportTable(result)}</div></body></html>`;
}

async function reportWorkspace(request, env, user, path, { print = false, exportCsv = false } = {}) {
  const access = requireView(user, "Reports");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const filters = reportFilters(url);
  if (reportFilterBad(filters)) {
    const content = `${reportForm(filters)}<section class="panel"><p class="error">End date must be on or after start date.</p></section>`;
    return html(layout({ title: "Reports", user, path, content }), 400);
  }
  const result = await buildReport(env, filters);
  if (exportCsv) {
    const lines = [result.columns.map((column) => column.label).join(",")];
    for (const row of result.raw_rows) lines.push(quotedCsvRow(row));
    return csv(lines.join("\n"), `${result.slug}.csv`);
  }
  if (print) {
    return html(reportPrintable(result, filters, await loadSettings(env)));
    const activeFilters = [["Report", result.label], ["Search", filters.q], ["Date From", filters.date_from], ["Date To", filters.date_to], ["Status", filters.status]].filter(([, value]) => value);
    const filterTags = activeFilters.length ? activeFilters.map(([label, value]) => `<span class="filter"><strong>${esc(label)}:</strong> ${esc(value)}</span>`).join("") : `<span class="filter">No filters applied</span>`;
    return html(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(result.label)}</title><style>@page{size:A4 landscape;margin:11mm}body{font:10pt Arial,sans-serif;color:#111;margin:0}.sheet{padding:2mm}.print-button{margin-bottom:10px}.header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #222;padding-bottom:8px;margin-bottom:10px}h1{font-size:18pt;margin:0 0 3px}h2{font-size:14pt;margin:0 0 4px}.muted{color:#555}.meta{font-size:9pt;text-align:right;line-height:1.45}.filters{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 10px}.filter{border:1px solid #bbb;border-radius:12px;padding:3px 8px;font-size:9pt}table{width:100%;border-collapse:collapse}th,td{border:1px solid #444;padding:4px 5px;vertical-align:top}th{background:#eee;text-align:left}tfoot td{font-weight:bold;background:#f7f7f7}.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.report-empty{text-align:center;padding:18px}@media print{.print-button{display:none}}</style></head><body><div class="sheet"><button class="print-button" onclick="window.print()">Print</button><div class="header"><div><h1>GMT Trucking</h1><h2>${esc(result.label)}</h2><div class="muted">${esc(result.description)}</div></div><div class="meta"><div><strong>Generated:</strong> ${esc(new Date().toISOString())}</div><div><strong>Rows:</strong> ${esc(result.row_count)}</div></div></div><div class="filters">${filterTags}</div>${reportTable(result)}</div></body></html>`);
  }
  const heading = `<section class="report-heading"><div><span class="dialog-kicker">Operational and Financial Report</span><h3>${esc(result.label)}</h3><p>${esc(result.description)}</p></div><div class="report-count"><strong>${esc(result.row_count)}</strong> <span>${result.row_count === 1 ? "row" : "rows"}</span></div></section>`;
  return html(layout({ title: "Reports", user, path, content: `${reportForm(filters)}${heading}${reportTable(result)}` }));
}

function settingsFormContent(settings, url, errors = []) {
  const errorBox = errors.length ? `<section class="panel"><ul class="error">${errors.map((err) => `<li>${esc(err)}</li>`).join("")}</ul></section>` : "";
  const fields = SETTINGS_FIELDS.map(([key, label, kind]) => {
    if (kind === "checkbox") return `<label class="checkbox-row"><input type="checkbox" name="${esc(key)}" value="1"${settings[key] === "1" ? " checked" : ""}> ${esc(label)}</label>`;
    if (kind === "textarea") return textareaInput(key, label, settings[key] || "", 'rows="3"');
    return textInput(key, label, settings[key] || "");
  });
  const logoPreview = settings.company_logo_data_url ? `<div class="logo-preview"><img src="${esc(settings.company_logo_data_url)}" alt="Company logo preview"><label class="checkbox-row"><input type="checkbox" name="remove_company_logo" value="1"> Remove current logo</label></div>` : `<p class="muted">No company logo uploaded yet.</p>`;
  return `${messagePanel(url)}${errorBox}<section class="panel"><h3>Company Profile &amp; Document Defaults</h3><p class="muted">These values appear on printable trip tickets, billing statements, statements of account, and reports. The logo is excluded from payslips.</p><form method="post" action="/settings" enctype="multipart/form-data"><div class="settings-logo-block"><label>Company logo<input type="file" name="company_logo" accept="image/png,image/jpeg,image/webp,image/svg+xml"></label>${logoPreview}<p class="muted">PNG, JPEG, WebP, or SVG only. Maximum 250 KB.</p></div><div class="grid">${fields.join("")}</div><div class="form-actions"><button>Save Settings</button></div></form></section>`;
}

async function settingsPage(request, env, user, path) {
  const access = requireEdit(user, "Settings");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const currentSettings = await loadSettings(env);
  if (request.method === "POST") {
    const { values, errors } = await settingsValuesFromRequest(request, currentSettings);
    if (errors.length) return html(layout({ title: "Settings", user, path, content: settingsFormContent(values, url, errors) }), 400);
    for (const key of [...SETTINGS_FIELDS.map(([field]) => field), COMPANY_LOGO_KEY]) {
      await run(env, "INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, values[key]]);
    }
    return redirect("/settings?ok=Settings%20updated.");
  }
  return html(layout({ title: "Settings", user, path, content: settingsFormContent(currentSettings, url) }));
}

const DATA_EXPORT_TABLES = [
  { table: "users", label: "Users", order: "id", columns: ["id", "username", "first_name", "last_name", "email", "role", "active", "created_at"] },
  { table: "employees", label: "Employees", order: "id", columns: ["id", "employee_code", "full_name", "employee_type", "contact_no", "address", "date_hired", "employment_status", "payroll_basis", "daily_rate", "trip_rate", "notes", "active"] },
  { table: "assets", label: "Fleet / Equipment", order: "id", columns: ["id", "asset_code", "asset_type", "plate_no", "make_model", "capacity_desc", "status", "assigned_employee_id", "notes"] },
  { table: "clients", label: "Clients", order: "id", columns: ["id", "client_code", "client_name", "billing_address", "contact_person", "contact_no", "terms_days", "notes", "active"] },
  { table: "suppliers", label: "Suppliers", order: "id", columns: ["id", "supplier_name", "contact_person", "contact_no", "address", "notes"] },
  { table: "recurring_trip_masters", label: "Recurring Trips", order: "id", columns: ["id", "master_code", "client_id", "job_description", "origin", "destination", "default_asset_id", "default_driver_id", "default_helper_count", "standard_base_rate", "driver_pay_rate", "helper_pay_rate", "default_extra_note", "remarks", "active"] },
  { table: "trips", label: "Trips", order: "id", columns: ["id", "trip_ticket_no", "reference_no", "trip_type", "recurring_master_id", "trip_date", "client_id", "job_description", "origin", "destination", "asset_id", "driver_id", "dispatch_time", "arrival_time", "status", "base_trip_rate", "driver_pay_rate", "helper_pay_rate", "driver_additional_pay", "helper_additional_pay", "fuel_surcharge", "loading_fee", "unloading_fee", "waiting_fee", "tolls", "additional_stop_charge", "special_handling_fee", "other_charges", "notes"] },
  { table: "trip_helpers", label: "Trip Helpers", order: "id", columns: ["id", "trip_id", "employee_id", "helper_order"] },
  { table: "trip_employee_pay_items", label: "Trip Pay Items", order: "id", columns: ["id", "trip_id", "employee_type", "label", "amount", "sort_order"] },
  { table: "projects", label: "Projects", order: "id", columns: ["id", "project_no", "reference_no", "start_date", "end_date", "client_id", "job_description", "origin", "destination", "project_location", "asset_id", "primary_employee_id", "billing_basis", "work_recording_mode", "default_billing_quantity", "client_unit_rate", "primary_pay_basis", "default_primary_pay_quantity", "primary_pay_rate", "default_primary_manual_pay", "helper_pay_basis", "default_helper_pay_quantity", "helper_pay_rate", "default_helper_manual_pay", "fuel_surcharge", "loading_fee", "unloading_fee", "waiting_fee", "tolls", "additional_stop_charge", "special_handling_fee", "other_charges", "status", "notes", "created_at"] },
  { table: "project_helpers", label: "Project Helpers", order: "id", columns: ["id", "project_id", "employee_id", "helper_order"] },
  { table: "project_pay_item_defaults", label: "Project Pay Defaults", order: "id", columns: ["id", "project_id", "employee_type", "label", "amount", "sort_order"] },
  { table: "project_work_entries", label: "Project Work Entries", order: "id", columns: ["id", "work_no", "project_id", "work_date", "reference_no", "billing_unit", "billing_quantity", "client_unit_rate", "base_charge", "primary_employee_id", "primary_pay_basis", "primary_pay_quantity", "primary_pay_rate", "primary_manual_pay", "helper_pay_basis", "helper_pay_quantity", "helper_pay_rate", "helper_manual_pay", "client_id_snapshot", "asset_id_snapshot", "job_description_snapshot", "origin_snapshot", "destination_snapshot", "project_location_snapshot", "start_time", "end_time", "meter_start", "meter_end", "fuel_surcharge", "loading_fee", "unloading_fee", "waiting_fee", "tolls", "additional_stop_charge", "special_handling_fee", "other_charges", "extra_total", "total_charge", "status", "notes", "created_at"] },
  { table: "project_work_helpers", label: "Project Work Helpers", order: "id", columns: ["id", "work_entry_id", "employee_id", "helper_order"] },
  { table: "project_work_pay_items", label: "Project Work Pay Items", order: "id", columns: ["id", "work_entry_id", "employee_type", "label", "amount", "sort_order"] },
  { table: "billing_project_lines", label: "Billing Project Lines", order: "id", columns: ["id", "billing_id", "work_entry_id", "amount_base", "amount_extra", "amount_total"] },
  { table: "payroll_project_entries", label: "Payroll Project Entries", order: "id", columns: ["id", "payroll_id", "work_entry_id", "employee_id", "employee_role", "pay_basis", "pay_quantity", "pay_rate", "base_amount"] },
  { table: "repairs", label: "Repairs", order: "id", columns: ["id", "repair_date", "asset_id", "repair_description", "meter_value", "supplier_id", "parts_cost", "labor_cost", "other_cost", "total_cost", "status", "notes", "auto_generate_payable"] },
  { table: "payables", label: "Payables", order: "id", columns: ["id", "payable_date", "supplier_id", "source_type", "reference_no", "description", "amount", "due_date", "status", "notes", "linked_repair_id"] },
  { table: "vale_records", label: "Vale", order: "id", columns: ["id", "employee_id", "date_granted", "amount", "installment_amount", "balance", "status", "notes"] },
  { table: "cash_advances", label: "Cash Advances", order: "id", columns: ["id", "employee_id", "date_granted", "amount", "balance", "applied", "status", "notes"] },
  { table: "payroll_entries", label: "Payroll Entries", order: "id", columns: ["id", "pay_date", "period_from", "period_to", "employee_id", "employee_type", "payroll_basis", "unit_description", "trips_count", "days_count", "gross_pay", "additional_pay", "driver_trip_additional_pay", "helper_trip_additional_pay", "vale_deduction", "cash_advance_deduction", "sss", "philhealth", "pagibig", "withholding_tax", "change_deduction", "other_deduction", "net_pay", "remarks"] },
  { table: "payroll_trips", label: "Payroll Trips", order: "id", columns: ["id", "payroll_id", "trip_id", "employee_id"] },
  { table: "payroll_additional_lines", label: "Payroll Additional Lines", order: "id", columns: ["id", "payroll_id", "employee_type", "label", "amount", "sort_order"] },
  { table: "billing_statements", label: "Billing Statements", order: "id", columns: ["id", "billing_no", "client_id", "billing_date", "period_from", "period_to", "base_charges_total", "extra_charges_total", "gross_total", "vat_enabled", "vat_amount", "additions_total", "deductions_total", "grand_total", "status", "notes"] },
  { table: "billing_lines", label: "Billing Lines", order: "id", columns: ["id", "billing_id", "trip_id", "amount_base", "amount_extra", "amount_total"] },
  { table: "billing_adjustments", label: "Billing Adjustments", order: "id", columns: ["id", "billing_id", "line_type", "label", "amount", "sort_order"] },
  { table: "collections", label: "Collections", order: "id", columns: ["id", "collection_date", "client_id", "billing_id", "amount_paid", "reference_no", "payment_method", "notes"] },
  { table: "system_settings", label: "System Settings", order: "key", columns: ["key", "value"] },
];

const RELATIONSHIP_CHECKS = [
  ["trip_helpers_missing_trips", "Trip helpers with missing trips", "SELECT COUNT(*) AS total FROM trip_helpers th LEFT JOIN trips t ON t.id=th.trip_id WHERE t.id IS NULL"],
  ["trip_helpers_missing_employees", "Trip helpers with missing employees", "SELECT COUNT(*) AS total FROM trip_helpers th LEFT JOIN employees e ON e.id=th.employee_id WHERE e.id IS NULL"],
  ["trip_pay_items_missing_trips", "Trip pay items with missing trips", "SELECT COUNT(*) AS total FROM trip_employee_pay_items pi LEFT JOIN trips t ON t.id=pi.trip_id WHERE t.id IS NULL"],
  ["trips_missing_clients", "Trips with missing clients", "SELECT COUNT(*) AS total FROM trips t LEFT JOIN clients c ON c.id=t.client_id WHERE t.client_id IS NOT NULL AND c.id IS NULL"],
  ["trips_missing_assets", "Trips with missing assets", "SELECT COUNT(*) AS total FROM trips t LEFT JOIN assets a ON a.id=t.asset_id WHERE t.asset_id IS NOT NULL AND a.id IS NULL"],
  ["trips_missing_drivers", "Trips with missing drivers", "SELECT COUNT(*) AS total FROM trips t LEFT JOIN employees e ON e.id=t.driver_id WHERE t.driver_id IS NOT NULL AND e.id IS NULL"],
  ["recurring_missing_clients", "Recurring trips with missing clients", "SELECT COUNT(*) AS total FROM recurring_trip_masters r LEFT JOIN clients c ON c.id=r.client_id WHERE r.client_id IS NOT NULL AND c.id IS NULL"],
  ["repairs_missing_assets", "Repairs with missing assets", "SELECT COUNT(*) AS total FROM repairs r LEFT JOIN assets a ON a.id=r.asset_id WHERE r.asset_id IS NOT NULL AND a.id IS NULL"],
  ["repairs_missing_suppliers", "Repairs with missing suppliers", "SELECT COUNT(*) AS total FROM repairs r LEFT JOIN suppliers s ON s.id=r.supplier_id WHERE r.supplier_id IS NOT NULL AND s.id IS NULL"],
  ["payables_missing_suppliers", "Payables with missing suppliers", "SELECT COUNT(*) AS total FROM payables p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.supplier_id IS NOT NULL AND s.id IS NULL"],
  ["vale_missing_employees", "Vale records with missing employees", "SELECT COUNT(*) AS total FROM vale_records v LEFT JOIN employees e ON e.id=v.employee_id WHERE e.id IS NULL"],
  ["cash_missing_employees", "Cash advances with missing employees", "SELECT COUNT(*) AS total FROM cash_advances c LEFT JOIN employees e ON e.id=c.employee_id WHERE e.id IS NULL"],
  ["payroll_trips_missing_entries", "Payroll trip links with missing payroll entries", "SELECT COUNT(*) AS total FROM payroll_trips pt LEFT JOIN payroll_entries p ON p.id=pt.payroll_id WHERE p.id IS NULL"],
  ["payroll_trips_missing_trips", "Payroll trip links with missing trips", "SELECT COUNT(*) AS total FROM payroll_trips pt LEFT JOIN trips t ON t.id=pt.trip_id WHERE t.id IS NULL"],
  ["payroll_lines_missing_entries", "Payroll additional lines with missing payroll entries", "SELECT COUNT(*) AS total FROM payroll_additional_lines pl LEFT JOIN payroll_entries p ON p.id=pl.payroll_id WHERE p.id IS NULL"],
  ["billing_lines_missing_statements", "Billing lines with missing billing statements", "SELECT COUNT(*) AS total FROM billing_lines bl LEFT JOIN billing_statements b ON b.id=bl.billing_id WHERE b.id IS NULL"],
  ["billing_lines_missing_trips", "Billing lines with missing trips", "SELECT COUNT(*) AS total FROM billing_lines bl LEFT JOIN trips t ON t.id=bl.trip_id WHERE t.id IS NULL"],
  ["billing_adjustments_missing_statements", "Billing adjustments with missing billing statements", "SELECT COUNT(*) AS total FROM billing_adjustments ba LEFT JOIN billing_statements b ON b.id=ba.billing_id WHERE b.id IS NULL"],
  ["projects_missing_clients", "Projects with missing clients", "SELECT COUNT(*) AS total FROM projects p LEFT JOIN clients c ON c.id=p.client_id WHERE c.id IS NULL"],
  ["projects_missing_assets", "Projects with missing assets", "SELECT COUNT(*) AS total FROM projects p LEFT JOIN assets a ON a.id=p.asset_id WHERE a.id IS NULL"],
  ["projects_missing_primary_employees", "Projects with missing primary employees", "SELECT COUNT(*) AS total FROM projects p LEFT JOIN employees e ON e.id=p.primary_employee_id WHERE e.id IS NULL"],
  ["project_helpers_missing_projects", "Project helpers with missing projects", "SELECT COUNT(*) AS total FROM project_helpers ph LEFT JOIN projects p ON p.id=ph.project_id WHERE p.id IS NULL"],
  ["project_helpers_missing_employees", "Project helpers with missing employees", "SELECT COUNT(*) AS total FROM project_helpers ph LEFT JOIN employees e ON e.id=ph.employee_id WHERE e.id IS NULL"],
  ["project_work_missing_projects", "Project work entries with missing projects", "SELECT COUNT(*) AS total FROM project_work_entries w LEFT JOIN projects p ON p.id=w.project_id WHERE p.id IS NULL"],
  ["project_work_helpers_missing_entries", "Project work helpers with missing work entries", "SELECT COUNT(*) AS total FROM project_work_helpers wh LEFT JOIN project_work_entries w ON w.id=wh.work_entry_id WHERE w.id IS NULL"],
  ["billing_project_lines_missing_billing", "Project billing lines with missing billing statements", "SELECT COUNT(*) AS total FROM billing_project_lines bpl LEFT JOIN billing_statements b ON b.id=bpl.billing_id WHERE b.id IS NULL"],
  ["billing_project_lines_missing_work", "Project billing lines with missing work entries", "SELECT COUNT(*) AS total FROM billing_project_lines bpl LEFT JOIN project_work_entries w ON w.id=bpl.work_entry_id WHERE w.id IS NULL"],
  ["payroll_project_entries_missing_payroll", "Project payroll claims with missing payroll entries", "SELECT COUNT(*) AS total FROM payroll_project_entries ppe LEFT JOIN payroll_entries p ON p.id=ppe.payroll_id WHERE p.id IS NULL"],
  ["payroll_project_entries_missing_work", "Project payroll claims with missing work entries", "SELECT COUNT(*) AS total FROM payroll_project_entries ppe LEFT JOIN project_work_entries w ON w.id=ppe.work_entry_id WHERE w.id IS NULL"],
  ["payroll_project_entries_missing_employees", "Project payroll claims with missing employees", "SELECT COUNT(*) AS total FROM payroll_project_entries ppe LEFT JOIN employees e ON e.id=ppe.employee_id WHERE e.id IS NULL"],
  ["collections_missing_billing", "Collections with missing billing statements", "SELECT COUNT(*) AS total FROM collections co LEFT JOIN billing_statements b ON b.id=co.billing_id WHERE co.billing_id IS NOT NULL AND b.id IS NULL"],
  ["collections_missing_clients", "Collections with missing clients", "SELECT COUNT(*) AS total FROM collections co LEFT JOIN clients c ON c.id=co.client_id WHERE co.client_id IS NOT NULL AND c.id IS NULL"],
];

async function dataCounts(env) {
  const pairs = await Promise.all(DATA_EXPORT_TABLES.map(async (spec) => {
    const row = await first(env, `SELECT COUNT(*) AS total FROM ${spec.table}`);
    return [spec.table, Number(row?.total || 0)];
  }));
  return Object.fromEntries(pairs);
}

async function dataControlTotals(env) {
  const [trips, projects, payroll, billing, collections, payables, vale, cash] = await Promise.all([
    first(env, "SELECT COUNT(*) AS count, COALESCE(SUM(base_trip_rate),0) AS base_total, COALESCE(SUM(fuel_surcharge + loading_fee + unloading_fee + waiting_fee + tolls + additional_stop_charge + special_handling_fee + other_charges),0) AS extra_total, COALESCE(SUM(base_trip_rate + fuel_surcharge + loading_fee + unloading_fee + waiting_fee + tolls + additional_stop_charge + special_handling_fee + other_charges),0) AS billable_total FROM trips"),
    first(env, "SELECT COUNT(*) AS count, COALESCE(SUM(base_charge),0) AS base_total, COALESCE(SUM(extra_total),0) AS extra_total, COALESCE(SUM(total_charge),0) AS billable_total FROM project_work_entries"),
    first(env, "SELECT COALESCE(SUM(gross_pay),0) AS gross_total, COALESCE(SUM(additional_pay),0) AS additional_total, COALESCE(SUM(vale_deduction + cash_advance_deduction + sss + philhealth + pagibig + withholding_tax + change_deduction + other_deduction),0) AS deduction_total, COALESCE(SUM(net_pay),0) AS net_total FROM payroll_entries"),
    first(env, "SELECT COALESCE(SUM(grand_total),0) AS grand_total FROM billing_statements"),
    first(env, "SELECT COALESCE(SUM(amount_paid),0) AS paid_total FROM collections"),
    first(env, "SELECT COALESCE(SUM(amount),0) AS open_total FROM payables WHERE status IN ('Open','Partial')"),
    first(env, "SELECT COALESCE(SUM(balance),0) AS open_balance FROM vale_records WHERE status='Open'"),
    first(env, "SELECT COALESCE(SUM(balance),0) AS open_balance FROM cash_advances WHERE status='Open'"),
  ]);
  const billingGrand = numeric(billing?.grand_total);
  const collectionPaid = numeric(collections?.paid_total);
  return {
    trips: {
      count: Number(trips?.count || 0),
      base_total: numeric(trips?.base_total),
      extra_total: numeric(trips?.extra_total),
      billable_total: numeric(trips?.billable_total),
    },
    project_work: {
      count: Number(projects?.count || 0),
      base_total: numeric(projects?.base_total),
      extra_total: numeric(projects?.extra_total),
      billable_total: numeric(projects?.billable_total),
    },
    payroll: {
      gross_total: numeric(payroll?.gross_total),
      additional_total: numeric(payroll?.additional_total),
      deduction_total: numeric(payroll?.deduction_total),
      net_total: numeric(payroll?.net_total),
    },
    billing: {
      grand_total: billingGrand,
      collections_total: collectionPaid,
      receivable_balance: billingGrand - collectionPaid,
    },
    payables: { open_total: numeric(payables?.open_total) },
    advances: {
      open_vale_balance: numeric(vale?.open_balance),
      open_cash_advance_balance: numeric(cash?.open_balance),
    },
  };
}

async function dataWarnings(env, counts) {
  const relationshipWarnings = [];
  for (const [key, label, sql] of RELATIONSHIP_CHECKS) {
    const row = await first(env, sql);
    const total = Number(row?.total || 0);
    if (total) relationshipWarnings.push({ key, severity: "warning", message: label, total });
  }
  const setupWarnings = [];
  const activeAdmins = await first(env, "SELECT COUNT(*) AS total FROM users WHERE role='admin' AND active=1");
  if (!Number(activeAdmins?.total || 0)) setupWarnings.push({ key: "missing_active_admin", severity: "critical", message: "No active admin user exists.", total: 0 });
  for (const [tableName, label] of [["employees", "employees"], ["clients", "clients"], ["assets", "fleet/equipment"], ["suppliers", "suppliers"]]) {
    if (!Number(counts[tableName] || 0)) setupWarnings.push({ key: `missing_${tableName}`, severity: "info", message: `No ${label} records found yet.`, total: 0 });
  }
  return [...setupWarnings, ...relationshipWarnings];
}

async function dataTableRows(env) {
  const entries = await Promise.all(DATA_EXPORT_TABLES.map(async (spec) => {
    const rows = await all(env, `SELECT ${spec.columns.join(", ")} FROM ${spec.table} ORDER BY ${spec.order}`);
    const safeRows = spec.table === "users" ? rows.map(({ password_hash, ...row }) => row) : rows;
    return [spec.table, safeRows];
  }));
  return Object.fromEntries(entries);
}

async function dataSnapshot(env, { includeRows = false } = {}) {
  const counts = await dataCounts(env);
  const [controls, warnings, tables] = await Promise.all([
    dataControlTotals(env),
    dataWarnings(env, counts),
    includeRows ? dataTableRows(env) : Promise.resolve(undefined),
  ]);
  return {
    metadata: {
      app: "GMT Trucking Cloudflare",
      generated_at: new Date().toISOString(),
      schema: "cloudflare-d1-v1",
      credentials_excluded: true,
      browser_import_supported: false,
    },
    counts,
    controls,
    warnings,
    ...(includeRows ? { tables } : {}),
  };
}

function moneySummaryRows(controls) {
  return [
    ["Trips base total", controls.trips.base_total],
    ["Trips extra total", controls.trips.extra_total],
    ["Trips billable total", controls.trips.billable_total],
    ["Project work base total", controls.project_work.base_total],
    ["Project work extra total", controls.project_work.extra_total],
    ["Project work billable total", controls.project_work.billable_total],
    ["Payroll gross", controls.payroll.gross_total],
    ["Payroll deductions", controls.payroll.deduction_total],
    ["Payroll net", controls.payroll.net_total],
    ["Billing grand total", controls.billing.grand_total],
    ["Collections total", controls.billing.collections_total],
    ["Receivable balance", controls.billing.receivable_balance],
    ["Open payables", controls.payables.open_total],
    ["Open vale balance", controls.advances.open_vale_balance],
    ["Open cash advance balance", controls.advances.open_cash_advance_balance],
  ];
}

function dataToolsContent(snapshot) {
  const countRows = DATA_EXPORT_TABLES.map((spec) => `<tr><td>${esc(spec.label)}</td><td>${esc(spec.table)}</td><td class="num">${esc(snapshot.counts[spec.table] || 0)}</td></tr>`);
  const totalRows = moneySummaryRows(snapshot.controls).map(([label, value]) => `<tr><td>${esc(label)}</td><td class="num">${esc(peso(value))}</td></tr>`);
  const warningRows = snapshot.warnings.map((warning) => `<tr><td>${esc(warning.severity)}</td><td>${esc(warning.message)}</td><td class="num">${esc(warning.total)}</td></tr>`);
  const commands = [
    "# 1) Backup D1 first: open /data-tools/export.json and save the file",
    "cd cloudflare",
    "python tools/export_django_sqlite_to_d1.py ../webapp/dev.sqlite3 --output-sql import.sql --summary-json import-manifest.json",
    "npx wrangler d1 execute gmt-trucking --remote --file=./import.sql",
    "Open /data-tools and compare counts/control totals with import-manifest.json.",
  ].join("\n");
  return `<section class="panel"><div class="toolbar"><div><h3>Data Tools</h3><p class="muted">Backup and verify the Cloudflare D1 database. Browser import is intentionally disabled; use Wrangler for large imports.</p></div><div class="toolbar-actions"><a class="button secondary" href="/data-tools/checklist">Staged Live-Use Checklist</a><a class="button secondary" href="/users">User Management</a><a class="button" href="/data-tools/export.json">Download JSON Backup</a></div></div></section>${cards([["Tables tracked", String(DATA_EXPORT_TABLES.length)], ["Total rows", String(Object.values(snapshot.counts).reduce((sum, value) => sum + Number(value || 0), 0))], ["Warnings", String(snapshot.warnings.length)], ["Password hashes", "Excluded"]])}<section class="panel"><h3>Guided Import</h3><p>Back up D1 first, then generate both SQL and a manifest from the approved Django SQLite file. Use a fresh D1 database or manually confirmed cleanup before importing production data. Real Cloudflare users should be managed in User Management, not imported from Django.</p><pre>${esc(commands)}</pre></section><section class="panel"><h3>Financial Control Totals</h3></section>${table(["Control", "Amount"], totalRows, { empty: "No totals found." })}<section class="panel"><h3>Table Counts</h3></section>${table(["Area", "Table", "Rows"], countRows, { empty: "No tables found." })}<section class="panel"><h3>Verification Warnings</h3></section>${table(["Severity", "Warning", "Count"], warningRows, { empty: "No relationship or setup warnings found." })}`;
}

function isDeploymentSecretSafe(env) {
  const secret = String(env.GMT_SESSION_SECRET || "").trim();
  return secret.length >= 32 && secret !== "development-secret" && !secret.startsWith("replace-this");
}

function stagedReadiness(snapshot, settings, env, previewAdminActive) {
  const blockers = [];
  const attention = [];
  const reminders = ["Download a fresh JSON backup before the staged test and again after it is complete."];
  const relationshipKeys = new Set(RELATIONSHIP_CHECKS.map(([key]) => key));

  if (snapshot.warnings.some((warning) => warning.key === "missing_active_admin")) {
    blockers.push("Create or reactivate at least one Admin account in User Management.");
  }
  if (!isDeploymentSecretSafe(env)) {
    blockers.push("Set a unique, long GMT_SESSION_SECRET in Cloudflare before sharing this app with real users.");
  }
  for (const warning of snapshot.warnings.filter((item) => relationshipKeys.has(item.key) && Number(item.total) > 0)) {
    blockers.push(`${warning.message}: ${warning.total}. Repair these relationship records before staged use.`);
  }

  const hasCompanyContact = Boolean(settings.company_address || settings.company_contact_no || settings.company_email);
  if (!settings.company_name || !hasCompanyContact) {
    attention.push("Complete the company profile in Settings so customer-facing printables have a usable company header.");
  }
  if (previewAdminActive) {
    attention.push("The preview account test_admin is active. Reset its password or deactivate it before inviting users outside the test team.");
  }
  for (const warning of snapshot.warnings.filter((item) => item.key.startsWith("missing_") && item.key !== "missing_active_admin")) {
    attention.push(warning.message);
  }

  const status = blockers.length ? "Blocked" : attention.length ? "Attention Needed" : "Ready";
  return { status, blockers, attention, reminders };
}

function readinessItems(items, kind, emptyMessage) {
  if (!items.length) return `<p class="${kind === "blocked" ? "success" : "muted"}">${esc(emptyMessage)}</p>`;
  return `<ul class="readiness-list ${esc(kind)}">${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
}

function dataToolsChecklistContent(readiness) {
  const statusClass = readiness.status === "Ready" ? "ready" : readiness.status === "Blocked" ? "blocked" : "attention";
  const stagedSteps = [
    "Download a D1 JSON backup from Data Tools and save it outside the repository.",
    "Review Company Profile, company logo, footer text, VAT default, and signature names in Settings.",
    "Confirm an Admin account exists, then create separate Encoder, Viewer, and Accounting test accounts in User Management.",
    "Create, edit, export, and guarded-delete one test Employee, Unit, Client, and Supplier.",
    "Create and print a test Trip Ticket / Waybill, including a recurring-template selection and helper validation.",
    "Create, print, and reverse one test Payroll entry; verify remaining Vale and Cash Advance balances.",
    "Create a Billing Statement, record a Collection, print Billing and SOA, then confirm balances and status.",
    "Load, print, and export a report; ensure customer printables use the saved company header and payslips remain logo-free.",
    "Sign in as Viewer and Accounting to confirm read-only/finance permissions, then download a final JSON backup.",
  ];
  return `<section class="panel readiness-summary ${statusClass}"><span class="dialog-kicker">Staged Live-Use Readiness</span><h3>${esc(readiness.status)}</h3><p>${readiness.status === "Ready" ? "No deployment blockers were found. Complete the staged test below before handling production data." : "Resolve blockers and review attention items before inviting staff to test this deployment."}</p><p><a class="button secondary" href="/data-tools">Back to Data Tools</a> <a class="button" href="/data-tools/export.json">Download JSON Backup</a></p></section><section class="panel"><h3>Blocking Checks</h3>${readinessItems(readiness.blockers, "blocked", "No blocking readiness issues found.")}</section><section class="panel"><h3>Attention Items</h3>${readinessItems(readiness.attention, "attention", "No attention items found.")}</section><section class="panel"><h3>Backup Reminder</h3>${readinessItems(readiness.reminders, "reminder", "No reminders.")}</section><section class="panel"><h3>Required Staged-Test Sequence</h3><ol class="checklist-steps">${stagedSteps.map((step) => `<li>${esc(step)}</li>`).join("")}</ol><p class="muted">This checklist is for sanitized or test data. Production import remains a separate, manually confirmed cutover using the SQL exporter and manifest comparison.</p></section>`;
}

async function dataToolsPage(request, env, user, path) {
  const access = requireView(user, "Data Tools");
  if (access) return errorResponse(access, user, path);
  const snapshot = await dataSnapshot(env);
  return html(layout({ title: "Data Tools", user, path, content: dataToolsContent(snapshot) }));
}

async function dataToolsChecklistPage(request, env, user, path) {
  const access = requireView(user, "Data Tools");
  if (access) return errorResponse(access, user, path);
  const [snapshot, settings, previewAdmin] = await Promise.all([
    dataSnapshot(env),
    loadSettings(env),
    first(env, "SELECT id FROM users WHERE username=? AND active=1", ["test_admin"]),
  ]);
  const readiness = stagedReadiness(snapshot, settings, env, Boolean(previewAdmin));
  return html(layout({ title: "Staged Live-Use Checklist", user, path, content: dataToolsChecklistContent(readiness) }));
}

async function dataToolsExportPage(request, env, user, path) {
  const access = requireView(user, "Data Tools");
  if (access) return errorResponse(access, user, path);
  const snapshot = await dataSnapshot(env, { includeRows: true });
  return new Response(JSON.stringify(snapshot, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="gmt-d1-backup-${todayISO()}.json"`,
    },
  });
}

const USER_ROLES = [
  ["admin", "Admin"],
  ["encoder", "Encoder"],
  ["viewer", "Viewer"],
  ["accounting", "Accounting"],
];
const USER_ROLE_LABELS = Object.fromEntries(USER_ROLES);

function userFilters(url) {
  return {
    q: (url.searchParams.get("q") || "").trim(),
    role: USER_ROLE_LABELS[url.searchParams.get("role")] ? url.searchParams.get("role") : "",
    active: ["active", "inactive"].includes(url.searchParams.get("active")) ? url.searchParams.get("active") : "",
  };
}

function userWhere(filters) {
  const clauses = [];
  const params = [];
  if (filters.q) {
    clauses.push("(username LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR email LIKE ?)");
    params.push(...Array(4).fill(`%${filters.q}%`));
  }
  if (filters.role) {
    clauses.push("role=?");
    params.push(filters.role);
  }
  if (filters.active === "active") clauses.push("active=1");
  if (filters.active === "inactive") clauses.push("active=0");
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

function userParams(filters, sort = null) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.role) params.set("role", filters.role);
  if (filters.active) params.set("active", filters.active);
  if (sort?.key) params.set("sort", sort.key);
  if (sort?.dir) params.set("dir", sort.dir);
  return params;
}

const USER_SORTS = {
  username: { sql: "username", label: "Username" },
  name: { sql: "last_name, first_name", label: "Name" },
  email: { sql: "email", label: "Email" },
  role: { sql: "role", label: "Role" },
  active: { sql: "active", label: "Status" },
};

function userFormValues(data, row = {}) {
  const role = USER_ROLE_LABELS[data.role] ? data.role : (row.role || "viewer");
  return {
    username: (data.username ?? row.username ?? "").trim(),
    first_name: (data.first_name ?? row.first_name ?? "").trim(),
    last_name: (data.last_name ?? row.last_name ?? "").trim(),
    email: (data.email ?? row.email ?? "").trim(),
    role,
    active: String(data.active ?? row.active ?? 1) === "0" ? 0 : 1,
  };
}

async function activeAdminCount(env, excludeId = null) {
  const row = excludeId
    ? await first(env, "SELECT COUNT(*) AS total FROM users WHERE role='admin' AND active=1 AND id<>?", [excludeId])
    : await first(env, "SELECT COUNT(*) AS total FROM users WHERE role='admin' AND active=1");
  return Number(row?.total || 0);
}

async function validateUserForm(env, values, id = null, password = "") {
  const errors = [];
  if (!values.username) errors.push("Username is required.");
  if (!USER_ROLE_LABELS[values.role]) errors.push("Choose a valid role.");
  const duplicate = values.username
    ? await first(env, `SELECT id FROM users WHERE username=?${id ? " AND id<>?" : ""} LIMIT 1`, id ? [values.username, id] : [values.username])
    : null;
  if (duplicate) errors.push("Username must be unique.");
  if (!id && !password) errors.push("Password is required.");
  if (id) {
    const existing = await first(env, "SELECT * FROM users WHERE id=?", [id]);
    if (existing && existing.role === "admin" && Number(existing.active) === 1 && (values.role !== "admin" || Number(values.active) !== 1)) {
      if (await activeAdminCount(env, id) <= 0) errors.push("At least one active admin account is required.");
    }
  }
  return errors;
}

function userFormContent(row, id = null, errors = []) {
  const roleOptions = USER_ROLES.map(([value, label]) => `<option value="${esc(value)}"${row.role === value ? " selected" : ""}>${esc(label)}</option>`).join("");
  const activeOptions = `<option value="1"${Number(row.active ?? 1) === 1 ? " selected" : ""}>Active</option><option value="0"${Number(row.active ?? 1) === 0 ? " selected" : ""}>Inactive</option>`;
  const fields = [
    textInput("username", "Username", row.username || "", "required autocomplete=\"username\""),
    textInput("first_name", "First name", row.first_name || ""),
    textInput("last_name", "Last name", row.last_name || ""),
    textInput("email", "Email", row.email || "", "type=\"email\""),
    `<label>Role<select name="role">${roleOptions}</select></label>`,
    `<label>Active status<select name="active">${activeOptions}</select></label>`,
  ];
  if (!id) fields.push(`<label>Password<input name="password" type="password" autocomplete="new-password" required></label>`);
  const errorBox = errors.length ? `<section class="panel"><ul class="error">${errors.map((err) => `<li>${esc(err)}</li>`).join("")}</ul></section>` : "";
  const passwordLink = id ? `<a class="button secondary" href="/users/${id}/password">Reset Password</a>` : "";
  const deactivateForm = id ? `<form method="post" action="/users/${id}/deactivate" class="delete-form" onsubmit="return confirm('Deactivate this user? They will no longer be able to sign in.');"><button class="danger">Deactivate</button><span class="muted">Users are deactivated for safety and audit continuity, not deleted.</span></form>` : "";
  return `${errorBox}<form method="post" action="${id ? `/users/${id}/edit` : "/users/new"}" class="panel"><div class="grid">${fields.join("")}</div><p><button>Save User</button> <a class="button secondary" href="/users">Cancel</a> ${passwordLink}</p></form>${deactivateForm}`;
}

async function usersPage(request, env, user, path) {
  const access = requireView(user, "User Management");
  if (access) return errorResponse(access, user, path);
  const url = new URL(request.url);
  const filters = userFilters(url);
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const where = userWhere(filters);
  const sort = listSort(url, USER_SORTS, "username", { sortName: "sort", dirName: "dir" });
  const countRow = await first(env, `SELECT COUNT(*) AS total FROM users${where.sql}`, where.params);
  const rows = await all(env, `SELECT id, username, first_name, last_name, email, role, active, created_at FROM users${where.sql} ORDER BY ${sort.order}, id LIMIT 25 OFFSET ?`, [...where.params, (page - 1) * 25]);
  const params = userParams(filters, sort);
  const roleOptions = `<option value="">All roles</option>${USER_ROLES.map(([value, label]) => `<option value="${esc(value)}"${filters.role === value ? " selected" : ""}>${esc(label)}</option>`).join("")}`;
  const activeOptions = `<option value="">All users</option><option value="active"${filters.active === "active" ? " selected" : ""}>Active</option><option value="inactive"${filters.active === "inactive" ? " selected" : ""}>Inactive</option>`;
  const body = rows.map((row) => `<tr><td><a href="/users/${row.id}/edit">${esc(row.username)}</a></td><td>${esc(`${row.first_name || ""} ${row.last_name || ""}`.trim())}</td><td>${esc(row.email || "")}</td><td>${esc(USER_ROLE_LABELS[row.role] || row.role)}</td><td>${Number(row.active) ? "Active" : "Inactive"}</td><td><a href="/users/${row.id}/edit">Edit</a> <a href="/users/${row.id}/password">Password</a></td></tr>`);
  const toolbar = `<div class="toolbar list-toolbar"><form method="get" class="list-query-form"><div class="list-search-row"><input name="q" value="${esc(filters.q)}" placeholder="Search users"><button>Apply</button><a class="button secondary" href="/users">Clear</a></div><details class="list-filters" open><summary>Filters</summary><div class="list-filter-grid"><label>Role<select name="role">${roleOptions}</select></label><label>Status<select name="active">${activeOptions}</select></label></div></details></form><div><a class="button" href="/users/new">New User</a> <a class="button secondary" href="/users/export.csv${params.toString() ? `?${params.toString()}` : ""}">Export CSV</a></div></div>`;
  const headers = sortableHeaders([
    { key: "username", label: "Username" }, { key: "name", label: "Name" }, { key: "email", label: "Email" }, { key: "role", label: "Role" }, { key: "active", label: "Status" }, { label: "Actions" },
  ], sort, params);
  const content = `${messagePanel(url)}<section class="panel">${toolbar}</section>${table(headers, body, { empty: "No users found." })}${paginationWithParams("/users", params, page, Number(countRow?.total || 0))}`;
  return html(layout({ title: "User Management", user, path, content }));
}

async function userFormPage(request, env, user, path, id = null) {
  const access = requireEdit(user, "User Management");
  if (access) return errorResponse(access, user, path);
  const existing = id ? await first(env, "SELECT * FROM users WHERE id=?", [id]) : null;
  if (id && !existing) return html(layout({ title: "User Not Found", user, path, content: `<section class="panel"><p class="error">User not found.</p></section>` }), 404);
  if (request.method === "POST") {
    const data = await parseForm(request);
    const values = userFormValues(data, existing || {});
    const password = (data.password || "").trim();
    const errors = await validateUserForm(env, values, id, password);
    if (errors.length) return html(layout({ title: id ? "Edit User" : "New User", user, path, content: userFormContent(values, id, errors) }), 400);
    if (id) {
      await run(env, "UPDATE users SET username=?, first_name=?, last_name=?, email=?, role=?, active=? WHERE id=?", [values.username, values.first_name, values.last_name, values.email, values.role, values.active, id]);
      return redirect(`/users?ok=${encodeURIComponent("User updated.")}`);
    }
    const passwordHash = await hashPassword(password);
    await run(env, "INSERT INTO users (username, password_hash, first_name, last_name, email, role, active) VALUES (?, ?, ?, ?, ?, ?, ?)", [values.username, passwordHash, values.first_name, values.last_name, values.email, values.role, values.active]);
    return redirect(`/users?ok=${encodeURIComponent("User created.")}`);
  }
  return html(layout({ title: id ? "Edit User" : "New User", user, path, content: userFormContent(userFormValues({}, existing || { role: "viewer", active: 1 }), id) }));
}

function passwordFormContent(target, errors = []) {
  const errorBox = errors.length ? `<section class="panel"><ul class="error">${errors.map((err) => `<li>${esc(err)}</li>`).join("")}</ul></section>` : "";
  return `${errorBox}<form method="post" action="/users/${target.id}/password" class="panel"><p class="muted">Reset password for <strong>${esc(target.username)}</strong>. Password hashes are never shown or exported.</p><div class="grid"><label>New password<input name="password" type="password" autocomplete="new-password" required></label><label>Confirm password<input name="confirm_password" type="password" autocomplete="new-password" required></label></div><p><button>Reset Password</button> <a class="button secondary" href="/users/${target.id}/edit">Cancel</a></p></form>`;
}

async function userPasswordPage(request, env, user, path, id) {
  const access = requireEdit(user, "User Management");
  if (access) return errorResponse(access, user, path);
  const target = await first(env, "SELECT id, username FROM users WHERE id=?", [id]);
  if (!target) return html(layout({ title: "User Not Found", user, path, content: `<section class="panel"><p class="error">User not found.</p></section>` }), 404);
  if (request.method === "POST") {
    const data = await parseForm(request);
    const password = (data.password || "").trim();
    const confirm = (data.confirm_password || "").trim();
    const errors = [];
    if (!password) errors.push("Password is required.");
    if (password !== confirm) errors.push("Password confirmation does not match.");
    if (errors.length) return html(layout({ title: "Reset Password", user, path, content: passwordFormContent(target, errors) }), 400);
    await run(env, "UPDATE users SET password_hash=? WHERE id=?", [await hashPassword(password), id]);
    return redirect(`/users?ok=${encodeURIComponent("Password reset.")}`);
  }
  return html(layout({ title: "Reset Password", user, path, content: passwordFormContent(target) }));
}

async function userDeactivatePage(request, env, user, path, id) {
  const access = requireEdit(user, "User Management");
  if (access) return errorResponse(access, user, path);
  if (request.method !== "POST") return html(layout({ title: "Method Not Allowed", user, path, content: `<section class="panel"><p class="error">Deactivate requires POST.</p></section>` }), 405);
  const target = await first(env, "SELECT * FROM users WHERE id=?", [id]);
  if (!target) return redirect(`/users?error=${encodeURIComponent("User not found.")}`);
  if (Number(user.id) === Number(id)) return redirect(`/users?error=${encodeURIComponent("You cannot deactivate your own account.")}`);
  if (target.role === "admin" && Number(target.active) === 1 && await activeAdminCount(env, id) <= 0) {
    return redirect(`/users?error=${encodeURIComponent("At least one active admin account is required.")}`);
  }
  await run(env, "UPDATE users SET active=0 WHERE id=?", [id]);
  return redirect(`/users?ok=${encodeURIComponent("User deactivated.")}`);
}

async function usersExportPage(request, env, user, path) {
  const access = requireView(user, "User Management");
  if (access) return errorResponse(access, user, path);
  const filters = userFilters(new URL(request.url));
  const where = userWhere(filters);
  const sort = listSort(new URL(request.url), USER_SORTS, "username");
  const rows = await all(env, `SELECT username, first_name, last_name, email, role, active FROM users${where.sql} ORDER BY ${sort.order}, id`, where.params);
  const lines = [quotedCsvRow(["Username", "First Name", "Last Name", "Email", "Role", "Active"])];
  for (const row of rows) lines.push(quotedCsvRow([row.username, row.first_name, row.last_name, row.email, USER_ROLE_LABELS[row.role] || row.role, Number(row.active) ? "Active" : "Inactive"]));
  return csv(lines.join("\n"), "users.csv");
}

async function placeholder(title, user, path, page) {
  const access = requireView(user, page);
  if (access) return errorResponse(access, user, path);
  return html(layout({ title, user, path, content: `<section class="panel"><p>${esc(title)} route is wired for the Cloudflare rewrite. Full workflow parity will be ported from Django in the matching migration phase.</p></section>` }));
}

function unavailablePage() {
  return `<!doctype html><html lang="en"><head>${appHead("GMT Trucking temporarily unavailable", { script: false })}</head><body class="login"><section class="login-card"><h1>GMT Trucking</h1><h2>Application setup required</h2><p>The application could not reach its required setup data. No data was changed.</p><p class="muted">An administrator should verify the Cloudflare D1 database binding and setup, then sign in and open Data Tools for the staged live-use checklist.</p><p><a class="button" href="/login">Return to sign in</a></p></section></body></html>`;
}

export async function handleRequest(request, env) {
  try {
    return await handleApplicationRequest(request, env);
  } catch (error) {
    console.error("GMT Cloudflare request failed", { path: new URL(request.url).pathname, error: String(error?.stack || error) });
    return html(unavailablePage(), 503);
  }
}

async function handleApplicationRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (path === "/health") return json({ ok: true, runtime: "cloudflare", database: Boolean(env.DB) });
  if (path === "/login") return login(request, env);
  if (path === "/logout" && request.method === "POST") return redirectWithHeaders("/login", clearSessionHeaders());

  let match;
  const user = await readSession(request, env);
  if (!user) return redirect("/login");
  user.appName = env.GMT_APP_NAME || "GMT Trucking";

  match = path.match(/^\/quick-create\/(client|employee|asset|supplier|recurring)$/);
  if (match) return quickCreatePage(request, env, user, match[1], url.searchParams.get("context") || "");

  if (path === "/") return dashboardPage(request, env, user, path);
  for (const [base, spec] of Object.entries(MASTER)) {
    if (path === base) return masterList(request, env, user, path, spec);
    if (path === `${base}/new`) return masterForm(request, env, user, base, spec);
    const edit = path.match(new RegExp(`^${base}/(\\d+)/edit$`));
    if (edit) return masterForm(request, env, user, base, spec, Number(edit[1]));
    const del = path.match(new RegExp(`^${base}/(\\d+)/delete$`));
    if (del) return masterDelete(request, env, user, base, spec, Number(del[1]));
    if (path === `${base}/export.csv`) return masterExport(request, env, user, base, spec);
  }
  if (path === "/projects" || path.startsWith("/projects/")) {
    const response = await handleProjects({ request, env, user, path });
    if (response) return response;
  }
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
  match = path.match(/^\/trips\/(\d+)\/status$/);
  if (match) return tripStatusPage(request, env, user, path, Number(match[1]));
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
  if (path === "/reports") return reportWorkspace(request, env, user, path);
  if (path === "/reports/print") return reportWorkspace(request, env, user, path, { print: true });
  if (path === "/reports/export.csv") return reportWorkspace(request, env, user, path, { exportCsv: true });
  if (path === "/settings") return settingsPage(request, env, user, path);
  if (path === "/data-tools") return dataToolsPage(request, env, user, path);
  if (path === "/data-tools/checklist") return dataToolsChecklistPage(request, env, user, path);
  if (path === "/data-tools/export.json") return dataToolsExportPage(request, env, user, path);
  if (path === "/users") return usersPage(request, env, user, path);
  if (path === "/users/new") return userFormPage(request, env, user, path);
  if (path === "/users/export.csv") return usersExportPage(request, env, user, path);
  match = path.match(/^\/users\/(\d+)\/edit$/);
  if (match) return userFormPage(request, env, user, path, Number(match[1]));
  match = path.match(/^\/users\/(\d+)\/password$/);
  if (match) return userPasswordPage(request, env, user, path, Number(match[1]));
  match = path.match(/^\/users\/(\d+)\/deactivate$/);
  if (match) return userDeactivatePage(request, env, user, path, Number(match[1]));
  return html(layout({ title: "Not Found", user, path, content: `<section class="panel"><p>Route not found.</p></section>` }), 404);
}
