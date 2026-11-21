/**
 * Geoportal Itajaí — Motor de Camadas GIS Multi-Fonte com Contingência Automática.
 *   - Sondagem inteligente de arcgis.itajai.sc.gov.br (timeout curto + cache compartilhado)
 *   - Failover automático para espelhos verificados GeoItajaí / IBGE / DataSUS / OSM / Bundle local
 *   - Reprojeção cliente SIRGAS 2000 UTM 22S (EPSG:31982 / 32722) -> WGS84 (EPSG:4326)
 *   - Articulação Cadastral sob demanda (divisaolotes/exportMalha/*.geojson) + Tiles PD2019
 *   - Recorte oficial IBGE 4208203, empilhamento determinístico e Raio-X ponto-em-polígono exato
 */
window.GeoLayerEngine = (() => {
  const {
    BASEMAPS,
    TRANSPARENT_TILE,
    ITAJAI_BOUNDS,
    buildServiceUrl,
    getLayerById,
  } = window.GeoCatalog;

  const PARCEL_ARTIC_URL =
    'https://raw.githubusercontent.com/geoitajai/desenveconomico/main/data/artic.json';
  const PARCEL_TILE_URL =
    'https://raw.githubusercontent.com/geoitajai/desenveconomico/main/data/divisaolotes/exportMalha';
  const GITHUB_PAGES_BASE = 'https://eriksdhoffmann.github.io/Geoportal-Itajai';

  const HIDDEN_FIELDS = new Set([
    'objectid', 'fid', 'globalid', 'shape__area', 'shape__length',
    'shape_leng', 'shape_area', 'created_user', 'created_date',
    'last_edited_user', 'last_edited_date', 'true_', 'id',
  ]);

  const FIELD_LABELS = {
    CD_MUN: 'Código IBGE',
    NM_MUN: 'Município',
    AREA_KM2: 'Área Oficial (km²)',
    NM_CONCURB: 'Concentração Urbana',
    FONTE: 'Fonte',
    nome: 'Nome / Sigla',
    abrev: 'Sigla',
    descr: 'Descrição',
    legenda: 'Zona / Classificação',
    memorial: 'Memorial Descritivo',
    inscricao: 'Inscrição Imobiliária',
    inscrlig: 'Inscrição (Ligação)',
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
    caixatotal: 'Caixa Total (m)',
    caixavia: 'Caixa da Via (m)',
    passeiod: 'Passeio Direito (m)',
    passeioe: 'Passeio Esquerdo (m)',
    passeionl: 'Passeio N/L (m)',
    passeioso: 'Passeio S/O (m)',
    leidata: 'Legislação / Data',
    lei: 'Legislação',
    leinumero: 'Lei Municipal',
    leidataano: 'Data / Ano da Lei',
    cota: 'Cota (m)',
    tipocurvan: 'Tipo de Curva',
    situa: 'Lâmina / Situação',
    situacao: 'Situação',
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
    'unidade_de_saúde__no_ups_': 'Unidade de Saúde',
    logradouro: 'Logradouro',
    'número': 'Número',
    mome: 'Escola / Unidade',
    categoria: 'Categoria',
    codigo_da_escola: 'Código',
    altmax: 'Altura Máxima',
    alturamax: 'Altura Máxima',
    alturaemb: 'Altura Embasamento',
    coefaprov: 'Coef. Aproveitamento',
    toemb: 'Taxa Ocup. Embasamento',
    totorre: 'Taxa Ocup. Torre',
    permitidos: 'Usos Permitidos',
    permissiv: 'Usos Permissivos',
    empresa: 'Empresa Responsável',
    n_doc: 'Documento',
    data_sond: 'Data Sondagem',
    local_: 'Local do Marco',
    alt_ortometrica: 'Altitude Ortométrica (m)',
    titulo: 'Título',
    descricao: 'Descrição',
    equipamentos: 'Equipamentos',
    Classificacao: 'Classificação',
    Descricao_Contato: 'Descrição / Contato',
    residuos: 'Resíduos Aceitos',
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
    if (Array.isArray(val)) return val.join(', ');
    if (typeof val === 'number') {
      if (key.toLowerCase().includes('data') && val > 100000000000) {
        return new Date(val).toLocaleDateString('pt-BR');
      }
      return Number.isInteger(val) ? val.toLocaleString('pt-BR') : val.toFixed(3).replace('.', ',');
    }
    const str = String(val).trim();
    if (!str || str === 'null' || str === 'Null' || str === 'undefined') return null;
    return str;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const extSignal = opts.signal;
    if (extSignal?.aborted) {
      ctrl.abort(extSignal.reason);
    }
    const onAbort = () => ctrl.abort(extSignal?.reason);
    if (extSignal) extSignal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(new DOMException('Tempo limite excedido', 'TimeoutError')), timeoutMs);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
      if (extSignal) extSignal.removeEventListener('abort', onAbort);
    }
  }

  function extractFirstCoord(geom) {
    if (!geom) return null;
    if (geom.type === 'GeometryCollection') {
      for (const g of geom.geometries || []) {
        const c = extractFirstCoord(g);
        if (c) return c;
      }
      return null;
    }
    let cur = geom.coordinates;
    while (Array.isArray(cur) && Array.isArray(cur[0])) {
      cur = cur[0];
    }
    if (Array.isArray(cur) && cur.length >= 2 && Number.isFinite(cur[0]) && Number.isFinite(cur[1])) {
      return cur;
    }
    return null;
  }

  function convertCoordsRecursive(coords) {
    if (!Array.isArray(coords)) return coords;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const [x, y] = coords;
      if ((Math.abs(x) > 180 || Math.abs(y) > 90) && window.GeoCoords?.utm22SToLatLon) {
        const ll = window.GeoCoords.utm22SToLatLon(x, y);
        return [Number(ll.lon.toFixed(6)), Number(ll.lat.toFixed(6))];
      }
      return coords.length > 2 ? [x, y] : coords;
    }
    return coords.map(convertCoordsRecursive);
  }

  function convertGeometryToWgs84(geom) {
    if (!geom) return geom;
    if (geom.type === 'GeometryCollection') {
      return {
        type: 'GeometryCollection',
        geometries: (geom.geometries || []).map(convertGeometryToWgs84),
      };
    }
    return {
      ...geom,
      coordinates: convertCoordsRecursive(geom.coordinates),
    };
  }

  function normalizeGeoJsonToWgs84(raw) {
    if (!raw) return { type: 'FeatureCollection', features: [] };
    const fc = Array.isArray(raw)
      ? { type: 'FeatureCollection', features: raw }
      : raw;
    const feats = fc.features || [];
    if (!feats.length) return { type: 'FeatureCollection', features: [] };

    let needsReproj = false;
    const crsName = String(fc.crs?.properties?.name || '');
    if (/31982|32722|29192/.test(crsName)) {
      needsReproj = true;
    } else {
      for (let i = 0; i < Math.min(20, feats.length); i++) {
        const sample = extractFirstCoord(feats[i]?.geometry);
        if (sample && (Math.abs(sample[0]) > 180 || Math.abs(sample[1]) > 90)) {
          needsReproj = true;
          break;
        }
      }
    }

    if (!needsReproj) {
      return { type: 'FeatureCollection', features: feats };
    }

    return {
      type: 'FeatureCollection',
      features: feats.map((f) => ({
        ...f,
        geometry: convertGeometryToWgs84(f.geometry),
      })),
    };
  }

  function applyFallbackTransform(geojson, cfg) {
    const normalized = normalizeGeoJsonToWgs84(geojson);
    const fb = cfg.fallback || {};
    let feats = normalized.features || [];

    if (fb.filterField && Array.isArray(fb.filterValues)) {
      const allowed = new Set(fb.filterValues);
      feats = feats.filter((f) => allowed.has(f.properties?.[fb.filterField]));
    }
    if (fb.filterArrayField && fb.filterValue !== undefined) {
      feats = feats.filter((f) => {
        const arr = f.properties?.[fb.filterArrayField];
        return Array.isArray(arr) && arr.includes(fb.filterValue);
      });
    }

    if (fb.normalizeProps === 'viario') {
      feats = feats.map((f) => {
        const p = f.properties || {};
        return {
          ...f,
          properties: {
            ...p,
            nome: p.nome || p.nomevia || '',
            largura: p.largura ?? p.caixatotal,
            passeiod: p.passeiod ?? p.passeionl,
            passeioe: p.passeioe ?? p.passeioso,
          },
        };
      });
    }

    if (fb.parcelGrid) {
      feats = feats.map((f) => {
        const p = f.properties || {};
        if (p.inscrlig && !p.inscricao) {
          return {
            ...f,
            properties: {
              ...p,
              inscricao: p.inscrlig,
            },
          };
        }
        return f;
      });
    }

    return { type: 'FeatureCollection', features: feats };
  }

  // ---- Geometria exata (ponto em polígono & distância a segmento) para Raio-X offline ----
  function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      const intersect =
        yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointInPolygonCoords(lon, lat, rings) {
    if (!rings?.length || !pointInRing(lon, lat, rings[0])) return false;
    for (let i = 1; i < rings.length; i++) {
      if (pointInRing(lon, lat, rings[i])) return false;
    }
    return true;
  }

  function distPointToSegmentSq(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const ex = px - cx;
    const ey = py - cy;
    return ex * ex + ey * ey;
  }

  function pointNearLine(lon, lat, lineCoords, tolSq) {
    for (let i = 0; i < lineCoords.length - 1; i++) {
      const a = lineCoords[i];
      const b = lineCoords[i + 1];
      if (distPointToSegmentSq(lon, lat, a[0], a[1], b[0], b[1]) <= tolSq) {
        return true;
      }
    }
    return false;
  }

  function geomContainsLatLng(geom, latlng, tolDeg) {
    if (!geom) return false;
    const lon = latlng.lng;
    const lat = latlng.lat;
    const tolSq = tolDeg * tolDeg;

    switch (geom.type) {
      case 'Polygon':
        return pointInPolygonCoords(lon, lat, geom.coordinates);
      case 'MultiPolygon':
        return (geom.coordinates || []).some((poly) => pointInPolygonCoords(lon, lat, poly));
      case 'Point': {
        const [px, py] = geom.coordinates || [];
        return (px - lon) * (px - lon) + (py - lat) * (py - lat) <= tolSq * 4;
      }
      case 'MultiPoint':
        return (geom.coordinates || []).some(
          ([px, py]) => (px - lon) * (px - lon) + (py - lat) * (py - lat) <= tolSq * 4
        );
      case 'LineString':
        return pointNearLine(lon, lat, geom.coordinates || [], tolSq);
      case 'MultiLineString':
        return (geom.coordinates || []).some((line) => pointNearLine(lon, lat, line, tolSq));
      case 'GeometryCollection':
        return (geom.geometries || []).some((g) => geomContainsLatLng(g, latlng, tolDeg));
      default:
        return false;
    }
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

  // TileLayer resiliente com retry automático para hosts confiáveis
  function attachTileRetry(tileLayer, maxRetries = 2) {
    tileLayer.on('tileerror', (ev) => {
      const img = ev.tile;
      if (!img) return;
      if (typeof tileLayer._retryAllowed === 'function' && !tileLayer._retryAllowed()) return;
      const attempt = Number(img.dataset.retryCount || 0);
      if (attempt >= maxRetries) return;
      img.dataset.retryCount = String(attempt + 1);
      const rawSrc = tileLayer.getTileUrl(ev.coords);
      if (!rawSrc || rawSrc.startsWith('data:')) return;
      const sep = rawSrc.includes('?') ? '&' : '?';
      setTimeout(() => {
        if (!img.isConnected) return;
        img.src = `${rawSrc}${sep}_r=${attempt + 1}`;
      }, 320 * (attempt + 1));
    });
    return tileLayer;
  }

  function createEngine(map, callbacks = {}) {
    const basemapLayers = new Map();
    const activeBasemaps = new Set();
    const activeLayers = new Map(); // id -> state
    const layerOrder = []; // bottom -> top
    const dataCache = new Map(); // id -> { geojson, usingFallback, fallbackLabel }
    const remoteRawCache = new Map(); // url -> parsed geojson
    const parcelTileCache = new Map(); // nome -> Feature[]
    const userLayers = [];

    let parcelGridIndex = null;
    let parcelGridPromise = null;

    // Estado de conectividade ao servidor oficial arcgis.itajai.sc.gov.br
    let arcgisStatus = 'unknown'; // 'unknown' | 'checking' | 'online' | 'offline'
    let arcgisCheckedAt = 0;
    let arcgisProbePromise = null;
    const PROBE_ONLINE_TTL = 120000;
    const PROBE_OFFLINE_TTL = 60000;

    // Panes dedicados para arquitetura de empilhamento cristalina
    map.createPane('paneBasemapUnderlay').style.zIndex = 195;
    map.createPane('paneBasemapGlobal').style.zIndex = 200;
    map.createPane('paneBasemapMunicipal').style.zIndex = 210;
    map.createPane('paneBasemapLabels').style.zIndex = 218;
    map.createPane('paneSwipeRight').style.zIndex = 222;
    map.createPane('paneMunicipalMask').style.zIndex = 230;
    map.getPane('paneMunicipalMask').style.pointerEvents = 'none';
    map.createPane('paneToolsOverlay').style.zIndex = 650;

    // Underlay contínuo de Satélite HD (Esri World Imagery)
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

    // ---- Sondagem única deduplicada do servidor ArcGIS ----
    async function ensureArcgisStatus(force = false) {
      const now = Date.now();
      if (!force) {
        if (arcgisStatus === 'online' && now - arcgisCheckedAt < PROBE_ONLINE_TTL) return 'online';
        if (arcgisStatus === 'offline' && now - arcgisCheckedAt < PROBE_OFFLINE_TTL) return 'offline';
        if (arcgisProbePromise) return arcgisProbePromise;
      }

      const prevStatus = arcgisStatus;
      arcgisStatus = 'checking';
      callbacks.onStateChange?.();

      arcgisProbePromise = (async () => {
        try {
          const probeUrl = `${buildServiceUrl('Hosted/bairros2025/FeatureServer/0')}?f=json`;
          const resp = await fetchWithTimeout(probeUrl, { cache: 'no-store' }, 2800);
          if (resp.ok) {
            const json = await resp.json();
            arcgisStatus = json && !json.error ? 'online' : 'offline';
          } else {
            arcgisStatus = 'offline';
          }
        } catch {
          arcgisStatus = 'offline';
        } finally {
          arcgisCheckedAt = Date.now();
          arcgisProbePromise = null;
        }

        if (prevStatus !== arcgisStatus) {
          syncBasemapsForStatus();
        }
        callbacks.onStateChange?.();
        return arcgisStatus;
      })();

      return arcgisProbePromise;
    }

    async function recheckArcgisServer() {
      const status = await ensureArcgisStatus(true);
      if (status === 'online') {
        callbacks.onToast?.('Servidor oficial arcgis.itajai.sc.gov.br acessível! Atualizando camadas...', 'success');
        for (const [id, st] of activeLayers) {
          if (st.usingFallback || st.offlineBlocked || st.error) {
            dataCache.delete(id);
            loadOrRefreshLayer(id, { notifyZoom: false });
          }
        }
      } else {
        callbacks.onToast?.(
          'Servidor arcgis.itajai.sc.gov.br continua inacessível (DNS/rede municipal). Mantendo modo de contingência.',
          'info'
        );
      }
      return status;
    }

    // ---- Máscara Oficial do Limite de Itajaí (IBGE 4208203_Itajai.gpkg) ----
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

      if (hasMunicipalBm) {
        if (!map.hasLayer(municipalSatUnderlay)) municipalSatUnderlay.addTo(map);
      } else {
        if (map.hasLayer(municipalSatUnderlay)) map.removeLayer(municipalSatUnderlay);
      }

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

    // ---- Construção de Basemaps (com fallback automático quando host ArcGIS está offline) ----
    function buildTileOpts(bmCfg, customPane, useFallback = false) {
      const pane = customPane || (bmCfg.isMunicipalClip ? 'paneBasemapMunicipal' : 'paneBasemapGlobal');
      const opts = {
        minZoom: bmCfg.minZoom || 5,
        maxZoom: bmCfg.maxZoom || 21,
        maxNativeZoom: useFallback ? (bmCfg.fallbackMaxNativeZoom || 16) : (bmCfg.maxNativeZoom || 19),
        attribution: bmCfg.attribution || '',
        pane,
        opacity: 1,
        keepBuffer: 4,
        updateWhenIdle: false,
      };
      if (bmCfg.bounds) opts.bounds = bmCfg.bounds;
      if (bmCfg.subdomains && !useFallback) opts.subdomains = bmCfg.subdomains;
      if (bmCfg.errorTileUrl) opts.errorTileUrl = bmCfg.errorTileUrl;
      return opts;
    }

    function buildSingleBasemapLayer(bmCfg, customPane = null) {
      if (bmCfg.type === 'bing') {
        return attachTileRetry(new BingTileLayer(bmCfg.url, buildTileOpts(bmCfg, customPane, false)), 2);
      }
      if (bmCfg.overlayUrls?.length) {
        const opts = buildTileOpts(bmCfg, customPane, false);
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
        return grp;
      }

      if (bmCfg.requiresArcgisHost) {
        if (arcgisStatus === 'online') {
          const tl = L.tileLayer(bmCfg.url, buildTileOpts(bmCfg, customPane, false));
          tl._retryAllowed = () => arcgisStatus === 'online';
          tl._sourceMode = 'live';
          return attachTileRetry(tl, 2);
        }
        if (arcgisStatus === 'unknown' || arcgisStatus === 'checking') {
          ensureArcgisStatus();
        }
        if (bmCfg.fallbackUrl) {
          const tl = L.tileLayer(bmCfg.fallbackUrl, buildTileOpts(bmCfg, customPane, true));
          tl._sourceMode = 'fallback';
          return attachTileRetry(tl, 1);
        }
        // Em contingência para ortofotos sem espelho de tiles (ex: Orto 2024),
        // evita disparar centenas de requisições a host inacessível e exibe Esri HD contínuo.
        if (customPane) {
          return L.tileLayer(
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            buildTileOpts({ ...bmCfg, maxNativeZoom: 19 }, customPane, false)
          );
        }
        const noop = L.layerGroup();
        noop._sourceMode = 'underlay';
        return noop;
      }

      return attachTileRetry(L.tileLayer(bmCfg.url, buildTileOpts(bmCfg, customPane, false)), 2);
    }

    function syncBasemapsForStatus() {
      for (const bmId of [...activeBasemaps]) {
        const bmCfg = BASEMAPS.find((b) => b.id === bmId);
        if (!bmCfg?.requiresArcgisHost) continue;
        const oldLayer = basemapLayers.get(bmId);
        const desiredMode = arcgisStatus === 'online' ? 'live' : bmCfg.fallbackUrl ? 'fallback' : 'underlay';
        if (oldLayer?._sourceMode === desiredMode) continue;

        if (oldLayer && map.hasLayer(oldLayer)) map.removeLayer(oldLayer);
        basemapLayers.delete(bmId);
        const fresh = buildSingleBasemapLayer(bmCfg, null);
        basemapLayers.set(bmId, fresh);
        fresh.addTo(map);
      }
      syncMunicipalMask();
    }

    function ensureBasemapLayer(bmCfg, customPane = null) {
      if (!customPane && basemapLayers.has(bmCfg.id)) {
        return basemapLayers.get(bmCfg.id);
      }
      const layer = buildSingleBasemapLayer(bmCfg, customPane);
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
      callbacks.onBasemapChange?.(bmCfg, enabled);
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
      return [...layerOrder]
        .reverse()
        .map((id) => activeLayers.get(id))
        .filter(Boolean);
    }

    function getEffectiveColorMap(cfg, state) {
      if (state?.usingFallback && cfg.fallback?.colorMap) return cfg.fallback.colorMap;
      return cfg.colorMap || null;
    }

    function getEffectiveTitleField(cfg, state) {
      if (state?.usingFallback && cfg.fallback?.titleField) return cfg.fallback.titleField;
      return cfg.titleField;
    }

    // ---- Estilização e Popups ----
    function computeFeatureStyle(cfg, feature, opacityOverride, stateRef = null) {
      const op = opacityOverride ?? cfg.opacity ?? 0.65;
      const props = feature?.properties || {};
      const colorMap = getEffectiveColorMap(cfg, stateRef);
      const actualType = feature?.geometry?.type || '';
      const isLine = actualType ? actualType.includes('Line') : cfg.geomType === 'line';

      if (isLine) {
        let color = cfg.style?.color || '#2563eb';
        if (cfg.colorField && colorMap) {
          const val = props[cfg.colorField];
          color = colorMap[val] || color;
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

      if (cfg.colorField && colorMap) {
        const raw = props[cfg.colorField];
        const mapped = colorMap[raw];
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

    function buildFeaturePopupHtml(cfg, feature, stateRef = null) {
      const props = feature?.properties || {};
      const titleField = getEffectiveTitleField(cfg, stateRef);
      const titleVal = titleField ? formatFieldValue(titleField, props[titleField]) : null;
      const heading = titleVal ? `${escapeHtml(cfg.name)} — ${escapeHtml(titleVal)}` : escapeHtml(cfg.name);

      const rows = [];
      const shown = new Set();
      if (titleField) shown.add(titleField.toLowerCase());

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

      if (stateRef?.usingFallback && stateRef.fallbackLabel) {
        rows.push(
          `<tr><th>Fonte ativa</th><td>${escapeHtml(stateRef.fallbackLabel)} (Contingência)</td></tr>`
        );
      }

      const insc = props.inscricao || props.INSCRICAO || props.inscrlig;
      const extraLink = insc
        ? `<div class="geo-popup-actions">
             <a class="geo-popup-btn" href="https://geoitajai.github.io/desenveconomico/plantacadastral.html" target="_blank" rel="noopener">
               Abrir Planta Cadastral GeoItajaí ↗
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

    function buildGeoJsonLayer(cfg, geojson, opacity, paneName, stateRef = null) {
      const layerRenderer = L.canvas({ pane: paneName, padding: 0.45 });
      const titleField = getEffectiveTitleField(cfg, stateRef);

      return L.geoJSON(geojson, {
        pane: paneName,
        renderer: layerRenderer,
        style: (feature) => computeFeatureStyle(cfg, feature, opacity, stateRef),
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
          const labelVal = titleField ? feature.properties?.[titleField] : null;
          if (labelVal) {
            const lbl = String(labelVal).trim();
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
              .setContent(buildFeaturePopupHtml(cfg, feature, stateRef))
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
          const span =
            Math.abs(bounds.getEast() - bounds.getWest()) +
            Math.abs(bounds.getNorth() - bounds.getSouth());
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

        const resp = await fetchWithTimeout(`${baseUrl}/query?${params.toString()}`, { signal, cache: 'no-store' }, 9500);
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

    // ---- Articulação Cadastral GeoItajaí (exportMalha sob demanda) ----
    async function ensureParcelGridIndex(signal = null) {
      if (parcelGridIndex) return parcelGridIndex;
      if (parcelGridPromise) return parcelGridPromise;

      parcelGridPromise = (async () => {
        const resp = await fetchWithTimeout(PARCEL_ARTIC_URL, { signal }, 9000);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        parcelGridIndex = await resp.json();
        return parcelGridIndex;
      })();

      try {
        return await parcelGridPromise;
      } finally {
        parcelGridPromise = null;
      }
    }

    async function loadGeoItajaiParcelGrid(bbox, signal = null) {
      const idx = await ensureParcelGridIndex(signal);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const south = bbox.getSouth();
      const north = bbox.getNorth();
      const west = bbox.getWest();
      const east = bbox.getEast();
      const cLat = (south + north) / 2;
      const cLon = (west + east) / 2;

      const matching = idx
        .filter(
          (cell) =>
            cell.ne?.[0] >= south &&
            cell.sw?.[0] <= north &&
            cell.ne?.[1] >= west &&
            cell.sw?.[1] <= east
        )
        .sort((a, b) => {
          const da = Math.hypot((a.sw[0] + a.ne[0]) / 2 - cLat, (a.sw[1] + a.ne[1]) / 2 - cLon);
          const db = Math.hypot((b.sw[0] + b.ne[0]) / 2 - cLat, (b.sw[1] + b.ne[1]) / 2 - cLon);
          return da - db;
        })
        .slice(0, 12);

      const results = await Promise.all(
        matching.map(async (cell) => {
          if (parcelTileCache.has(cell.nome)) return parcelTileCache.get(cell.nome);
          try {
            const resp = await fetchWithTimeout(`${PARCEL_TILE_URL}/${cell.nome}.geojson`, { signal }, 10000);
            if (!resp.ok) {
              parcelTileCache.set(cell.nome, []);
              return [];
            }
            const raw = await resp.json();
            const arr = Array.isArray(raw) ? raw : raw?.features || [];
            parcelTileCache.set(cell.nome, arr);
            return arr;
          } catch (err) {
            if (err.name === 'AbortError') throw err;
            return [];
          }
        })
      );

      const seen = new Set();
      const merged = [];
      for (const arr of results) {
        for (const f of arr) {
          const p = f.properties || {};
          const coord = extractFirstCoord(f.geometry);
          const key = `${p.inscrlig || p.inscricao || ''}:${coord?.[0] || ''}:${coord?.[1] || ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(f);
          if (merged.length >= 4500) break;
        }
        if (merged.length >= 4500) break;
      }
      return { type: 'FeatureCollection', features: merged };
    }

    async function fetchRemoteGeoJson(url, signal) {
      if (remoteRawCache.has(url)) return remoteRawCache.get(url);
      const isFileProto = window.location.protocol === 'file:';
      const targetUrl =
        !url.startsWith('http') && isFileProto ? `${GITHUB_PAGES_BASE}/${url}` : url;

      const resp = await fetchWithTimeout(targetUrl, { signal }, 12000);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      remoteRawCache.set(url, json);
      return json;
    }

    async function loadFallbackLayer(state, signal) {
      const { cfg } = state;
      const fb = cfg.fallback;
      if (!fb) throw new Error('Sem fonte alternativa configurada');

      // 1. Raster Tiles Fallback (ex: PD2019 GeoItajaí)
      if (fb.tileUrl) {
        clearStateMapObjects(state);
        const { paneName } = state;
        const tileOpacity = state.opacity ?? fb.tileOpacity ?? 0.72;
        const tl = attachTileRetry(
          L.tileLayer(fb.tileUrl, {
            pane: paneName,
            minZoom: 10,
            maxNativeZoom: fb.tileMaxNativeZoom || 16,
            maxZoom: 21,
            bounds: ITAJAI_BOUNDS,
            opacity: tileOpacity,
            errorTileUrl: TRANSPARENT_TILE,
            keepBuffer: 4,
          }),
          1
        );
        tl.addTo(map);
        state.tileOverlay = tl;
        state.leafletLayer = null;
        state.labelGroup = null;
        state.geojson = null;
        state.count = 0;
        state.loading = false;
        state.error = null;
        state.offlineBlocked = false;
        state.usingFallback = true;
        state.isTileFallback = true;
        state.fallbackLabel = fb.label || 'Tiles GeoItajaí';
        syncLayerZIndexes();
        callbacks.onStateChange?.();
        return;
      }

      // 2. Articulação Cadastral (parcelGrid)
      if (fb.parcelGrid) {
        const bbox = map.getBounds().pad(0.08);
        const rawFc = await loadGeoItajaiParcelGrid(bbox, signal);
        if (signal.aborted || !activeLayers.has(cfg.id)) return;
        const gj = applyFallbackTransform(rawFc, cfg);
        attachLayerData(state, gj, { usingFallback: true, fallbackLabel: fb.label || 'Articulação Cadastral' });
        return;
      }

      // 3. Bundle embarcado instantâneo (funciona em 0ms tanto em file:// quanto https://)
      if (fb.bundleKey && window.GEOITAJAI_BUNDLE?.[fb.bundleKey]) {
        const gj = applyFallbackTransform(window.GEOITAJAI_BUNDLE[fb.bundleKey], cfg);
        attachLayerData(state, gj, { usingFallback: true, fallbackLabel: fb.label || 'Contingência Local' });
        return;
      }

      // 4. Lista de URLs remotas / relativas CORS
      const candidateUrls = [...(fb.urls || [])];
      if (window.location.protocol === 'file:') {
        // Garante tentativa no GitHub Pages caso urls só tenha path relativo
        for (const u of [...candidateUrls]) {
          if (!u.startsWith('http')) {
            const ghUrl = `${GITHUB_PAGES_BASE}/${u}`;
            if (!candidateUrls.includes(ghUrl)) candidateUrls.push(ghUrl);
          }
        }
      }

      let lastErr = null;
      for (const u of candidateUrls) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        try {
          const raw = await fetchRemoteGeoJson(u, signal);
          if (signal.aborted || !activeLayers.has(cfg.id)) return;
          const gj = applyFallbackTransform(raw, cfg);
          if (!cfg.viewportMode && !fb.ignoreCache) {
            dataCache.set(cfg.id, {
              geojson: gj,
              usingFallback: true,
              fallbackLabel: fb.label || 'GeoItajaí (Contingência)',
            });
          }
          attachLayerData(state, gj, {
            usingFallback: true,
            fallbackLabel: fb.label || 'GeoItajaí (Contingência)',
          });
          return;
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          lastErr = err;
        }
      }

      throw lastErr || new Error('Fontes alternativas indisponíveis');
    }

    function clearStateMapObjects(state) {
      if (state.leafletLayer && map.hasLayer(state.leafletLayer)) {
        map.removeLayer(state.leafletLayer);
      }
      if (state.labelGroup && map.hasLayer(state.labelGroup)) {
        map.removeLayer(state.labelGroup);
      }
      if (state.tileOverlay && map.hasLayer(state.tileOverlay)) {
        map.removeLayer(state.tileOverlay);
      }
      state.leafletLayer = null;
      state.labelGroup = null;
      state.tileOverlay = null;
    }

    async function enableLayer(layerId) {
      if (activeLayers.has(layerId)) return;

      const userL = userLayers.find((u) => u.id === layerId);
      if (userL) {
        const { paneName } = getOrCreateLayerPane(layerId);
        layerOrder.push(layerId);
        const st = {
          cfg: userL,
          paneName,
          leafletLayer: null,
          labelGroup: null,
          tileOverlay: null,
          geojson: userL.geojson,
          opacity: userL.opacity,
          loading: false,
          zoomBlocked: false,
          offlineBlocked: false,
          usingFallback: false,
          isTileFallback: false,
          error: null,
          count: userL.geojson.features.length,
        };
        activeLayers.set(layerId, st);
        const gl = buildGeoJsonLayer(userL, userL.geojson, userL.opacity, paneName, st);
        gl.addTo(map);
        st.leafletLayer = gl;
        syncLayerZIndexes();
        callbacks.onStateChange?.();
        return;
      }

      const found = getLayerById(layerId);
      if (!found) return;
      const { layer: cfg } = found;
      const { paneName } = getOrCreateLayerPane(layerId);

      layerOrder.push(layerId);
      const state = {
        cfg,
        paneName,
        leafletLayer: null,
        labelGroup: null,
        tileOverlay: null,
        geojson: null,
        opacity: cfg.opacity ?? 0.7,
        loading: false,
        zoomBlocked: false,
        offlineBlocked: false,
        usingFallback: false,
        isTileFallback: false,
        fallbackLabel: null,
        error: null,
        count: 0,
        controller: null,
      };
      activeLayers.set(layerId, state);
      syncLayerZIndexes();

      if (cfg.isLocalData && cfg.id === 'limite_municipal_ibge' && window.ITAJAI_LIMIT_GEOJSON) {
        attachLayerData(state, window.ITAJAI_LIMIT_GEOJSON, { usingFallback: false });
        return;
      }

      await loadOrRefreshLayer(layerId, { notifyZoom: true });
    }

    async function loadOrRefreshLayer(layerId, { notifyZoom = false } = {}) {
      const state = activeLayers.get(layerId);
      if (!state || state.cfg.isUserLayer || state.cfg.isLocalData) return;
      const { cfg } = state;

      // Verifica cache primeiro (camadas não dependentes de viewport)
      if (!cfg.viewportMode && dataCache.has(layerId)) {
        const cached = dataCache.get(layerId);
        attachLayerData(state, cached.geojson, {
          usingFallback: cached.usingFallback,
          fallbackLabel: cached.fallbackLabel,
        });
        return;
      }

      if (state.controller) state.controller.abort();
      const controller = new AbortController();
      state.controller = controller;
      state.loading = true;
      state.error = null;
      state.offlineBlocked = false;
      state.zoomBlocked = false;
      callbacks.onStateChange?.();

      try {
        const status = await ensureArcgisStatus();
        if (controller.signal.aborted || !activeLayers.has(layerId)) return;

        if (status === 'online') {
          if (cfg.viewportMode && cfg.minZoom && map.getZoom() < cfg.minZoom) {
            clearStateMapObjects(state);
            state.zoomBlocked = true;
            state.loading = false;
            callbacks.onStateChange?.();
            if (notifyZoom) callbacks.onZoomHint?.(cfg);
            return;
          }

          try {
            const bbox = cfg.viewportMode ? map.getBounds().pad(0.15) : null;
            const gj = await queryFeatureServer(cfg, { bbox, signal: controller.signal });
            if (controller.signal.aborted || !activeLayers.has(layerId)) return;
            if (!cfg.viewportMode) {
              dataCache.set(layerId, { geojson: gj, usingFallback: false, fallbackLabel: null });
            }
            attachLayerData(state, gj, { usingFallback: false, fallbackLabel: null });
            return;
          } catch (liveErr) {
            if (liveErr.name === 'AbortError' || controller.signal.aborted) return;
            if (!cfg.fallback) {
              if (cfg.liveOnly) {
                clearStateMapObjects(state);
                state.loading = false;
                state.offlineBlocked = true;
                state.error = cfg.offlineNote || liveErr.message;
                callbacks.onStateChange?.();
                callbacks.onToast?.(state.error, 'info');
                return;
              }
              throw liveErr;
            }
            // Se falhou ao vivo mas possui contingência configurada, segue para fallback!
          }
        }

        // Modo Contingência (arcgis.itajai.sc.gov.br offline ou erro na consulta ao vivo)
        if (cfg.liveOnly) {
          clearStateMapObjects(state);
          state.loading = false;
          state.offlineBlocked = true;
          state.usingFallback = false;
          state.error =
            cfg.offlineNote ||
            `"${cfg.name}" depende exclusivamente do servidor oficial arcgis.itajai.sc.gov.br (atualmente indisponível).`;
          callbacks.onStateChange?.();
          if (notifyZoom) {
            callbacks.onToast?.(state.error, 'info');
          }
          return;
        }

        if (cfg.fallback) {
          const enforceZoom =
            cfg.viewportMode &&
            cfg.minZoom &&
            !cfg.fallback.ignoreMinZoomOnFallback &&
            map.getZoom() < cfg.minZoom;

          if (enforceZoom) {
            clearStateMapObjects(state);
            state.zoomBlocked = true;
            state.loading = false;
            callbacks.onStateChange?.();
            if (notifyZoom) callbacks.onZoomHint?.(cfg);
            return;
          }

          await loadFallbackLayer(state, controller.signal);
          return;
        }

        throw new Error('Servidor oficial indisponível e camada sem contingência.');
      } catch (err) {
        if (err.name === 'AbortError' || controller.signal.aborted) return;
        clearStateMapObjects(state);
        state.loading = false;
        state.error = err.message || 'Falha ao carregar camada';
        callbacks.onStateChange?.();
        callbacks.onToast?.(`Não foi possível carregar "${cfg.name}": ${state.error}`, 'error');
      }
    }

    function attachLayerData(state, geojson, meta = {}) {
      const { cfg, paneName } = state;
      clearStateMapObjects(state);

      state.usingFallback = Boolean(meta.usingFallback);
      state.isTileFallback = false;
      state.fallbackLabel = meta.fallbackLabel || null;
      state.offlineBlocked = false;

      const gl = buildGeoJsonLayer(cfg, geojson, state.opacity, paneName, state);
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
      clearStateMapObjects(state);
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
      if (state.tileOverlay && typeof state.tileOverlay.setOpacity === 'function') {
        state.tileOverlay.setOpacity(opacity);
      }
      if (state.leafletLayer) {
        state.leafletLayer.eachLayer((sub) => {
          if (sub instanceof L.CircleMarker) {
            sub.setStyle({ fillOpacity: Math.min(1, opacity), opacity: Math.min(1, opacity) });
          } else if (sub.setStyle) {
            sub.setStyle(computeFeatureStyle(state.cfg, sub.feature, opacity, state));
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
      map.fitBounds(ITAJAI_BOUNDS, { padding: [20, 20] });
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
          const needsViewportRefresh =
            state.cfg.viewportMode &&
            !(state.usingFallback && state.cfg.fallback?.ignoreMinZoomOnFallback) &&
            !state.isTileFallback;
          if (needsViewportRefresh) {
            loadOrRefreshLayer(id, { notifyZoom: false });
          }
        }
      }, 260);
    });

    function findLocalHits(geojson, latlng, tolDeg = 0.0003) {
      const hits = [];
      for (const f of geojson?.features || []) {
        try {
          if (geomContainsLatLng(f.geometry, latlng, tolDeg)) {
            hits.push(f);
            if (hits.length >= 5) break;
          }
        } catch {
          // ignore
        }
      }
      return hits;
    }

    async function getCoreOfflineGeoJson(layerId) {
      const activeSt = activeLayers.get(layerId);
      if (activeSt?.geojson?.features?.length) return activeSt.geojson;
      const cached = dataCache.get(layerId);
      if (cached?.geojson?.features?.length) return cached.geojson;

      if (layerId === 'bairros_2025' && window.GEOITAJAI_BUNDLE?.bairros) {
        return normalizeGeoJsonToWgs84(window.GEOITAJAI_BUNDLE.bairros);
      }
      if (layerId === 'zoneamento_2024' && window.GEOITAJAI_BUNDLE?.zoneamento_contingency) {
        return normalizeGeoJsonToWgs84(window.GEOITAJAI_BUNDLE.zoneamento_contingency);
      }
      if (layerId === 'planta_cadastral') {
        try {
          const idx = await ensureParcelGridIndex();
          const latlngCenter = map.getCenter();
          // Caso já esteja em cache o quadrante, reaproveita sem refetch pesado
          const cell = idx.find(
            (c) =>
              c.sw[0] <= latlngCenter.lat &&
              latlngCenter.lat <= c.ne[0] &&
              c.sw[1] <= latlngCenter.lng &&
              latlngCenter.lng <= c.ne[1]
          );
          if (cell && parcelTileCache.has(cell.nome)) {
            return { type: 'FeatureCollection', features: parcelTileCache.get(cell.nome) };
          }
        } catch {
          // ignore
        }
      }
      return null;
    }

    async function identifyAtPoint(latlng) {
      const results = [];
      const tolDeg = 0.00025 * Math.pow(2, Math.max(0, 15 - map.getZoom()));
      const env = `${latlng.lng - tolDeg},${latlng.lat - tolDeg},${latlng.lng + tolDeg},${latlng.lat + tolDeg}`;

      const targetIds = new Set([...activeLayers.keys()]);
      for (const cid of ['bairros_2025', 'zoneamento_2024', 'planta_cadastral']) targetIds.add(cid);

      const status = await ensureArcgisStatus();

      const tasks = [...targetIds].map(async (id) => {
        const state = activeLayers.get(id);
        const found = state ? { layer: state.cfg } : getLayerById(id);
        if (!found) return;
        const cfg = found.layer;
        const isCoreExtra = !activeLayers.has(id);

        if (state?.geojson) {
          const hits = findLocalHits(state.geojson, latlng, tolDeg);
          if (hits.length) {
            results.push({ layerId: id, layerName: cfg.name, cfg, features: hits, isCoreExtra });
          }
          return;
        }

        if (cfg.isUserLayer || cfg.isLocalData) return;

        if (status === 'online' && cfg.service) {
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
            const resp = await fetchWithTimeout(`${baseUrl}/query?${params.toString()}`, { cache: 'no-store' }, 5000);
            if (resp.ok) {
              const json = await resp.json();
              const feats = (json.features || []).map((f) => ({ properties: f.attributes || {} }));
              if (feats.length) {
                results.push({ layerId: id, layerName: cfg.name, cfg, features: feats, isCoreExtra });
                return;
              }
            }
          } catch {
            // tenta contingência local abaixo
          }
        }

        // Contingência local / GeoItajaí para Raio-X instantâneo
        if (id === 'planta_cadastral') {
          try {
            const idx = await ensureParcelGridIndex();
            const cell = idx.find(
              (c) =>
                c.sw[0] <= latlng.lat &&
                latlng.lat <= c.ne[0] &&
                c.sw[1] <= latlng.lng &&
                latlng.lng <= c.ne[1]
            );
            if (cell) {
              let feats = parcelTileCache.get(cell.nome);
              if (!feats) {
                const resp = await fetchWithTimeout(`${PARCEL_TILE_URL}/${cell.nome}.geojson`, {}, 6000);
                if (resp.ok) {
                  const raw = await resp.json();
                  feats = Array.isArray(raw) ? raw : raw?.features || [];
                  parcelTileCache.set(cell.nome, feats);
                }
              }
              if (feats?.length) {
                const hits = findLocalHits({ type: 'FeatureCollection', features: feats }, latlng, tolDeg).map(
                  (f) => ({
                    ...f,
                    properties: {
                      ...f.properties,
                      inscricao: f.properties?.inscricao || f.properties?.inscrlig,
                    },
                  })
                );
                if (hits.length) {
                  results.push({
                    layerId: id,
                    layerName: cfg.name,
                    cfg,
                    features: hits,
                    isCoreExtra,
                  });
                }
              }
            }
          } catch {
            // ignore
          }
          return;
        }

        const fallbackGj = await getCoreOfflineGeoJson(id);
        if (fallbackGj) {
          const hits = findLocalHits(fallbackGj, latlng, tolDeg);
          if (hits.length) {
            results.push({ layerId: id, layerName: cfg.name, cfg, features: hits, isCoreExtra });
          }
        }
      });

      await Promise.all(tasks);
      const order = { bairros_2025: 1, zoneamento_2024: 2, planta_cadastral: 3 };
      results.sort((a, b) => (order[a.layerId] || 50) - (order[b.layerId] || 50));
      return results;
    }

    function exportLayerGeoJSON(layerId) {
      const state = activeLayers.get(layerId);
      if (state?.isTileFallback) {
        callbacks.onToast?.(
          `"${state.cfg.name}" está em modo matricial (tiles PNG) de contingência — exportação vetorial indisponível offline.`,
          'info'
        );
        return;
      }
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

      geojson = normalizeGeoJsonToWgs84(geojson);
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
        str
          .trim()
          .split(/\s+/)
          .map((p) => p.split(',').map(Number))
          .filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
          .map((c) => [c[0], c[1]]);
      for (const pm of placemarks) {
        const name = pm.querySelector('name')?.textContent?.trim() || 'Feição KML';
        const desc = pm.querySelector('description')?.textContent?.trim() || '';
        const pt = pm.querySelector('Point coordinates');
        const ls = pm.querySelector('LineString coordinates');
        const pg = pm.querySelector('Polygon outerBoundaryIs LinearRing coordinates');
        let geometry = null;
        if (pt) {
          const c = parseCoords(pt.textContent)[0];
          if (c) geometry = { type: 'Point', coordinates: c };
        } else if (ls) {
          const c = parseCoords(ls.textContent);
          if (c.length >= 2) geometry = { type: 'LineString', coordinates: c };
        } else if (pg) {
          const c = parseCoords(pg.textContent);
          if (c.length >= 3) geometry = { type: 'Polygon', coordinates: [c] };
        }
        if (geometry) features.push({ type: 'Feature', properties: { nome: name, descricao: desc }, geometry });
      }
      return { type: 'FeatureCollection', features };
    }

    function getActiveLegends() {
      return getOrderedActiveLayers().map((state) => {
        const { cfg } = state;
        const entry = {
          id: cfg.id,
          name: cfg.name,
          geomType: cfg.geomType,
          usingFallback: state.usingFallback,
          fallbackLabel: state.fallbackLabel,
          isTileFallback: state.isTileFallback,
          offlineBlocked: state.offlineBlocked,
          swatches: [],
        };

        if (state.offlineBlocked) {
          entry.swatches.push({
            label: 'Servidor oficial inacessível',
            color: '#cbd5e1',
            outline: true,
          });
          return entry;
        }

        const cmap = getEffectiveColorMap(cfg, state);
        if (cmap) {
          for (const [label, color] of Object.entries(cmap)) {
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
            label: state.isTileFallback ? `${cfg.name} (${state.fallbackLabel || 'Tiles'})` : cfg.name,
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
      getArcgisStatus: () => arcgisStatus,
      ensureArcgisStatus,
      recheckArcgisServer,
      reloadLayer: (id) => loadOrRefreshLayer(id, { notifyZoom: true }),
      prettyFieldName,
      formatFieldValue,
      escapeHtml,
    };
  }

  return {
    createEngine,
    prettyFieldName,
    formatFieldValue,
    escapeHtml,
    normalizeGeoJsonToWgs84,
    geomContainsLatLng,
    fetchWithTimeout,
  };
})();
