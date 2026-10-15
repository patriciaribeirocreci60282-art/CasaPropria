
export async function onRequestGet({ env }) {
  try {
    const { results = [] } = await env.DB.prepare(`
      SELECT
        id,
        titulo,
        tipo,
        finalidade,
        descricao,
        cidade,
        bairro,
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
      WHERE status = 'Publicado'
      ORDER BY data_cadastro DESC
    `).all();

    const imoveis = results.map((item) => ({
      id: item.id,
      title: item.titulo,
      type: item.tipo,
      purpose: item.finalidade,
      description: item.descricao,
      location: [item.bairro, item.cidade].filter(Boolean).join(", "),
      price: item.preco,
      area: item.area_m2,
      bedrooms: item.quartos,
      bathrooms: item.banheiros,
      parking: item.vagas,
      image: item.foto_url,
      featured: Boolean(item.destaque),
      launch: Boolean(item.lancamento),
      publishedAt: item.data_cadastro
    }));

    return Response.json(
      { success: true, imoveis },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return Response.json(
      { success: false, error: "Erro ao consultar os imóveis." },
      { status: 500 }
    );
  }
}
