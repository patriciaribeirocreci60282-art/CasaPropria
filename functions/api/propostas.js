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
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) {
      return json({ error: "O vínculo DB (D1) não está configurado." }, 500);
    }

    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      return json({ error: "Envio inválido. Use multipart/form-data." }, 400);
    }

    const formData = await request.formData();
    const nome = clean(formData.get("nome"), 100);
    const telefone = clean(formData.get("telefone"), 30);
    const cidade = clean(formData.get("cidade"), 100);
    const bairro = clean(formData.get("bairro"), 100);
    const tipo = clean(formData.get("tipo"), 60);
    const valor = numberOrNull(formData.get("valor"));
    const descricaoUser = clean(formData.get("descricao"), 5000);

    if (!nome || !telefone || !cidade || !tipo || valor === null || !descricaoUser) {
      return json({ error: "Preencha todos os campos obrigatórios." }, 400);
    }

    const anotacaoInterna = `Proprietário: ${nome} (Tel: ${telefone}). Valor desejado: R$ ${valor}. Descrição: ${descricaoUser}`;
    const titulo = `${tipo} em ${cidade}${bairro ? ' - ' + bairro : ''}`;

    let fotoUrl = "";
    const files = formData.getAll("fotos");

    // Faz o upload das imagens para o R2 seguindo o mesmo padrão do painel admin
    if (files && files.length > 0 && env.FOTOS_BUCKET) {
      for (let i = 0; i < Math.min(files.length, 5); i++) {
        const file = files[i];
        if (file && typeof file === "object" && file.size > 0) {
          const ext = file.name.split(".").pop() || "jpg";
          const key = `imoveis/pendentes/${Date.now()}_${i}.${ext}`;
          
          await env.FOTOS_BUCKET.put(key, file.stream(), {
            httpMetadata: { contentType: file.type || "image/jpeg" }
          });

          const url = `https://${R2_PUBLIC_HOST}/${key}`;
          if (!fotoUrl) {
            fotoUrl = url; // Define a primeira foto como a principal do imóvel
          }
        }
      }
    }

    // Insere na tabela imoveis com status 'Pendente', igualzinho ao painel admin
    const result = await env.DB.prepare(`
      INSERT INTO imoveis (
        titulo, tipo, finalidade, descricao, cidade, bairro, 
        preco, foto_url, status, anotacao_interna, destaque, lancamento
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `).bind(
      titulo,
      tipo,
      "Venda",
      descricaoUser,
      cidade,
      bairro || null,
      valor,
      fotoUrl || null,
      "Pendente",
      anotacaoInterna
    ).run();

    const id = result.meta?.last_row_id ?? null;

    return json({
      success: true,
      message: "Proposta enviada com sucesso para análise.",
      id,
      codigo: id
    }, 201);

  } catch (error) {
    console.error("Erro ao salvar proposta no banco D1:", error);
    return json({ error: "Não foi possível salvar o imóvel no banco D1." }, 500);
  }
}
