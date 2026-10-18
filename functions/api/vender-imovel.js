
const VERSAO_TERMO = "v1.0-2026";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function clean(value, max = 500) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function required(value, label, max = 500) {
  const result = clean(value, max);

  if (!result) {
    throw new Error(`Preencha o campo: ${label}.`);
  }

  return result;
}

function optionalNumber(value, label, integer = false) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }

  const number = Number(value);

  if (
    !Number.isFinite(number) ||
    number < 0 ||
    (integer && !Number.isSafeInteger(number))
  ) {
    throw new Error(`Valor inválido no campo: ${label}.`);
  }

  return number;
}

function moneyToCents(value, label) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Informe um valor válido para ${label}.`);
  }

  const cents = Math.round(number * 100);

  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error(`Valor inválido para ${label}.`);
  }

  return cents;
}

function validatePhoto(value) {
  if (!value) return true;

  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function validEmail(value) {
  if (!value) return true;

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) {
    return json({
      error: "Banco de dados D1 não configurado."
    }, 500);
  }

  if (
    !(request.headers.get("Content-Type") || "")
      .toLowerCase()
      .includes("application/json")
  ) {
    return json({
      error: "Envie os dados em formato JSON."
    }, 415);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({
      error: "O conteúdo enviado não é um JSON válido."
    }, 400);
  }

  try {
    const nome = required(
      body.nome_proprietario,
      "nome completo",
      150
    );

    const telefone = required(
      body.telefone,
      "telefone",
      30
    );

    const email = clean(body.email, 254).toLowerCase();

    if (!validEmail(email)) {
      throw new Error("Informe um e-mail válido.");
    }

    const titulo = required(body.titulo, "título do imóvel", 150);
    const tipo = required(body.tipo, "tipo do imóvel", 60);
    const cidade = required(body.cidade, "cidade", 100);

    const descricao = clean(body.descricao, 5000);
    const bairro = clean(body.bairro, 100);
    const endereco = clean(body.endereco, 250);
    const fotoUrl = clean(body.foto_url, 2000);

    if (!validatePhoto(fotoUrl)) {
      throw new Error("A foto deve possuir uma URL HTTPS válida.");
    }

    const valorLiquido = moneyToCents(
      body.valor_liquido,
      "valor líquido desejado"
    );

    // Comissão de 5% sobre o preço de venda.
    // Para o proprietário receber o valor líquido solicitado,
    // o preço de venda é o líquido dividido por 0,95.
    const precoVenda = Math.round(valorLiquido / 0.95);
    const comissao = precoVenda - valorLiquido;

    if (
      !Number.isSafeInteger(precoVenda) ||
      !Number.isSafeInteger(comissao)
    ) {
      throw new Error("Não foi possível calcular os valores.");
    }

    if (body.aceitou_comissao !== true) {
      throw new Error(
        "É necessário aceitar expressamente o termo de comissão."
      );
    }

    const area = optionalNumber(body.area_m2, "área");
    const quartos = optionalNumber(body.quartos, "quartos", true);
    const banheiros = optionalNumber(body.banheiros, "banheiros", true);
    const vagas = optionalNumber(body.vagas, "vagas", true);

    const result = await env.DB.prepare(`
      INSERT INTO solicitacoes_venda (
        nome_proprietario,
        telefone,
        email,
        titulo,
        tipo,
        descricao,
        cidade,
        bairro,
        endereco,
        valor_liquido_centavos,
        preco_venda_centavos,
        comissao_centavos,
        percentual_comissao,
        area_m2,
        quartos,
        banheiros,
        vagas,
        foto_url,
        aceitou_comissao,
        versao_termo,
        data_aceite,
        status
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 5.0,
        ?, ?, ?, ?, ?, 1, ?, ?, 'Pendente'
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
      area,
      quartos,
      banheiros,
      vagas,
      fotoUrl || null,
      VERSAO_TERMO,
      new Date().toISOString()
    ).run();

    return json({
      success: true,
      message:
        "Solicitação recebida. Seu imóvel será analisado antes de ser publicado.",
      protocolo: result.meta?.last_row_id ?? null,
      status: "Pendente",
      valores: {
        valor_liquido_centavos: valorLiquido,
        preco_venda_centavos: precoVenda,
        comissao_centavos: comissao,
        percentual_comissao: 5
      }
    }, 201);
  } catch (error) {
    if (error instanceof Error) {
      return json({
        error: error.message || "Não foi possível processar a solicitação."
      }, 400);
    }

    console.error("Erro ao registrar solicitação de venda:", error);

    return json({
      error: "Erro interno ao salvar a solicitação."
    }, 500);
  }
}
