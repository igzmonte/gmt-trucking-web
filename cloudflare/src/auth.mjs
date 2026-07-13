const encoder = new TextEncoder();

function b64(bytes) {
  const raw = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function unb64(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return b64(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export async function verifyPassword(password, encoded) {
  const [kind, iterations, salt64, hash64] = String(encoded || "").split("$");
  if (kind !== "pbkdf2_sha256") return false;
  const salt = unb64(salt64);
  const expected = hash64;
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: Number(iterations), hash: "SHA-256" },
    key,
    256,
  );
  return b64(bits) === expected;
}

export async function createSession(user, secret) {
  const payload = b64(encoder.encode(JSON.stringify({
    id: user.id,
    username: user.username,
    role: user.role,
    active: user.active,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12,
  })));
  const signature = await hmac(secret, payload);
  return `${payload}.${signature}`;
}

export async function readSession(request, env) {
  const cookie = request.headers.get("cookie") || "";
  const match = /(?:^|;\s*)gmt_session=([^;]+)/.exec(cookie);
  if (!match) return null;
  const [payload, signature] = match[1].split(".");
  if (!payload || !signature) return null;
  const expected = await hmac(env.GMT_SESSION_SECRET || "development-secret", payload);
  if (signature !== expected) return null;
  try {
    const user = JSON.parse(new TextDecoder().decode(unb64(payload)));
    if (user.exp < Math.floor(Date.now() / 1000)) return null;
    return user;
  } catch {
    return null;
  }
}

export function clearSessionHeaders() {
  return { "set-cookie": "gmt_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" };
}

export function sessionHeaders(token) {
  return { "set-cookie": `gmt_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200` };
}
