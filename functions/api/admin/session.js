import { requireAdmin } from "./auth.js";

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);

  if (!auth.ok) {
    return auth.response;
  }

  return Response.json(
    { authenticated: true },
    {
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
}
