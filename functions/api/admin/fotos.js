import { requireAdmin } from "./auth.js";

const PUBLIC_URL =
  "https://pub-0d961880c43e4ed59f5117c94ea18f93.r2.dev";

const MAX_FOTOS = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png"
]);

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
  } catch (error) {
    console.error("Erro de autenticação:", error);

    return json({
      error: "Não foi possível verificar sua sessão. Entre novamente."
    }, 401);
  }
}

function safeName(name) {
  return String(name || "foto")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(-100) || "foto";
}

function publicUrl(key) {
  return PUBLIC_URL.replace(/\/+$/, "") + "/" +
    key.split("/").map(encodeURIComponent).join("/");
}

function errorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error || "Erro desconhecido");
}

function isFile(value) {
  return value &&
    typeof value === "object" &&
    typeof value.arrayBuffer === "function" &&
    typeof value.size === "number" &&
    value.size > 0;
}

function validId(value) {
  const id = Number(value);

  return Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

function validateFiles(files) {
  for (const file of files) {
    if (!ALLOWED_TYPES.has(file.type)) {
      return `O arquivo "${safeName(file.name)}" não é JPG, JPEG ou PNG.`;
    }

    if (file.size > MAX_BYTES) {
      return `A foto "${safeName(file.name)}" ultrapassa o limite de 10 MB.`;
    }
  }

  return null;
}

async function saveToR2(file, imovelId = null) {
  const extension = file.type === "image/png" ? "png" : "jpg";
  const originalName = safeName(file.name || `foto.${extension}`);
  const folder = imovelId
    ? `imoveis/${imovelId}`
    : "imoveis/pendentes";

  const key =
    `${folder}/${crypto.randomUUID()}-${originalName}`;

  await envPut(file, key);

  return {
    chave_r2: key,
    url: publicUrl(key),
    tipo: file.type,
    tamanho: file.size
  };
}

// Usa o binding R2 do ambiente.
// O binding FOTOS_BUCKET precisa estar configurado no Cloudflare.
async function envPut(file, key) {
  // A referência ao bucket é definida dentro dos handlers.
  throw new Error("Bucket não inicializado.");
}

// LISTAR FOTOS DE UM IMÓVEL
export async function onRequestGet({ request, env }) {
  const denied = await authorize(request, env);
  if (denied) return denied;

  if (!env.DB) {
    return json({
      error: "O vínculo DB não está configurado."
    }, 500);
  }

  const url = new URL(request.url);
  const imovelId = validId(url.searchParams.get("imovel_id"));

  if (!imovelId) {
    return json({
      error: "Código do imóvel inválido."
    }, 400);
  }

  try {
    const result = await env.DB.prepare(`
      SELECT id, imovel_id, chave_r2, url, tipo,
             tamanho, ordem, data_cadastro
      FROM fotos_imoveis
      WHERE imovel_id = ?
      ORDER BY ordem, id
    `).bind(imovelId).all();

    return json({
      success: true,
      fotos: result.results || []
    });
  } catch (error) {
    console.error(
      "Erro ao listar fotos:",
      errorMessage(error)
    );

    return json({
      error: "Não foi possível listar as fotos no banco de dados."
    }, 500);
  }
}

// ENVIAR FOTO ÚNICA OU GALERIA DE FOTOS
export async function onRequestPost({ request, env }) {
  const denied = await authorize(request, env);
  if (denied) return denied;

  if (!env.FOTOS_BUCKET) {
    return json({
      error: "O vínculo FOTOS_BUCKET não está configurado no Cloudflare."
    }, 500);
  }

  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return json({
      error: "Envie as imagens usando FormData."
    }, 415);
  }

  let form;

  try {
    form = await request.formData();
  } catch (error) {
    console.error(
      "Erro ao ler formulário:",
      errorMessage(error)
    );

    return json({
      error: "Não foi possível ler as fotos enviadas."
    }, 400);
  }

  // Compatibilidade com o HTML atual:
  // formData.append("file", file)
  const singleFile = form.get("file");

  // Compatibilidade com envio de galeria:
  // formData.append("fotos", file)
  const galleryFiles = form.getAll("fotos").filter(isFile);

  const files = [
    ...(isFile(singleFile) ? [singleFile] : []),
    ...galleryFiles
  ];

  if (files.length < 1 || files.length > MAX_FOTOS) {
    return json({
      error: "Selecione de 1 a 5 fotos por envio."
    }, 400);
  }

  const fileError = validateFiles(files);

  if (fileError) {
    return json({ error: fileError }, 400);
  }

  const imovelId = validId(form.get("imovel_id"));

  /*
   * MODO 1 — HTML atual:
   * envia apenas "file", antes de salvar o imóvel.
   *
   * A foto é enviada ao R2 e a API retorna { url }.
   * O HTML grava essa URL em imoveis.foto_url.
   */
  if (!imovelId) {
    if (files.length !== 1 || !isFile(singleFile)) {
      return json({
        error:
          "Para enviar várias fotos, informe imovel_id e salve o imóvel primeiro."
      }, 400);
    }

    try {
      const file = singleFile;
      const extension = file.type === "image/png" ? "png" : "jpg";
      const originalName = safeName(file.name || `foto.${extension}`);
      const key =
        `imoveis/pendentes/${crypto.randomUUID()}-${originalName}`;

      await env.FOTOS_BUCKET.put(key, file.stream(), {
        httpMetadata: {
          contentType: file.type,
          cacheControl: "public, max-age=31536000"
        }
      });

      const url = publicUrl(key);

      return json({
        success: true,
        message: "Foto enviada ao R2 com sucesso.",
        url,
        chave_r2: key,
        tipo: file.type,
        tamanho: file.size
      }, 201);
    } catch (error) {
      console.error(
        "Erro ao enviar foto ao R2:",
        errorMessage(error)
      );

      return json({
        error:
          "Não foi possível enviar a foto ao R2. Verifique o binding FOTOS_BUCKET e os logs da função."
      }, 500);
    }
  }

  /*
   * MODO 2 — Galeria vinculada a um imóvel existente.
   * Grava os arquivos no R2 e os registros no D1.
   */
  if (!env.DB) {
    return json({
      error: "O vínculo DB não está configurado."
    }, 500);
  }

  try {
    const imovel = await env.DB.prepare(
      "SELECT id FROM imoveis WHERE id = ?"
    ).bind(imovelId).first();

    if (!imovel) {
      return json({
        error: "Imóvel não encontrado. Salve o imóvel primeiro."
      }, 404);
    }

    const existentes = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM fotos_imoveis WHERE imovel_id = ?"
    ).bind(imovelId).first();

    const totalAtual = Number(existentes?.total || 0);

    if (totalAtual + files.length > MAX_FOTOS) {
      return json({
        error:
          `Este imóvel já possui ${totalAtual} foto(s). O limite total é de 5.`
      }, 400);
    }

    const salvas = [];
    const arquivosEnviados = [];

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const extension = file.type === "image/png" ? "png" : "jpg";
        const originalName = safeName(
          file.name || `foto.${extension}`
        );

        const key =
          `imoveis/${imovelId}/${crypto.randomUUID()}-${originalName}`;

        await env.FOTOS_BUCKET.put(key, file.stream(), {
          httpMetadata: {
            contentType: file.type,
            cacheControl: "public, max-age=31536000"
          }
        });

        arquivosEnviados.push(key);

        const url = publicUrl(key);
        const ordem = totalAtual + i + 1;

        const result = await env.DB.prepare(`
          INSERT INTO fotos_imoveis
            (imovel_id, chave_r2, url, tipo, tamanho, ordem)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          imovelId,
          key,
          url,
          file.type,
          file.size,
          ordem
        ).run();

        salvas.push({
          id: result.meta?.last_row_id ?? null,
          imovel_id: imovelId,
          chave_r2: key,
          url,
          tipo: file.type,
          tamanho: file.size,
          ordem
        });
      }
    } catch (error) {
      console.error(
        "Erro durante upload da galeria:",
        errorMessage(error)
      );

      // Desfaz os registros criados nesta operação.
      for (const foto of salvas) {
        if (foto.id != null) {
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
      }

      // Desfaz os arquivos criados no R2.
      for (const key of arquivosEnviados) {
        try {
          await env.FOTOS_BUCKET.delete(key);
        } catch (rollbackError) {
          console.error(
            "Erro ao remover arquivo do R2:",
            errorMessage(rollbackError)
          );
        }
      }

      throw error;
    }

    return json({
      success: true,
      message: `${salvas.length} foto(s) enviada(s) com sucesso.`,
      // Também retorna url para facilitar a integração com o HTML.
      url: salvas[0]?.url || null,
      fotos: salvas
    }, 201);

  } catch (error) {
    console.error(
      "Falha ao salvar fotos:",
      errorMessage(error)
    );

    return json({
      error:
        "Falha ao salvar as fotos. Verifique os vínculos R2 e D1 e os logs da função."
    }, 500);
  }
}

// EXCLUIR FOTO DA GALERIA
export async function onRequestDelete({ request, env }) {
  const denied = await authorize(request, env);
  if (denied) return denied;

  if (!env.DB) {
    return json({
      error: "O vínculo DB não está configurado."
    }, 500);
  }

  if (!env.FOTOS_BUCKET) {
    return json({
      error: "O vínculo FOTOS_BUCKET não está configurado."
    }, 500);
  }

  const url = new URL(request.url);
  const id = validId(url.searchParams.get("id"));

  if (!id) {
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
        error: "A foto não possui uma chave R2 válida."
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
    console.error(
      "Erro ao excluir foto:",
      errorMessage(error)
    );

    return json({
      error:
        "Não foi possível excluir a foto. Consulte os logs da função."
    }, 500);
  }
}
