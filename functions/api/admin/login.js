const COOKIE_NAME = "__Host-casapropria_session";
const SESSION_SECONDS = 8 * 60 * 60;

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlToBytes(value) {
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

  return bytesToBase64Url(new Uint8Array(signature));
}

function cookieHeader(value, maxAge) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) {
    return json({ error: "Configuração de autenticação incompleta." }, 500);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }

  if (typeof body.password !== "string" || body.password.length > 1024) {
    return json({ error: "Senha inválida." }, 400);
  }

  const encoder = new TextEncoder();
  const expected = encoder.encode(env.ADMIN_PASSWORD);
  const supplied = encoder.encode(body.password);

  let difference = expected.length ^ supplied.length;
  const max = Math.max(expected.length, supplied.length);

  for (let i = 0; i < max; i++) {
    difference |= (expected[i] || 0) ^ (supplied[i] || 0);
  }

  if (difference !== 0) {
    return json({ error: "Senha incorreta." }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = bytesToBase64Url(
    encoder.encode(JSON.stringify({
      exp: now + SESSION_SECONDS,
      nonce: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)))
    }))
  );

  const signature = await sign(payload, env.ADMIN_SESSION_SECRET);
  const token = `${payload}.${signature}`;

  return json(
    { success: true },
    200,
    { "Set-Cookie": cookieHeader(token, SESSION_SECONDS) }
  );
}

export async function onRequestGet() {
  return json({ error: "Use POST para entrar." }, 405, { Allow: "POST" });
}
