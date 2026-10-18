import { requireAdmin } from "./auth.js";

const PUBLIC_URL =
  "https://pub-0d961880c43e4ed59f5117c94ea18f93.r2.dev";

const MAX_FOTOS = 5;
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png"]);

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

async function authorize(request, env) {
  try {
    const auth = await requireAdmin(request, env);
    return auth.ok ? null : auth.response;
  } catch {
    return json(
      { error: "Não foi possível verificar sua sessão. Entre novamente." },
      401
    );
  }
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

function errorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error || "Erro desconhecido");
}

// LISTAR FOTOS DE UM IMÓVEL
export async function onRequestGet({ request, env }) {
  const denied = await authorize(request, env);
  if (denied) return denied;

  if (!env.DB) {
    return json({ error: "O vínculo DB não está configurado." }, 500);
  }

  const url = new URL(request.url);
  const imovelId = Number(url.searchParams.get("imovel_id"));

  if (!Number.isSafeInteger(imovelId) || imovelId < 1) {
    return json({ error: "Código do imóvel inválido." }, 400);
  }

  try {
    const result = await env.DB.prepare(`
      SELECT id, imovel_id, url, tipo, tamanho, ordem, data_cadastro
      FROM fotos_imoveis
      WHERE imovel_id = ?
      ORDER BY ordem, id
    `).bind(imovelId).all();

    return json({
      success: true,
      fotos: result.results || []
    });
  } catch (error) {
    console.error("Erro ao listar fotos:", errorMessage(error));

    return json({
      error: "Não foi possível listar as fotos no banco de dados."
    }, 500);
  }
}

// ENVIAR FOTOS
export async function onRequestPost({ request, env }) {
  const denied = await authorize(request, env);
  if (denied) return denied;

  if (!env.DB) {
    return json({ error: "O vínculo DB não está configurado." }, 500);
  }

  if (!env.FOTOS_BUCKET) {
    return json({
      error: "O armazenamento FOTOS_BUCKET não está configurado no Cloudflare."
    }, 500);
  }

  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return json({
      error: "Envie as fotos usando FormData e multipart/form-data."
    }, 415);
  }

  let form;

  try {
    form = await request.formData();
  } catch (error) {
    console.error("Erro ao ler formulário:", errorMessage(error));

    return json({
      error: "Não foi possível ler as fotos enviadas. Tente novamente."
    }, 400);
  }

  const imovelId = Number(form.get("imovel_id"));

  const fotos = form.getAll("fotos").filter(item =>
    item &&
    typeof item === "object" &&
    typeof item.arrayBuffer === "function" &&
    item.size > 0
  );

  if (!Number.isSafeInteger(imovelId) || imovelId < 1) {
    return json({
      error: "Código do imóvel inválido. Salve o imóvel antes de enviar as fotos."
    }, 400);
  }

  if (fotos.length < 1 || fotos.length > MAX_FOTOS) {
    return json({
      error: "Selecione de 1 a 5 fotos por envio."
    }, 400);
  }

  for (const foto of fotos) {
    if (!ALLOWED_TYPES.has(foto.type)) {
      return json({
        error: `O arquivo "${safeName(foto.name)}" não é JPG ou PNG.`
      }, 400);
    }

    if (foto.size > MAX_BYTES) {
      return json({
        error: `A foto "${safeName(foto.name)}" ultrapassa o limite de 5 MB.`
      }, 400);
    }
  }

  try {
    const imovel = await env.DB.prepare(
      "SELECT id FROM imoveis WHERE id = ?"
    ).bind(imovelId).first();

    if (!imovel) {
      return json({
        error: "Imóvel não encontrado. Salve o cadastro antes de enviar as fotos."
      }, 404);
    }

    const existentes = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM fotos_imoveis WHERE imovel_id = ?"
    ).bind(imovelId).first();

    const totalAtual = Number(existentes?.total || 0);

    if (totalAtual + fotos.length > MAX_FOTOS) {
      return json({
        error: `Este imóvel já possui ${totalAtual} foto(s). O limite total é de 5.`
      }, 400);
    }

    const salvas = [];
    const arquivosEnviados = [];

    try {
      for (let i = 0; i < fotos.length; i++) {
        const foto = fotos[i];
        const tipo = foto.type;
        const extensao = tipo === "image/png" ? "png" : "jpg";
        const nome = safeName(foto.name || `foto.${extensao}`);

        const chave =
          `imoveis/${imovelId}/${crypto.randomUUID()}-${nome}`;

        const urlFoto = publicUrl(chave);
        const ordem = totalAtual + i + 1;

        // Salva a imagem no Cloudflare R2.
        await env.FOTOS_BUCKET.put(chave, foto.stream(), {
          httpMetadata: {
            contentType: tipo,
            cacheControl: "public, max-age=31536000"
          }
        });

        arquivosEnviados.push(chave);

        // Registra a imagem no banco D1.
        const result = await env.DB.prepare(`
          INSERT INTO fotos_imoveis
            (imovel_id, chave_r2, url, tipo, tamanho, ordem)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          imovelId,
          chave,
          urlFoto,
          tipo,
          foto.size,
          ordem
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
      }
    } catch (error) {
      console.error("Erro durante upload das fotos:", errorMessage(error));

      // Tenta desfazer os registros e arquivos criados nesta operação.
      for (const foto of salvas) {
        try {
          await env.DB.prepare(
            "DELETE FROM fotos_imoveis WHERE id = ?"
          ).bind(foto.id).run();
        } catch (rollbackError) {
          console.error(
            "Erro ao desfazer registro:",
            errorMessage(rollbackError)
          );
        }
      }

      for (const chave of arquivosEnviados) {
        try {
          await env.FOTOS_BUCKET.delete(chave);
        } catch (rollbackError) {
          console.error(
            "Erro ao remover arquivo:",
            errorMessage(rollbackError)
          );
        }
      }

      throw error;
    }

    return json({
      success: true,
      message: `${salvas.length} foto(s) enviada(s) com sucesso.`,
      fotos: salvas
    }, 201);

  } catch (error) {
    console.error("Falha ao salvar fotos:", errorMessage(error));

    return json({
      error: "Falha ao salvar as fotos. Verifique os vínculos R2 e D1 e os logs da função."
    }, 500);
  }
}

// EXCLUIR FOTO
export async function onRequestDelete({ request, env }) {
  const denied = await authorize(request, env);
  if (denied) return denied;

  if (!env.DB) {
    return json({ error: "O vínculo DB não está configurado." }, 500);
  }

  if (!env.FOTOS_BUCKET) {
    return json({
      error: "O armazenamento FOTOS_BUCKET não está configurado."
    }, 500);
  }

  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));

  if (!Number.isSafeInteger(id) || id < 1) {
    return json({
      error: "Informe um código de foto válido."
    }, 400);
  }

  try {
    const foto = await env.DB.prepare(
      "SELECT id, chave_r2 FROM fotos_imoveis WHERE id = ?"
    ).bind(id).first();

    if (!foto) {
      return json({
        error: "Foto não encontrada."
      }, 404);
    }

    if (!foto.chave_r2) {
      return json({
        error: "A foto não possui uma chave de armazenamento válida."
      }, 500);
    }

    await env.FOTOS_BUCKET.delete(foto.chave_r2);

    await env.DB.prepare(
      "DELETE FROM fotos_imoveis WHERE id = ?"
    ).bind(id).run();

    return json({
      success: true,
      message: "Foto excluída com sucesso."
    });
  } catch (error) {
    console.error("Erro ao excluir foto:", errorMessage(error));

    return json({
      error: "Não foi possível excluir a foto. Consulte os logs da função."
    }, 500);
  }
}
