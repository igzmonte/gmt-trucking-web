import { canEdit, canView } from "./access.mjs";
import { esc, peso } from "./utils.mjs";

const nav = [
  ["Overview", [["Dashboard", "/"]]],
  ["Operations", [["Trips", "/trips"], ["Recurring Trips", "/recurring-trips"], ["Vale / Cash Advance", "/advances"]]],
  ["Maintenance", [["Repairs", "/repairs"]]],
  ["Master Data", [["Employees", "/employees"], ["Fleet / Equipment", "/fleet"], ["Clients", "/clients"], ["Suppliers", "/suppliers"]]],
  ["Finance", [["Payroll", "/payroll"], ["Billing", "/billing"], ["Collections", "/collections"], ["Payables", "/payables"], ["Reports", "/reports"]]],
  ["System", [["User Management", "/users"]]],
];

export function layout({ title, user, path = "/", content }) {
  const menu = nav.map(([group, items]) => {
    const links = items.filter(([page]) => canView(user, page)).map(([page, href]) => {
      const active = path === href || (href !== "/" && path.startsWith(href));
      const extras = canEdit(user, page) && page === "Trips" ? `<a class="sub" href="/trips/new">+ New Trip Details</a>` : "";
      return `<a class="${active ? "active" : ""}" href="${href}">${esc(page === "Trips" ? "Trips List" : page)}</a>${extras}`;
    }).join("");
    return links ? `<section><h2>${esc(group)}</h2>${links}</section>` : "";
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · GMT</title><link rel="stylesheet" href="/app.css"></head><body><div class="shell"><aside><h1>GMT Trucking</h1><p class="user">${esc(user?.username || "")} · ${esc(user?.role || "")}</p><nav>${menu}</nav><form method="post" action="/logout"><button>Sign out</button></form></aside><main><header><h2>${esc(title)}</h2><span>GMT Cloudflare Migration</span></header>${content}</main></div></body></html>`;
}

export function loginPage(error = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · GMT</title><link rel="stylesheet" href="/app.css"></head><body class="login"><form method="post" class="login-card"><h1>GMT Trucking</h1><p>Sign in to the Cloudflare migration preview.</p>${error ? `<p class="error">${esc(error)}</p>` : ""}<label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button><p><small>Preview: test_admin / characterization-only</small></p></form></body></html>`;
}

export function cards(items) {
  return `<div class="cards">${items.map(([label, value]) => `<div class="card"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("")}</div>`;
}

export function table(headers, rows, { empty = "No records found." } = {}) {
  return `<div class="panel"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.join("") : `<tr><td colspan="${headers.length}">${esc(empty)}</td></tr>`}</tbody></table></div>`;
}

export function textInput(name, label, value = "", attrs = "") {
  return `<label>${esc(label)}<input name="${esc(name)}" value="${esc(value)}" ${attrs}></label>`;
}

export function numberInput(name, label, value = "0") {
  return textInput(name, label, value, `type="number" step="0.01"`);
}

export function selectInput(name, label, rows, selected = "", labeler = (row) => row.name, blank = "---------") {
  return `<label>${esc(label)}<select name="${esc(name)}"><option value="">${esc(blank)}</option>${rows.map((row) => `<option value="${esc(row.id)}"${String(selected) === String(row.id) ? " selected" : ""}>${esc(labeler(row))}</option>`).join("")}</select></label>`;
}

export function formPanel(action, fields, submit = "Save") {
  return `<form method="post" action="${esc(action)}" class="panel"><div class="grid">${fields.join("")}</div><p><button>${esc(submit)}</button> <a class="button secondary" href="javascript:history.back()">Cancel</a></p></form>`;
}

export function moneyCell(value) {
  return `<td class="num">${esc(peso(value))}</td>`;
}
