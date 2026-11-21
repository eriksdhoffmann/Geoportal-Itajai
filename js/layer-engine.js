/**
 * Geoportal Itajaí — Motor de Camadas GIS (Ortofoto Completa com Recorte IBGE 4208203,
 * Satélite HD / Híbrido / Bing Aerial, Empilhamento Determinístico por Camada com Z-Index
 * Individual, Reordenação ↑/↓, Retry Automático de Tiles e Importação Local).
 */
window.GeoLayerEngine = (() => {
  const {
    BASEMAPS,
    TRANSPARENT_TILE,
    buildServiceUrl,
    getLayerById,
  } = window.GeoCatalog;

  const HIDDEN_FIELDS = new Set([
    'objectid', 'fid', 'globalid', 'shape__area', 'shape__length',
    'shape_leng', 'shape_area', 'created_user', 'created_date',
    'last_edited_user', 'last_edited_date', 'true_',
  ]);

  const FIELD_LABELS = {
    CD_MUN: 'Código IBGE',
    NM_MUN: 'Município',
    AREA_KM2: 'Área Oficial (km²)',
    NM_CONCURB: 'Concentração Urbana',
    FONTE: 'Fonte',
    nome: 'Nome / Sigla',
    descr: 'Descrição',
    legenda: 'Zona (2012)',
    memorial: 'Memorial Descritivo',
    inscricao: 'Inscrição Imobiliária',
    setor: 'Setor',
    quadra: 'Quadra',
    face: 'Face',
    lote: 'Lote',
    via: 'Logradouro',
    nomevia: 'Logradouro',
    num: 'Número',
    numero: 'Número',
    loteamento: 'Loteamento',
    hierarquia: 'Hierarquia Viária',
    largura: 'Largura da Via (m)',
    passeiod: 'Passeio Direito (m)',
    passeioe: 'Passeio Esquerdo (m)',
    leidata: 'Legislação / Data',
    cota: 'Cota (m)',
    tipocurvan: 'Tipo de Curva',
    rua_avenida: 'Logradouro',
    bairro: 'Bairro',
    endereco: 'Endereço',
    tombo: 'Ato de Tombamento',
    tombotipo: 'Tipo de Tombamento',
    uso: 'Uso',
    diametro: 'Diâmetro',
    material: 'Material',
    tipo: 'Tipo',
    posicao: 'Posição',
    profundida: 'Profundidade',
    classe: 'Classe',
    plan: 'Situação / Fase',
    secao_existente: 'Seção Existente',
    unidade_de_saúde__no_ups_: 'Unidade de Saúde',
    logradouro: 'Logradouro',
    número: 'Número',
    mome: 'Escola / Unidade',
    categoria: 'Categoria',
    codigo_da_escola: 'Código',
    altmax: 'Altura Máxima',
    empresa: 'Empresa Responsável',
    n_doc: 'Documento',
    data_sond: 'Data Sondagem',
    local_: 'Local do Marco',
    titulo: 'Título',
    descricao: 'Descrição',
  };

  function prettyFieldName(key) {
    if (FIELD_LABELS[key]) return FIELD_LABELS[key];
    const lk = String(key || '').toLowerCase();
    if (FIELD_LABELS[lk]) return FIELD_LABELS[lk];
    return String(key)
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function formatFieldValue(key, val) {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number') {
      if (key.toLowerCase().includes('data') && val > 100000000000) {
        return new Date(val).toLocaleDateString('pt-BR');
      }
      return Number.isInteger(val) ? val.toLocaleString('pt-BR') : val.toFixed(3).replace('.', ',');
    }
    const str = String(val).trim();
    if (!str || str === 'null' || str === 'Null') return null;
    return str;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Subclasse TileLayer para Bing VirtualEarth QuadKey
  const BingTileLayer = L.TileLayer.extend({
    getTileUrl(coords) {
      let quadKey = '';
      for (let i = coords.z; i > 0; i--) {
        let digit = 0;
        const mask = 1 << (i - 1);
        if ((coords.x & mask) !== 0) digit += 1;
        if ((coords.y & mask) !== 0) digit += 2;
        quadKey += digit;
      }
      const s = this._getSubdomain(coords);
      return L.Util.template(this._url, { s, q: quadKey });
    },
  });

  // TileLayer resiliente com retry automático (elimina buracos na Ortoimagem 2024!)
  function attachTileRetry(tileLayer, maxRetries = 3) {
    tileLayer.on('tileerror', (ev) => {
      const tile = ev.tile;
      if (!tile || !tile.src || tile.src.startsWith('data:')) return;
      const attempt = Number(tile.dataset.retry || '0');
      if (attempt >= maxRetries) {
        // Deixa o tile transparente para revelar o Satélite HD contínuo por baixo
        tile.src = TRANSPARENT_TILE;
        return;
      }
      tile.dataset.retry = String(attempt + 1);
      const orig = tile.dataset.origSrc || tile.src;
      tile.dataset.origSrc = orig;
      const sep = orig.includes('?') ? '&' : '?';
      setTimeout(() => {
        tile.src = `${orig}${sep}_r=${attempt + 1}&t=${Date.now()}`;
      }, 450 * (attempt + 1));
    });
    return tileLayer;
  }

  function createEngine(map, callbacks = {}) {
    const basemapLayers = new Map();
    const activeBasemaps = new Set();
    const activeLayers = new Map(); // id -> state
    const layerOrder = []; // bottom -> top (cada camada tem seu próprio pane + zIndex!)
    const dataCache = new Map();
    const userLayers = [];

    // Panes dedicados para arquitetura de empilhamento cristalina
    map.createPane('paneBasemapUnderlay').style.zIndex = 195; // Esri Satélite sem buracos sob Ortofoto
    map.createPane('paneBasemapGlobal').style.zIndex = 200;
    map.createPane('paneBasemapMunicipal').style.zIndex = 210;
    map.createPane('paneBasemapLabels').style.zIndex = 218;
    map.createPane('paneSwipeRight').style.zIndex = 222;
    map.createPane('paneMunicipalMask').style.zIndex = 230; // Máscara branca oficial IBGE 4208203!
    map.getPane('paneMunicipalMask').style.pointerEvents = 'none';
    // Camadas vetoriais dinâmicas ocupam zIndex 410..598 (uma pane por camada!)
    map.createPane('paneToolsOverlay').style.zIndex = 650; // Medição, Desenho e Destaques SEMPRE NO TOPO!

    // Underlay contínuo de Satélite HD (Esri World Imagery) que preenche 100% do polígono de Itajaí
    // caso qualquer tile da Ortoimagem 2024 leve milissegundos a mais ou sofra throttling
    const municipalSatUnderlay = attachTileRetry(
      L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
          minZoom: 5,
          maxNativeZoom: 19,
          maxZoom: 21,
          pane: 'paneBasemapUnderlay',
          keepBuffer: 4,
          attribution: '',
        }
      ),
      2
    );

    // ---- Máscara Oficial do Limite de Itajaí (IBGE 4208203_Itajai.gpkg) ----
    // Recorta qualquer base aérea/satélite no contorno exato de Itajaí (sem serrilhado preto!)
    let municipalClipEnabled = true;
    let municipalMaskLayer = null;

    function buildMunicipalMask() {
      const gj = window.ITAJAI_LIMIT_GEOJSON;
      if (!gj?.features?.[0]?.geometry) return null;
      const geom = gj.features[0].geometry;
      const worldRing = [
        [-85, -180],
        [-85, 180],
        [85, 180],
        [85, -180],
        [-85, -180],
      ];
      // Converte MultiPolygon GeoJSON [lon, lat] em buracos [lat, lon] dentro do retângulo mundial
      const holes = [];
      const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
      for (const poly of polys) {
        if (poly[0]) {
          holes.push(poly[0].map(([lon, lat]) => [lat, lon]));
        }
      }
      const maskSvg = L.svg({ pane: 'paneMunicipalMask', padding: 1.0 });
      const group = L.layerGroup();
      L.polygon([worldRing, ...holes], {
        pane: 'paneMunicipalMask',
        renderer: maskSvg,
        stroke: false,
        fillColor: '#ffffff',
        fillOpacity: 1,
        interactive: false,
      }).addTo(group);

      // Contorno vetorial fino e nítido acompanhando o limite exato de 4208203_Itajai.gpkg
      for (const ring of holes) {
        L.polyline(ring, {
          pane: 'paneMunicipalMask',
          renderer: maskSvg,
          color: '#0d4b75',
          weight: 1.6,
          opacity: 0.72,
          interactive: false,
        }).addTo(group);
      }
      return group;
    }

    function syncMunicipalMask() {
      if (!municipalMaskLayer) municipalMaskLayer = buildMunicipalMask();
      if (!municipalMaskLayer) return;

      const hasMunicipalBm = [...activeBasemaps].some((id) => {
        const b = BASEMAPS.find((x) => x.id === id);
        return b?.hasSatelliteUnderlay;
      });

      // Underlay contínuo de satélite só fica ligado sob ortofoto oficial para evitar qualquer buraco
      if (hasMunicipalBm) {
        if (!map.hasLayer(municipalSatUnderlay)) municipalSatUnderlay.addTo(map);
      } else {
        if (map.hasLayer(municipalSatUnderlay)) map.removeLayer(municipalSatUnderlay);
      }

      // Máscara branca de recorte IBGE 4208203
      if (municipalClipEnabled && activeBasemaps.size > 0) {
        if (!map.hasLayer(municipalMaskLayer)) municipalMaskLayer.addTo(map);
      } else {
        if (map.hasLayer(municipalMaskLayer)) map.removeLayer(municipalMaskLayer);
      }
    }

    function setMunicipalClip(enabled) {
      municipalClipEnabled = Boolean(enabled);
      syncMunicipalMask();
      callbacks.onStateChange?.();
    }

    function isMunicipalClipEnabled() {
      return municipalClipEnabled;
    }

    // ---- Construção de Basemaps ----
    function ensureBasemapLayer(bmCfg, customPane = null) {
      if (!customPane && basemapLayers.has(bmCfg.id)) {
        return basemapLayers.get(bmCfg.id);
      }
      const pane = customPane || (bmCfg.isMunicipalClip ? 'paneBasemapMunicipal' : 'paneBasemapGlobal');
      const opts = {
        minZoom: bmCfg.minZoom || 5,
        maxZoom: bmCfg.maxZoom || 21,
        maxNativeZoom: bmCfg.maxNativeZoom || 19,
        attribution: bmCfg.attribution || '',
        pane,
        opacity: 1,
        keepBuffer: 4,
        updateWhenIdle: false,
      };
      if (bmCfg.bounds) opts.bounds = bmCfg.bounds;
      if (bmCfg.subdomains) opts.subdomains = bmCfg.subdomains;
      if (bmCfg.errorTileUrl) opts.errorTileUrl = bmCfg.errorTileUrl;

      let layer;
      if (bmCfg.type === 'bing') {
        layer = attachTileRetry(new BingTileLayer(bmCfg.url, opts), 2);
      } else if (bmCfg.overlayUrls?.length) {
        const grp = L.layerGroup();
        attachTileRetry(L.tileLayer(bmCfg.url, opts), 2).addTo(grp);
        for (const ovUrl of bmCfg.overlayUrls) {
          attachTileRetry(
            L.tileLayer(ovUrl, {
              ...opts,
              pane: customPane || 'paneBasemapLabels',
              attribution: '',
            }),
            1
          ).addTo(grp);
        }
        layer = grp;
      } else {
        layer = attachTileRetry(L.tileLayer(bmCfg.url, opts), 3);
      }

      if (!customPane) basemapLayers.set(bmCfg.id, layer);
      return layer;
    }

    function setBasemapActive(bmId, enabled, exclusive = true) {
      const bmCfg = BASEMAPS.find((b) => b.id === bmId);
      if (!bmCfg) return;

      if (exclusive && enabled) {
        for (const activeId of [...activeBasemaps]) {
          if (activeId !== bmId) {
            const l = basemapLayers.get(activeId);
            if (l && map.hasLayer(l)) map.removeLayer(l);
            activeBasemaps.delete(activeId);
          }
        }
      }

      const layer = ensureBasemapLayer(bmCfg);
      if (enabled) {
        if (!map.hasLayer(layer)) layer.addTo(map);
        activeBasemaps.add(bmId);
      } else {
        if (map.hasLayer(layer)) map.removeLayer(layer);
        activeBasemaps.delete(bmId);
      }
      syncMunicipalMask();
      callbacks.onStateChange?.();
    }

    function isBasemapActive(bmId) {
      return activeBasemaps.has(bmId);
    }

    // ---- Empilhamento Determinístico: Uma Pane + Renderer Exclusivo por Camada ----
    function getOrCreateLayerPane(layerId) {
      const paneName = `paneLayer_${layerId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      let pane = map.getPane(paneName);
      if (!pane) {
        pane = map.createPane(paneName);
      }
      return { paneName, pane };
    }

    function syncLayerZIndexes() {
      // Base começa em 410; cada camada sobe +4 garantindo espaço para rótulos (+2)
      for (let i = 0; i < layerOrder.length; i++) {
        const id = layerOrder[i];
        const st = activeLayers.get(id);
        if (!st) continue;
        const z = 410 + i * 4;
        const { pane } = getOrCreateLayerPane(id);
        pane.style.zIndex = String(z);
        st.zIndex = z;
      }
    }

    function moveLayerOrder(layerId, direction) {
      // direction: 'up' (mais à frente / topo), 'down' (mais atrás / fundo), 'top', 'bottom'
      const idx = layerOrder.indexOf(layerId);
      if (idx === -1) return;
      if (direction === 'up' && idx < layerOrder.length - 1) {
        [layerOrder[idx], layerOrder[idx + 1]] = [layerOrder[idx + 1], layerOrder[idx]];
      } else if (direction === 'down' && idx > 0) {
        [layerOrder[idx], layerOrder[idx - 1]] = [layerOrder[idx - 1], layerOrder[idx]];
      } else if (direction === 'top' && idx < layerOrder.length - 1) {
        layerOrder.splice(idx, 1);
        layerOrder.push(layerId);
      } else if (direction === 'bottom' && idx > 0) {
        layerOrder.splice(idx, 1);
        layerOrder.unshift(layerId);
      }
      syncLayerZIndexes();
      callbacks.onStateChange?.();
    }

    function getOrderedActiveLayers() {
      // Retorna do TOPO (frente) para a BASE (fundo) para exibição natural na UI
      return [...layerOrder]
        .reverse()
        .map((id) => activeLayers.get(id))
        .filter(Boolean);
    }

    // ---- Estilização e Popups ----
    function computeFeatureStyle(cfg, feature, opacityOverride) {
      const op = opacityOverride ?? cfg.opacity ?? 0.65;
      const props = feature?.properties || {};

      if (cfg.geomType === 'line') {
        let color = cfg.style?.color || '#2563eb';
        if (cfg.colorField && cfg.colorMap) {
          const val = props[cfg.colorField];
          color = cfg.colorMap[val] || color;
        }
        return {
          color,
          weight: cfg.style?.weight || 2.4,
          dashArray: cfg.style?.dashArray || null,
          opacity: Math.min(1, op),
        };
      }

      let fillColor = cfg.style?.fillColor || '#3b82f6';
      let color = cfg.style?.color || '#1e293b';
      let fillOpacity = cfg.outlineMode ? (cfg.style?.fillOpacity ?? 0.02) : op;

      if (cfg.colorField && cfg.colorMap) {
        const raw = props[cfg.colorField];
        const mapped = cfg.colorMap[raw];
        if (mapped) {
          fillColor = mapped;
          color = '#2b3440';
        }
      }

      return {
        color,
        weight: cfg.style?.weight ?? 1.25,
        dashArray: cfg.style?.dashArray || null,
        opacity: Math.min(1, op + 0.28),
        fillColor,
        fillOpacity: cfg.outlineMode ? Math.min(0.25, fillOpacity) : Math.min(0.92, fillOpacity),
      };
    }

    function buildFeaturePopupHtml(cfg, feature) {
      const props = feature?.properties || {};
      const titleVal = cfg.titleField ? formatFieldValue(cfg.titleField, props[cfg.titleField]) : null;
      const heading = titleVal ? `${escapeHtml(cfg.name)} — ${escapeHtml(titleVal)}` : escapeHtml(cfg.name);

      const rows = [];
      const shown = new Set();
      if (cfg.titleField) shown.add(cfg.titleField.toLowerCase());

      for (const f of cfg.subtitleFields || []) {
        const val = formatFieldValue(f, props[f]);
        if (val) {
          rows.push(`<tr><th>${escapeHtml(prettyFieldName(f))}</th><td>${escapeHtml(val)}</td></tr>`);
          shown.add(f.toLowerCase());
        }
      }
      for (const [k, v] of Object.entries(props)) {
        if (rows.length >= 10) break;
        const lk = k.toLowerCase();
        if (HIDDEN_FIELDS.has(lk) || shown.has(lk)) continue;
        const val = formatFieldValue(k, v);
        if (val) {
          rows.push(`<tr><th>${escapeHtml(prettyFieldName(k))}</th><td>${escapeHtml(val)}</td></tr>`);
          shown.add(lk);
        }
      }

      const insc = props.inscricao || props.INSCRICAO;
      const extraLink = insc
        ? `<div class="geo-popup-actions">
             <a class="geo-popup-btn" href="https://arcgis.itajai.sc.gov.br/geoitajai/plantacadastral/plantacadastral.html" target="_blank" rel="noopener">
               Abrir Planta Cadastral Oficial ↗
             </a>
           </div>`
        : '';

      return `
        <div class="geo-popup">
          <div class="geo-popup-header">${heading}</div>
          <div class="geo-popup-body">
            ${rows.length ? `<table class="geo-popup-table">${rows.join('')}</table>` : '<p class="geo-popup-empty">Sem atributos tabulares adicionais.</p>'}
            ${extraLink}
          </div>
        </div>`;
    }

    function buildGeoJsonLayer(cfg, geojson, opacity, paneName) {
      // Cada camada usa seu próprio Canvas renderer dentro da sua própria pane!
      // Assim a ordem das camadas é 100% determinística e nunca se embaralha.
      const layerRenderer = L.canvas({ pane: paneName, padding: 0.45 });

      return L.geoJSON(geojson, {
        pane: paneName,
        renderer: layerRenderer,
        style: (feature) => computeFeatureStyle(cfg, feature, opacity),
        pointToLayer: (feature, latlng) => {
          const ps = cfg.pointStyle || {
            radius: 6,
            color: '#ffffff',
            weight: 1.8,
            fillColor: '#0d4b75',
            fillOpacity: 0.94,
          };
          return L.circleMarker(latlng, {
            ...ps,
            pane: paneName,
            renderer: layerRenderer,
            fillOpacity: Math.min(1, (ps.fillOpacity ?? 0.94) * (opacity ?? 1)),
            opacity: Math.min(1, opacity ?? 1),
          });
        },
        onEachFeature: (feature, layer) => {
          if (cfg.titleField && feature.properties?.[cfg.titleField]) {
            const lbl = String(feature.properties[cfg.titleField]).trim();
            if (lbl) {
              layer.bindTooltip(escapeHtml(lbl), {
                sticky: true,
                direction: 'top',
                className: 'geo-hover-tooltip',
                opacity: 0.94,
              });
            }
          }
          layer.on('click', (ev) => {
            if (callbacks.shouldInterceptClick?.()) return;
            L.DomEvent.stopPropagation(ev);
            L.popup({ maxWidth: 360, className: 'geo-custom-popup' })
              .setLatLng(ev.latlng)
              .setContent(buildFeaturePopupHtml(cfg, feature))
              .openOn(map);
          });
        },
      });
    }

    function buildLabelsGroup(cfg, geojson) {
      if (!cfg.labelField || !geojson?.features?.length) return null;
      const group = L.layerGroup();
      const placed = new Set();

      for (const feat of geojson.features) {
        const text = feat.properties?.[cfg.labelField];
        if (!text) continue;
        const key = String(text).trim();
        if (!key) continue;
        try {
          const tmp = L.geoJSON(feat);
          const bounds = tmp.getBounds();
          if (!bounds.isValid()) continue;
          const span = Math.abs(bounds.getEast() - bounds.getWest()) + Math.abs(bounds.getNorth() - bounds.getSouth());
          if (cfg.id !== 'bairros_2025' && span < 0.008) continue;
          if (cfg.id === 'bairros_2025' && placed.has(key)) continue;
          placed.add(key);

          L.marker(bounds.getCenter(), {
            interactive: false,
            icon: L.divIcon({
              className: `geo-map-label ${cfg.id === 'bairros_2025' ? 'geo-label-bairro' : 'geo-label-zona'}`,
              html: `<span>${escapeHtml(key)}</span>`,
              iconSize: null,
            }),
          }).addTo(group);
        } catch {
          // ignore
        }
      }
      return group;
    }

    async function queryFeatureServer(cfg, { bbox = null, signal = null, maxFeatures = 2500 } = {}) {
      const baseUrl = buildServiceUrl(cfg.service);
      const allFeatures = [];
      let offset = 0;
      const pageSize = 1000;

      while (allFeatures.length < maxFeatures) {
        const params = new URLSearchParams({
          where: '1=1',
          outFields: '*',
          returnGeometry: 'true',
          outSR: '4326',
          f: 'geojson',
          resultOffset: String(offset),
          resultRecordCount: String(pageSize),
        });
        if (cfg.simplify) params.set('maxAllowableOffset', String(cfg.simplify));
        if (bbox) {
          params.set('geometry', `${bbox.getWest()},${bbox.getSouth()},${bbox.getEast()},${bbox.getNorth()}`);
          params.set('geometryType', 'esriGeometryEnvelope');
          params.set('inSR', '4326');
          params.set('spatialRel', 'esriSpatialRelIntersects');
        }

        const resp = await fetch(`${baseUrl}/query?${params.toString()}`, { signal, cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        if (json.error) throw new Error(json.error.message || 'Erro no serviço ArcGIS');

        const feats = json.features || [];
        allFeatures.push(...feats);
        const exceeded = json.properties?.exceededTransferLimit || json.exceededTransferLimit;
        if (!exceeded || feats.length < pageSize) break;
        offset += pageSize;
      }

      return { type: 'FeatureCollection', features: allFeatures };
    }

    async function enableLayer(layerId) {
      if (activeLayers.has(layerId)) return;

      // 1. Camada importada pelo usuário
      const userL = userLayers.find((u) => u.id === layerId);
      if (userL) {
        const { paneName } = getOrCreateLayerPane(layerId);
        layerOrder.push(layerId);
        const gl = buildGeoJsonLayer(userL, userL.geojson, userL.opacity, paneName);
        gl.addTo(map);
        activeLayers.set(layerId, {
          cfg: userL,
          paneName,
          leafletLayer: gl,
          labelGroup: null,
          geojson: userL.geojson,
          opacity: userL.opacity,
          loading: false,
          zoomBlocked: false,
          count: userL.geojson.features.length,
        });
        syncLayerZIndexes();
        callbacks.onStateChange?.();
        return;
      }

      const found = getLayerById(layerId);
      if (!found) return;
      const { layer: cfg } = found;
      const { paneName } = getOrCreateLayerPane(layerId);

      // Nova camada sempre entra NO TOPO (acima das anteriores!)
      layerOrder.push(layerId);
      const state = {
        cfg,
        paneName,
        leafletLayer: null,
        labelGroup: null,
        geojson: null,
        opacity: cfg.opacity ?? 0.7,
        loading: false,
        zoomBlocked: false,
        error: null,
        count: 0,
        controller: null,
      };
      activeLayers.set(layerId, state);
      syncLayerZIndexes();

      // Camada local embutida (ex: Limite Municipal Oficial IBGE 4208203)
      if (cfg.isLocalData && cfg.id === 'limite_municipal_ibge' && window.ITAJAI_LIMIT_GEOJSON) {
        attachLayerData(state, window.ITAJAI_LIMIT_GEOJSON);
        return;
      }

      await loadOrRefreshLayer(layerId, { notifyZoom: true });
    }

    async function loadOrRefreshLayer(layerId, { notifyZoom = false } = {}) {
      const state = activeLayers.get(layerId);
      if (!state || state.cfg.isUserLayer || state.cfg.isLocalData) return;
      const { cfg } = state;

      if (cfg.viewportMode && cfg.minZoom && map.getZoom() < cfg.minZoom) {
        if (state.leafletLayer && map.hasLayer(state.leafletLayer)) {
          map.removeLayer(state.leafletLayer);
          state.leafletLayer = null;
        }
        state.zoomBlocked = true;
        state.loading = false;
        state.error = null;
        callbacks.onStateChange?.();
        if (notifyZoom) {
          callbacks.onZoomHint?.(cfg);
        }
        return;
      }

      state.zoomBlocked = false;

      if (!cfg.viewportMode && dataCache.has(layerId)) {
        attachLayerData(state, dataCache.get(layerId));
        return;
      }

      if (state.controller) state.controller.abort();
      const controller = new AbortController();
      state.controller = controller;
      state.loading = true;
      state.error = null;
      callbacks.onStateChange?.();

      try {
        const bbox = cfg.viewportMode ? map.getBounds().pad(0.15) : null;
        const gj = await queryFeatureServer(cfg, { bbox, signal: controller.signal });
        if (!activeLayers.has(layerId)) return;
        if (!cfg.viewportMode) dataCache.set(layerId, gj);
        attachLayerData(state, gj);
      } catch (err) {
        if (err.name === 'AbortError') return;
        state.loading = false;
        state.error = err.message || 'Falha ao carregar camada';
        callbacks.onStateChange?.();
        callbacks.onToast?.(`Erro ao carregar "${cfg.name}": ${state.error}`, 'error');
      }
    }

    function attachLayerData(state, geojson) {
      const { cfg, paneName } = state;
      if (state.leafletLayer && map.hasLayer(state.leafletLayer)) {
        map.removeLayer(state.leafletLayer);
      }
      if (state.labelGroup && map.hasLayer(state.labelGroup)) {
        map.removeLayer(state.labelGroup);
      }

      const gl = buildGeoJsonLayer(cfg, geojson, state.opacity, paneName);
      gl.addTo(map);

      let lg = null;
      if (cfg.labelField) {
        lg = buildLabelsGroup(cfg, geojson);
        if (lg && map.getZoom() >= 13) lg.addTo(map);
      }

      state.leafletLayer = gl;
      state.labelGroup = lg;
      state.geojson = geojson;
      state.count = geojson?.features?.length || 0;
      state.loading = false;
      state.error = null;
      syncLayerZIndexes();
      callbacks.onStateChange?.();
    }

    function disableLayer(layerId) {
      const state = activeLayers.get(layerId);
      if (!state) return;
      if (state.controller) state.controller.abort();
      if (state.leafletLayer && map.hasLayer(state.leafletLayer)) map.removeLayer(state.leafletLayer);
      if (state.labelGroup && map.hasLayer(state.labelGroup)) map.removeLayer(state.labelGroup);
      activeLayers.delete(layerId);
      const idx = layerOrder.indexOf(layerId);
      if (idx !== -1) layerOrder.splice(idx, 1);
      syncLayerZIndexes();
      callbacks.onStateChange?.();
    }

    function toggleLayer(layerId, forceState = null) {
      const currentlyOn = activeLayers.has(layerId);
      const next = forceState !== null ? forceState : !currentlyOn;
      if (next) return enableLayer(layerId);
      disableLayer(layerId);
      return Promise.resolve();
    }

    function setLayerOpacity(layerId, opacity) {
      const state = activeLayers.get(layerId);
      if (!state) return;
      state.opacity = opacity;
      if (state.leafletLayer) {
        state.leafletLayer.eachLayer((sub) => {
          if (state.cfg.geomType === 'point' && sub.setStyle) {
            sub.setStyle({ fillOpacity: opacity, opacity });
          } else if (sub.setStyle) {
            sub.setStyle(computeFeatureStyle(state.cfg, sub.feature, opacity));
          }
        });
      }
    }

    function zoomToLayer(layerId) {
      const state = activeLayers.get(layerId);
      if (state?.leafletLayer) {
        const b = state.leafletLayer.getBounds();
        if (b && b.isValid()) {
          map.fitBounds(b, { padding: [36, 36], maxZoom: 17 });
          return true;
        }
      }
      if (state?.cfg?.minZoom) {
        map.setView(window.GeoCatalog.ITAJAI_URBAN_CENTER, state.cfg.minZoom);
        return true;
      }
      map.fitBounds(window.GeoCatalog.ITAJAI_BOUNDS, { padding: [20, 20] });
      return false;
    }

    function clearAllLayers() {
      for (const id of [...activeLayers.keys()]) {
        disableLayer(id);
      }
    }

    let moveTimer = null;
    map.on('moveend zoomend', () => {
      const z = map.getZoom();
      for (const [, state] of activeLayers) {
        if (state.labelGroup) {
          const shouldShow = z >= 13;
          if (shouldShow && !map.hasLayer(state.labelGroup)) state.labelGroup.addTo(map);
          if (!shouldShow && map.hasLayer(state.labelGroup)) map.removeLayer(state.labelGroup);
        }
      }
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        for (const [id, state] of activeLayers) {
          if (state.cfg.viewportMode) {
            loadOrRefreshLayer(id, { notifyZoom: false });
          }
        }
      }, 260);
    });

    async function identifyAtPoint(latlng) {
      const results = [];
      const tolDeg = 0.00025 * Math.pow(2, Math.max(0, 15 - map.getZoom()));
      const env = `${latlng.lng - tolDeg},${latlng.lat - tolDeg},${latlng.lng + tolDeg},${latlng.lat + tolDeg}`;

      const targetIds = new Set([...activeLayers.keys()]);
      for (const cid of ['bairros_2025', 'zoneamento_2024', 'planta_cadastral']) targetIds.add(cid);

      const tasks = [...targetIds].map(async (id) => {
        const state = activeLayers.get(id);
        const found = state ? { layer: state.cfg } : getLayerById(id);
        if (!found) return;
        const cfg = found.layer;
        const isCoreExtra = !activeLayers.has(id);

        if ((cfg.isUserLayer || cfg.isLocalData) && state?.geojson) {
          const hits = findLocalHits(state.geojson, latlng);
          if (hits.length) {
            results.push({ layerId: id, layerName: cfg.name, cfg, features: hits, isCoreExtra: false });
          }
          return;
        }
        if (!cfg.service) return;

        try {
          const baseUrl = buildServiceUrl(cfg.service);
          const params = new URLSearchParams({
            geometry: cfg.geomType === 'polygon' ? `${latlng.lng},${latlng.lat}` : env,
            geometryType: cfg.geomType === 'polygon' ? 'esriGeometryPoint' : 'esriGeometryEnvelope',
            inSR: '4326',
            spatialRel: 'esriSpatialRelIntersects',
            outFields: '*',
            returnGeometry: 'false',
            resultRecordCount: '5',
            f: 'json',
          });
          const resp = await fetch(`${baseUrl}/query?${params.toString()}`, { cache: 'no-store' });
          if (!resp.ok) return;
          const json = await resp.json();
          const feats = (json.features || []).map((f) => ({ properties: f.attributes || {} }));
          if (feats.length) {
            results.push({ layerId: id, layerName: cfg.name, cfg, features: feats, isCoreExtra });
          }
        } catch {
          // ignore
        }
      });

      await Promise.all(tasks);
      const order = { bairros_2025: 1, zoneamento_2024: 2, planta_cadastral: 3 };
      results.sort((a, b) => (order[a.layerId] || 50) - (order[b.layerId] || 50));
      return results;
    }

    function findLocalHits(geojson, latlng) {
      const hits = [];
      for (const f of geojson.features || []) {
        try {
          const b = L.geoJSON(f).getBounds();
          if (b.isValid() && b.pad(0.03).contains(latlng)) {
            hits.push(f);
            if (hits.length >= 5) break;
          }
        } catch {
          // ignore
        }
      }
      return hits;
    }

    function exportLayerGeoJSON(layerId) {
      const state = activeLayers.get(layerId);
      if (!state?.geojson?.features?.length) {
        callbacks.onToast?.('Ative a camada e aguarde o carregamento antes de exportar.', 'info');
        return;
      }
      const blob = new Blob([JSON.stringify(state.geojson, null, 2)], { type: 'application/geo+json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `geoportal_itajai_${layerId}.geojson`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      callbacks.onToast?.(`Exportado: geoportal_itajai_${layerId}.geojson (${state.geojson.features.length} feições)`, 'success');
    }

    async function importUserFile(file) {
      const name = file.name;
      const ext = name.split('.').pop().toLowerCase();
      let geojson = null;

      if (ext === 'geojson' || ext === 'json') {
        geojson = JSON.parse(await file.text());
      } else if (ext === 'kml') {
        geojson = parseSimpleKML(await file.text());
      } else if (ext === 'zip') {
        if (typeof window.shp !== 'function') {
          throw new Error('Biblioteca de leitura Shapefile (.zip) ainda carregando. Tente novamente em instantes.');
        }
        const parsed = await window.shp(await file.arrayBuffer());
        geojson = Array.isArray(parsed)
          ? { type: 'FeatureCollection', features: parsed.flatMap((g) => g.features || []) }
          : parsed;
      } else {
        throw new Error('Formato não suportado. Use .geojson, .json, .kml ou Shapefile .zip');
      }

      if (!geojson?.features?.length) {
        throw new Error('O arquivo não contém feições geográficas válidas.');
      }

      const firstType = geojson.features[0]?.geometry?.type || 'Polygon';
      const geomType = firstType.includes('Point') ? 'point' : firstType.includes('Line') ? 'line' : 'polygon';
      const colors = ['#e11d48', '#7c3aed', '#0d9488', '#ea580c', '#2563eb'];
      const color = colors[userLayers.length % colors.length];

      const id = `user_${Date.now()}`;
      const userCfg = {
        id,
        name: name.replace(/\.(geojson|json|kml|zip)$/i, ''),
        geomType,
        isUserLayer: true,
        opacity: 0.7,
        geojson,
        style: { color, weight: 2.2, fillColor: color, fillOpacity: 0.35 },
        pointStyle: { radius: 6, color: '#ffffff', weight: 1.8, fillColor: color, fillOpacity: 0.95 },
        description: `Camada importada localmente (${file.name} — ${geojson.features.length} feições).`,
      };

      userLayers.push(userCfg);
      await enableLayer(id);
      zoomToLayer(id);
      callbacks.onUserLayersChanged?.();
      callbacks.onToast?.(`Camada "${userCfg.name}" importada (${geojson.features.length} feições)!`, 'success');
      return userCfg;
    }

    function parseSimpleKML(xmlText) {
      const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
      const placemarks = [...doc.querySelectorAll('Placemark')];
      const features = [];
      const parseCoords = (str) =>
        str.trim().split(/\s+/).map((p) => p.split(',').map(Number)).filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])).map((c) => [c[0], c[1]]);
      for (const pm of placemarks) {
        const name = pm.querySelector('name')?.textContent?.trim() || 'Feição KML';
        const desc = pm.querySelector('description')?.textContent?.trim() || '';
        const pt = pm.querySelector('Point coordinates');
        const ls = pm.querySelector('LineString coordinates');
        const pg = pm.querySelector('Polygon outerBoundaryIs LinearRing coordinates');
        let geometry = null;
        if (pt) { const c = parseCoords(pt.textContent)[0]; if (c) geometry = { type: 'Point', coordinates: c }; }
        else if (ls) { const c = parseCoords(ls.textContent); if (c.length >= 2) geometry = { type: 'LineString', coordinates: c }; }
        else if (pg) { const c = parseCoords(pg.textContent); if (c.length >= 3) geometry = { type: 'Polygon', coordinates: [c] }; }
        if (geometry) features.push({ type: 'Feature', properties: { nome: name, descricao: desc }, geometry });
      }
      return { type: 'FeatureCollection', features };
    }

    function getActiveLegends() {
      return getOrderedActiveLayers().map((state) => {
        const { cfg } = state;
        const entry = { id: cfg.id, name: cfg.name, geomType: cfg.geomType, swatches: [] };
        if (cfg.colorMap) {
          for (const [label, color] of Object.entries(cfg.colorMap)) {
            entry.swatches.push({ label, color });
          }
        } else {
          const color =
            cfg.geomType === 'point'
              ? cfg.pointStyle?.fillColor || '#0d4b75'
              : cfg.geomType === 'line'
              ? cfg.style?.color || '#2563eb'
              : cfg.outlineMode
              ? cfg.style?.color || '#0284c7'
              : cfg.style?.fillColor || '#3b82f6';
          entry.swatches.push({
            label: cfg.name,
            color,
            outline: cfg.outlineMode,
            dashed: Boolean(cfg.style?.dashArray),
          });
        }
        return entry;
      });
    }

    return {
      activeLayers,
      activeBasemaps,
      userLayers,
      dataCache,
      layerOrder,
      ensureBasemapLayer,
      setBasemapActive,
      isBasemapActive,
      setMunicipalClip,
      isMunicipalClipEnabled,
      enableLayer,
      disableLayer,
      toggleLayer,
      setLayerOpacity,
      moveLayerOrder,
      getOrderedActiveLayers,
      zoomToLayer,
      clearAllLayers,
      identifyAtPoint,
      exportLayerGeoJSON,
      importUserFile,
      getActiveLegends,
      prettyFieldName,
      formatFieldValue,
      escapeHtml,
    };
  }

  return { createEngine, prettyFieldName, formatFieldValue, escapeHtml };
})();
