export const APP_NAME = "GMT Trucking";

export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function money(value) {
  const n = Number(value || 0);
  return n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function peso(value) {
  return `₱ ${money(value)}`;
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export async function parseForm(request) {
  const form = await request.formData();
  return Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
}

export function redirect(location, status = 303) {
  return new Response(null, { status, headers: { Location: location } });
}

export function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...headers,
    },
  });
}

export function csv(body, filename) {
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function field(row, name, fallback = "") {
  return row?.[name] ?? fallback;
}
