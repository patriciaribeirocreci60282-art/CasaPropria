
export async function onRequestGet({ env }) {
  try {
    if (!env.DB) {
      return Response.json(
        { success: false, error: "O banco de dados não está configurado." },
        { status: 500 }
      );
    }

    const { results = [] } = await env.DB.prepare(`
      SELECT
        id,
        titulo,
        tipo,
        finalidade,
        descricao,
        cidade,
        bairro,
        endereco,
        preco,
        area_m2,
        quartos,
        banheiros,
        vagas,
        foto_url,
        destaque,
        lancamento,
        status,
        data_cadastro
      FROM imoveis
      WHERE LOWER(TRIM(COALESCE(status, ''))) = 'publicado'
      ORDER BY data_cadastro DESC
    `).all();

    const imoveis = results.map((item) => ({
      id: item.id,
      titulo: item.titulo,
      tipo: item.tipo,
      finalidade: item.finalidade,
      descricao: item.descricao,
      cidade: item.cidade,
      bairro: item.bairro,
      endereco: item.endereco,
      preco: item.preco,
      area_m2: item.area_m2,
      quartos: item.quartos,
      banheiros: item.banheiros,
      vagas: item.vagas,
      foto_url: item.foto_url,
      destaque: Boolean(item.destaque),
      lancamento: Boolean(item.lancamento),
      status: item.status,
      data_cadastro: item.data_cadastro
    }));

    return Response.json(
      { success: true, imoveis },
      {
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  } catch (error) {
    console.error("Erro ao consultar imóveis públicos:", error);

    return Response.json(
      {
        success: false,
        error: "Erro ao consultar os imóveis."
      },
      { status: 500 }
    );
  }
}
