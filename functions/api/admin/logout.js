const COOKIE_NAME = "__Host-casapropria_session";

function clearSession() {
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie":
        `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
    }
  });
}

export async function onRequestPost({ request }) {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);

  if (origin && origin !== url.origin) {
    return Response.json(
      { error: "Origem não autorizada." },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }

  return clearSession();
}

export async function onRequestGet() {
  return Response.json(
    { error: "Use POST para sair." },
    {
      status: 405,
      headers: {
        "Allow": "POST",
        "Cache-Control": "no-store"
      }
    }
  );
}
