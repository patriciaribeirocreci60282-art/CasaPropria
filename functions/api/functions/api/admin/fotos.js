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

async function authorize(request, env) {
  const auth = await requireAdmin(request, env);
  return auth.ok ? null : auth.response;
}

function safeName(name) {
  return String(name || "foto")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(-100);
}

function publicUrl(key) {
  return PUBLIC_URL + "/" +
    key.split("/").map(encodeURIComponent).join("/");
}

// Lista as fotos de um imóvel.
export async function onRequestGet({ request, env }) {
  const denied = await authorize(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const id = Number(url.searchParams.get("imovel_id"));

  if (!Number.isSafeInteger(id) || id < 1) {
    return json({ error: "Código do imóvel inválido." }, 400);
  }

  try {
    const result = await env.DB.prepare(`
      SELECT id, imovel_id, url, tipo, tamanho, ordem, data_cadastro
      FROM fotos_imoveis
      WHERE imovel_id = ?
      ORDER BY ordem, id
    `).bind(id).all();

    return json({ success: true, fotos: result.results || [] });
  } catch {
    return json({ error: "Não foi possível listar as fotos." }, 500);
  }
}

// Recebe até cinco imagens PNG ou JPG.
export async function onRequestPost({ request, env }) {
  const denied = await authorize(request, env);
  if (denied) return denied;

  if (!env.FOTOS_BUCKET) {
    return json({ error: "O vínculo FOTOS_BUCKET não está configurado." }, 500);
  }

  if (!request.headers.get("Content-Type")?.includes("multipart/form-data")) {
    return json({ error: "Envie as fotos usando um formulário multipart." }, 415);
  }

  let form;

  try {
    form = await request.formData();
  } catch {
    return json({ error: "Não foi possível ler os arquivos enviados." }, 400);
  }

  const imovelId = Number(form.get("imovel_id"));
  const fotos = form.getAll("fotos").filter(
    item => item && typeof item === "object" &&
      typeof item.arrayBuffer === "function" && item.size > 0
  );

  if (!Number.isSafeInteger(imovelId) || imovelId < 1) {
    return json({ error: "Código do imóvel inválido." }, 400);
  }

  if (fotos.length < 1 || fotos.length > MAX_FOTOS) {
    return json({ error: "Selecione de 1 a 5 fotos por envio." }, 400);
  }

  for (const foto of fotos) {
    if (!["image/jpeg", "image/png"].includes(foto.type)) {
      return json({
        error: "Formato não permitido. Use apenas PNG ou JPG."
      }, 400);
    }

    if (foto.size > MAX_BYTES) {
      return json({
        error: "Cada foto deve ter no máximo 5 MB."
      }, 400);
    }
  }

  try {
    const imovel = await env.DB.prepare(
      "SELECT id FROM imoveis WHERE id = ?"
    ).bind(imovelId).first();

    if (!imovel) {
      return json({ error: "Cadastre o imóvel antes de enviar as fotos." }, 404);
    }

    const existentes = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM fotos_imoveis WHERE imovel_id = ?"
    ).bind(imovelId).first();

    const totalAtual = Number(existentes?.total || 0);

    if (totalAtual + fotos.length > MAX_FOTOS) {
      return json({
        error: `Este imóvel já tem ${totalAtual} foto(s). O limite é 5.`
      }, 400);
    }

    const salvas = [];

    try {
      for (let i = 0; i < fotos.length; i++) {
        const foto = fotos[i];
        const tipo = foto.type;
        const extensao = tipo === "image/png" ? "png" : "jpg";
        const nome = safeName(foto.name || `foto.${extensao}`);
        const chave = `imoveis/${imovelId}/${crypto.randomUUID()}-${nome}`;
        const urlFoto = publicUrl(chave);
        const ordem = totalAtual + i + 1;

        await env.FOTOS_BUCKET.put(chave, foto.stream(), {
          httpMetadata: { contentType: tipo }
        });

        try {
          const result = await env.DB.prepare(`
            INSERT INTO fotos_imoveis
              (imovel_id, chave_r2, url, tipo, tamanho, ordem)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(
            imovelId, chave, urlFoto, tipo, foto.size, ordem
          ).run();

          salvas.push({
            id: result.meta?.last_row_id,
            imovel_id: imovelId,
            chave_r2: chave,
            url: urlFoto,
            tipo,
            tamanho: foto.size,
            ordem
          });
        } catch (error) {
          await env.FOTOS_BUCKET.delete(chave);
          throw error;
        }
      }
    } catch (error) {
      // Reverte os registros e arquivos deste envio se algo falhar.
      for (const foto of salvas) {
        await env.DB.prepare(
          "DELETE FROM fotos_imoveis WHERE id = ?"
        ).bind(foto.id).run();

        await env.FOTOS_BUCKET.delete(foto.chave_r2);
      }

      throw error;
    }

    return json({
      success: true,
      message: `${salvas.length} foto(s) enviada(s) com sucesso.`,
      fotos: salvas
    }, 201);
  } catch {
    return json({
      error: "Falha ao salvar as fotos no R2 e registrar no D1."
    }, 500);
  }
}

// Exclui uma foto pelo ID do registro na tabela fotos_imoveis.
export async function onRequestDelete({ request, env }) {
  const denied = await authorize(request, env);
  if (denied) return denied;

  if (!env.FOTOS_BUCKET) {
    return json({ error: "O vínculo FOTOS_BUCKET não está configurado." }, 500);
  }

  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));

  if (!Number.isSafeInteger(id) || id < 1) {
    return json({ error: "Informe o código da foto." }, 400);
  }

  try {
    const foto = await env.DB.prepare(
      "SELECT id, chave_r2 FROM fotos_imoveis WHERE id = ?"
    ).bind(id).first();

    if (!foto) {
      return json({ error: "Foto não encontrada." }, 404);
    }

    // Remove o arquivo do R2 antes de apagar o registro no D1.
    await env.FOTOS_BUCKET.delete(foto.chave_r2);

    await env.DB.prepare(
      "DELETE FROM fotos_imoveis WHERE id = ?"
    ).bind(id).run();

    return json({
      success: true,
      message: "Foto excluída com sucesso."
    });
  } catch {
    return json({ error: "Não foi possível excluir a foto." }, 500);
  }
}
