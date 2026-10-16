import { requireAdmin } from "./auth.js";

const PUBLIC_URL =
  "https://pub-0d961880c43e4ed59f5117c94ea18f93.r2.dev";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function validId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function validImage(bytes, type) {
  if (type === "image/jpeg") {
    return bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff;
  }

  if (type === "image/png") {
    return bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a;
  }

  return false;
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;

  if (!env.FOTOS_BUCKET) {
    return json({
      error: "O bucket FOTOS_BUCKET não está associado à aplicação."
    }, 500);
  }

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return json({ error: "Envie as fotos pelo formulário." }, 415);
  }

  let form;

  try {
    form = await request.formData();
  } catch {
    return json({ error: "Não foi possível ler os arquivos enviados." }, 400);
  }

  const idImovel = validId(form.get("idImovel"));
  const fotos = form.getAll("fotos");

  if (!idImovel) {
    return json({
      error: "Salve o imóvel primeiro para obter seu código."
    }, 400);
  }

  if (fotos.length < 1 || fotos.length > 5) {
    return json({ error: "Selecione de 1 a 5 fotos por envio." }, 400);
  }

  const salvas = [];

  try {
    for (const foto of fotos) {
      if (
        typeof foto.arrayBuffer !== "function" ||
        !["image/jpeg", "image/png"].includes(foto.type)
      ) {
        throw new Error("Envie somente imagens JPG ou PNG.");
      }

      if (foto.size <= 0 || foto.size > 5 * 1024 * 1024) {
        throw new Error("Cada foto deve ter no máximo 5 MB.");
      }

      const bytes = new Uint8Array(await foto.arrayBuffer());

      if (!validImage(bytes, foto.type)) {
        throw new Error("Uma das imagens não é um JPG ou PNG válido.");
      }

      const extensao = foto.type === "image/png" ? "png" : "jpg";
      const chave =
        `imoveis/${idImovel}/${crypto.randomUUID()}.${extensao}`;

      await env.FOTOS_BUCKET.put(chave, bytes, {
        httpMetadata: {
          contentType: foto.type,
          cacheControl: "public, max-age=31536000, immutable"
        }
      });

      salvas.push({
        chave,
        url: `${PUBLIC_URL}/${chave}`,
        tipo: foto.type,
        tamanho: foto.size
      });
    }

    return json({
      success: true,
      message: "Fotos enviadas para o R2.",
      idImovel,
      fotos: salvas
    }, 201);
  } catch (error) {
    await Promise.all(
      salvas.map(foto =>
        env.FOTOS_BUCKET.delete(foto.chave).catch(() => {})
      )
    );

    return json({
      error: error.message || "Não foi possível enviar as fotos."
    }, 400);
  }
}
