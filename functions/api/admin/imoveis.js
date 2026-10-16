import { requireAdmin } from "./auth.js";

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
    status: body.status === "Rascunho" ? "Rascunho" : "Publicado"
  };
}

function propertyValues(p) {
  return [
    p.titulo, p.tipo, p.finalidade, p.descricao || null,
    p.cidade || null, p.bairro || null, p.endereco || null,
    p.preco, p.area_m2, p.quartos, p.banheiros, p.vagas,
    p.foto_url || null, p.destaque, p.lancamento, p.status
  ];
}

async function authorized(request, env) {
  return requireAdmin(request, env);
}

export async function onRequestGet({ request, env }) {
  const auth = await authorized(request, env);
  if (!auth.ok) return auth.response;

  try {
    const url = new URL(request.url);
    const idParam = url.searchParams.get("id");
    const busca = clean(url.searchParams.get("busca") || "", 150);

    let query = `
      SELECT id, titulo, tipo, finalidade, descricao, cidade,
             bairro, endereco, preco, area_m2, quartos, banheiros,
             vagas, foto_url, destaque, lancamento, status, data_cadastro
      FROM imoveis
    `;

    let statement;

    if (idParam !== null) {
      const id = validId(idParam);
      if (!id) return json({ error: "Código inválido." }, 400);

      statement = env.DB.prepare(query + " WHERE id = ?").bind(id);
    } else if (busca) {
      const id = validId(busca);

      if (id) {
        statement = env.DB.prepare(
          query + " WHERE id = ? OR titulo LIKE ? ORDER BY data_cadastro DESC"
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
      if (!item) return json({ error: "Imóvel não encontrado." }, 404);
      return json({ success: true, imovel: item });
    }

    const { results = [] } = await statement.all();
    return json({ success: true, imoveis: results });
  } catch {
    return json({ error: "Erro ao consultar os imóveis." }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  const auth = await authorized(request, env);
  if (!auth.ok) return auth.response;

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return json({ error: "Envie os dados em formato JSON." }, 415);
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
    return json({ error: error.message || "Dados inválidos." }, 400);
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
  } catch {
    return json({ error: "Não foi possível salvar o imóvel no banco D1." }, 500);
  }
}

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
  if (!id) return json({ error: "Informe o código do imóvel." }, 400);

  let p;

  try {
    p = readProperty(body);
  } catch (error) {
    return json({ error: error.message || "Dados inválidos." }, 400);
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
      return json({ error: "Imóvel não encontrado ou sem alterações." }, 404);
    }

    return json({
      success: true,
      message: "Imóvel atualizado com sucesso.",
      id,
      codigo: id
    });
  } catch {
    return json({ error: "Não foi possível atualizar o imóvel no banco D1." }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  const auth = await authorized(request, env);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const id = validId(url.searchParams.get("id"));

  if (!id) return json({ error: "Informe um código válido na URL." }, 400);

  try {
    const result = await env.DB.prepare(
      "DELETE FROM imoveis WHERE id = ?"
    ).bind(id).run();

    if (!result.meta?.changes) {
      return json({ error: "Imóvel não encontrado." }, 404);
    }

    return json({
      success: true,
      message: "Imóvel excluído com sucesso.",
      id,
      codigo: id
    });
  } catch {
    return json({ error: "Não foi possível excluir o imóvel do banco D1." }, 500);
  }
}
