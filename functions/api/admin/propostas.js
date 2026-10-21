// functions/api/propostas.js

const R2_PUBLIC_HOST = "pub-0d961880c43e4ed59f5117c94ea18f93.r2.dev";

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

function numberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) {
    return json({ error: "O vínculo DB não está configurado." }, 500);
  }

  try {
    const contentType = request.headers.get("Content-Type") || "";
    let titulo = "";
    let tipo = "";
    let cidade = "";
    let bairro = "";
    let preco = null;
    let descricao = "";
    let anotacaoInterna = "";
    let fotoUrl = null;

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      
      const nomeProprietario = clean(formData.get("nome"), 100);
      const telProprietario = clean(formData.get("telefone"), 50);
      
      tipo = clean(formData.get("tipo"), 60);
      cidade = clean(formData.get("cidade"), 100);
      bairro = clean(formData.get("bairro"), 100);
      preco = numberOrNull(formData.get("valor") || formData.get("preco"));
      descricao = clean(formData.get("descricao"), 5000);
      
      titulo = clean(formData.get("titulo") || `${tipo || "Imóvel"} em ${cidade || "Santa Catarina"}`, 150);

      // Salva os dados de contato do proprietário na anotação interna para controle no admin
      anotacaoInterna = `Proprietário: ${nomeProprietario} | Contato/WhatsApp: ${telProprietario}`;

      // Processa o envio das fotos para o R2 (mesmo padrão do painel)
      const arquivos = formData.getAll("fotos");
      for (const arquivo of arquivos) {
        if (arquivo && typeof arquivo === "object" && arquivo.size > 0) {
          if (env.FOTOS_BUCKET) {
            const ext = arquivo.name.split(".").pop() || "jpg";
            const key = `imoveis/pendentes/${Date.now()}-${Math.random().toString(36).substring(2, 7)}.${ext}`;
            
            await env.FOTOS_BUCKET.put(key, arquivo.stream(), {
              httpMetadata: { contentType: arquivo.type || "image/jpeg" }
            });

            const urlR2 = `https://${R2_PUBLIC_HOST}/${key}`;
            if (!fotoUrl) {
              fotoUrl = urlR2; // Define a primeira foto como principal
            }
          }
        }
      }
    } else {
      const body = await request.json();
      titulo = clean(body.titulo, 150);
      tipo = clean(body.tipo, 60);
      cidade = clean(body.cidade, 100);
      bairro = clean(body.bairro, 100);
      preco = numberOrNull(body.preco);
      descricao = clean(body.descricao, 5000);
      anotacaoInterna = clean(body.anotacao_interna, 1000);
      fotoUrl = clean(body.foto_url, 2000);
    }

    if (!titulo || !tipo || !cidade) {
      return json({ error: "Preencha os campos obrigatórios (título, tipo e cidade)." }, 400);
    }

    // Insere exatamente na mesma tabela "imoveis", fixando o status como "Pendente"
    const result = await env.DB.prepare(`
      INSERT INTO imoveis (
        titulo, tipo, finalidade, descricao, cidade, bairro, 
        preco, foto_url, anotacao_interna, status, destaque, lancamento, data_cadastro
      ) VALUES (?, ?, 'Venda', ?, ?, ?, ?, ?, ?, 'Pendente', 0, 0, datetime('now'))
    `).bind(
      titulo,
      tipo,
      descricao || null,
      cidade,
      bairro || null,
      preco,
      fotoUrl,
      anotacaoInterna || null
    ).run();

    const id = result.meta?.last_row_id ?? null;

    return json({
      success: true,
      message: "Imóvel cadastrado com sucesso para análise.",
      id,
      codigo: id
    }, 201);

  } catch (error) {
    console.error("Erro ao registrar proposta de imóvel:", error);
    return json({
      success: false,
      error: "Não foi possível salvar o imóvel no banco de dados."
    }, 500);
  }
}
