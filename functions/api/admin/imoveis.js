import { requireAdmin } from "./auth.js";

const R2_PUBLIC_HOST =
  "pub-0d961880c43e4ed59f5117c94ea18f93.r2.dev";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function clean(value, max = 500) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function numberOrNull(value, field) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Campo inválido: ${field}`);
  }

  return number;
}

function validId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function validatePhoto(value) {
  if (!value) return true;

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// Converte a URL pública do R2 na chave do objeto.
// Somente aceita o domínio público configurado para este projeto.
function r2KeyFromPublicUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value);

    if (
      url.protocol !== "https:" ||
      url.hostname !== R2_PUBLIC_HOST ||
      url.port ||
      url.username ||
      url.password
    ) {
      return null;
    }

    const segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map(segment => decodeURIComponent(segment));

    const key = segments.join("/");

    if (
      !key ||
      segments.some(segment =>
        !segment || segment === "." || segment === ".."
      ) ||
      !/^imoveis\/(?:pendentes|[1-9]\d*)\/.+/.test(key)
    ) {
      return null;
    }

    return key;
  } catch {
    return null;
  }
}

function readProperty(body) {
  const titulo = clean(body.titulo, 150);
  const tipo = clean(body.tipo, 60);
  const finalidade = clean(body.finalidade, 30) || "Venda";

  if (!titulo || !tipo) {
    throw new Error("Preencha o título e o tipo do imóvel.");
  }

  if (!["Venda", "Aluguel", "Locação", "Lançamento"].includes(finalidade)) {
    throw new Error("Finalidade inválida.");
  }

  const foto_url = clean(body.foto_url, 2000);

  if (!validatePhoto(foto_url)) {
    throw new Error("URL da foto inválida.");
  }

  // CORREÇÃO: Aceita explicitamente "Pendente", "Rascunho" ou "Publicado" enviado pelo front-end
  const statusInformado = clean(body.status, 20);
  const statusFinal = ["Pendente", "Rascunho", "Publicado"].includes(statusInformado)
    ? statusInformado
    : "Publicado";

  return {
    titulo,
    tipo,
    finalidade,
    descricao: clean(body.descricao, 5000),
    cidade: clean(body.cidade, 100),
    bairro: clean(body.bairro, 100),
    endereco: clean(body.endereco, 250),
    foto_url,
    preco: numberOrNull(body.preco, "preco"),
    area_m2: numberOrNull(body.area_m2, "area_m2"),
    quartos: numberOrNull(body.quartos, "quartos"),
    banheiros: numberOrNull(body.banheiros, "banheiros"),
    vagas: numberOrNull(body.vagas, "vagas"),
    destaque: body.destaque === true ? 1 : 0,
    lancamento: body.lancamento === true ? 1 : 0,
    status: statusFinal
  };
}

function propertyValues(p) {
  return [
    p.titulo,
    p.tipo,
    p.finalidade,
    p.descricao || null,
    p.cidade || null,
    p.bairro || null,
    p.endereco || null,
    p.preco,
    p.area_m2,
    p.quartos,
    p.banheiros,
    p.vagas,
    p.foto_url || null,
    p.destaque,
    p.lancamento,
    p.status
  ];
}

async function authorized(request, env) {
  return requireAdmin(request, env);
}

// CONSULTAR IMÓVEIS
export async function onRequestGet({ request, env }) {
  const auth = await authorized(request, env);
  if (!auth.ok) return auth.response;

  try {
    const url = new URL(request.url);
    const idParam = url.searchParams.get("id");
    const busca = clean(url.searchParams.get("busca") || "", 150);

    const query = `
      SELECT id, titulo, tipo, finalidade, descricao, cidade,
             bairro, endereco, preco, area_m2, quartos, banheiros,
             vagas, foto_url, destaque, lancamento, status, data_cadastro
      FROM imoveis
    `;

    let statement;

    if (idParam !== null) {
      const id = validId(idParam);

      if (!id) {
        return json({ error: "Código inválido." }, 400);
      }

      statement = env.DB.prepare(
        query + " WHERE id = ?"
      ).bind(id);
    } else if (busca) {
      const id = validId(busca);

      if (id) {
        statement = env.DB.prepare(
          query +
          " WHERE id = ? OR titulo LIKE ? ORDER BY data_cadastro DESC"
        ).bind(id, `%${busca}%`);
      } else {
        statement = env.DB.prepare(
          query + " WHERE titulo LIKE ? ORDER BY data_cadastro DESC"
        ).bind(`%${busca}%`);
      }
    } else {
      statement = env.DB.prepare(
        query + " ORDER BY data_cadastro DESC"
      );
    }

    if (idParam !== null) {
      const item = await statement.first();

      if (!item) {
        return json({ error: "Imóvel não encontrado." }, 404);
      }

      return json({ success: true, imovel: item });
    }

    const { results = [] } = await statement.all();

    return json({
      success: true,
      imoveis: results
    });
  } catch (error) {
    console.error("Erro ao consultar imóveis:", error);

    return json({
      error: "Erro ao consultar os imóveis."
    }, 500);
  }
}

// CADASTRAR IMÓVEL
export async function onRequestPost({ request, env }) {
  const auth = await authorized(request, env);
  if (!auth.ok) return auth.response;

  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    return json({
      error: "Envie os dados em formato JSON."
    }, 415);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Dados inválidos." }, 400);
  }

  let p;

  try {
    p = readProperty(body);
  } catch (error) {
    return json({
      error: error.message || "Dados inválidos."
    }, 400);
  }

  try {
    const result = await env.DB.prepare(`
      INSERT INTO imoveis (
        titulo, tipo, finalidade, descricao, cidade, bairro, endereco,
        preco, area_m2, quartos, banheiros, vagas, foto_url,
        destaque, lancamento, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(...propertyValues(p)).run();

    const id = result.meta?.last_row_id ?? null;

    return json({
      success: true,
      message: "Imóvel cadastrado com sucesso.",
      id,
      codigo: id
    }, 201);
  } catch (error) {
    console.error("Erro ao cadastrar imóvel:", error);

    return json({
      error: "Não foi possível salvar o imóvel no banco D1."
    }, 500);
  }
}

// EDITAR IMÓVEL
export async function onRequestPut({ request, env }) {
  const auth = await authorized(request, env);
  if (!auth.ok) return auth.response;

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Dados inválidos." }, 400);
  }

  const id = validId(body.id ?? body.codigo);

  if (!id) {
    return json({ error: "Informe o código do imóvel." }, 400);
  }

  let p;

  try {
    p = readProperty(body);
  } catch (error) {
    return json({
      error: error.message || "Dados inválidos."
    }, 400);
  }

  try {
    const result = await env.DB.prepare(`
      UPDATE imoveis SET
        titulo = ?, tipo = ?, finalidade = ?, descricao = ?,
        cidade = ?, bairro = ?, endereco = ?, preco = ?,
        area_m2 = ?, quartos = ?, banheiros = ?, vagas = ?,
        foto_url = ?, destaque = ?, lancamento = ?, status = ?
      WHERE id = ?
    `).bind(...propertyValues(p), id).run();

    if (!result.meta?.changes) {
      return json({
        error: "Imóvel não encontrado ou sem alterações."
      }, 404);
    }

    return json({
      success: true,
      message: "Imóvel atualizado com sucesso.",
      id,
      codigo: id
    });
  } catch (error) {
    console.error("Erro ao atualizar imóvel:", error);

    return json({
      error: "Não foi possível atualizar o imóvel no banco D1."
    }, 500);
  }
}

// EXCLUIR IMÓVEL, FOTO PRINCIPAL, GALERIA E REGISTROS NO D1
export async function onRequestDelete({ request, env }) {
  const auth = await authorized(request, env);
  if (!auth.ok) return auth.response;

  if (!env.FOTOS_BUCKET) {
    return json({
      error: "O vínculo FOTOS_BUCKET não está configurado."
    }, 500);
  }

  if (!env.DB) {
    return json({
      error: "O vínculo DB não está configurado."
    }, 500);
  }

  const url = new URL(request.url);
  const id = validId(url.searchParams.get("id"));

  if (!id) {
    return json({
      error: "Informe um código válido na URL."
    }, 400);
  }

  try {
    // 1. Recupera a URL da foto principal.
    const imovel = await env.DB.prepare(`
      SELECT id, foto_url
      FROM imoveis
      WHERE id = ?
    `).bind(id).first();

    if (!imovel) {
      return json({
        error: "Imóvel não encontrado."
      }, 404);
    }

    // 2. Recupera as fotos da galeria.
    const { results: fotos = [] } = await env.DB.prepare(`
      SELECT id, chave_r2
      FROM fotos_imoveis
      WHERE imovel_id = ?
      ORDER BY id
    `).bind(id).all();

    // 3. Reúne as chaves R2, sem duplicações.
    const keys = new Set();

    const mainKey = r2KeyFromPublicUrl(imovel.foto_url);

    if (mainKey) {
      keys.add(mainKey);
    }

    for (const foto of fotos) {
      if (!foto.chave_r2) {
        throw new Error(
          `A foto ${foto.id} não possui chave_r2 registrada.`
        );
      }

      keys.add(foto.chave_r2);
    }

    // 4. Exclui os arquivos no R2.
    for (const key of keys) {
      await env.FOTOS_BUCKET.delete(key);

      // O HEAD retorna null quando o objeto não existe.
      const restante = await env.FOTOS_BUCKET.head(key);

      if (restante) {
        throw new Error(
          `Não foi possível confirmar a exclusão do objeto R2: ${key}`
        );
      }
    }

    // 5. Remove os registros da galeria.
    await env.DB.prepare(`
      DELETE FROM fotos_imoveis
      WHERE imovel_id = ?
    `).bind(id).run();

    // 6. Remove o imóvel no D1.
    const result = await env.DB.prepare(`
      DELETE FROM imoveis
      WHERE id = ?
    `).bind(id).run();

    if (!result.meta?.changes) {
      return json({
        error: "Não foi possível confirmar a exclusão do imóvel."
      }, 500);
    }

    return json({
      success: true,
      message: "Imóvel e fotos excluídos com sucesso.",
      id,
      fotos_excluidas: keys.size
    });
  } catch (error) {
    console.error(
      `Erro ao excluir imóvel ${id} e suas fotos:`,
      error
    );

    return json({
      error:
        "Não foi possível excluir completamente o imóvel e suas fotos. Verifique os logs da função antes de tentar novamente."
    }, 500);
  }
}
