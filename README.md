# 🗺️ Geoportal Itajaí — Base Geoespacial Integrada (GeoItajaí)

Portal WebGIS interativo no padrão do Geoportal municipal com a identidade visual aprimorada do **GeoItajaí**, reunindo em **um único mapa interativo** todas as camadas oficiais do município, a série histórica de ortoimagens (**1984–2024**) recortada pelo **limite oficial IBGE (`4208203_Itajai.gpkg`)**, satélite de alta resolução e a central de downloads.

🌐 **Acesso Online (GitHub Pages)**: https://eriksdhoffmann.github.io/Geoportal-Itajai/

---

## ✨ Funcionalidades e Melhorias

- **Ortoimagem 2024 Completa + Recorte Oficial IBGE (`4208203_Itajai.gpkg`)**:
  - Polígono oficial do município de Itajaí (`289,022 km²`, SIRGAS 2000 / UTM 22S) embutido em `data/limite_itajai.geojson` e `js/limite-itajai.js`, recortando com precisão todas as bordas da ortofoto sem serrilhado preto.
  - Base contínua de satélite HD por baixo + **retry automático de tiles**, eliminando lacunas/buracos durante zoom ou navegação.
  - Alternância instantânea no painel (**Recortar mapa ao limite oficial de Itajaí**) para exibir apenas Itajaí ou toda a região metropolitana.

- **Satélite Global Alta Resolução, Híbrido, Bing Aéreo e Série Histórica 1984–2024**:
  - **Satélite Alta Resolução (Esri / Maxar)**, **Satélite Híbrido (Satélite + Ruas e Rótulos)**, **Satélite Clarity HD**, **Bing Satélite Aéreo**, **OpenStreetMap** e **Carto Positron**.
  - **Ortoimagens 2024, 2020, 2013, 2007** e **Restituições 2020 e 1984** com ferramenta **Cortina Comparativa (Antes × Depois)**.

- **Empilhamento Real e Reordenação de Camadas (`Ordem`)**:
  - Cada camada vetorial ativa recebe sua própria pane e renderizador Canvas com `zIndex` determinístico, garantindo que novas camadas apareçam sempre **por cima** das anteriores.
  - Aba dedicada **Ordem** no *Controle de Camadas* com botões **▲ Subir** / **▼ Descer** e controle individual de transparência.

- **Ferramentas Cartográficas Completas**:
  - **Medição Geodésica de Distância e Área** renderizada em camada SVG superior dedicada (`zIndex: 650`) com halo branco de alto contraste sobre qualquer camada, além de rótulo dinâmico acompanhando o cursor.
  - **Busca Unificada** por Bairro, Logradouro, Inscrição Imobiliária (Lote) ou Coordenadas (WGS84 / SIRGAS 2000 UTM 22S).
  - **Identificação Multi-Camada (Raio-X do Ponto)**, **Desenho & Exportação GeoJSON**, **Importação de Shapefile (`.zip`), GeoJSON e KML** e **Impressão em PDF**.
  - **Central de Downloads** com todos os 22 pacotes oficiais do GeoItajaí (`geo.itajai.sc.gov.br/downloads/`) + Limite IBGE 4208203, cada um com ação **"Ver no Mapa"**.

---

## 🚀 Como Executar Localmente

1. Clone o repositório:
   ```bash
   git clone https://github.com/eriksdhoffmann/Geoportal-Itajai.git
   ```
2. Abra `index.html` no navegador ou execute `ABRIR_GEOPORTAL_ITAJAI.bat`.
