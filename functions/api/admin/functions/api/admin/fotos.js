import { requireAdmin } from "./auth.js";

const PUBLIC_URL =
  "https://pub-0d961880c43e4ed59f5117c94ea18f93.r2.dev";

const MAX_FOTOS = 5;
const MAX_BYTES = 5 * 1024 * 1024;

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

  if (!env.DB || !env.FOTOS_BUCKET) {
    return json({
      error: "Verifique as associações DB e FOTOS_BUCKET."
    }, 500);
  }

  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return json({ error: "Envie as imagens pelo formulário." }, 415);
  }

  let form;

  try {
    form = await request.formData();
  } catch {
    return json({ error: "Não foi possível ler os arquivos enviados." }, 400);
  }

  const imovelId = validId(form.get("idImovel"));
  const fotos = form.getAll("fotos");

  if (!imovelId) {
    return json({
      error: "Código de imóvel inválido. Salve o imóvel primeiro."
    }, 400);
  }

  if (
    fotos.length < 1 ||
    fotos.length > MAX_FOTOS ||
    fotos.some(foto => typeof foto.arrayBuffer !== "function")
  ) {
    return json({ error: "Selecione de 1 a 5 imagens." }, 400);
  }

  try {
    const imovel = await env.DB.prepare(
      "SELECT id FROM imoveis WHERE id = ?"
    ).bind(imovelId).first();

    if (!imovel) {
      return json({ error: "Imóvel não encontrado no D1." }, 404);
    }

    const contagem = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM fotos_imoveis WHERE imovel_id = ?"
    ).bind(imovelId).first();

    if (Number(contagem?.total || 0) + fotos.length > MAX_FOTOS) {
      return json({
        error: `Este imóvel já tem ${contagem?.total || 0} foto(s). O limite total é de 5.`
      }, 400);
    }
  } catch {
    return json({ error: "Não foi possível consultar o imóvel e suas fotos." }, 500);
  }

  const salvas = [];

  try {
    for (let i = 0; i < fotos.length; i++) {
      const foto = fotos[i];

      if (!["image/jpeg", "image/png"].includes(foto.type)) {
        throw new Error("Envie somente imagens JPG ou PNG.");
      }

      if (foto.size <= 0 || foto.size > MAX_BYTES) {
        throw new Error("Cada foto deve ter no máximo 5 MB.");
      }

      const bytes = new Uint8Array(await foto.arrayBuffer());

      if (!validImage(bytes, foto.type)) {
        throw new Error("Uma das imagens não é um JPG ou PNG válido.");
      }

      const extensao = foto.type === "image/png" ? "png" : "jpg";
      const chave = `imoveis/${imovelId}/${crypto.randomUUID()}.${extensao}`;
      const url = `${PUBLIC_URL}/${chave}`;

      await env.FOTOS_BUCKET.put(chave, bytes, {
        httpMetadata: {
          contentType: foto.type,
          cacheControl: "public, max-age=31536000, immutable"
        }
      });

      salvas.push({ chave, url, tipo: foto.type, tamanho: foto.size });

      const resultado = await env.DB.prepare(`
        INSERT INTO fotos_imoveis
          (imovel_id, chave_r2, url, tipo, tamanho, ordem)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        imovelId,
        chave,
        url,
        foto.type,
        foto.size,
        (Number(i) + 1)
      ).run();

      salvas[salvas.length - 1].registroId =
        resultado.meta?.last_row_id;
    }

    return json({
      success: true,
      message: "Fotos enviadas e registradas com sucesso.",
      idImovel: imovelId,
      fotos: salvas.map(foto => ({
        url: foto.url,
        tipo: foto.tipo,
        tamanho: foto.tamanho
      }))
    }, 201);
  } catch (error) {
    await Promise.all(salvas.map(async foto => {
      if (foto.registroId) {
        await env.DB.prepare(
          "DELETE FROM fotos_imoveis WHERE id = ?"
        ).bind(foto.registroId).run().catch(() => {});
      }

      await env.FOTOS_BUCKET.delete(foto.chave).catch(() => {});
    }));

    return json({
      error: error.message || "Não foi possível salvar as fotos."
    }, 400);
  }
}
