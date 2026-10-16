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

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;

  try {
    const { results = [] } = await env.DB.prepare(`
      SELECT id, titulo, tipo, finalidade, descricao, cidade,
             bairro, endereco, preco, area_m2, quartos, banheiros,
             vagas, foto_url, destaque, lancamento, status, data_cadastro
      FROM imoveis
      ORDER BY data_cadastro DESC
    `).all();

    return json({ success: true, imoveis: results });
  } catch {
    return json({ error: "Erro ao consultar os imóveis." }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
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

  const titulo = clean(body.titulo, 150);
  const tipo = clean(body.tipo, 60);
  const finalidade = clean(body.finalidade, 30) || "Venda";
  const descricao = clean(body.descricao, 5000);
  const cidade = clean(body.cidade, 100);
  const bairro = clean(body.bairro, 100);
  const endereco = clean(body.endereco, 250);
  const fotoUrl = clean(body.foto_url, 2000);

  if (!titulo || !tipo) {
    return json({ error: "Preencha o título e o tipo do imóvel." }, 400);
  }

  if (!["Venda", "Aluguel", "Locação", "Lançamento"].includes(finalidade)) {
    return json({ error: "Finalidade inválida." }, 400);
  }

  if (fotoUrl) {
    try {
      const url = new URL(fotoUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        return json({ error: "URL da foto inválida." }, 400);
      }
    } catch {
      return json({ error: "URL da foto inválida." }, 400);
    }
  }

  let preco, area, quartos, banheiros, vagas;

  try {
    preco = numberOrNull(body.preco, "preco");
    area = numberOrNull(body.area_m2, "area_m2");
    quartos = numberOrNull(body.quartos, "quartos");
    banheiros = numberOrNull(body.banheiros, "banheiros");
    vagas = numberOrNull(body.vagas, "vagas");
  } catch (error) {
    return json({ error: error.message }, 400);
  }

  const destaque = body.destaque === true ? 1 : 0;
  const lancamento = body.lancamento === true ? 1 : 0;
  const status = body.status === "Rascunho" ? "Rascunho" : "Publicado";

  try {
    const result = await env.DB.prepare(`
      INSERT INTO imoveis (
        titulo, tipo, finalidade, descricao, cidade, bairro, endereco,
        preco, area_m2, quartos, banheiros, vagas, foto_url,
        destaque, lancamento, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      titulo, tipo, finalidade, descricao || null, cidade || null,
      bairro || null, endereco || null, preco, area, quartos,
      banheiros, vagas, fotoUrl || null, destaque, lancamento, status
    ).run();

    return json({
      success: true,
      message: "Imóvel cadastrado com sucesso.",
      id: result.meta?.last_row_id ?? null
    }, 201);
  } catch {
    return json({ error: "Não foi possível salvar o imóvel no banco D1." }, 500);
  }
}

export async function onRequestPut() {
  return json({ error: "Edição ainda não implementada." }, 405);
}

export async function onRequestDelete() {
  return json({ error: "Exclusão ainda não implementada." }, 405);
}
