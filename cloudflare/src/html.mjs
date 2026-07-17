import { canEdit, canView } from "./access.mjs";
import { esc, peso } from "./utils.mjs";

const nav = [
  ["Overview", [["Dashboard", "/"]]],
  ["Operations", [["Trips", "/trips"], ["Recurring Trips", "/recurring-trips"], ["Vale / Cash Advance", "/advances"]]],
  ["Maintenance", [["Repairs", "/repairs"]]],
  ["Master Data", [["Employees", "/employees"], ["Fleet / Equipment", "/fleet"], ["Clients", "/clients"], ["Suppliers", "/suppliers"]]],
  ["Finance", [["Payroll", "/payroll"], ["Billing", "/billing"], ["Collections", "/collections"], ["Payables", "/payables"], ["Reports", "/reports"]]],
  ["System", [["User Management", "/users"], ["Settings", "/settings"], ["Data Tools", "/data-tools"]]],
];

export function layout({ title, user, path = "/", content, appName = "GMT Trucking" }) {
  const brand = user?.appName || appName;
  const menu = nav.map(([group, items]) => {
    const links = items.filter(([page]) => canView(user, page)).map(([page, href]) => {
      const active = path === href || (href !== "/" && path.startsWith(href));
      const extras = canEdit(user, page) && page === "Trips" ? `<a class="nav-sub" href="/trips/new">New Trip Details</a>` : "";
      return `<a class="nav-link${active ? " active" : ""}" href="${href}">${esc(page === "Trips" ? "Trips List" : page)}</a>${extras}`;
    }).join("");
    return links ? `<section class="nav-group"><h2>${esc(group)}</h2>${links}</section>` : "";
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ${esc(brand)}</title><link rel="stylesheet" href="/app.css"><script>document.documentElement.classList.add('js')</script><script defer src="/app.js"></script></head><body><div class="app-shell"><aside class="sidebar"><div class="sidebar-brand"><h1>${esc(brand)}</h1><p>${esc(user?.username || "")} · ${esc(user?.role || "")}</p></div><div class="sidebar-scroll"><nav>${menu}</nav></div><form class="sidebar-footer" method="post" action="/logout"><button class="button secondary">Sign out</button></form></aside><main class="app-main"><header class="page-header"><h1>${esc(title)}</h1><span>${esc(brand)}</span></header><div class="page-content">${content}</div></main></div></body></html>`;
}

export function loginPage(error = "", appName = "GMT Trucking") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · ${esc(appName)}</title><link rel="stylesheet" href="/app.css"></head><body class="login"><form method="post" class="login-card"><h1>${esc(appName)}</h1><p class="muted">Sign in to continue.</p>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}<label>Username<input name="username" autocomplete="username" required autofocus></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form></body></html>`;
}

export function cards(items) {
  return `<div class="metric-grid">${items.map(([label, value]) => `<article class="metric-card"><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`).join("")}</div>`;
}

export function table(headers, rows, { empty = "No records found.", bare = false, className = "" } = {}) {
  const markup = `<div class="table-scroll ${esc(className)}"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.join("") : `<tr><td class="empty-state" colspan="${headers.length}">${esc(empty)}</td></tr>`}</tbody></table></div>`;
  return bare ? markup : `<section class="panel table-panel">${markup}</section>`;
}

export function textInput(name, label, value = "", attrs = "") {
  return `<label>${esc(label)}<input name="${esc(name)}" value="${esc(value)}" ${attrs}></label>`;
}

export function numberInput(name, label, value = "0") {
  return textInput(name, label, value, `type="number" step="0.01"`);
}

export function textareaInput(name, label, value = "", attrs = "") {
  return `<label>${esc(label)}<textarea name="${esc(name)}" ${attrs}>${esc(value)}</textarea></label>`;
}

export function selectInput(name, label, rows, selected = "", labeler = (row) => row.name, blank = "---------", { searchable = false, attrs = "" } = {}) {
  const options = `<option value="">${esc(blank)}</option>${rows.map((row) => `<option value="${esc(row.id)}"${String(selected) === String(row.id) ? " selected" : ""}>${esc(labeler(row))}</option>`).join("")}`;
  if (!searchable) return `<label>${esc(label)}<select name="${esc(name)}"${attrs ? ` ${attrs}` : ""}>${options}</select></label>`;
  const selectedRow = rows.find((row) => String(row.id) === String(selected));
  const selectedLabel = selectedRow ? labeler(selectedRow) : "";
  return `<label class="combobox-field">${esc(label)}<span class="combobox" data-combobox><input type="text" class="combobox-input" value="${esc(selectedLabel)}" placeholder="Search or select…" role="combobox" aria-expanded="false" aria-autocomplete="list" autocomplete="off" data-combobox-input><button class="combobox-toggle" type="button" tabindex="-1" aria-label="Show options" data-combobox-toggle>▾</button><span class="combobox-options" role="listbox" data-combobox-options></span><select name="${esc(name)}" data-searchable-select${attrs ? ` ${attrs}` : ""}>${options}</select></span></label>`;
}

export function formPanel(action, fields, submit = "Save", { className = "", enctype = "", cancelHref = "javascript:history.back()" } = {}) {
  return `<form method="post" action="${esc(action)}" class="panel app-form ${esc(className)}"${enctype ? ` enctype="${esc(enctype)}"` : ""}><div class="form-grid">${fields.join("")}</div><div class="form-actions"><button>${esc(submit)}</button><a class="button secondary" href="${esc(cancelHref)}">Cancel</a></div></form>`;
}

export function dialogShell({ title, subtitle = "", body, closeHref, wide = true }) {
  return `<dialog class="app-dialog${wide ? " app-dialog-wide" : ""}" open data-dialog><div class="dialog-header"><div><span class="dialog-kicker">${esc(subtitle)}</span><h2>${esc(title)}</h2></div><a class="dialog-close" href="${esc(closeHref)}" aria-label="Close">×</a></div><div class="dialog-body">${body}</div></dialog><div class="dialog-backdrop" data-dialog-backdrop></div>`;
}

export function moneyCell(value) {
  return `<td class="num">${esc(peso(value))}</td>`;
}
