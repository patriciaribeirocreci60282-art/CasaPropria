
const TAXA_COMISSAO = 0.05;
const VERSAO_TERMO = "v1";

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

function moneyInCents(value) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }

  if (number > 100000000000) return null;

  return Math.round(number * 100);
}

function optionalNumber(value, field, integer = false) {
  if (value === "" || value === null || value === undefined) {
    return { valid: true, value: null };
  }

  const number = Number(value);

  if (
    !Number.isFinite(number) ||
    number < 0 ||
    number > 1000000 ||
    (integer && !Number.isSafeInteger(number))
  ) {
    return { valid: false, value: null, field };
  }

  return { valid: true, value: number };
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);

  if (origin && origin !== url.origin) {
    return json({ error: "Origem não autorizada." }, 403);
  }

  if (!env.DB) {
    return json({ error: "Banco D1 não configurado." }, 500);
  }

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

  const nome = clean(body.nome, 150);
  const telefone = clean(body.telefone, 30);
  const email = clean(body.email, 254);
  const titulo = clean(body.titulo, 150);
  const tipo = clean(body.tipo, 60);
  const descricao = clean(body.descricao, 5000);
  const cidade = clean(body.cidade, 100);
  const bairro = clean(body.bairro, 100);
  const endereco = clean(body.endereco, 250);

  const tiposPermitidos = [
    "Casa",
    "Apartamento",
    "Terreno",
    "Sítio",
    "Sala comercial",
    "Outro"
  ];

  const valorLiquido = moneyInCents(body.valor_liquido);

  if (
    !nome ||
    !telefone ||
    !titulo ||
    !cidade ||
    !tiposPermitidos.includes(tipo) ||
    valorLiquido === null
  ) {
    return json({
      error: "Confira os campos obrigatórios e o valor desejado."
    }, 400);
  }

  if (telefone.replace(/\D/g, "").length < 10) {
    return json({ error: "Informe um telefone válido." }, 400);
  }

  if (
    email &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return json({ error: "Informe um e-mail válido." }, 400);
  }

  if (body.aceitou_comissao !== true) {
    return json({
      error: "É necessário aceitar o termo de comissão."
    }, 400);
  }

  const area = optionalNumber(body.area_m2, "área");
  const quartos = optionalNumber(body.quartos, "quartos", true);
  const banheiros = optionalNumber(body.banheiros, "banheiros", true);
  const vagas = optionalNumber(body.vagas, "vagas", true);

  for (const result of [area, quartos, banheiros, vagas]) {
    if (!result.valid) {
      return json({
        error: `Valor inválido no campo ${result.field}.`
      }, 400);
    }
  }

  // Valores calculados no servidor.
  const precoVenda = Math.ceil(valorLiquido / (1 - TAXA_COMISSAO));
  const comissao = precoVenda - valorLiquido;
  const dataAceite = new Date().toISOString();

  try {
    const result = await env.DB.prepare(`
      INSERT INTO solicitacoes_venda (
        nome_proprietario, telefone, email,
        titulo, tipo, descricao, cidade, bairro, endereco,
        valor_liquido_centavos, preco_venda_centavos,
        comissao_centavos, percentual_comissao,
        area_m2, quartos, banheiros, vagas,
        aceitou_comissao, versao_termo, data_aceite, status
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        1, ?, ?, 'Pendente'
      )
    `).bind(
      nome,
      telefone,
      email || null,
      titulo,
      tipo,
      descricao || null,
      cidade,
      bairro || null,
      endereco || null,
      valorLiquido,
      precoVenda,
      comissao,
      5.0,
      area.value,
      quartos.value,
      banheiros.value,
      vagas.value,
      VERSAO_TERMO,
      dataAceite
    ).run();

    return json({
      success: true,
      message: "Solicitação enviada para análise.",
      protocolo: result.meta?.last_row_id ?? null,
      status: "Pendente"
    }, 201);
  } catch (error) {
    console.error("Erro ao salvar solicitação:", error);

    return json({
      error: "Não foi possível registrar a solicitação."
    }, 500);
  }
}

export async function onRequestGet() {
  return json({ error: "Use POST para enviar a solicitação." }, 405);
}
