const COOKIE_NAME = "__Host-casapropria_session";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );

  let binary = "";
  for (const byte of new Uint8Array(signature)) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";

  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;

    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }

  return null;
}

export async function requireAdmin(request, env) {
  if (!env.ADMIN_SESSION_SECRET) {
    return { ok: false, response: json({
      error: "Configuração de sessão incompleta."
    }, 500) };
  }

  const token = getCookie(request, COOKIE_NAME);

  if (!token || token.length > 2048) {
    return { ok: false, response: json({
      error: "Acesso não autorizado."
    }, 401) };
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return { ok: false, response: json({
      error: "Sessão inválida."
    }, 401) };
  }

  const [payload, suppliedSignature] = parts;

  try {
    const expectedSignature = await sign(
      payload,
      env.ADMIN_SESSION_SECRET
    );

    const expectedBytes = new TextEncoder().encode(expectedSignature);
    const suppliedBytes = new TextEncoder().encode(suppliedSignature);

    let difference = expectedBytes.length ^ suppliedBytes.length;
    const length = Math.max(expectedBytes.length, suppliedBytes.length);

    for (let i = 0; i < length; i++) {
      difference |= (expectedBytes[i] || 0) ^ (suppliedBytes[i] || 0);
    }

    if (difference !== 0) {
      return { ok: false, response: json({
        error: "Sessão inválida."
      }, 401) };
    }

    const decoded = new TextDecoder().decode(decodeBase64Url(payload));
    const session = JSON.parse(decoded);

    if (
      !Number.isInteger(session.exp) ||
      session.exp <= Math.floor(Date.now() / 1000) ||
      typeof session.nonce !== "string"
    ) {
      return { ok: false, response: json({
        error: "Sessão expirada."
      }, 401) };
    }

    return { ok: true };
  } catch {
    return { ok: false, response: json({
      error: "Não foi possível validar a sessão."
    }, 401) };
  }
}

export async function onRequestGet() {
  return json({ error: "Este arquivo é um módulo interno." }, 404);
}
