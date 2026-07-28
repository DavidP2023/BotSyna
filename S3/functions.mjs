// functions.mjs - SALOMON PROPIEDADES - Inmobiliaria Bot
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

// ─── SUPABASE CLIENT (mismo patrón que la clínica) ───────────────────────────
class SupabaseClient {
  constructor(url, apiKey) {
    this.url = url;
    this.apiKey = apiKey;
    this.headers = {
      'apikey': apiKey,
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };
  }

  async get(table, params = {}) {
    let url = `${this.url}/rest/v1/${table}`;
    const queryParams = new URLSearchParams();

    if (params.select) queryParams.append('select', params.select);

    // Filtros simples eq
    if (params.eq) {
      Object.entries(params.eq).forEach(([key, val]) => {
        queryParams.append(key, `eq.${val}`);
      });
    }

    // Filtros ilike (case-insensitive like)
    if (params.ilike) {
      Object.entries(params.ilike).forEach(([key, val]) => {
        queryParams.append(key, `ilike.${val}`);
      });
    }

    // Limit
    if (params.limit) queryParams.append('limit', params.limit);

    // Offset para paginación
    if (params.offset) queryParams.append('offset', params.offset);

    // Order
    if (params.order) queryParams.append('order', params.order);

    if (queryParams.toString()) url += `?${queryParams.toString()}`;

    const response = await fetch(url, { method: 'GET', headers: this.headers });
    if (!response.ok) throw new Error(`Supabase GET error: ${response.status} - ${await response.text()}`);
    return await response.json();
  }

  async post(table, data) {
    const response = await fetch(`${this.url}/rest/v1/${table}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(data)
    });
    if (!response.ok) throw new Error(`Supabase POST error: ${response.status} - ${await response.text()}`);
    return await response.json();
  }
}

function getPropertyTables(supabaseConfig) {
  const configured = Array.isArray(supabaseConfig?.property_tables)
    ? supabaseConfig.property_tables
    : [];

  const defaults = ['propiedades_v2'];
  const unique = [...configured, ...defaults]
    .map(t => String(t || '').trim())
    .filter(Boolean)
    .filter((t, i, arr) => arr.indexOf(t) === i);

  return unique.length > 0 ? unique : defaults;
}

function buildPropertyUrl(supabaseUrl, table, params = {}) {
  const qp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    qp.append(key, String(value));
  }
  return `${supabaseUrl}/rest/v1/${table}?${qp.toString()}`;
}

async function fetchFromPropertyTables({ supabaseConfig, headers, params, contextTag }) {
  const tables = getPropertyTables(supabaseConfig);
  let lastError = null;

  for (const table of tables) {
    const url = buildPropertyUrl(supabaseConfig.url, table, params);
    const { data, error } = await supabaseRequest(
      url,
      { method: 'GET', headers },
      `${contextTag}_${table.toUpperCase()}`
    );

    if (error) {
      lastError = error;
      continue;
    }

    if (Array.isArray(data) && data.length > 0) {
      return { data, table, error: null };
    }
  }

  return { data: [], table: null, error: lastError };
}

// ─── BUSCAR PROPIEDAD POR CÓDIGO DE LINK ─────────────────────────────────────

/**
 * Detecta si un mensaje contiene un link de Zonaprop o La Voz,
 * extrae el código numérico y la URL limpia.
 * Retorna: { fuente, codigo, link } | null
 *
 * Formatos soportados:
 *   Zonaprop: zonaprop.com.ar/...-58389364.html  → codigo: "58389364"
 *   La Voz:   clasificados.lavoz.com.ar/.../5565873  → codigo: "5565873"
 *             lavoz.com.ar/.../5565873/...          → codigo: "5565873"
 */
function detectarLink(mensaje) {
  if (!mensaje || typeof mensaje !== 'string') return null;

  // ── Zonaprop ──────────────────────────────────────────────────────────────
  // El código es el último bloque de 6+ dígitos en el path (antes de .html o ?)
  if (/zonaprop\.com\.ar/i.test(mensaje)) {
    const urlMatch = mensaje.match(/(?:https?:\/\/)?(?:www\.)?zonaprop\.com\.ar([^\s"'#<>\]]*)/i);
    if (urlMatch) {
      const fullUrl = `https://www.zonaprop.com.ar${urlMatch[1]}`;
      const path = urlMatch[1].split('?')[0].split('#')[0];
      const numeros = path.match(/\d{6,}/g);
      if (numeros && numeros.length > 0) {
        const codigo = numeros[numeros.length - 1];
        console.log(JSON.stringify({ type: 'LINK_DETECTED', portal: 'zonaprop', codigo, path }));
        return { fuente: 'zonaprop', codigo, link: fullUrl };
      }
    }
  }

  // ── La Voz / Clasificados La Voz ─────────────────────────────────────────
  // Soporta: clasificados.lavoz.com.ar, lavoz.com.ar
  // El código es el último bloque de 5+ dígitos en el path
  if (/lavoz\.com\.ar/i.test(mensaje)) {
    const urlMatch = mensaje.match(/(?:https?:\/\/)?(?:(?:clasificados|www)\.)?lavoz\.com\.ar([^\s"'#<>\]]*)/i);
    if (urlMatch) {
      const rawHost = mensaje.match(/(?:https?:\/\/)?([^\s"'#<>\]]*lavoz\.com\.ar[^\s"'#<>\]]*)/i)?.[1] || '';
      const fullUrl = rawHost.startsWith('http') ? rawHost : `https://${rawHost}`;
      const path = urlMatch[1].split('?')[0].split('#')[0];
      const numeros = path.match(/\d{5,}/g);
      if (numeros && numeros.length > 0) {
        const codigo = numeros[numeros.length - 1];
        console.log(JSON.stringify({ type: 'LINK_DETECTED', portal: 'lavoz', codigo, path }));
        return { fuente: 'lavoz', codigo, link: fullUrl };
      }
    }
  }

  return null;
}

async function buscarPropiedadPorLink(fuente, codigo, supabaseConfig) {
  return obtenerPropiedadPorCodigo(fuente, codigo, supabaseConfig);
}

/**
 * Busca una propiedad en Supabase por el código del portal.
 * Portal 'zonaprop' → columna cod_zp
 * Portal 'lavoz'    → columna cod_lvi
 * Retorna el objeto propiedad completo o null.
 */
async function obtenerPropiedadPorCodigo(portal, codigo, supabaseConfig) {
  if (!portal || !codigo) {
    console.error('❌ obtenerPropiedadPorCodigo: portal y codigo son requeridos');
    return null;
  }

  const apiKey = supabaseConfig?.service_role_key || supabaseConfig?.anon_key;
  const supabaseUrl = supabaseConfig?.url;

  if (!supabaseUrl || !apiKey) {
    console.error('❌ obtenerPropiedadPorCodigo: falta config Supabase');
    return null;
  }

  const codigoSafe = encodeURIComponent(String(codigo).trim());
  const headers = {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };

  const columnas = portal === 'zonaprop' ? ['cod_zp'] : ['cod_lvi', 'cod_lv'];

  let data = null;
  let error = null;
  for (const columna of columnas) {
    const res = await fetchFromPropertyTables({
      supabaseConfig,
      headers,
      params: { select: '*', [columna]: `eq.${codigoSafe}`, limit: 1 },
      contextTag: `PROPIEDAD_BY_CODE_${portal.toUpperCase()}_${columna.toUpperCase()}`
    });
    data = res.data;
    error = res.error;
    if (!error && Array.isArray(data) && data.length > 0) {
      console.log(JSON.stringify({ type: 'PROPERTY_MATCH_SUCCESS', portal, codigo, columna, tabla: res.table, propiedadId: data[0].id }));
      return data[0];
    }
  }

  if (error) {
    console.log(JSON.stringify({ type: 'PROPERTY_MATCH_FAIL', portal, codigo, reason: String(error) }));
    return null;
  }

  if (!Array.isArray(data) || data.length === 0) {
    console.log(JSON.stringify({ type: 'PROPERTY_MATCH_FAIL', portal, codigo, reason: 'NOT_FOUND' }));
    return null;
  }

  return data[0];
}

/**
 * Guarda un lead de link de portal en la tabla consultas_links.
 * Tiene deduplicación fuerte: no inserta si ya existe (telefono + codigo).
 * Retorna true si se guardó (o ya existía), false si hubo error real.
 */
async function guardarConsultaLink({ telefono, link, portal, codigo }, supabaseConfig) {
  // Para insertar necesitamos service_role (RLS puede bloquear anon)
  const apiKey = supabaseConfig?.service_role_key || supabaseConfig?.anon_key;
  const supabaseUrl = supabaseConfig?.url;

  if (!supabaseUrl || !apiKey) {
    console.error('❌ guardarConsultaLink: falta config Supabase');
    return false;
  }

  if (!link || !portal) {
    console.error('❌ guardarConsultaLink: link y portal son requeridos');
    return false;
  }

  const headers = {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };

  const telefonoClean = telefono ? String(telefono).replace(/\D/g, '') : null;
  const codigoClean   = codigo   ? String(codigo).trim() : null;

  // ── Deduplicación: mismo usuario + mismo código de propiedad ──────────────
  if (telefonoClean && codigoClean) {
    const dedupUrl = `${supabaseUrl}/rest/v1/consultas_links?telefono=eq.${encodeURIComponent(telefonoClean)}&codigo=eq.${encodeURIComponent(codigoClean)}&limit=1`;
    const { data: existente, error: dedupError } = await supabaseRequest(
      dedupUrl,
      { method: 'GET', headers },
      'CONSULTAS_LINKS_DEDUP'
    );

    if (!dedupError && Array.isArray(existente) && existente.length > 0) {
      console.log(`⚠️ guardarConsultaLink: lead duplicado omitido (tel=${telefonoClean}, cod=${codigoClean})`);
      return true;
    }
  }

  const payload = {
    telefono: telefonoClean,
    link:     String(link).substring(0, 1000), // prevenir textos enormes
    portal:   String(portal).substring(0, 20),
    codigo:   codigoClean
  };

  const { data, error } = await supabaseRequest(
    `${supabaseUrl}/rest/v1/consultas_links`,
    { method: 'POST', headers, body: JSON.stringify(payload) },
    'CONSULTAS_LINKS_INSERT'
  );

  if (error) {
    // El índice único lanza 409/23505 si hay race condition → no es error fatal
    if (String(error).includes('23505') || String(error).includes('409')) {
      console.log('⚠️ guardarConsultaLink: conflicto único en insert (race condition), ignorado');
      return true;
    }
    console.error('❌ guardarConsultaLink: error al insertar:', error);
    return false;
  }

  console.log(JSON.stringify({
    type: 'LEAD_SAVED',
    portal,
    codigo: codigoClean,
    telefono: telefonoClean,
    insertedId: Array.isArray(data) ? data[0]?.id : null
  }));
  return true;
}

// ─── BUSCAR PROPIEDADES CON FILTROS ─────────────────────────────────────────

async function buscarPropiedades(filtros, supabaseConfig, offset = 0) {
  console.log(JSON.stringify({ type: 'PROPERTY_SEARCH', filtros, offset, timestamp: new Date().toISOString() }));

  if (!supabaseConfig?.url || !supabaseConfig?.anon_key) {
    console.log('❌ Falta config Supabase');
    return null;
  }

  const norm       = str => (str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const parsePrice = str => parseFloat(String(str || '').replace(/[.,\s]/g, '')) || 0;
  const normStreet = str => norm(str).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const splitWords = str => normStreet(str).split(' ').filter(w => w.length >= 3);
  const levenshtein = (a, b) => {
    if (a === b) return 0;
    if (!a) return b.length;
    if (!b) return a.length;
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[m][n];
  };
  const closeWord = (a, b) => {
    const maxLen = Math.max(a.length, b.length);
    const dist = levenshtein(a, b);
    if (maxLen <= 5) return dist <= 1;
    if (maxLen <= 9) return dist <= 2;
    return dist <= 3;
  };
  const fuzzyDireccion = (inputDir, rowDir) => {
    const iw = splitWords(inputDir);
    if (iw.length === 0) return false;
    const rowNorm = normStreet(rowDir);
    if (!rowNorm) return false;
    if (rowNorm.includes(normStreet(inputDir))) return true;
    const rw = splitWords(rowDir);
    if (rw.length === 0) return false;
    return iw.every(w => rw.some(r => closeWord(w, r)));
  };

  const operacionNorm  = norm(filtros.operacion);
  const tipologiaNorm  = norm(filtros.tipologia || filtros.tipo_propiedad);
  const tiposArray     = tipologiaNorm ? tipologiaNorm.split(',').map(t => t.trim()).filter(Boolean) : [];
  const barrioNorm     = norm(filtros.barrio);
  const direccionNorm  = norm(filtros.direccion);
  const ambientesNum   = filtros?.ambientes    ? parseInt(filtros.ambientes, 10) : null;
  const dormitoriosNum = filtros?.dormitorios  ? parseInt(filtros.dormitorios, 10) : null;
  const dormitoriosOp  = filtros?.dormitorios_op || 'eq';
  const aptoBanco      = filtros?.apto_banco   || false;
  const limitNum       = Number.isFinite(Number(filtros?.limit)) ? Number(filtros.limit) : 10;

  // Precio: min y max directos (el caller ya resolvió el presupuesto como techo)
  const precioMin = filtros?.precio_min ? Number(filtros.precio_min) : null;
  const precioMax = filtros?.precio_max ? Number(filtros.precio_max) : null;
  console.log("TIPOS:", tiposArray);
  console.log("PRECIO MIN:", precioMin);
  console.log("PRECIO MAX:", precioMax);

  // Fetch amplio desde Supabase — solo filtros estructurales (operacion/tipologia/barrio)
  // El precio se filtra en JS igual que en Sheets para evitar problemas de tipo TEXT
  const _fetchDB = async () => {
    const qp = new URLSearchParams();
    qp.append('select', '*');
    if (operacionNorm) qp.append('operacion', `ilike.${operacionNorm}`);
    if (tiposArray.length === 1) {
      qp.append('tipologia', `ilike.${tiposArray[0]}`);
    } else if (tiposArray.length > 1) {
      qp.append('or', `(${tiposArray.map(t => `tipologia.ilike.${t}`).join(',')})`);
    }
    if (barrioNorm)     qp.append('barrio',     `ilike.${barrioNorm}`);
    if (ambientesNum   && ambientesNum > 0)  qp.append('ambientes',   `eq.${ambientesNum}`);
    if (dormitoriosNum && dormitoriosNum > 0) qp.append('dormitorios', `${dormitoriosOp}.${dormitoriosNum}`);
    if (aptoBanco) qp.append('apto_banco', `eq.true`);
    qp.append('limit',  '200');
    qp.append('offset', '0');
    qp.append('order',  'id.asc');
    const apiKey = supabaseConfig.service_role_key || supabaseConfig.anon_key;
    const headers = { apikey: apiKey, Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    const tables = getPropertyTables(supabaseConfig);
    const merged = [];
    const seenIds = new Set();

    for (const table of tables) {
      const qpExact = new URLSearchParams(qp.toString());
      if (direccionNorm) qpExact.append('direccion', `ilike.%${direccionNorm}%`);

      const url = `${supabaseConfig.url}/rest/v1/${table}?${qpExact.toString()}`;
      const response = await fetch(url, { method: 'GET', headers });
      if (!response.ok) {
        console.error(`❌ Supabase error (${table}): ${response.status}`, await response.text());
        continue;
      }
      let rows = await response.json();
      if (!Array.isArray(rows)) {
        console.error(`❌ Supabase respuesta inesperada (${table})`);
        continue;
      }

      if (direccionNorm && rows.length === 0) {
        const urlRelaxed = `${supabaseConfig.url}/rest/v1/${table}?${qp.toString()}`;
        const respRelaxed = await fetch(urlRelaxed, { method: 'GET', headers });
        if (respRelaxed.ok) {
          const relaxedRows = await respRelaxed.json();
          if (Array.isArray(relaxedRows)) {
            rows = relaxedRows.filter(r => fuzzyDireccion(direccionNorm, r?.direccion || ''));
          }
        }
      }

      for (const row of rows) {
        const rowId = row?.id != null ? String(row.id) : null;
        if (!rowId || seenIds.has(rowId)) continue;
        seenIds.add(rowId);
        merged.push(row);
      }
    }

    return merged;
  };

  // Filtro de precio en JS (igual que filtrarPropiedades de Sheets)
  const _filtrarPrecio = (data, pMin, pMax) => data.filter(p => {
    const num = parsePrice(p.precio);
    if (pMin && num < pMin) return false;
    if (pMax && num > pMax) return false;
    return true;
  });

  try {
    const data = await _fetchDB();
    if (data === null) return null;

    let filtrados = _filtrarPrecio(data, precioMin, precioMax);

    // Fallback: las más baratas si no hay resultados con el filtro (igual que Sheets)
    if (filtrados.length === 0 && data.length > 0) {
      filtrados = [...data].sort((a, b) => parsePrice(a.precio) - parsePrice(b.precio)).slice(0, 3);
      console.log(`Fallback más baratas: ${filtrados.length} props`);
    }

    // Paginado en JS
    const results = filtrados.slice(offset, offset + limitNum);

    if (results.length === 0) {
      console.log(JSON.stringify({ type: 'NO_RESULTS', filtros, offset, timestamp: new Date().toISOString() }));
      return [];
    }
    console.log(JSON.stringify({ type: 'PROPERTY_RESULTS', total: results.length, ids: results.map(p => p.id), timestamp: new Date().toISOString() }));
    return results;
  } catch (err) {
    console.error('❌ Error buscando propiedades:', err.message);
    return null;
  }
}

// ─── FORMATEAR PROPIEDAD PARA MOSTRAR ────────────────────────────────────────

function construirEncabezadoPropiedad(prop, numero, total = 2) {
  const tipologia = String(prop?.tipologia || 'Propiedad').trim();
  const barrio = String(prop?.barrio || '').trim();
  const titulo = barrio ? `${tipologia} en ${barrio}` : tipologia;
  if (Number(total) === 1) return `🏠 *${titulo}*`;
  return `🏠 *Opción ${numero} - ${titulo}*`;
}

function formatearPropiedad(prop, numero, total = 2) {
  const precio = prop.precio
    ? `$${Number(prop.precio).toLocaleString('es-AR')}`
    : 'Consultar';
  const aptoBanco = prop.apto_banco === 1 || prop.apto_banco === true ? 'Sí' : 'No';
  const ambientes = prop.ambientes ? `${prop.ambientes} ambientes` : '';
  const dormitorios = prop.dormitorios ? `${prop.dormitorios} dormitorios` : '';
  const habitInfo = [ambientes, dormitorios].filter(Boolean).join(' | ');

  let texto = `${construirEncabezadoPropiedad(prop, numero, total)}\n`;
  texto += `📍 ${prop.direccion}\n`;
  if (habitInfo) texto += `🚪 ${habitInfo}\n`;
  texto += `💰 ${precio}\n`;
  texto += `🏦 Apto banco: ${aptoBanco}\n`;
  if (prop.descripcion) texto += `📝 ${prop.descripcion}`;

  return texto;
}

// ─── REFERENCIA DE FECHAS (para evitar errores del LLM con fechas relativas) ──

// Lambda corre en UTC. Argentina es UTC-3 sin DST — ajuste manual.
function ahoraArgentina() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
  return new Date(utcMs + (-3 * 60 * 60 * 1000));
}

function generarContextoFechas() {
  const diasSemana = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const nombresMes = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const hoy = ahoraArgentina();
  const lineas = [];

  for (let i = 0; i <= 30; i++) {
    const d = new Date(hoy);
    d.setDate(hoy.getDate() + i);
    const dd    = String(d.getDate()).padStart(2, '0');
    const mm    = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy  = d.getFullYear();
    const nombre = diasSemana[d.getDay()];
    let label;
    if (i === 0)      label = `Hoy (${nombre})`;
    else if (i === 1) label = `Mañana (${nombre})`;
    else              label = `${nombre} (en ${i} días)`;
    lineas.push(`- ${label}: ${dd}/${mm}/${yyyy}`);
  }

  // Calcular el último día de cada nombre de la semana en los meses cubiertos
  const mesesCubiertos = new Set();
  for (let i = 0; i <= 30; i++) {
    const d = new Date(hoy);
    d.setDate(hoy.getDate() + i);
    mesesCubiertos.add(`${d.getFullYear()}-${d.getMonth()}`);
  }

  const ultimosPorMes = [];
  for (const clave of mesesCubiertos) {
    const [yyyy, mes] = clave.split('-').map(Number);
    const nombreMes = nombresMes[mes];
    // Último día del mes
    const ultimoDia = new Date(yyyy, mes + 1, 0).getDate();
    // Para cada día de la semana, encontrar el último en este mes
    for (let dow = 0; dow < 7; dow++) {
      const nombreDia = diasSemana[dow];
      // Empezar desde el último día del mes y retroceder
      for (let d = ultimoDia; d >= 1; d--) {
        const fecha = new Date(yyyy, mes, d);
        if (fecha.getDay() === dow) {
          const dd = String(d).padStart(2, '0');
          const mm = String(mes + 1).padStart(2, '0');
          ultimosPorMes.push(`- Último ${nombreDia} de ${nombreMes}: ${dd}/${mm}/${yyyy}`);
          break;
        }
      }
    }
  }

  return `REFERENCIA DE FECHAS (OBLIGATORIO: usá SOLO estas fechas para interpretar expresiones relativas — NO calcules por tu cuenta):\n${lineas.join('\n')}\n\nÚLTIMOS DÍAS DEL MES (para expresiones como "el último miércoles de abril"):\n${ultimosPorMes.join('\n')}\n\n⚠️ REGLA CRÍTICA: Para "último [día] del mes", usá EXACTAMENTE la fecha listada arriba en "ÚLTIMOS DÍAS DEL MES". Nunca calcules esto por tu cuenta.`;
}

// ─── BUSCAR VISITAS DEL USUARIO ───────────────────────────────────────────────

async function buscarVisitasUsuario(telefono, supabaseConfig) {
  console.log('=== BUSCAR VISITAS USUARIO ===');
  console.log(`📞 Teléfono recibido: "${telefono}" | supabaseUrl=${supabaseConfig?.url ? 'OK' : 'NULL'} | apiKey=${supabaseConfig?.service_role_key ? 'service_role' : supabaseConfig?.anon_key ? 'anon' : 'NINGUNA'}`);

  const apiKey = supabaseConfig?.service_role_key || supabaseConfig?.anon_key;
  const supabaseUrl = supabaseConfig?.url;

  if (!supabaseUrl || !apiKey || !telefono) {
    console.log(`⚠️ Abortando buscarVisitasUsuario: supabaseUrl=${!!supabaseUrl} apiKey=${!!apiKey} telefono=${!!telefono}`);
    return [];
  }

  const cleanPhone = String(telefono).replace(/\D/g, ''); // ej: "5492994630729"

  // Generar variantes en orden de especificidad.
  // %25 en la URL = % que el servidor decodifica como wildcard SQL para ILIKE.
  const variantes = [];
  variantes.push(cleanPhone);                          // "5492994630729"   (exact prefix)
  variantes.push(cleanPhone.slice(-10));               // "2994630729"      (sin prefijo país)
  if (cleanPhone.startsWith('549')) {
    variantes.push(cleanPhone.slice(3));               // "2994630729" (omite 549)
  } else if (cleanPhone.startsWith('54')) {
    variantes.push(cleanPhone.slice(2));               // "92994630729" (omite 54)
  }

  // Deduplicar y filtrar strings demasiado cortos
  const queries = [...new Set(variantes)].filter(v => v.length >= 7);
  console.log(`📋 Variantes a probar: [${queries.join(', ')}]`);

  const headers = {
    'apikey': apiKey,
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };

  for (const variant of queries) {
    try {
      const url = `${supabaseUrl}/rest/v1/visitas?select=*&telefono=ilike.%25${variant}&operacion=neq.cancelado&order=fecha.desc&limit=5`;
      console.log(`🔎 Probando variante "${variant}" → ${url}`);
      const response = await fetch(url, { method: 'GET', headers });
      if (!response.ok) {
        console.error(`❌ Error buscando visitas (variante ${variant}): ${response.status} ${await response.text()}`);
        continue;
      }
      const data = await response.json();
      console.log(`📋 Variante "${variant}": ${data.length} visitas encontradas${data.length > 0 ? ' → ' + JSON.stringify(data.map(v => ({ id: v.id, tel: v.telefono, fecha: v.fecha, op: v.operacion }))) : ''}`);
      if (data.length > 0) {
        // Enriquecer cada visita con datos de la propiedad asociada
        await Promise.all(data.map(async (visita) => {
          if (!visita.id_propiedad) return;
          try {
            const { data: propData } = await fetchFromPropertyTables({
              supabaseConfig,
              headers,
              params: { select: 'direccion,barrio,tipologia', id: `eq.${visita.id_propiedad}`, limit: 1 },
              contextTag: 'VISITAS_ENRICH_PROP'
            });
            if (Array.isArray(propData) && propData.length > 0) {
              visita._propiedad = propData[0];
              console.log(`🏠 Propiedad de visita ${visita.id}: ${propData[0].tipologia} en ${propData[0].barrio} - ${propData[0].direccion}`);
            }
          } catch (err) {
            console.error(`❌ Error buscando propiedad ${visita.id_propiedad}:`, err.message);
          }
        }));
        return data;
      }
    } catch (err) {
      console.error(`❌ Error buscando visitas (variante ${variant}):`, err.message);
    }
  }

  console.log('⚠️ Sin visitas activas para ninguna variante de teléfono');
  return [];
}

async function buscarUltimaVisitaUsuario(telefono, supabaseConfig) {
  const apiKey = supabaseConfig?.service_role_key || supabaseConfig?.anon_key;
  const supabaseUrl = supabaseConfig?.url;
  if (!telefono || !apiKey || !supabaseUrl) return null;

  const cleanPhone = String(telefono).replace(/\D/g, '');
  const variantes = [];
  variantes.push(cleanPhone);
  variantes.push(cleanPhone.slice(-10));
  if (cleanPhone.startsWith('549')) variantes.push(cleanPhone.slice(3));
  if (cleanPhone.startsWith('54') && !cleanPhone.startsWith('549')) variantes.push(cleanPhone.slice(2));

  const queries = [...new Set(variantes)].filter(v => v.length >= 7);
  const headers = {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };

  for (const variant of queries) {
    const url = `${supabaseUrl}/rest/v1/visitas?select=*&telefono=ilike.%25${variant}&operacion=neq.cancelado&order=fecha.desc,hora.desc&limit=1`;
    const { data, error } = await supabaseRequest(url, { method: 'GET', headers }, 'VISITAS_LAST_BY_PHONE');
    if (error) continue;
    if (Array.isArray(data) && data.length > 0) return data[0];
  }

  return null;
}

// ─── ACTUALIZAR VISITA (PATCH) ────────────────────────────────────────────────

async function supabaseRequest(url, options, logLabel = 'SUPABASE') {
  try {
    const response = await fetch(url, options);
    const raw = await response.text();

    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    }

    if (!response.ok) {
      const error = `${logLabel} ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`;
      console.error('❌', error);
      return { data: null, error };
    }

    return { data, error: null };
  } catch (err) {
    const error = `${logLabel} exception: ${err.message}`;
    console.error('❌', error);
    return { data: null, error };
  }
}

// ─── GUARDAR VISITA ──────────────────────────────────────────────────────────

function parseFecha(fechaStr) {
  if (!fechaStr) return { value: null, error: 'Fecha requerida' };

  const input = String(fechaStr).trim();
  let dd;
  let mm;
  let yyyy;

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(input)) {
    const parts = input.split('/');
    dd = parseInt(parts[0], 10);
    mm = parseInt(parts[1], 10);
    yyyy = parseInt(parts[2], 10);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const parts = input.split('-');
    yyyy = parseInt(parts[0], 10);
    mm = parseInt(parts[1], 10);
    dd = parseInt(parts[2], 10);
  } else if (/^\d{2}-\d{2}-\d{4}$/.test(input)) {
    const parts = input.split('-');
    dd = parseInt(parts[0], 10);
    mm = parseInt(parts[1], 10);
    yyyy = parseInt(parts[2], 10);
  } else {
    return { value: null, error: 'Formato de fecha inválido. Usá DD/MM/YYYY.' };
  }

  const date = new Date(Date.UTC(yyyy, mm - 1, dd));
  const esValida =
    date.getUTCFullYear() === yyyy &&
    date.getUTCMonth() === (mm - 1) &&
    date.getUTCDate() === dd;

  if (!esValida) return { value: null, error: 'Fecha inválida' };

  const value = `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  return { value, error: null };
}

function formatFechaParaSupabase(fechaStr) {
  return parseFecha(fechaStr).value;
}

function parseHora(horaStr) {
  if (!horaStr) return { value: null, error: 'Hora requerida' };

  const input = String(horaStr).trim();
  const match = input.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return { value: null, error: 'Formato de hora inválido. Usá HH:MM.' };
  }

  const hh = parseInt(match[1], 10);
  const mm = parseInt(match[2], 10);
  const ss = match[3] !== undefined ? parseInt(match[3], 10) : 0;

  if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) {
    return { value: null, error: 'Hora inválida' };
  }

  const value = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return { value, error: null };
}

function validarDatosReserva(data) {
  if (!data?.id_propiedad) return { ok: false, error: 'Falta id_propiedad' };
  if (!data?.nombre || String(data.nombre).trim().length < 2) return { ok: false, error: 'Nombre inválido' };
  if (!data?.telefono || String(data.telefono).replace(/\D/g, '').length < 8) return { ok: false, error: 'Teléfono inválido' };
  if (!data?.fecha) return { ok: false, error: 'Falta fecha' };
  if (!data?.hora) return { ok: false, error: 'Falta hora' };
  if (!/^\d+$/.test(String(data.id_propiedad))) return { ok: false, error: 'id_propiedad inválido' };
  return { ok: true, error: null };
}

function esConfirmacionClara(texto = '') {
  const t = String(texto || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /^(si|s|dale|ok|okay|confirmo|confirmado|de una|perfecto|listo|hagamoslo|hacelo|procede|proceda)$/.test(t)
    || /\b(si|dale|ok|confirmo|procede)\b/.test(t);
}

function esRechazoClaro(texto = '') {
  const t = String(texto || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /^(no|cancelar|cancela|mejor no|no confirmo|dejalo|deja|frenalo|frenar)$/.test(t)
    || /\b(mejor no|no confirmo|cancelar)\b/.test(t);
}

function esIntencionCancelarVisita(texto = '') {
  const t = String(texto || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!t) return false;
  if (/\bno\s+cancel(?:es|en|ar)?\b/.test(t)) return false;
  return /\b(cancelar|cancela|cancele|cancelalo|cancelala|anular|anula|dar de baja|baja la visita|quiero cancel)/.test(t);
}

function obtenerUltimoMensajeUsuario(history = []) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === 'user') return history[i]?.content || '';
  }
  return '';
}

function pendingActionVigente(pendingAction, ttlMs = 10 * 60 * 1000) {
  if (!pendingAction?.timestamp || !pendingAction?.type || !pendingAction?.data) return false;
  return (Date.now() - Number(pendingAction.timestamp)) <= ttlMs;
}

function logActionExecution(action, data, result) {
  console.log({
    type: 'ACTION_EXECUTION',
    action,
    data,
    result,
    timestamp: new Date().toISOString()
  });
}

function guardarLogAccion({ action, status, payload, error = null }) {
  console.log({
    type: 'ACTION_AUDIT',
    action,
    status,
    payload,
    error,
    timestamp: new Date().toISOString()
  });
}

function validarHorarioVisita(fechaISO, horaStr) {
  const fecha = new Date(fechaISO + 'T12:00:00');
  const diaSemana = fecha.getDay(); // 0=domingo
  const partes = (horaStr || '').split(':');
  const hora = parseInt(partes[0], 10);
  const minutos = parseInt(partes[1] || '0', 10);

  if (diaSemana === 0 || diaSemana === 6) {
    return { valido: false, razon: 'Los fines de semana estamos cerrados. Atendemos de lunes a viernes de 09:00 a 17:00 hs.' };
  }

  if (diaSemana >= 1 && diaSemana <= 5) {
    if (hora < 9 || hora >= 17) {
      return { valido: false, razon: 'Ese horario está fuera de nuestra atención. De lunes a viernes atendemos de 09:00 a 17:00 hs.' };
    }
  }

  if (![0, 15, 30, 45].includes(minutos)) {
    return { valido: false, razon: 'Los horarios disponibles son cada 15 minutos. Por ejemplo: 09:00, 09:15, 09:30, 09:45.' };
  }

  return { valido: true };
}

function limpiarNombrePersona(nombre = '') {
  const raw = String(nombre || '').trim();
  if (!raw) return '';

  const cleaned = raw
    .replace(/^(?:mi\s+nombre\s+es|mi\s+nombre|me\s+llamo|soy)\s+/i, '')
    .replace(/^nombre\s*[:\-]?\s*/i, '')
    .replace(/^es\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || raw;
}

async function guardarVisita(data, supabaseConfig) {
  console.log('=== GUARDAR VISITA ===');
  console.log('DATA:', JSON.stringify(data));

  if (!supabaseConfig?.url || !supabaseConfig?.service_role_key) {
    console.error('❌ Falta config Supabase');
    return { success: false, visitaId: null, error: 'Falta configuración de base de datos', razon: 'Falta configuración de base de datos' };
  }

  try {
    const validacion = validarDatosReserva(data);
    if (!validacion.ok) {
      return { success: false, visitaId: null, error: validacion.error, razon: validacion.error };
    }

    const { value: fechaISO, error: errorFecha } = parseFecha(data.fecha);
    if (errorFecha) {
      return { success: false, visitaId: null, error: errorFecha, razon: errorFecha };
    }

    const { value: horaSQL, error: errorHora } = parseHora(data.hora);
    if (errorHora) {
      return { success: false, visitaId: null, error: errorHora, razon: errorHora };
    }

    // Validar horario antes de guardar
    const horarioOk = validarHorarioVisita(fechaISO, horaSQL);
    if (!horarioOk.valido) {
      console.log('❌ Horario inválido:', horarioOk.razon);
      return { success: false, visitaId: null, error: horarioOk.razon, razon: horarioOk.razon };
    }

    const nombreLimpio = limpiarNombrePersona(data.nombre);
    if (!nombreLimpio || nombreLimpio.length < 2) {
      return { success: false, visitaId: null, error: 'Nombre inválido', razon: 'Nombre inválido' };
    }

    const visitaData = {
      id_propiedad: parseInt(data.id_propiedad, 10),
      nombre: nombreLimpio,
      telefono: data.telefono ? data.telefono.toString().trim() : '',
      fecha: fechaISO,
      hora: horaSQL,
      operacion: data?.operacion === 'confirmado' ? 'confirmado' : 'pendiente'
    };

    // Verificacion obligatoria: la propiedad debe existir en DB antes de agendar.
    const { data: propiedadRows, error: propiedadError } = await fetchFromPropertyTables({
      supabaseConfig,
      headers: {
        apikey: supabaseConfig.service_role_key,
        Authorization: `Bearer ${supabaseConfig.service_role_key}`,
        'Content-Type': 'application/json'
      },
      params: { select: 'id,tipologia,direccion,barrio,operacion', id: `eq.${visitaData.id_propiedad}`, limit: 1 },
      contextTag: 'VISITAS_VALIDATE_PROPERTY_EXISTS'
    });

    if (propiedadError) {
      return { success: false, visitaId: null, error: propiedadError, razon: 'No pude validar la propiedad en base de datos' };
    }

    if (!Array.isArray(propiedadRows) || propiedadRows.length === 0) {
      return {
        success: false,
        visitaId: null,
        error: 'Propiedad inexistente',
        razon: 'La propiedad seleccionada no existe en la base de datos'
      };
    }

    console.log(`✅ Propiedad validada en DB para visita: ID ${propiedadRows[0].id} (${propiedadRows[0].tipologia || 'sin tipo'})`);

    // Evitar doble reserva de mismo horario para misma propiedad (ignorando canceladas)
    const conflictUrl = `${supabaseConfig.url}/rest/v1/visitas?select=id&id_propiedad=eq.${visitaData.id_propiedad}&fecha=eq.${visitaData.fecha}&hora=eq.${visitaData.hora}&operacion=neq.cancelado&limit=1`;
    const { data: conflictos, error: conflictError } = await supabaseRequest(conflictUrl, {
      method: 'GET',
      headers: {
        apikey: supabaseConfig.service_role_key,
        Authorization: `Bearer ${supabaseConfig.service_role_key}`,
        'Content-Type': 'application/json'
      }
    }, 'VISITAS_CONFLICT_CHECK');

    if (conflictError) {
      return { success: false, visitaId: null, error: conflictError, razon: 'No pude validar disponibilidad del horario' };
    }

    if (Array.isArray(conflictos) && conflictos.length > 0) {
      return {
        success: false,
        visitaId: null,
        error: 'Ese horario ya está ocupado para esta propiedad',
        razon: 'Ese horario ya está ocupado para esta propiedad'
      };
    }

    // Idempotencia fuerte: mismo telefono + propiedad + fecha + hora
    const telefonoSafe = encodeURIComponent(visitaData.telefono);
    const duplicateUrl = `${supabaseConfig.url}/rest/v1/visitas?select=id&telefono=eq.${telefonoSafe}&id_propiedad=eq.${visitaData.id_propiedad}&fecha=eq.${visitaData.fecha}&hora=eq.${visitaData.hora}&operacion=neq.cancelado&limit=1`;
    const { data: duplicadas, error: duplicateError } = await supabaseRequest(duplicateUrl, {
      method: 'GET',
      headers: {
        apikey: supabaseConfig.service_role_key,
        Authorization: `Bearer ${supabaseConfig.service_role_key}`,
        'Content-Type': 'application/json'
      }
    }, 'VISITAS_IDEMPOTENCY_CHECK');

    if (duplicateError) {
      return { success: false, visitaId: null, error: duplicateError, razon: 'No pude validar visitas duplicadas' };
    }

    if (Array.isArray(duplicadas) && duplicadas.length > 0) {
      return {
        success: false,
        visitaId: null,
        error: 'Ya tenés una visita agendada en ese horario',
        razon: 'Ya tenés una visita agendada en ese horario'
      };
    }

    const { data: insertData, error: insertError } = await supabaseRequest(`${supabaseConfig.url}/rest/v1/visitas`, {
      method: 'POST',
      headers: {
        apikey: supabaseConfig.service_role_key,
        Authorization: `Bearer ${supabaseConfig.service_role_key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify(visitaData)
    }, 'VISITAS_INSERT');

    if (insertError) {
      return { success: false, visitaId: null, error: insertError, razon: 'No pude guardar la visita en la base de datos' };
    }

    const visitaId = Array.isArray(insertData) ? insertData[0]?.id || null : null;

    console.log(`✅ Visita guardada, ID: ${visitaId}`);
    return { success: true, visitaId, data: Array.isArray(insertData) ? insertData[0] : null };
  } catch (err) {
    console.error('❌ Error guardando visita:', err.message);
    return { success: false, visitaId: null, error: err.message, razon: 'No pude guardar la visita' };
  }
}

async function cancelarVisita(id, supabaseConfig) {
  console.log(`=== CANCELAR VISITA ${id} ===`);

  const visitId = parseInt(String(id || '').replace(/\D/g, ''), 10);
  if (!visitId) {
    return { success: false, error: 'ID de visita inválido', razon: 'ID de visita inválido' };
  }

  if (!supabaseConfig?.url || !supabaseConfig?.service_role_key) {
    return { success: false, error: 'Falta configuración de base de datos', razon: 'Falta configuración de base de datos' };
  }

  const headers = {
    apikey: supabaseConfig.service_role_key,
    Authorization: `Bearer ${supabaseConfig.service_role_key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };

  const { data: currentRows, error: currentError } = await supabaseRequest(
    `${supabaseConfig.url}/rest/v1/visitas?select=id,operacion&id=eq.${visitId}&limit=1`,
    { method: 'GET', headers },
    'VISITAS_GET_FOR_CANCEL'
  );

  if (currentError) return { success: false, error: currentError, razon: 'No pude validar la visita a cancelar' };
  if (!Array.isArray(currentRows) || currentRows.length === 0) {
    return { success: false, error: 'La visita no existe', razon: 'No encontré la visita en la base de datos.' };
  }
  if (currentRows[0].operacion === 'cancelado') {
    return { success: false, error: 'La visita ya estaba cancelada', razon: 'La visita ya estaba cancelada.' };
  }

  const { data: updatedRows, error: patchError } = await supabaseRequest(
    `${supabaseConfig.url}/rest/v1/visitas?id=eq.${visitId}`,
    { method: 'PATCH', headers, body: JSON.stringify({ operacion: 'cancelado' }) },
    'VISITAS_CANCEL_PATCH'
  );

  if (patchError) return { success: false, error: patchError, razon: 'No pude cancelar la visita' };
  if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
    return { success: false, error: 'Sin filas afectadas', razon: 'No se pudo cancelar la visita.' };
  }

  return { success: true, data: updatedRows[0] };
}

async function actualizarVisita(id, data, supabaseConfig) {
  console.log(`=== ACTUALIZAR VISITA ${id} ===`, JSON.stringify(data));

  const visitId = parseInt(String(id || '').replace(/\D/g, ''), 10);
  if (!visitId) {
    return { success: false, error: 'ID de visita inválido', razon: 'ID de visita inválido' };
  }

  const apiKey = supabaseConfig?.service_role_key;
  const supabaseUrl = supabaseConfig?.url;
  if (!supabaseUrl || !apiKey) {
    return { success: false, error: 'Falta configuración de base de datos', razon: 'Falta configuración de base de datos' };
  }

  const headers = {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };

  const { data: rowsActuales, error: getError } = await supabaseRequest(
    `${supabaseUrl}/rest/v1/visitas?select=id,id_propiedad,fecha,hora,operacion&id=eq.${visitId}&limit=1`,
    { method: 'GET', headers },
    'VISITAS_GET_FOR_UPDATE'
  );

  if (getError) return { success: false, error: getError, razon: 'No pude consultar la visita a modificar' };
  if (!Array.isArray(rowsActuales) || rowsActuales.length === 0) {
    return { success: false, error: 'La visita no existe', razon: 'No encontré la visita en la base de datos.' };
  }

  const actual = rowsActuales[0];
  const patch = {};

  if (data.operacion !== undefined) {
    const estado = String(data.operacion).trim().toLowerCase();
    if (!['pendiente', 'confirmado', 'cancelado'].includes(estado)) {
      return { success: false, error: 'Estado inválido', razon: 'Estado inválido. Usá pendiente, confirmado o cancelado.' };
    }
    patch.operacion = estado;
  }

  if (data.fecha !== undefined) {
    const { value, error } = parseFecha(data.fecha);
    if (error) return { success: false, error, razon: error };
    patch.fecha = value;
  }

  if (data.hora !== undefined) {
    const { value, error } = parseHora(data.hora);
    if (error) return { success: false, error, razon: error };
    patch.hora = value;
  }

  if (data.id_propiedad !== undefined) {
    const newPropertyId = parseInt(String(data.id_propiedad), 10);
    if (!newPropertyId) {
      return { success: false, error: 'id_propiedad inválido', razon: 'id_propiedad inválido para actualizar visita.' };
    }

    const { data: propRows, error: propError } = await fetchFromPropertyTables({
      supabaseConfig,
      headers,
      params: { select: 'id', id: `eq.${newPropertyId}`, limit: 1 },
      contextTag: 'PROPIEDAD_GET_FOR_UPDATE'
    });

    if (propError) {
      return { success: false, error: propError, razon: 'No pude validar la propiedad nueva para la visita' };
    }

    if (!Array.isArray(propRows) || propRows.length === 0) {
      return { success: false, error: 'Propiedad inexistente', razon: 'No encontré esa propiedad para asignar a la visita.' };
    }

    patch.id_propiedad = newPropertyId;
  }

  if (Object.keys(patch).length === 0) {
    return { success: false, error: 'No hay cambios para aplicar', razon: 'No especificaste qué cambiar en la visita.' };
  }

  const fechaFinal = patch.fecha || actual.fecha;
  const horaFinal = patch.hora || actual.hora;
  const propiedadFinal = patch.id_propiedad || actual.id_propiedad;

  if (patch.fecha || patch.hora) {
    const horarioOk = validarHorarioVisita(fechaFinal, horaFinal);
    if (!horarioOk.valido) {
      return { success: false, error: horarioOk.razon, razon: horarioOk.razon };
    }

    const conflictUrl = `${supabaseUrl}/rest/v1/visitas?select=id&id_propiedad=eq.${propiedadFinal}&fecha=eq.${fechaFinal}&hora=eq.${horaFinal}&operacion=neq.cancelado&id=neq.${visitId}&limit=1`;
    const { data: conflictos, error: conflictError } = await supabaseRequest(conflictUrl, { method: 'GET', headers }, 'VISITAS_UPDATE_CONFLICT_CHECK');
    if (conflictError) {
      return { success: false, error: conflictError, razon: 'No pude validar disponibilidad del nuevo horario' };
    }
    if (Array.isArray(conflictos) && conflictos.length > 0) {
      return { success: false, error: 'Ese horario ya está ocupado', razon: 'Ese horario ya está ocupado para esta propiedad' };
    }
  }

  const { data: updatedRows, error: patchError } = await supabaseRequest(
    `${supabaseUrl}/rest/v1/visitas?id=eq.${visitId}`,
    { method: 'PATCH', headers, body: JSON.stringify(patch) },
    'VISITAS_PATCH'
  );

  if (patchError) return { success: false, error: patchError, razon: 'No pude modificar la visita' };
  if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
    return { success: false, error: 'Sin filas afectadas', razon: 'No se pudo modificar la visita.' };
  }

  console.log(`✅ Visita ${visitId} actualizada:`, JSON.stringify(patch));
  return { success: true, visita: updatedRows[0], data: updatedRows[0] };
}

// ─── PROCESS RESERVATION ─────────────────────────────────────────────────────

function parseActionPayload(botReply) {
  if (!botReply) return null;
  if (typeof botReply === 'object') return botReply;
  if (typeof botReply !== 'string') return null;

  const input = botReply.trim();
  if (input.startsWith('{') && input.endsWith('}')) {
    try {
      return JSON.parse(input);
    } catch {
      // continuar con extracción tolerante
    }
  }

  const candidates = input.match(/\{[\s\S]*?\}/g) || [];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && typeof parsed.action === 'string') {
        return parsed;
      }
    } catch {
      // ignorar fragmento inválido
    }
  }

  return null;
}

function normalizeActionEnvelope(parsedPayload) {
  if (!parsedPayload || typeof parsedPayload !== 'object' || typeof parsedPayload.action !== 'string') return null;

  if (parsedPayload.data && typeof parsedPayload.data === 'object' && !Array.isArray(parsedPayload.data)) {
    return { action: parsedPayload.action, data: parsedPayload.data, strict: true };
  }

  // Backward compatibility con payload legacy { action, ...campos }
  const { action, ...legacyData } = parsedPayload;
  return { action, data: legacyData, strict: false };
}

function resolvePropertyIdFromHistory(history = []) {
  const systemPrompt = history.find(h => h.role === 'system')?.content || '';

  const selectedMatch = systemPrompt.match(/PROPIEDAD_SELECCIONADA_ID:(\d+)/);
  if (selectedMatch) return parseInt(selectedMatch[1], 10);

  const idsLine = systemPrompt.match(/IDS_PROPIEDADES_MOSTRADAS:\[([^\]]+)\]/);
  if (idsLine) {
    const ids = idsLine[1].split(',').map(v => parseInt(v.trim(), 10)).filter(Boolean);
    if (ids.length === 1) return ids[0];
  }

  return null;
}

async function processReservation(botReply, configOrSupabase, skipLog = false, history = [], sessionId = null, metadata = {}, executionOptions = {}) {
  const supabaseConfig = configOrSupabase?.supabase || configOrSupabase;
  const workingMetadata = { ...(metadata || {}) };
  const userLastMessage = obtenerUltimoMensajeUsuario(history);
  const forceExecutePending = Boolean(executionOptions?.forceExecutePending);

  console.log('SUPABASE_CONFIG_STATUS:', {
    hasUrl: Boolean(supabaseConfig?.url),
    hasServiceRole: Boolean(supabaseConfig?.service_role_key),
    hasAnon: Boolean(supabaseConfig?.anon_key)
  });

  if (workingMetadata.pendingAction && !pendingActionVigente(workingMetadata.pendingAction)) {
    console.log('🕒 pendingAction expirado, se limpia');
    workingMetadata.pendingAction = null;
  }

  console.log('MODEL_JSON_RAW:', typeof botReply === 'string' ? botReply : JSON.stringify(botReply));
  let payload = parseActionPayload(botReply);

  if (!payload) {
    return {
      reply: 'No pude interpretar la acción. Reintentá indicando fecha, hora y propiedad para poder ayudarte.',
      appended: false,
      metadata: workingMetadata,
      handled: true
    };
  }

  const normalized = normalizeActionEnvelope(payload);
  if (!normalized) {
    console.log(JSON.stringify({ type: 'ACTION_ERROR', reason: 'INVALID_ACTION_ENVELOPE', raw: payload }));
    return { reply: 'No pude procesar la acción porque el formato es inválido.', appended: false, metadata: workingMetadata, handled: true };
  }

  if (!normalized.strict) {
    console.log(JSON.stringify({ type: 'ACTION_ERROR', reason: 'LEGACY_ACTION_FORMAT_USED', action: normalized.action }));
  }

  payload = { action: normalized.action, ...(normalized.data || {}) };

  if (!payload.action || typeof payload.action !== 'string') {
    return { reply: 'No pude procesar la acción porque falta el campo action.', appended: false, metadata: workingMetadata, handled: true };
  }

  console.log('ACTION:', payload.action);

  // ─── action: reserve (INSERT nueva visita) ────────────────────────────────
  if (payload.action === 'reserve') {
    if (forceExecutePending) {
      if (!workingMetadata.pendingAction || workingMetadata.pendingAction.type !== 'reserve') {
        return { reply: 'No encontré una reserva pendiente para confirmar.', appended: false, metadata: workingMetadata, handled: true };
      }
      if (!pendingActionVigente(workingMetadata.pendingAction)) {
        workingMetadata.pendingAction = null;
        return { reply: 'La confirmación venció. Pedime nuevamente la reserva para continuar.', appended: false, metadata: workingMetadata, handled: true };
      }

      const pendingData = { ...(workingMetadata.pendingAction.data || {}) };
      const ajusteReciente = inferirAjusteReservaReciente({ history });
      if (ajusteReciente?.fecha || ajusteReciente?.hora) {
        if (ajusteReciente.fecha) pendingData.fecha = ajusteReciente.fecha;
        if (ajusteReciente.hora) pendingData.hora = ajusteReciente.hora;
        workingMetadata.pendingAction = {
          ...workingMetadata.pendingAction,
          data: pendingData,
          timestamp: Date.now()
        };
        console.log('🔄 Ajuste aplicado sobre reserva pendiente antes de confirmar:', JSON.stringify({
          fecha: pendingData.fecha,
          hora: pendingData.hora,
          fuente: ajusteReciente.fuente
        }));
      }

      payload = { ...pendingData, operacion: 'confirmado' };
    }

    if (!payload.telefono && sessionId) payload.telefono = String(sessionId);

    const idDesdeContexto = resolvePropertyIdFromHistory(history);
    if (!payload.id_propiedad) {
      if (idDesdeContexto) {
        payload.id_propiedad = idDesdeContexto;
      } else {
        const idDesdeMetadata = metadata?.propiedadSeleccionadaId;
        if (idDesdeMetadata) payload.id_propiedad = idDesdeMetadata;
      }
    }

    // Si hay divergencia entre prompt actual y metadata persistida, priorizar prompt actual
    if (idDesdeContexto && payload.id_propiedad && String(idDesdeContexto) !== String(payload.id_propiedad)) {
      console.log('⚠️ id_propiedad inconsistente entre metadata y prompt actual, priorizando prompt:', {
        metadataId: payload.id_propiedad,
        promptId: idDesdeContexto
      });
      payload.id_propiedad = idDesdeContexto;
    }

    const validacion = validarDatosReserva(payload);
    if (!validacion.ok) {
      return {
        reply: `No pude agendar la visita: ${validacion.error}.`,
        appended: false,
        metadata: workingMetadata,
        handled: true
      };
    }

    // El LLM ya manejó la confirmación en ETAPA 2 del flujo conversacional.
    // Se ejecuta la reserva directamente sin pedir confirmación adicional.
    payload = { ...payload, operacion: 'confirmado' };

    const { success, visitaId, razon, data } = await guardarVisita(payload, supabaseConfig);
    console.log('DB RESULT:', JSON.stringify({ success, visitaId, razon }));
    logActionExecution('reserve', payload, { success, visitaId, razon });
    guardarLogAccion({ action: 'reserve', status: success ? 'success' : 'error', payload, error: razon || null });

    if (!success) {
      if (razon) {
        return { reply: `No pude agendar la visita: ${razon}`, appended: false, metadata: workingMetadata, handled: true };
      }
      return {
        reply: 'Hubo un problema al agendar la visita. Por favor, intentá de nuevo o comunicate con nosotros directamente.',
        appended: false,
        metadata: workingMetadata,
        handled: true
      };
    }

    workingMetadata.pendingAction = null;
    workingMetadata.visitaSeleccionadaId = visitaId || data?.id || null;

    const fechaFinal = data?.fecha || formatFechaParaSupabase(payload.fecha) || payload.fecha;
    const horaFinal = data?.hora || parseHora(payload.hora).value || payload.hora;
    const confirmacion = `¡Listo! El turno quedó registrado para el ${fechaFinal} a las ${horaFinal}.\nNosotros nos comunicaremos con vos más adelante para confirmar la visita.`;

    return { reply: confirmacion, appended: true, visitaId, metadata: workingMetadata, handled: true };
  }

  // ─── action: cancel_visit (PATCH operacion = cancelado) ──────────────────
  // ─── Resolución de ID de visita (fallback server-side) ──────────────────
  // Si el LLM usó el placeholder (77777) o un ID inválido,
  // buscar la visita real del usuario en Supabase usando el teléfono de sesión.
  async function resolverIdVisita(idDelLLM) {
    const idDesdeMetadata = parseInt(String(workingMetadata?.visitaSeleccionadaId || '').replace(/\D/g, ''), 10);
    if (idDesdeMetadata) {
      console.log('VISITA ID USADA:', idDesdeMetadata, '(metadata.visitaSeleccionadaId)');
      return { id: idDesdeMetadata, error: null };
    }

    const idNum = parseInt(String(idDelLLM).replace(/\D/g, ''), 10);
    const PLACEHOLDER = 77777;
    const esPlaceholder = !idNum || idNum === PLACEHOLDER;

    console.log(`🔍 resolverIdVisita: LLM dijo id=${idDelLLM} → numerico=${idNum} placeholder=${esPlaceholder}`);

    if (!esPlaceholder) {
      console.log('VISITA ID USADA:', idNum, '(payload)');
      return { id: idNum, error: null };
    }

    // Fallback: buscar en DB por teléfono
    if (!sessionId) return { id: null, error: 'No tengo tu número de teléfono para buscar la visita.' };
    const ultimaVisita = await buscarUltimaVisitaUsuario(sessionId, supabaseConfig);
    if (!ultimaVisita) return { id: null, error: 'No encontré visitas activas para tu número.' };

    console.log('VISITA ID USADA:', ultimaVisita.id, '(fallback ultima visita por telefono)');
    return { id: ultimaVisita.id, error: null };
  }

  if (payload.action === 'cancel_visit') {
    if (forceExecutePending) {
      if (!workingMetadata.pendingAction || workingMetadata.pendingAction.type !== 'cancel_visit') {
        return { reply: 'No encontré una cancelación pendiente para confirmar.', appended: false, metadata: workingMetadata, handled: true };
      }
      if (!pendingActionVigente(workingMetadata.pendingAction)) {
        workingMetadata.pendingAction = null;
        return { reply: 'La confirmación venció. Volvé a pedir la cancelación.', appended: false, metadata: workingMetadata, handled: true };
      }
      payload.id = workingMetadata.pendingAction.data?.id;
    }

    const { id: visitId, error: idError } = await resolverIdVisita(payload.id);
    if (idError) return { reply: `No pude cancelar la visita: ${idError}`, appended: false, metadata: workingMetadata, handled: true };

    if (!forceExecutePending) {
      const pending = workingMetadata.pendingAction;
      const samePendingCancel = pending && pending.type === 'cancel_visit' && String(pending.data?.id) === String(visitId);

      if (!samePendingCancel) {
        workingMetadata.pendingAction = { type: 'cancel_visit', data: { id: visitId }, timestamp: Date.now() };
        return {
          reply: 'Confirmo que querés cancelar la visita. Respondé "si" para confirmar o "no" para mantenerla.',
          appended: true,
          metadata: workingMetadata,
          handled: true
        };
      }

      if (!pendingActionVigente(workingMetadata.pendingAction)) {
        workingMetadata.pendingAction = null;
        return { reply: 'La confirmación venció. Volvé a pedir la cancelación.', appended: false, metadata: workingMetadata, handled: true };
      }

      const insisteCancelacion = esIntencionCancelarVisita(userLastMessage);

      if (!insisteCancelacion && esRechazoClaro(userLastMessage)) {
        workingMetadata.pendingAction = null;
        return { reply: 'Perfecto, mantengo la visita sin cambios.', appended: true, metadata: workingMetadata, handled: true };
      }

      if (!insisteCancelacion && !esConfirmacionClara(userLastMessage)) {
        return { reply: 'Necesito confirmación explícita para cancelar. Respondé "si" o "no".', appended: true, metadata: workingMetadata, handled: true };
      }
    }

    const { success, razon } = await cancelarVisita(visitId, supabaseConfig);
    console.log('DB RESULT:', JSON.stringify({ success, razon, visitId }));
    logActionExecution('cancel_visit', { id: visitId }, { success, razon });
    guardarLogAccion({ action: 'cancel_visit', status: success ? 'success' : 'error', payload: { id: visitId }, error: razon || null });

    if (!success) {
      return {
        reply: razon
          ? `No pude cancelar la visita: ${razon}`
          : 'Hubo un problema al cancelar la visita. Comunicate con nosotros directamente.',
        appended: false,
        metadata: workingMetadata,
        handled: true
      };
    }

    workingMetadata.pendingAction = null;
    workingMetadata.visitaSeleccionadaId = null;

    return {
      reply: 'Visita cancelada con éxito.',
      appended: true,
      metadata: workingMetadata,
      handled: true
    };
  }

  // ─── action: update_visit (PATCH fecha / hora / operacion) ───────────────
  if (payload.action === 'update_visit') {
    if (forceExecutePending) {
      if (!workingMetadata.pendingAction || workingMetadata.pendingAction.type !== 'update_visit') {
        return { reply: 'No encontré una modificación pendiente para confirmar.', appended: false, metadata: workingMetadata, handled: true };
      }
      if (!pendingActionVigente(workingMetadata.pendingAction)) {
        workingMetadata.pendingAction = null;
        return { reply: 'La confirmación venció. Volvé a pedir la modificación.', appended: false, metadata: workingMetadata, handled: true };
      }
      payload = {
        action: 'update_visit',
        id: workingMetadata.pendingAction.data?.id,
        ...(workingMetadata.pendingAction.data?.updateData || {})
      };
    }

    const updateData = {};
    if (payload.operacion) updateData.operacion = payload.operacion;
    if (payload.fecha)     updateData.fecha     = payload.fecha;
    if (payload.hora)      updateData.hora      = payload.hora;
    if (payload.id_propiedad) updateData.id_propiedad = payload.id_propiedad;

    if (Object.keys(updateData).length === 0) {
      return { reply: 'No especificaste qué cambiar en la visita.', appended: false, metadata: workingMetadata, handled: true };
    }

    const { id: visitId, error: idError } = await resolverIdVisita(payload.id);
    if (idError) return { reply: `No pude modificar la visita: ${idError}`, appended: false, metadata: workingMetadata, handled: true };

    if (!forceExecutePending) {
      const pending = workingMetadata.pendingAction;
      const samePendingUpdate = pending
        && pending.type === 'update_visit'
        && String(pending.data?.id) === String(visitId)
        && JSON.stringify(pending.data?.updateData || {}) === JSON.stringify(updateData);

      if (!samePendingUpdate) {
        workingMetadata.pendingAction = { type: 'update_visit', data: { id: visitId, updateData }, timestamp: Date.now() };
        return {
          reply: 'Confirmo la modificación de la visita. Respondé "si" para confirmar o "no" para cancelar el cambio.',
          appended: true,
          metadata: workingMetadata,
          handled: true
        };
      }

      if (!pendingActionVigente(workingMetadata.pendingAction)) {
        workingMetadata.pendingAction = null;
        return { reply: 'La confirmación venció. Volvé a pedir la modificación.', appended: false, metadata: workingMetadata, handled: true };
      }

      if (esRechazoClaro(userLastMessage)) {
        workingMetadata.pendingAction = null;
        return { reply: 'Perfecto, no realicé cambios en la visita.', appended: true, metadata: workingMetadata, handled: true };
      }

      if (!esConfirmacionClara(userLastMessage)) {
        return { reply: 'Necesito confirmación explícita para modificar. Respondé "si" o "no".', appended: true, metadata: workingMetadata, handled: true };
      }
    }

    const { success, razon, visita } = await actualizarVisita(visitId, updateData, supabaseConfig);
    console.log('DB RESULT:', JSON.stringify({ success, razon, visitId, visita }));
    logActionExecution('update_visit', { id: visitId, updateData }, { success, razon, visita });
    guardarLogAccion({ action: 'update_visit', status: success ? 'success' : 'error', payload: { id: visitId, updateData }, error: razon || null });

    if (!success) {
      return {
        reply: razon
          ? `No pude modificar la visita: ${razon}`
          : 'Hubo un problema al modificar la visita. Comunicate con nosotros directamente.',
        appended: false,
        metadata: workingMetadata,
        handled: true
      };
    }

    workingMetadata.pendingAction = null;
    workingMetadata.visitaSeleccionadaId = visitId;

    const fechaMsg = visita?.fecha ? ` nueva fecha ${visita.fecha}` : '';
    const horaMsg = visita?.hora ? ` nueva hora ${visita.hora}` : '';
    return {
      reply: `Visita actualizada con éxito.${fechaMsg}${horaMsg}`.trim(),
      appended: true,
      metadata: workingMetadata,
      handled: true
    };
  }

  return { reply: `No pude procesar la acción: ${payload.action}`, appended: false, metadata: workingMetadata, handled: true };
}

function extraerTelefonoDesdeTexto(text = '', sessionId = '') {
  const chunks = String(text).match(/\d{8,15}/g) || [];
  if (chunks.length > 0) return chunks.sort((a, b) => b.length - a.length)[0];
  const sid = String(sessionId || '').replace(/\D/g, '');
  return sid.length >= 8 ? sid : null;
}

function extraerHoraDesdeTexto(text = '') {
  const aLas = String(text).match(/a\s+las\s+(\d{1,2})(?::(\d{2}))?\s*(?:hs?|h)?/i);
  if (aLas) {
    const h = String(parseInt(aLas[1], 10)).padStart(2, '0');
    const m = String(parseInt(aLas[2] || '0', 10)).padStart(2, '0');
    return `${h}:${m}`;
  }

  const hhmm = String(text).match(/\b(\d{1,2}):(\d{2})\b/);
  if (hhmm) {
    const h = String(parseInt(hhmm[1], 10)).padStart(2, '0');
    const m = String(parseInt(hhmm[2], 10)).padStart(2, '0');
    return `${h}:${m}`;
  }

  return null;
}

function extraerFechaDesdeTexto(text = '') {
  const raw = String(text).toLowerCase();
  const textoMes = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const diasSemana = {
    domingo: 0,
    lunes: 1,
    martes: 2,
    miercoles: 3,
    jueves: 4,
    viernes: 5,
    sabado: 6
  };

  const ordMap = {
    primer: 1,
    primero: 1,
    segundo: 2,
    tercer: 3,
    tercero: 3,
    cuarto: 4
  };

  const fraseSemana = textoMes.match(/\b(primer|primero|segundo|tercer|tercero|cuarto|ultimo)\s+(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+del\s+mes\b/);
  if (fraseSemana) {
    const ord = fraseSemana[1];
    const dow = diasSemana[fraseSemana[2]];
    const now = new Date();
    let month = now.getMonth();
    let year = now.getFullYear();

    const resolverFecha = (yy, mm) => {
      if (ord === 'ultimo') {
        const lastDay = new Date(yy, mm + 1, 0);
        const shift = (lastDay.getDay() - dow + 7) % 7;
        return new Date(yy, mm, lastDay.getDate() - shift);
      }

      const n = ordMap[ord] || 1;
      const firstDay = new Date(yy, mm, 1);
      const delta = (dow - firstDay.getDay() + 7) % 7;
      const day = 1 + delta + (n - 1) * 7;
      const candidate = new Date(yy, mm, day);
      if (candidate.getMonth() !== mm) return null;
      return candidate;
    };

    let fecha = resolverFecha(year, month);
    const hoy = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (!fecha || fecha < hoy) {
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
      fecha = resolverFecha(year, month);
    }

    if (fecha) {
      const dd = String(fecha.getDate()).padStart(2, '0');
      const mm = String(fecha.getMonth() + 1).padStart(2, '0');
      const yyyy = String(fecha.getFullYear());
      return `${dd}/${mm}/${yyyy}`;
    }
  }

  const ddmmyyyy = raw.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (ddmmyyyy) {
    const dd = String(parseInt(ddmmyyyy[1], 10)).padStart(2, '0');
    const mm = String(parseInt(ddmmyyyy[2], 10)).padStart(2, '0');
    const yyyy = ddmmyyyy[3]
      ? String(parseInt(ddmmyyyy[3], 10)).padStart(4, '20')
      : String(new Date().getFullYear());
    return `${dd}/${mm}/${yyyy}`;
  }

  const meses = {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
    julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12
  };
  const conMes = textoMes.match(/\b(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?\b/);
  if (conMes && meses[conMes[2]]) {
    const dd = String(parseInt(conMes[1], 10)).padStart(2, '0');
    const mm = String(meses[conMes[2]]).padStart(2, '0');
    const yyyy = String(parseInt(conMes[3] || String(new Date().getFullYear()), 10));
    return `${dd}/${mm}/${yyyy}`;
  }

  const soloDia = textoMes.match(/(?:para\s+el\s+dia|dia|fecha|el)\s+(\d{1,2})\b/);
  if (soloDia) {
    const now = new Date();
    let day = parseInt(soloDia[1], 10);
    let month = now.getMonth() + 1;
    let year = now.getFullYear();
    if (day < now.getDate()) {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${String(year)}`;
  }

  return null;
}

function extraerNombreDesdeTexto(text = '', fallback = 'Cliente') {
  const t = String(text).trim();
  if (!t) return fallback;

  const byComma = t.split(',')[0].trim();
  if (/^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]{3,60}$/.test(byComma)) return byComma;

  const soy = t.match(/\b(?:soy|me llamo)\s+([a-zA-ZáéíóúÁÉÍÓÚñÑ\s]{3,60})/i);
  if (soy && soy[1]) return soy[1].trim();

  return fallback;
}

function inferirIdPropiedadDesdeOpcion({ history = [], metadata = {} }) {
  const idsDesdeMetadata = Array.isArray(metadata?.idsPropiedadesMostradas)
    ? metadata.idsPropiedadesMostradas
        .map(v => parseInt(String(v), 10))
        .filter(Number.isFinite)
    : [];

  const idsDesdePropiedades = Array.isArray(metadata?.propiedadesMostradas)
    ? metadata.propiedadesMostradas
        .map(p => parseInt(String(p?.id), 10))
        .filter(Number.isFinite)
    : [];

  const ids = idsDesdeMetadata.length > 0 ? idsDesdeMetadata : idsDesdePropiedades;
  if (ids.length === 0) return null;

  const userMsgs = (history || [])
    .filter(m => m.role === 'user')
    .map(m => String(m.content || ''))
    .filter(Boolean);

  for (let i = userMsgs.length - 1; i >= 0; i--) {
    const msg = userMsgs[i].toLowerCase();
    const m = msg.match(/(?:opci[oó]n|opcion)\s*(\d{1,2})/i);
    if (!m) continue;
    const optionNum = parseInt(m[1], 10);
    const idx = optionNum - 1;
    if (idx >= 0 && idx < ids.length) {
      return ids[idx];
    }
  }

  return null;
}

function inferirReservaDesdeHistorial({ history = [], sessionId = '', metadata = {} }) {
  const idPropiedad = metadata?.propiedadSeleccionadaId
    || resolvePropertyIdFromHistory(history)
    || inferirIdPropiedadDesdeOpcion({ history, metadata });
  if (!idPropiedad) return null;

  const userMsgs = history
    .filter(m => m.role === 'user')
    .map(m => String(m.content || ''))
    .filter(Boolean);

  if (userMsgs.length === 0) return null;

  let candidato = null;
  for (let i = userMsgs.length - 1; i >= 0; i--) {
    const t = userMsgs[i];
    const tel = extraerTelefonoDesdeTexto(t, sessionId);
    const fecha = extraerFechaDesdeTexto(t);
    const hora = extraerHoraDesdeTexto(t);
    if (tel && (fecha || hora)) {
      candidato = t;
      break;
    }
  }

  if (!candidato) return null;

  const telefono = extraerTelefonoDesdeTexto(candidato, sessionId);
  const fecha = extraerFechaDesdeTexto(candidato);
  const hora = extraerHoraDesdeTexto(candidato);
  const nombre = extraerNombreDesdeTexto(candidato, 'Cliente');

  if (!telefono || !fecha || !hora) return null;

  return {
    id_propiedad: parseInt(String(idPropiedad), 10),
    nombre,
    telefono,
    fecha,
    hora
  };
}

function inferirAjusteReservaReciente({ history = [] }) {
  const userMsgs = (history || [])
    .filter(m => m.role === 'user')
    .map(m => String(m.content || '').trim())
    .filter(Boolean);

  // El ultimo mensaje suele ser la confirmacion "si"; se revisan los previos.
  if (userMsgs.length < 2) return null;

  const start = Math.max(0, userMsgs.length - 6);
  for (let i = userMsgs.length - 2; i >= start; i--) {
    const msg = userMsgs[i];
    const n = msg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (!/(cambiar|reprogram|pasar|mover|entonces|fecha|hora|para el|a las|\bhs\b|\bh\b)/.test(n)) continue;

    const fecha = extraerFechaDesdeTexto(msg);
    const hora = extraerHoraDesdeTexto(msg);
    if (fecha || hora) {
      return { fecha: fecha || null, hora: hora || null, fuente: msg };
    }
  }

  return null;
}

function inferirModificacionDesdeHistorial({ history = [], metadata = {} }) {
  const idVisit = parseInt(String(metadata?.visitaSeleccionadaId || ''), 10);
  if (!idVisit) return null;

  const userMsgs = (history || [])
    .filter(m => m.role === 'user')
    .map(m => String(m.content || '').trim())
    .filter(Boolean);

  if (userMsgs.length === 0) return null;

  // Evita activar update si no hubo una intencion clara de cambiar/reprogramar.
  const ventana = userMsgs.slice(-6).join(' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const hayIntencionUpdate = /(modificar|cambiar|reprogram|mover|pasar|nueva fecha|nuevo horario|misma hora)/.test(ventana);
  if (!hayIntencionUpdate) return null;

  let fecha = null;
  let hora = null;
  const start = Math.max(0, userMsgs.length - 6);
  for (let i = userMsgs.length - 1; i >= start; i--) {
    const msg = userMsgs[i];
    if (!fecha) fecha = extraerFechaDesdeTexto(msg);
    if (!hora) hora = extraerHoraDesdeTexto(msg);
    if (fecha && hora) break;
  }

  const updateData = {};
  if (fecha) updateData.fecha = fecha;
  if (hora) updateData.hora = hora;
  if (Object.keys(updateData).length === 0) return null;

  return { id: idVisit, updateData };
}

function inferirCancelacionDesdeHistorial({ history = [], metadata = {} }) {
  const idVisit = parseInt(String(metadata?.visitaSeleccionadaId || ''), 10)
    || (Array.isArray(metadata?.visitasMostradas) && metadata.visitasMostradas.length === 1
      ? parseInt(String(metadata.visitasMostradas[0] || ''), 10)
      : 0);

  if (!idVisit) return null;

  const userMsgs = (history || [])
    .filter(m => m.role === 'user')
    .map(m => String(m.content || '').trim())
    .filter(Boolean)
    .slice(-8);

  if (userMsgs.length === 0) return null;

  const normalizar = (txt) => String(txt).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const reCancel = /\b(cancelar|cancela|cancele|cancelalo|cancelala|anular|anula|dar de baja|baja la visita)\b/;
  const reUpdate = /\b(modificar|modifica|cambiar|cambia|reprogramar|reprograma|mover|mueve|pasar la visita|nueva fecha|nuevo horario|misma hora)\b/;

  let lastCancelIdx = -1;
  let lastUpdateIdx = -1;

  for (let i = 0; i < userMsgs.length; i++) {
    const t = normalizar(userMsgs[i]);
    if (reCancel.test(t)) lastCancelIdx = i;
    if (reUpdate.test(t)) lastUpdateIdx = i;
  }

  // Solo inferir cancelación si fue la última intención de gestión del usuario.
  if (lastCancelIdx === -1 || lastCancelIdx < lastUpdateIdx) return null;

  return { id: idVisit };
}

async function handleImplicitConfirmation({ message = '', history = [], sessionId = null, metadata = {}, config = null }) {
  const msgNorm = String(message || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const esCancelacionDirecta = /\b(cancelar|cancela|cancele|cancelalo|cancelala|anular|anula|dar de baja|baja la visita)\b/.test(msgNorm);
  const esConfirmacion = esConfirmacionClara(message);
  if (!esConfirmacion && !esCancelacionDirecta) return { handled: false };

  const pending = metadata?.pendingAction;
  if (pending && pendingActionVigente(pending)) {
    // Ya hay flujo pendiente; processChat genérico lo resuelve antes de llamar este hook.
    return { handled: false };
  }

  const cancelacionInferida = inferirCancelacionDesdeHistorial({ history, metadata });
  if (cancelacionInferida) {
    console.log('🔄 [BOT] Cancelacion inferida en handleImplicitConfirmation:', cancelacionInferida);

    const nextMetadata = {
      ...(metadata || {}),
      pendingAction: {
        type: 'cancel_visit',
        data: cancelacionInferida,
        timestamp: Date.now()
      }
    };

    const result = await processReservation(
      JSON.stringify({ action: 'cancel_visit', data: { id: cancelacionInferida.id } }),
      config,
      true,
      history,
      sessionId,
      nextMetadata
    );

    return {
      handled: result?.handled !== false,
      reply: result?.reply,
      metadata: result?.metadata || nextMetadata
    };
  }

  if (esCancelacionDirecta) {
    // Fallback controlado: delega resolución de visita a resolverIdVisita()
    // usando placeholder (77777) para buscar la última visita activa del teléfono.
    const fallbackCancel = { id: 77777 };
    const nextMetadata = {
      ...(metadata || {}),
      pendingAction: {
        type: 'cancel_visit',
        data: fallbackCancel,
        timestamp: Date.now()
      }
    };

    const result = await processReservation(
      JSON.stringify({ action: 'cancel_visit', data: fallbackCancel }),
      config,
      true,
      history,
      sessionId,
      nextMetadata
    );

    return {
      handled: result?.handled !== false,
      reply: result?.reply,
      metadata: result?.metadata || nextMetadata
    };
  }

  // Si fue una solicitud directa de cancelación pero no se pudo inferir ID,
  // no forzar otras inferencias (update/reserve).
  if (esCancelacionDirecta && !esConfirmacion) return { handled: false };

  const modificacionInferida = inferirModificacionDesdeHistorial({ history, metadata });
  if (modificacionInferida) {
    console.log('🔄 [BOT] Modificacion inferida en handleImplicitConfirmation:', modificacionInferida);

    const nextMetadata = {
      ...(metadata || {}),
      pendingAction: {
        type: 'update_visit',
        data: modificacionInferida,
        timestamp: Date.now()
      }
    };

    const result = await processReservation(
      JSON.stringify({ action: 'update_visit', data: { id: modificacionInferida.id, ...(modificacionInferida.updateData || {}) } }),
      config,
      true,
      history,
      sessionId,
      nextMetadata
    );

    return {
      handled: result?.handled !== false,
      reply: result?.reply,
      metadata: result?.metadata || nextMetadata
    };
  }

  const reservaInferida = inferirReservaDesdeHistorial({ history, sessionId, metadata });
  if (!reservaInferida) return { handled: false };

  console.log('🔄 [BOT] Reserva inferida en handleImplicitConfirmation:', reservaInferida);

  const nextMetadata = {
    ...(metadata || {}),
    pendingAction: {
      type: 'reserve',
      data: reservaInferida,
      timestamp: Date.now()
    }
  };

  const result = await processReservation(
    JSON.stringify({ action: 'reserve', data: reservaInferida }),
    config,
    true,
    history,
    sessionId,
    nextMetadata
  );

  return {
    handled: result?.handled !== false,
    reply: result?.reply,
    metadata: result?.metadata || nextMetadata
  };
}

// ─── MEMORY (lógica central del bot) ─────────────────────────────────────────

async function memory(history, userMessage, configOrSupabase = null, sessionId = null, metadata = {}) {
  const supabaseConfig = configOrSupabase?.supabase || configOrSupabase;
  const safeMetadata = {
    propiedadSeleccionadaId: metadata?.propiedadSeleccionadaId || null,
    propiedadesMostradas: Array.isArray(metadata?.propiedadesMostradas) ? metadata.propiedadesMostradas : [],
    visitaSeleccionadaId: metadata?.visitaSeleccionadaId || null,
    visitasMostradas: Array.isArray(metadata?.visitasMostradas) ? metadata.visitasMostradas : [],
    origen: metadata?.origen || null,
    pendingAction: metadata?.pendingAction || null,
    idsPropiedadesMostradas: Array.isArray(metadata?.idsPropiedadesMostradas) ? metadata.idsPropiedadesMostradas : [],
    ultimaBusqueda: {
      operacion: metadata?.ultimaBusqueda?.operacion || null,
      tipologia: metadata?.ultimaBusqueda?.tipologia || null,
      barrio: metadata?.ultimaBusqueda?.barrio || '',
      offset: Number.isInteger(metadata?.ultimaBusqueda?.offset) ? metadata.ultimaBusqueda.offset : 0,
      ambientes: metadata?.ultimaBusqueda?.ambientes || null,
      dormitorios: metadata?.ultimaBusqueda?.dormitorios || null,
      dormitoriosOp: metadata?.ultimaBusqueda?.dormitoriosOp || 'eq',
      aptoBanco: metadata?.ultimaBusqueda?.aptoBanco || null,
      precioMax: metadata?.ultimaBusqueda?.precioMax || null,
      precioMin: metadata?.ultimaBusqueda?.precioMin || null,
      presupuesto: metadata?.ultimaBusqueda?.presupuesto || null
    }
  };

  console.log('=== MEMORY SALOMON ===');
  console.log('Mensaje:', userMessage.substring(0, 100));
  console.log(`🔑 sessionId="${sessionId}" | supabaseConfig=${supabaseConfig ? 'OK' : 'NULL'}`);

  // ── PASO 0: Limpiar flags de sesión anterior y actualizar fecha ──────────
  // Guardar estado ANTES de limpiar, para usarlo en PASO 1.5
  const visitasBuscadasEnTurnoAnterior = history
    .filter(h => h.role === 'assistant')
    .slice(-3)
    .some(m => /visita agendada|tenés una visita|visita actualizada|visita cancelada/i.test(m.content));

  if (history[0]?.role === 'system') {
    const hoy = ahoraArgentina();
    const dd = String(hoy.getDate()).padStart(2, '0');
    const mm = String(hoy.getMonth() + 1).padStart(2, '0');
    const yyyy = hoy.getFullYear();
    const fechaHoy = `${dd}/${mm}/${yyyy}`;

    // Limpiar flags que no deben persistir entre invocaciones
    history[0].content = history[0].content
      .replace(/\nBUSQUEDA_VISITAS_USUARIO:[^\n]*/g, '')
      .replace(/\n\n---VISITAS_USUARIO---[\s\S]*?---FIN_VISITAS_USUARIO---/g, '')
      .replace(/\{\{current_date\}\}/g, fechaHoy)
      .replace(/Hoy es \d{2}\/\d{2}\/\d{4}/g, `Hoy es ${fechaHoy}`)
      // Limpiar INSTRUCCIÓN CRÍTICA acumuladas de turnos anteriores (Casos A/B/C)
      // Estas instrucciones de recolección de filtros no deben persistir entre turnos
      .replace(/\nINSTRUCCIÓN CRÍTICA: El usuario (?:quiere ver|busca)\b[^\n]*/g, '')
      .replace(/\nINSTRUCCIÓN CRÍTICA: El usuario hizo una referencia ambigua[^\n]*/g, '');

    // Refrescar REFERENCIA DE FECHAS en cada turno para evitar que quede desactualizada
    // entre días. El bloque se genera una vez al crear la sesión pero puede volver viejo.
    history[0].content = history[0].content.replace(
      /\n*REFERENCIA DE FECHAS[\s\S]*?⚠️ REGLA CRÍTICA:.*(\n|$)/,
      ''
    );
    history[0].content += `\n\n${generarContextoFechas()}`;

    // BUG 3: Si en los últimos 4 mensajes hay un update_visit o cancel_visit ya procesado,
    // limpiar PROPIEDAD_SELECCIONADA_ID para evitar que el bot lo reutilice en una nueva reserva
    const recentMessages = history.slice(-4);
    const hayGestionReciente = recentMessages.some(m =>
      m.role === 'assistant' && (
        /✅ \*Visita actualizada/.test(m.content) ||
        /✅ \*Visita cancelada/.test(m.content) ||
        /"action"\s*:\s*"(update_visit|cancel_visit)"/.test(m.content)
      )
    );
    if (hayGestionReciente) {
      history[0].content = history[0].content
        .replace(/\n*PROPIEDAD_SELECCIONADA_ID:[^\n]*/g, '')
        .replace(/\n*INSTRUCCIÓN: El usuario eligió[^\n]*/g, '');
      console.log('🧹 PROPIEDAD_SELECCIONADA_ID limpiado — gestión de visita reciente detectada');
    }

    console.log(`📅 Fecha actualizada: ${fechaHoy}`);

    // Mantener compatibilidad con prompts existentes, usando metadata como fuente real
    if (safeMetadata.propiedadSeleccionadaId && !history[0].content.includes('PROPIEDAD_SELECCIONADA_ID:')) {
      const id = safeMetadata.propiedadSeleccionadaId;
      history[0].content += `\n\nPROPIEDAD_SELECCIONADA_ID:${id}\nINSTRUCCIÓN: El usuario ya eligió la propiedad ID ${id}. Usar este id_propiedad en el JSON de reserva.`;
      console.log(`♻️ PROPIEDAD_SELECCIONADA_ID re-inyectado desde metadata: ${id}`);
    }
  }

  // ── Normalizar mensaje (necesario para los pasos siguientes) ──────────────
  const msgNorm = userMessage.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // ── pendingAction: expiración + confirmación contextual ───────────────────
  if (safeMetadata.pendingAction && !pendingActionVigente(safeMetadata.pendingAction)) {
    safeMetadata.pendingAction = null;
  }

  if (safeMetadata.pendingAction && history[0]?.role === 'system') {
    const pa = safeMetadata.pendingAction;
    const jsonPendiente = pa.type === 'reserve'
      ? JSON.stringify({ action: 'reserve', ...pa.data })
      : pa.type === 'cancel_visit'
        ? JSON.stringify({ action: 'cancel_visit', id: pa.data?.id })
        : JSON.stringify({ action: 'update_visit', id: pa.data?.id, ...(pa.data?.updateData || {}) });

    history[0].content = history[0].content.replace(/\nPENDING_ACTION:[\s\S]*?END_PENDING_ACTION/g, '');
    history[0].content += `\nPENDING_ACTION:\nHay una acción pendiente de confirmación (${pa.type}).\nSi el usuario confirma claramente (si, dale, ok, confirmo), tu respuesta debe ser SOLO este JSON exacto y nada más:\n${jsonPendiente}\nSi el usuario no confirma claramente, NO emitas JSON y pedí confirmación explícita.\nEND_PENDING_ACTION`;

    if (esRechazoClaro(msgNorm)) {
      safeMetadata.pendingAction = null;
    }
  }

  // ── DETECCIÓN TEMPRANA de selección de propiedad ─────────────────────────
  // Debe correr ANTES de PASO 1.5 para evitar que la gestión de visitas
  // intercepte mensajes del tipo "quiero el de Av. Hipólito Yrigoyen 789".
  let propiedadPreseleccionadaId = null;
  let propiedadPreseleccionadaNum = null;
  let seleccionAmbigua = false;
  {
    const promptPrev = history[0]?.content || '';
    const idsPrevMeta = safeMetadata.idsPropiedadesMostradas.map(id => String(id));
    const idsMatchPrev = promptPrev.match(/IDS_PROPIEDADES_MOSTRADAS:\[([^\]]+)\]/);
    const idsPrevPrompt = idsMatchPrev ? idsMatchPrev[1].split(',').map(id => id.trim()) : [];
    const idsPrev = idsPrevMeta.length > 0 ? idsPrevMeta : idsPrevPrompt;
    if (idsPrev.length > 0) {
      const selOpPrev = userMessage.match(/opci[oó]n\s*([1-9])|\bla\s+([1-9])\b|\bel\s+([1-9])\b|^([1-9])$/i);
      const selNumPrev = selOpPrev ? parseInt(selOpPrev[1] || selOpPrev[2] || selOpPrev[3] || selOpPrev[4], 10) : null;
      let preId = selNumPrev ? idsPrev[selNumPrev - 1] : null;
      let preNum = selNumPrev;
      if (!preId) {
        const dirsMatchPrev = promptPrev.match(/DIRS_PROPIEDADES_MOSTRADAS:\[([^\]]*)\]/);
        if (dirsMatchPrev) {
          const dirsPrev = dirsMatchPrev[1].split('|');
          for (let i = 0; i < dirsPrev.length; i++) {
            const dirNorm = dirsPrev[i].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            const dirWords = dirNorm.split(/\s+/).filter(w => w.length > 3);
            const matchCount = dirWords.filter(w => msgNorm.includes(w)).length;
            if (matchCount >= 2) {
              preId = idsPrev[i];
              preNum = i + 1;
              console.log(`📍 [EARLY] Selección por dirección: "${dirsPrev[i]}" → Opción ${preNum} (ID ${preId})`);
              break;
            }
          }
        }
      }
      propiedadPreseleccionadaId = preId || null;
      propiedadPreseleccionadaNum = preNum || null;

      const referenciaAmbigua = /\b(ese|esa|eso|uno|una|quiero ese|me interesa ese|la de ahi|la otra)\b/i.test(userMessage);
      if (referenciaAmbigua && !propiedadPreseleccionadaId) {
        seleccionAmbigua = true;
      }
    }
  }

  if (seleccionAmbigua && history[0]?.role === 'system') {
    history[0].content += '\nINSTRUCCIÓN CRÍTICA: El usuario hizo una referencia ambigua a una propiedad (por ejemplo "ese" o "uno"). Pedir aclaración breve: número de opción o dirección exacta. NO asumir propiedad.';
  }

  // ── PASO 1: Detectar link de portal inmobiliario ─────────────────────────
  // Corre siempre antes de cualquier otra lógica de búsqueda. Si el mensaje
  // contiene un link de Zonaprop o La Voz, toma el control completo del turno.
  const linkDetectado = detectarLink(userMessage);
  if (linkDetectado) {
    console.log(JSON.stringify({
      type: 'LINK_DETECTED',
      portal: linkDetectado.fuente,
      codigo: linkDetectado.codigo,
      link: linkDetectado.link,
      sessionId,
      timestamp: new Date().toISOString()
    }));

    // Guard: no volver a buscar el mismo código si ya fue procesado en esta sesión.
    // Permite re-procesar si el usuario manda otro link con código distinto.
    const yaFueBuscado = (history[0]?.content || '').includes(`LINK_BUSCADO:${linkDetectado.codigo}`);

    if (!yaFueBuscado && supabaseConfig) {
      const propiedad = await obtenerPropiedadPorCodigo(
        linkDetectado.fuente,
        linkDetectado.codigo,
        supabaseConfig
      );

      if (propiedad) {
        // ── CASO A: Propiedad encontrada en DB ──────────────────────────────
        console.log(JSON.stringify({
          type: 'PROPERTY_MATCH_SUCCESS',
          portal: linkDetectado.fuente,
          codigo: linkDetectado.codigo,
          propiedadId: propiedad.id,
          sessionId,
          timestamp: new Date().toISOString()
        }));

        // Setear en metadata para que processReservation lo use directamente
        safeMetadata.propiedadSeleccionadaId = propiedad.id;
        safeMetadata.idsPropiedadesMostradas  = [propiedad.id];
        safeMetadata.propiedadesMostradas = [propiedad.id];
        safeMetadata.origen = 'link';

        if (history[0]?.role === 'system') {
          // Limpiar bloque de propiedades previo (puede haber de búsqueda anterior)
          history[0].content = history[0].content
            .replace(/\n\n---PROPIEDADES---[\s\S]*?---FIN_PROPIEDADES---/g, '')
            .replace(/\n*PROPIEDAD_SELECCIONADA_ID:[^\n]*/g, '')
            .replace(/\n*INSTRUCCIÓN: El usuario eligió[^\n]*/g, '');

          history[0].content +=
            `\n\nLINK_BUSCADO:${linkDetectado.codigo}` +
            `\n\n---PROPIEDADES---\n**PROPIEDAD ENCONTRADA POR LINK (${linkDetectado.fuente})**\n\n` +
            `${formatearPropiedad(propiedad, 1, 1)}\nID interno: ${propiedad.id}\n\n` +
            `IDS_PROPIEDADES_MOSTRADAS:[${propiedad.id}]\n` +
            `DIRS_PROPIEDADES_MOSTRADAS:[${(propiedad.direccion || '').replace(/\|/g, ' ')}]\n\n` +
            `PROPIEDAD_SELECCIONADA_ID:${propiedad.id}\n` +
            `INSTRUCCIÓN: El usuario compartió un link del portal ${linkDetectado.fuente}. ` +
            `Mostrar los datos de esta propiedad de forma entusiasta y preguntar si quiere coordinar una visita. ` +
            `Usar id_propiedad: ${propiedad.id} en el JSON de reserva.\n` +
            `---FIN_PROPIEDADES---`;
        }

      } else {
        // ── CASO B: Propiedad NO encontrada → fallback comercial + guardar lead ──
        console.log(JSON.stringify({
          type: 'PROPERTY_MATCH_FAIL',
          portal: linkDetectado.fuente,
          codigo: linkDetectado.codigo,
          sessionId,
          timestamp: new Date().toISOString()
        }));

        safeMetadata.origen = 'link_fallback';

        // Guardar el lead de forma asíncrona sin bloquear la respuesta.
        // Si falla el insert, la conversación igual continúa normalmente.
        guardarConsultaLink(
          {
            telefono: sessionId,
            link:     linkDetectado.link || userMessage.substring(0, 1000),
            portal:   linkDetectado.fuente,
            codigo:   linkDetectado.codigo
          },
          supabaseConfig
        ).catch(err => {
          console.error('❌ guardarConsultaLink (non-blocking):', err.message);
        });

        if (history[0]?.role === 'system') {
          // Instrucción en lenguaje interno → el LLM la transforma en respuesta comercial.
          // Nunca mencionar "no encontrado", "base de datos", ni nada técnico.
          history[0].content +=
            `\n\nLINK_BUSCADO:${linkDetectado.codigo}` +
            `\n\nINSTRUCCIÓN PARA LINK SIN MATCH:` +
            `\nEl usuario compartió un link del portal ${linkDetectado.fuente} (código interno: ${linkDetectado.codigo}).` +
            `\nEsta propiedad todavía no está cargada en nuestro sistema. ` +
            `NUNCA decir "no encontré la propiedad" ni mencionar errores técnicos.` +
            `\nRespondé de forma cálida y comercial, por ejemplo:` +
            `\n"¡Gracias por compartir la propiedad! La estoy revisando y en breve un asesor te puede dar todos los detalles. ` +
            `¿Querés que mientras tanto te vaya adelantando la coordinación de una visita? ` +
            `Solo necesito tu nombre y cuándo te vendría bien."` +
            `\nEl objetivo es mantener el interés del usuario y avanzar hacia una visita.` +
            `\nNO emitir ningún JSON de acción en este turno.`;
        }
      }
    } else if (yaFueBuscado) {
      console.log(`🔄 Link ${linkDetectado.codigo} ya procesado en esta sesión — sin re-búsqueda`);
    }

    if (history.length > 30) history = [history[0], ...history.slice(1).slice(-29)];
    return { history: [...history, { role: 'user', content: userMessage }], metadata: safeMetadata };
  }

  // ── PASO 1.5: Detectar intención de gestionar visita existente ────────────
  const ultimoMsgAsistente = history.filter(h => h.role === 'assistant').slice(-1)[0]?.content || '';
  const contextoAsistenteEsVisita = /visita|fecha|hora|cambiar|cancelar|confirmar|reprogramar/i.test(ultimoMsgAsistente);

  const quiereGestionarVisita =
    // Frases explícitas de gestión (infinitivos, conjugados e imperativos)
    /\b(cancelar|confirmar|cambiar|cambia|cambie|cambies|cambio|cambiaste|modificar|modifica|modificalo|modificala|reprogramar|reprograma|pasarla|pasarlo|moverla|moverlo|mover|mova|postergar|cambiarla|cambiarlo|reagendar|mi visita|tengo visita|visita agendada|quiero cancelar|quiero cambiar|quiero confirmar|puedo cambiar|puede cambiar|podemos pasar|podemos cambiar|el turno|una visita|la visita|para las|a las|el registro|direccion|direcci|datos de|que propiedad|cual es la|donde es|donde esta|donde queda|tengo agendad|visita agendad|que visita|mis visitas|mis turnos|tengo turno|turno agendad)\b/.test(msgNorm)
    // Re-inyectar si el turno anterior ya tenía visitas cargadas y el bot habló de visitas
    || (visitasBuscadasEnTurnoAnterior && contextoAsistenteEsVisita);

  const quiereCancelar = /\bcancelar|cancelo|anular|dar de baja\b/.test(msgNorm);
  const quiereReprogramar = /\breprogramar|cambiar|modificar|mover\b/.test(msgNorm);
  const gestionVisitaExplicita = /\b(mi visita|mis visitas|visita agendada|tengo visita|tengo turno|mis turnos|quiero cambiar la visita|quiero cancelar la visita|quiero reprogramar la visita)\b/.test(msgNorm);

  // BUG 2: Si hay una propiedad seleccionada activa, el usuario está en flujo de agendamiento
  // — no buscar visitas aunque el mensaje contenga "a las", "para las", etc.
  const hayPropiedadSeleccionada = Boolean(safeMetadata.propiedadSeleccionadaId) || (history[0]?.content || '').includes('PROPIEDAD_SELECCIONADA_ID:');

  // También bloquear si el bot ya está recopilando datos para agendar (selección por dirección no setea el tag)
  const botRecopilandoReserva = history
    .filter(h => h.role === 'assistant')
    .slice(-2)
    .some(m => /nombre.*tel[eé]fono|tel[eé]fono.*nombre|cu[aá]l es tu nombre|d[ií]a y hora|nombre y n[uú]mero/i.test(m.content));

  console.log(`🔍 quiereGestionarVisita=${quiereGestionarVisita} | hayPropiedadSeleccionada=${hayPropiedadSeleccionada} | botRecopilandoReserva=${botRecopilandoReserva} | msgNorm="${msgNorm.substring(0, 80)}" | visitasBuscadasAnterior=${visitasBuscadasEnTurnoAnterior} | contextoAsistenteEsVisita=${contextoAsistenteEsVisita}`);

  const bloquearGestionPorFlujoReserva = hayPropiedadSeleccionada && !quiereCancelar && !quiereReprogramar && !gestionVisitaExplicita;

  if (quiereGestionarVisita && !bloquearGestionPorFlujoReserva && !botRecopilandoReserva && !propiedadPreseleccionadaId && supabaseConfig && sessionId) {
    const promptContent = history[0]?.content || '';
    const yaFueBuscadoVisitas = promptContent.includes('BUSQUEDA_VISITAS_USUARIO:');

    if (!yaFueBuscadoVisitas) {
      console.log('🗓️ Intención de gestionar visita — buscando visitas del usuario...');
      const visitasUsuario = await buscarVisitasUsuario(sessionId, supabaseConfig);

      if (history[0]?.role === 'system') {
        // Limpiar bloque anterior si existiera
        history[0].content = history[0].content.replace(/\n\n---VISITAS_USUARIO---[\s\S]*?---FIN_VISITAS_USUARIO---/g, '');
        history[0].content += '\nBUSQUEDA_VISITAS_USUARIO:done';

        if (visitasUsuario.length > 0) {
          const visitasText = visitasUsuario.map(v => {
            const prop = v._propiedad;
            const propInfo = prop
              ? ` | Propiedad: ${prop.tipologia} en ${prop.barrio} - ${prop.direccion}`
              : ' | Propiedad: no disponible';
            return `[ID:${v.id}] Fecha: ${v.fecha} | Hora: ${v.hora ? v.hora.substring(0, 5) : '—'} | Estado: ${v.operacion}${propInfo}`;
          }).join('\n');
          history[0].content += `\n\n---VISITAS_USUARIO---\nVisitas del usuario:\n${visitasText}\n\nINSTRUCCIÓN: Presentá sus visitas al usuario (sin mostrar el ID numérico) incluyendo fecha, hora, estado y dirección de la propiedad. Preguntá cuál quiere gestionar y qué desea hacer. Pedí confirmación explícita antes de emitir el JSON.\n---FIN_VISITAS_USUARIO---`;
          console.log(`✅ ${visitasUsuario.length} visitas inyectadas en system prompt`);
          safeMetadata.visitasMostradas = visitasUsuario.map(v => v.id);
          if (visitasUsuario.length === 1) safeMetadata.visitaSeleccionadaId = visitasUsuario[0].id;
        } else {
          // Fallback: si la búsqueda por teléfono no encontró nada (puede ser un teléfono
          // distinto al que el usuario le dio al bot), buscar por visitaSeleccionadaId de sesión.
          const visitaIdFallback = safeMetadata.visitaSeleccionadaId;
          if (visitaIdFallback && supabaseConfig?.url) {
            console.log(`⚠️ Sin visitas por teléfono — fallback a visitaSeleccionadaId=${visitaIdFallback}`);
            let visitaFallback = null;
            try {
              const fbApiKey = supabaseConfig.service_role_key || supabaseConfig.anon_key;
              const fbUrl = `${supabaseConfig.url}/rest/v1/visitas?select=*&id=eq.${visitaIdFallback}&limit=1`;
              const fbResp = await fetch(fbUrl, { method: 'GET', headers: { apikey: fbApiKey, Authorization: `Bearer ${fbApiKey}`, 'Content-Type': 'application/json' } });
              if (fbResp.ok) {
                const fbData = await fbResp.json();
                if (Array.isArray(fbData) && fbData.length > 0) visitaFallback = fbData[0];
              }
            } catch (e) { console.error('❌ Fallback visita por ID:', e.message); }

            if (visitaFallback) {
              const visitaText = `[ID:${visitaFallback.id}] Fecha: ${visitaFallback.fecha} | Hora: ${visitaFallback.hora ? visitaFallback.hora.substring(0, 5) : '—'} | Estado: ${visitaFallback.operacion}`;
              history[0].content += `\n\n---VISITAS_USUARIO---\nVisitas del usuario:\n${visitaText}\n\nINSTRUCCIÓN: Presentá la visita al usuario (sin mostrar el ID) incluyendo fecha, hora y estado. Preguntá qué desea hacer. Pedí confirmación explícita antes de emitir el JSON.\n---FIN_VISITAS_USUARIO---`;
              safeMetadata.visitasMostradas = [visitaFallback.id];
              console.log(`✅ Visita fallback encontrada por ID: ${visitaFallback.id}`);
            } else {
              history[0].content += `\n\n---VISITAS_USUARIO---\nINSTRUCCIÓN: Existe una visita registrada en la sesión. Preguntá qué cambio desea hacer y pedí confirmación antes de emitir el JSON de acción.\n---FIN_VISITAS_USUARIO---`;
              safeMetadata.visitasMostradas = [visitaIdFallback];
              console.log(`⚠️ Visita fallback sin detalles — ID ${visitaIdFallback} en metadata`);
            }
            // No limpiar visitaSeleccionadaId: resolverIdVisita lo usa como fuente primaria.
          } else {
            history[0].content += `\n\n---VISITAS_USUARIO---\n⚠️ **BASE DE DATOS CONSULTADA: SIN VISITAS ACTIVAS** — No existen visitas pendientes ni confirmadas para este número de WhatsApp en la base de datos.\n\nINSTRUCCIÓN OBLIGATORIA:\n1. Respondé EXACTAMENTE: "No encontré visitas pendientes o confirmadas asociadas a tu número. ¿Querés agendar una nueva visita?"\n2. PROHIBIDO emitir JSON de tipo update_visit o cancel_visit — no hay visitas que modificar.\n3. PROHIBIDO usar datos del historial de conversación para inferir visitas — la única fuente válida es la base de datos.\n---FIN_VISITAS_USUARIO---`;
            console.log('⚠️ Sin visitas activas para el usuario');
            safeMetadata.visitasMostradas = [];
            safeMetadata.visitaSeleccionadaId = null;
          }
        }
      }
    } else {
      console.log('🔄 Visitas ya consultadas en esta sesión — usando contexto existente');
    }
  }

  // Selección explícita de visita por número (1,2,3...) usando metadata.visitasMostradas
  if (Array.isArray(safeMetadata.visitasMostradas) && safeMetadata.visitasMostradas.length > 0) {
    const selVisit = userMessage.match(/opci[oó]n\s*([1-9])|\bla\s+([1-9])\b|\bel\s+([1-9])\b|^([1-9])$/i);
    const selNum = selVisit ? parseInt(selVisit[1] || selVisit[2] || selVisit[3] || selVisit[4], 10) : null;
    if (selNum && safeMetadata.visitasMostradas[selNum - 1]) {
      safeMetadata.visitaSeleccionadaId = safeMetadata.visitasMostradas[selNum - 1];
      console.log('VISITA ID USADA:', safeMetadata.visitaSeleccionadaId, '(seleccion por opcion en metadata.visitasMostradas)');
    }
  }

  // ── PASO 3: Detectar operación y tipología ────────────────────────────────
  const esAlquiler = /alquil|arrendar|renta/.test(msgNorm);
  const esVenta    = /compr|venta|vend/.test(msgNorm);

  const tipologiaDetectada = (() => {
    const TIPOS_MAP = [
      [/\bdeptos?\b|\bdepartamentos?\b|\bapartamentos?\b/, 'departamento'],
      [/\bphs?\b/,                                         'ph'],
      [/\bcasas?\b/,                                       'casa'],
      [/\bduplexes?\b|\bdúplexes?\b/,                      'duplex'],
      [/\blocales?\b/,                                     'local'],
      [/\boficinas?\b/,                                    'oficina'],
      [/\bcocheras?\b|\bgarages?\b|\bgarajes?\b/,           'cochera'],
    ];
    const encontrados = [];
    for (const [re, v] of TIPOS_MAP) {
      if (re.test(msgNorm) && !encontrados.includes(v)) encontrados.push(v);
    }
    if (encontrados.length === 0) return null;
    return encontrados.length === 1 ? encontrados[0] : encontrados.join(',');
  })();

  // ── PASO 4: Detectar barrio ───────────────────────────────────────────────
  const BARRIOS = [
    'quintas de santa ana', 'villa allende parque', 'cerro de las rosas',
    'villa eucaristica', 'villa los troncos', 'villa warcalde',
    'villa belgrano', 'villa cabrera', 'alta cordoba', 'general paz',
    'valle escondido', 'poeta lugones', 'san vicente', 'los boulevares',
    'nueva cordoba', 'las rosas', 'arguello', 'alberdi', 'cofico',
    'guemes', 'jardin', 'urca'
  ];
  const barrioDetectado = BARRIOS.find(b => msgNorm.includes(b)) || null;

  const direccionMatch = userMessage.match(/(?:\bcalle\b|\bdireccion\b|\bdirección\b)\s+([a-z0-9áéíóúüñ.\-\s]{3,80})/i);
  const direccionDetectada = direccionMatch?.[1]
    ? direccionMatch[1].replace(/\b(en|de|del|para|con|y)\b.*$/i, '').replace(/\s+/g, ' ').trim()
    : null;

  const sinPreferenciaBarrio = /^no$|^da lo mismo$|^me da lo mismo$|^cualquiera$|sin preferencia|cualquier barrio|todos los barrios|no tengo preferencia|no importa|me da igual|indistinto/.test(msgNorm.trim());

  const pideMas = /\bver mas\b|\bmas opciones?\b|\bmostrame mas\b|\bsiguientes?\b|\bmas propiedades?\b|\bmas resultados?\b|\bdame mas\b/.test(msgNorm);

  // ── PASO 4.5: Detectar filtros adicionales ────────────────────────────────
  const ambientesMatch = msgNorm.match(/\b(\d+)\s*ambientes?\b/);
  const ambientesDetectados = ambientesMatch ? parseInt(ambientesMatch[1], 10) : null;

  const _NUM_PALABRAS_DORM = { uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };
  const _parseDorm = s => { const n = parseInt(s, 10); return isNaN(n) ? (_NUM_PALABRAS_DORM[s] || null) : n; };
  const _DORM_PAT = '(\\d+|uno|una|dos|tres|cuatro|cinco|seis)';
  const _DORM_NOUN = '(?:dormitorios?|habitaciones?|cuartos?|piezas?)';
  const dormGteMatch =
    msgNorm.match(new RegExp(`(?:mas\\s+de|al\\s+menos|minimo|como\\s+minimo|por\\s+lo\\s+menos)\\s+${_DORM_PAT}\\s*${_DORM_NOUN}`, 'i')) ||
    msgNorm.match(new RegExp(`${_DORM_PAT}\\s*${_DORM_NOUN}\\s+o\\s+mas`, 'i'));
  const dormEqMatch = msgNorm.match(new RegExp(`\\b${_DORM_PAT}\\s*${_DORM_NOUN}\\b`, 'i'));
  let dormitoriosDetectados = null;
  let dormitoriosOpDetectado = null;
  if (dormGteMatch) {
    dormitoriosDetectados = _parseDorm(dormGteMatch[1]);
    dormitoriosOpDetectado = 'gte';
  } else if (dormEqMatch) {
    dormitoriosDetectados = _parseDorm(dormEqMatch[1]);
    dormitoriosOpDetectado = 'eq';
  }

  const aptoBancoDetectado = /\bapto\s*banco\b|\bacepta\s*banco\b|\bbanco\b|\bhipoteca\b|\bcr[eé]dito\s*hipotecario\b/.test(msgNorm) ? true : null;

  // Rango explícito de presupuesto.
  // Ejemplos: "entre 200 y 400 mil", "rango de 200000 a 600000", "desde 250k hasta 500k"
  const precioRangoMatch =
    msgNorm.match(/(?:entre|rango\s+de|desde)\s*\$?\s*([\d.]+)\s*(k|mil)?\s*(?:y|a|hasta)\s*\$?\s*([\d.]+)\s*(k|mil)?\b/i)
    || msgNorm.match(/\b([\d.]{3,})\s*(k|mil)?\s*(?:a|hasta)\s*([\d.]{3,})\s*(k|mil)?\b/i);

  let precioMaxDetectado  = null;
  let precioMinDetectado  = null;
  let presupuestoDetectado = null; // presupuesto flexible → generará rango inteligente en PASO 5

  if (precioRangoMatch) {
    const _parseP = (raw, sfx) => {
      let v = parseInt(String(raw || '').replace(/\./g, ''), 10);
      if (!v) return null;
      if (/k|mil/i.test(sfx || '')) v *= 1000;
      return v > 0 ? v : null;
    };
    let minVal = _parseP(precioRangoMatch[1], precioRangoMatch[2]);
    let maxVal = _parseP(precioRangoMatch[3], precioRangoMatch[4]);
    // "entre 200 y 400 mil" → el "mil" aplica a ambos números
    if (minVal && maxVal && !precioRangoMatch[2] && /k|mil/i.test(precioRangoMatch[4] || '') && minVal < 1000) {
      minVal *= 1000;
    }
    if (minVal) precioMinDetectado = minVal;
    if (maxVal) precioMaxDetectado = maxVal;
  } else {
    // Techo duro: "hasta X", "máximo X", "no más de X" → límite explícito, sin expansión
    const hardMaxMatch = msgNorm.match(/hasta\s*(?:\$|pesos)?\s*([\d.]+(?:k|mil)?)\b|(?:menos\s*de)\s*(?:\$|pesos)?\s*([\d.]+(?:k|mil)?)\b|m[aá]ximo\s*(?:\$|pesos)?\s*([\d.]+(?:k|mil)?)\b|(?:no\s+m[aá]s\s+de|tope\s*(?:de)?)\s*(?:\$|pesos)?\s*([\d.]+(?:k|mil)?)\b/);
    if (hardMaxMatch) {
      const raw = (hardMaxMatch[1]||hardMaxMatch[2]||hardMaxMatch[3]||hardMaxMatch[4]||'').replace(/\./g,'');
      if (raw) {
        let v = parseInt(raw, 10);
        if (/k\b|mil/i.test(hardMaxMatch[0])) v *= 1000;
        if (v > 0) precioMaxDetectado = v;
      }
    } else {
      // Presupuesto flexible: "tengo X", "presupuesto X", "por Xk" → rango inteligente en PASO 5
      const presupuestoMatch = msgNorm.match(/presupuesto\s*(?:de\s*hasta\s*|de\s*|es\s*|hasta\s*)?(?:\$|pesos)?\s*([\d.]+(?:k|mil)?)\b|tengo\s*(?:hasta\s*)?(?:\$|pesos)?\s*([\d.]+(?:k|mil)+)\b|tengo\s*(?:hasta\s*)?(?:\$|pesos)?\s*(\d{6,})\b|cuento\s+con\s*(?:hasta\s*)?(?:\$|pesos)?\s*([\d.]+(?:k|mil)+)\b|cuento\s+con\s*(?:hasta\s*)?(?:\$|pesos)?\s*(\d{6,})\b|por\s*(?:\$|pesos)?\s*([\d.]+(?:k|mil)+)\b/);
      if (presupuestoMatch) {
        const raw = (presupuestoMatch[1]||presupuestoMatch[2]||presupuestoMatch[3]||presupuestoMatch[4]||presupuestoMatch[5]||presupuestoMatch[6]||'').replace(/\./g,'');
        if (raw) {
          let v = parseInt(raw, 10);
          if (/k\b|mil/i.test(presupuestoMatch[0])) v *= 1000;
          if (v > 0) presupuestoDetectado = v;
        }
      } else {
        // Número suelto (ej: "390.000", "390000") → presupuesto directo
        const soloNumMatch = userMessage.match(/^\s*\$?\s*([\d.,']+)\s*$/);
        if (soloNumMatch) {
          const v = parseInt(soloNumMatch[1].replace(/[.,]/g, ''), 10);
          if (v > 1000) presupuestoDetectado = v;
        }
      }
    }
  }

  // Lookup directo por ID interno: "id 42", "número 42", "propiedad 42"
  const idInternoMatch = userMessage.match(/\b(?:id|n[uú]mero|n[uú]m|propiedad|prop)\s*#?\s*(\d{1,6})\b/i) || null;
  const idInternoDetectado = idInternoMatch ? parseInt(idInternoMatch[1], 10) : null;

  // ── PASO 5: Recuperar filtros guardados ───────────────────────────────────
  const sistemaPrompt = history[0]?.content || '';
  const operacionGuardada = safeMetadata.ultimaBusqueda.operacion || (sistemaPrompt.match(/FILTRO_OPERACION:(alquiler|venta)/) || [])[1] || null;
  const tipologiaGuardada = safeMetadata.ultimaBusqueda.tipologia || (sistemaPrompt.match(/FILTRO_TIPOLOGIA:([^\n]+)/) || [])[1]?.trim() || null;
  const barrioGuardado = (safeMetadata.ultimaBusqueda.barrio ?? '') !== ''
    ? safeMetadata.ultimaBusqueda.barrio
    : (sistemaPrompt.match(/FILTRO_BARRIO:([^\n]*)/) || [])[1]?.trim() || null;
  const direccionGuardada = (safeMetadata.ultimaBusqueda.direccion ?? '') !== ''
    ? safeMetadata.ultimaBusqueda.direccion
    : (sistemaPrompt.match(/FILTRO_DIRECCION:([^\n]*)/) || [])[1]?.trim() || null;
  const offsetGuardado = Number.isInteger(safeMetadata.ultimaBusqueda.offset)
    ? safeMetadata.ultimaBusqueda.offset
    : parseInt((sistemaPrompt.match(/FILTRO_OFFSET:(\d+)/) || [])[1] || '0', 10);

  const operacionFinal = (esAlquiler ? 'alquiler' : esVenta ? 'venta' : null) || operacionGuardada;
  const pideBusquedaGeneralPropiedades =
    /\bpropiedad(?:es)?\b/.test(msgNorm)
    && !tipologiaDetectada
    && !/\bque tipo\b|\btipologia\b/.test(msgNorm);
  const tipologiaFinal = pideBusquedaGeneralPropiedades
    ? 'departamento,casa,ph,duplex,local,oficina,cochera'
    : (tipologiaDetectada || tipologiaGuardada);
  const barrioFinal    = sinPreferenciaBarrio ? '' : (barrioDetectado || barrioGuardado || null);
  const direccionFinal = direccionDetectada || direccionGuardada || null;

  // Reset offset si cambia cualquier filtro primario
  const filtroCambiado = (operacionGuardada && operacionFinal !== operacionGuardada)
    || (tipologiaGuardada && tipologiaFinal !== tipologiaGuardada)
    || (barrioGuardado && barrioFinal !== barrioGuardado)
    || (direccionGuardada && direccionFinal !== direccionGuardada);
  const offsetFinal = pideMas ? (offsetGuardado + 5) : (filtroCambiado ? 0 : offsetGuardado);

  const ambientesFinal   = ambientesDetectados   || safeMetadata.ultimaBusqueda.ambientes   || null;
  const dormitoriosFinal   = dormitoriosDetectados || safeMetadata.ultimaBusqueda.dormitorios || null;
  const dormitoriosOpFinal = dormitoriosOpDetectado || safeMetadata.ultimaBusqueda.dormitoriosOp || 'eq';
  const aptoBancoFinal   = aptoBancoDetectado     || safeMetadata.ultimaBusqueda.aptoBanco   || null;
  const precioMaxFinal    = precioMaxDetectado     || safeMetadata.ultimaBusqueda.precioMax    || null;
  const precioMinFinal    = precioMinDetectado     || safeMetadata.ultimaBusqueda.precioMin    || null;
  const presupuestoFinal  = presupuestoDetectado   || safeMetadata.ultimaBusqueda.presupuesto  || null;

  // Presupuesto = techo de precio (igual que Sheets: precio <= presupuesto)
  const queryPrecioMin = precioMinFinal || null;
  const queryPrecioMax = precioMaxFinal || presupuestoFinal || null;

  console.log('🔍 Filtros detectados:', { operacionFinal, tipologiaFinal, barrioFinal, direccionFinal, pideMas, offsetFinal, presupuestoFinal, queryPrecioMin, queryPrecioMax });
  console.log("TIPO DETECTADO:", tipologiaFinal);
  console.log("TIPOS ARRAY:", tipologiaFinal ? tipologiaFinal.split(',').map(t => t.trim()) : []);
  console.log("RANGO:", queryPrecioMin, queryPrecioMax);

  // ── PASO 5.5: Persistir filtros parciales y pedir lo que falta ──────────
  if (history[0]?.role === 'system') {
    let prompt = history[0].content;

    if (direccionFinal) {
      if (prompt.includes('FILTRO_DIRECCION:')) {
        prompt = prompt.replace(/FILTRO_DIRECCION:[^\n]*/g, `FILTRO_DIRECCION:${direccionFinal}`);
      } else {
        prompt += `\nFILTRO_DIRECCION:${direccionFinal}`;
      }
    }

    // Caso A: hay tipología pero falta operación → guardar tipología/barrio y pedir operación
    if (tipologiaFinal && !operacionFinal) {
      if (prompt.includes('FILTRO_TIPOLOGIA:')) {
        prompt = prompt.replace(/FILTRO_TIPOLOGIA:[^\n]*/g, `FILTRO_TIPOLOGIA:${tipologiaFinal}`);
      } else {
        prompt += `\nFILTRO_TIPOLOGIA:${tipologiaFinal}`;
      }
      if (barrioDetectado) {
        if (prompt.includes('FILTRO_BARRIO:')) {
          prompt = prompt.replace(/FILTRO_BARRIO:[^\n]*/g, `FILTRO_BARRIO:${barrioDetectado}`);
        } else {
          prompt += `\nFILTRO_BARRIO:${barrioDetectado}`;
        }
      }
      prompt += `\nINSTRUCCIÓN CRÍTICA: El usuario quiere ver un ${tipologiaFinal}${barrioFinal ? ' en ' + barrioFinal : ''} pero NO indicó si es para alquilar o comprar. NO mostrar propiedades. Preguntarle EXACTAMENTE: "¿Estás buscando para alquilar o para comprar?"`;
      history[0].content = prompt;
      // Persistir tipologia/barrio en metadata para resiliencia
      safeMetadata.ultimaBusqueda = { ...safeMetadata.ultimaBusqueda, tipologia: tipologiaFinal };
      if (barrioDetectado) safeMetadata.ultimaBusqueda = { ...safeMetadata.ultimaBusqueda, barrio: barrioDetectado };
      console.log(`💾 Tipología sin operación — guardando filtros y pidiendo operación`);
      if (history.length > 30) history = [history[0], ...history.slice(1).slice(-29)];
      return { history: [...history, { role: 'user', content: userMessage }], metadata: safeMetadata };
    }

    // Caso B: hay operación/barrio pero falta tipología → guardar y pedir tipología
    if ((operacionFinal || barrioDetectado) && !tipologiaFinal) {
      if (operacionFinal) {
        if (prompt.includes('FILTRO_OPERACION:')) {
          prompt = prompt.replace(/FILTRO_OPERACION:[^\n]*/g, `FILTRO_OPERACION:${operacionFinal}`);
        } else {
          prompt += `\nFILTRO_OPERACION:${operacionFinal}`;
        }
      }
      if (barrioDetectado) {
        if (prompt.includes('FILTRO_BARRIO:')) {
          prompt = prompt.replace(/FILTRO_BARRIO:[^\n]*/g, `FILTRO_BARRIO:${barrioDetectado}`);
        } else {
          prompt += `\nFILTRO_BARRIO:${barrioDetectado}`;
        }
      }
      const contextoOp = operacionFinal ? ` para ${operacionFinal}` : '';
      const contextoBarrio = barrioDetectado ? ` en ${barrioDetectado}` : '';
      prompt += `\nINSTRUCCIÓN CRÍTICA: El usuario busca${contextoOp}${contextoBarrio} pero NO indicó tipo de propiedad. NO mostrar propiedades ni prometer búsqueda. Preguntar EXACTAMENTE: "¿Qué tipo de propiedad estás buscando? Tenemos departamentos, casas, PHs, locales y cocheras."`;
      history[0].content = prompt;
      // Persistir operacion/barrio en metadata para resiliencia si el system prompt se pierde
      if (operacionFinal) safeMetadata.ultimaBusqueda = { ...safeMetadata.ultimaBusqueda, operacion: operacionFinal };
      if (barrioDetectado) safeMetadata.ultimaBusqueda = { ...safeMetadata.ultimaBusqueda, barrio: barrioDetectado };
      console.log(`💾 Filtros parciales + instrucción — esperando tipología`);
      if (history.length > 30) history = [history[0], ...history.slice(1).slice(-29)];
      return { history: [...history, { role: 'user', content: userMessage }], metadata: safeMetadata };
    }

    // Caso C: hay operación + tipología pero falta presupuesto → pedirlo antes de buscar
    const hayPrecio = presupuestoFinal || precioMaxFinal || precioMinFinal;
    if (operacionFinal && tipologiaFinal && !hayPrecio && !pideMas) {
      if (prompt.includes('FILTRO_OPERACION:')) {
        prompt = prompt
          .replace(/FILTRO_OPERACION:[^\n]*/g, `FILTRO_OPERACION:${operacionFinal}`)
          .replace(/FILTRO_TIPOLOGIA:[^\n]*/g, `FILTRO_TIPOLOGIA:${tipologiaFinal}`);
      } else {
        prompt += `\nFILTRO_OPERACION:${operacionFinal}\nFILTRO_TIPOLOGIA:${tipologiaFinal}`;
      }
      if (barrioFinal) {
        if (prompt.includes('FILTRO_BARRIO:')) {
          prompt = prompt.replace(/FILTRO_BARRIO:[^\n]*/g, `FILTRO_BARRIO:${barrioFinal}`);
        } else {
          prompt += `\nFILTRO_BARRIO:${barrioFinal}`;
        }
      }
      prompt += `\nINSTRUCCIÓN CRÍTICA: El usuario busca ${operacionFinal} un/una ${tipologiaFinal}${barrioFinal ? ' en ' + barrioFinal : ''} pero NO indicó presupuesto. NO buscar ni mostrar propiedades todavía. Preguntarle EXACTAMENTE: "Perfecto, ¿con qué presupuesto estás trabajando?"`;
      history[0].content = prompt;
      safeMetadata.ultimaBusqueda = { ...safeMetadata.ultimaBusqueda, operacion: operacionFinal, tipologia: tipologiaFinal, barrio: barrioFinal || '' };
      console.log(`💾 Operación + tipología sin presupuesto — pidiendo budget`);
      if (history.length > 30) history = [history[0], ...history.slice(1).slice(-29)];
      return { history: [...history, { role: 'user', content: userMessage }], metadata: safeMetadata };
    }
  }

  // ── PASO 5.9: Lookup directo por ID interno ───────────────────────────────
  if (idInternoDetectado && supabaseConfig) {
    const claveId = `ID_INTERNO:${idInternoDetectado}`;
    const yaFueBuscadoId = (history[0]?.content || '').includes(claveId);

    if (!yaFueBuscadoId) {
      console.log(`🔍 Lookup directo por ID interno: ${idInternoDetectado}`);
      const apiKeyId = supabaseConfig.service_role_key || supabaseConfig.anon_key;
      const headersId = { apikey: apiKeyId, Authorization: `Bearer ${apiKeyId}`, 'Content-Type': 'application/json' };
      const { data: propData, error: propError } = await fetchFromPropertyTables({
        supabaseConfig,
        headers: headersId,
        params: { select: '*', id: `eq.${idInternoDetectado}`, limit: 1 },
        contextTag: 'PROPERTY_BY_ID'
      });

      if (history[0]?.role === 'system') {
        history[0].content = history[0].content
          .replace(/\n\n---PROPIEDADES---[\s\S]*?---FIN_PROPIEDADES---/g, '')
          .replace(/\n*PROPIEDAD_SELECCIONADA_ID:[^\n]*/g, '')
          .replace(/\n*INSTRUCCIÓN: El usuario eligió[^\n]*/g, '');

        if (!propError && Array.isArray(propData) && propData.length > 0) {
          const prop = propData[0];
          safeMetadata.propiedadSeleccionadaId = prop.id;
          safeMetadata.idsPropiedadesMostradas = [prop.id];
          safeMetadata.propiedadesMostradas = [prop.id];
          history[0].content +=
            `\n\n${claveId}` +
            `\n\n---PROPIEDADES---\n**PROPIEDAD ENCONTRADA POR ID INTERNO (${idInternoDetectado})**\n\n` +
            `${formatearPropiedad(prop, 1, 1)}\nID interno: ${prop.id}\n\n` +
            `IDS_PROPIEDADES_MOSTRADAS:[${prop.id}]\n` +
            `DIRS_PROPIEDADES_MOSTRADAS:[${(prop.direccion || '').replace(/\|/g, ' ')}]\n\n` +
            `PROPIEDAD_SELECCIONADA_ID:${prop.id}\n` +
            `INSTRUCCIÓN: Mostrar los datos de esta propiedad y preguntar si quiere coordinar una visita. Usar id_propiedad: ${prop.id} en el JSON de reserva.\n` +
            `---FIN_PROPIEDADES---`;
          console.log(`✅ Propiedad ID ${idInternoDetectado} encontrada e inyectada`);
        } else {
          history[0].content +=
            `\n\n${claveId}` +
            `\n\n---PROPIEDADES---\nSIN_RESULTADOS\n\nINSTRUCCIÓN: No encontramos una propiedad con ese número en nuestro sistema. Decilo de forma natural. Ofrecé buscar por tipo y zona.\n---FIN_PROPIEDADES---`;
          console.log(`⚠️ Propiedad ID ${idInternoDetectado} no encontrada`);
        }
      }
    }

    if (history.length > 30) history = [history[0], ...history.slice(1).slice(-29)];
    return { history: [...history, { role: 'user', content: userMessage }], metadata: safeMetadata };
  }

  // ── PASO 6: Buscar si hay filtros suficientes ─────────────────────────────
  if (operacionFinal && tipologiaFinal && supabaseConfig) {
    const precioIndicador = (queryPrecioMin || queryPrecioMax) ? 'range' : dormitoriosOpFinal;
    const claveActual = `BUSQUEDA:${operacionFinal}:${tipologiaFinal}:${barrioFinal || 'todos'}:${direccionFinal || 'todas'}:${ambientesFinal||''}:${dormitoriosFinal||''}:${precioIndicador}:${aptoBancoFinal||''}:${queryPrecioMin||''}:${queryPrecioMax||''}:${offsetFinal}`;
    const yaFueBuscado = sistemaPrompt.includes(claveActual);

    const hayBusquedaPrevia = sistemaPrompt.includes(`BUSQUEDA:${operacionFinal}:${tipologiaFinal}:`);
    const esMensajeVago = sinPreferenciaBarrio && !barrioDetectado && !pideMas;
    if (hayBusquedaPrevia && esMensajeVago) {
      console.log('🔄 Mensaje vago con búsqueda previa — usando contexto existente sin relanzar');
      if (history.length > 30) history = [history[0], ...history.slice(1).slice(-29)];
      return { history: [...history, { role: 'user', content: userMessage }], metadata: safeMetadata };
    }

    if (!yaFueBuscado) {
      console.log(`🔎 Ejecutando búsqueda: ${claveActual}`);

      const _filtrosBase = {
        operacion:      operacionFinal,
        tipologia:      tipologiaFinal,
        barrio:         barrioFinal || '',
        direccion:      direccionFinal || '',
        ambientes:      ambientesFinal,
        dormitorios:    dormitoriosFinal,
        dormitorios_op: dormitoriosOpFinal,
        apto_banco:     aptoBancoFinal
      };
      const propiedades = await buscarPropiedades(
        { ..._filtrosBase, presupuesto: presupuestoFinal, precio_min: queryPrecioMin, precio_max: queryPrecioMax, limit: 5 },
        supabaseConfig,
        offsetFinal
      );

      if (history[0]?.role === 'system') {
        let prompt = history[0].content;

        if (prompt.includes('FILTRO_OPERACION:')) {
          prompt = prompt
            .replace(/FILTRO_OPERACION:[^\n]*/g, `FILTRO_OPERACION:${operacionFinal}`)
            .replace(/FILTRO_TIPOLOGIA:[^\n]*/g, `FILTRO_TIPOLOGIA:${tipologiaFinal}`)
            .replace(/FILTRO_BARRIO:[^\n]*/g,    `FILTRO_BARRIO:${barrioFinal || ''}`)
            .replace(/FILTRO_DIRECCION:[^\n]*/g, `FILTRO_DIRECCION:${direccionFinal || ''}`)
            .replace(/FILTRO_OFFSET:[^\n]*/g,    `FILTRO_OFFSET:${offsetFinal}`);
        } else {
          prompt += `\nFILTRO_OPERACION:${operacionFinal}\nFILTRO_TIPOLOGIA:${tipologiaFinal}\nFILTRO_BARRIO:${barrioFinal || ''}\nFILTRO_DIRECCION:${direccionFinal || ''}\nFILTRO_OFFSET:${offsetFinal}`;
        }

        prompt = prompt
          .replace(/\n\n---PROPIEDADES---[\s\S]*?---FIN_PROPIEDADES---/g, '')
          .replace(/\n*PROPIEDAD_SELECCIONADA_ID:[^\n]*/g, '')
          .replace(/\n*INSTRUCCIÓN: El usuario eligió[^\n]*/g, '');

        const ultimaBusquedaActualizada = {
          operacion:    operacionFinal,
          tipologia:    tipologiaFinal,
          barrio:       barrioFinal || '',
          direccion:    direccionFinal || '',
          offset:       offsetFinal,
          ambientes:    ambientesFinal,
          dormitorios:  dormitoriosFinal,
          dormitoriosOp: dormitoriosOpFinal,
          aptoBanco:    aptoBancoFinal,
          precioMin:    precioMinFinal,
          precioMax:    precioMaxFinal,
          presupuesto:  presupuestoFinal
        };

        if (propiedades === null) {
          // Error de BD — distinguir de "sin resultados"
          prompt += `\n\n---PROPIEDADES---\nERROR_BD\n\nINSTRUCCIÓN: Hubo un error técnico consultando la base de datos. Disculpate brevemente (ej: "En este momento tengo un problema técnico para acceder al sistema") y ofrecé contactar directamente a la inmobiliaria. NUNCA menciones si hay o no propiedades disponibles.\n---FIN_PROPIEDADES---`;
          console.error('❌ Error de BD al buscar propiedades');
          safeMetadata.idsPropiedadesMostradas = [];
          safeMetadata.propiedadesMostradas = [];
          safeMetadata.propiedadSeleccionadaId = null;
          safeMetadata.ultimaBusqueda = ultimaBusquedaActualizada;
        } else if (propiedades.length > 0) {
          const propTextos = propiedades.map((p, i) => `[ID:${p.id}]\n${formatearPropiedad(p, i + 1, propiedades.length)}`).join('\n\n---\n\n');
          const ids = propiedades.map(p => p.id).join(',');
          const dirs = propiedades.map(p => (p.direccion || '').replace(/\|/g, ' ')).join('|');
          prompt += `\n\n---PROPIEDADES---\n**${claveActual}**\n\n⚠️ INSTRUCCIÓN CRÍTICA DE CONTEXTO: Estas son las propiedades de la búsqueda ACTUAL. Ignorá cualquier propiedad mencionada en mensajes anteriores de esta conversación. Solo usá las que aparecen abajo.\n\n**PROPIEDADES ENCONTRADAS (${propiedades.length}):**\n${propTextos}\n\nIDS_PROPIEDADES_MOSTRADAS:[${ids}]\nDIRS_PROPIEDADES_MOSTRADAS:[${dirs}]\n\nINSTRUCCIÓN: Presentar EXACTAMENTE estas ${propiedades.length} propiedades con sus datos reales. NO inventar ni modificar ningún dato. Luego preguntar si alguna le interesa.\n---FIN_PROPIEDADES---`;
          console.log(`✅ ${propiedades.length} propiedades inyectadas`);
          safeMetadata.idsPropiedadesMostradas = propiedades.map(p => p.id);
          safeMetadata.propiedadesMostradas = propiedades.map(p => p.id);
          safeMetadata.propiedadSeleccionadaId = null;
          safeMetadata.ultimaBusqueda = ultimaBusquedaActualizada;
        } else {
          // Sin resultados con rango inicial — intentar fallback más amplio si hay presupuesto
          let propFallback = null;
          if (presupuestoFinal && offsetFinal === 0) {
            const fbMin = Math.round(presupuestoFinal * 0.55);
            const fbMax = Math.round(presupuestoFinal * 1.45);
            console.log(`🔄 Sin resultados — fallback rango ampliado: ${fbMin}–${fbMax}`);
            propFallback = await buscarPropiedades(
              { ..._filtrosBase, precio_min: fbMin, precio_max: fbMax, limit: 5 },
              supabaseConfig, 0
            );
          }

          if (Array.isArray(propFallback) && propFallback.length > 0) {
            const propTextos = propFallback.map((p, i) => `[ID:${p.id}]\n${formatearPropiedad(p, i + 1, propFallback.length)}`).join('\n\n---\n\n');
            const ids  = propFallback.map(p => p.id).join(',');
            const dirs = propFallback.map(p => (p.direccion || '').replace(/\|/g, ' ')).join('|');
            prompt += `\n\n---PROPIEDADES---\n**${claveActual}**\n\n⚠️ INSTRUCCIÓN CRÍTICA DE CONTEXTO: Estas son las propiedades de la búsqueda ACTUAL con rango ampliado.\n\n**PROPIEDADES ENCONTRADAS (${propFallback.length}) — cercanas al presupuesto:**\n${propTextos}\n\nIDS_PROPIEDADES_MOSTRADAS:[${ids}]\nDIRS_PROPIEDADES_MOSTRADAS:[${dirs}]\n\nINSTRUCCIÓN: No hay propiedades exactas en el presupuesto indicado. Mostrá estas ${propFallback.length} opciones cercanas mencionando que son las más próximas disponibles. Luego preguntar si alguna le interesa.\n---FIN_PROPIEDADES---`;
            console.log(`✅ Fallback: ${propFallback.length} propiedades inyectadas con rango ampliado`);
            safeMetadata.idsPropiedadesMostradas = propFallback.map(p => p.id);
            safeMetadata.propiedadesMostradas = propFallback.map(p => p.id);
            safeMetadata.propiedadSeleccionadaId = null;
            safeMetadata.ultimaBusqueda = ultimaBusquedaActualizada;
          } else {
            // Sin resultados ni con fallback
            const filtrosDesc = [operacionFinal, tipologiaFinal, barrioFinal].filter(Boolean).join(' + ');
            const extras = [
              ambientesFinal   && `${ambientesFinal} amb.`,
              dormitoriosFinal && `${dormitoriosFinal} dorm.`,
              aptoBancoFinal   && 'apto banco',
              presupuestoFinal && `presupuesto $${presupuestoFinal.toLocaleString('es-AR')} → rango $${queryPrecioMin?.toLocaleString('es-AR')}–$${queryPrecioMax?.toLocaleString('es-AR')}`,
              !presupuestoFinal && queryPrecioMin && `desde $${queryPrecioMin.toLocaleString('es-AR')}`,
              !presupuestoFinal && queryPrecioMax && `hasta $${queryPrecioMax.toLocaleString('es-AR')}`
            ].filter(Boolean).join(', ');
            prompt += `\n\n---PROPIEDADES---\n**${claveActual}**\n\nSIN_RESULTADOS\n\nINSTRUCCIÓN: No hay propiedades disponibles para los criterios: ${filtrosDesc}${extras ? ' (' + extras + ')' : ''}. Decilo de forma natural: "No tengo propiedades en ese rango de precio. Si querés puedo buscarte otras opciones cambiando el presupuesto o la zona." NUNCA repitas el string SIN_RESULTADOS ni el formato interno.\n---FIN_PROPIEDADES---`;
            console.log('⚠️ Sin propiedades (ni con fallback)');
            safeMetadata.idsPropiedadesMostradas = [];
            safeMetadata.propiedadesMostradas = [];
            safeMetadata.propiedadSeleccionadaId = null;
            safeMetadata.ultimaBusqueda = ultimaBusquedaActualizada;
          }
        }

        history[0].content = prompt;
      }
    } else {
      console.log('🔄 Búsqueda ya ejecutada, usando contexto existente');
    }
  }

  // ── PASO 7: Detectar selección de propiedad ───────────────────────────────
  // Usa los valores pre-calculados antes de PASO 1.5 para evitar duplicación.
  if (propiedadPreseleccionadaId) {
    const idSeleccionado = propiedadPreseleccionadaId;
    const seleccionNumeroFinal = propiedadPreseleccionadaNum;
    history[0].content = history[0].content
      .replace(/\n\nPROPIEDAD_SELECCIONADA_ID:[^\n]*\nINSTRUCCIÓN:[^\n]*/g, '');
    history[0].content += `\n\nPROPIEDAD_SELECCIONADA_ID:${idSeleccionado}\nINSTRUCCIÓN: El usuario eligió la Opción ${seleccionNumeroFinal} (ID: ${idSeleccionado}). Pedirle nombre, teléfono y fecha/hora para la visita. Usar id_propiedad: ${idSeleccionado} en el JSON.`;
    console.log(`✅ Propiedad seleccionada: ID ${idSeleccionado}`);
    console.log(JSON.stringify({ type: 'PROPERTY_SELECTED', id: parseInt(String(idSeleccionado), 10), opcion: seleccionNumeroFinal, timestamp: new Date().toISOString() }));
    if (history.length > 30) history = [history[0], ...history.slice(1).slice(-29)];
    return {
      history: [...history, { role: 'user', content: userMessage }],
      metadata: {
        ...safeMetadata,
        propiedadesMostradas: safeMetadata.idsPropiedadesMostradas,
        propiedadSeleccionadaId: parseInt(String(idSeleccionado), 10)
      }
    };
  }

  // ── PASO 8: Resolver dudas de propiedad seleccionada consultando DB ──────
  const consultaDetalleProp = /\b(detalle|detalles|direccion|dirección|precio|valor|cuanto|cu[aá]nto|expensas|barrio|zona|ambientes|dormitorios|dormitorio|habitaciones|apto\s*banco|requisitos|imagen|link|ubicaci[oó]n|disponible|estado)\b/i.test(userMessage);
  const idPropActiva = safeMetadata.propiedadSeleccionadaId || resolvePropertyIdFromHistory(history);

  if (consultaDetalleProp && idPropActiva && supabaseConfig && history[0]?.role === 'system') {
    try {
      const apiKey = supabaseConfig.service_role_key || supabaseConfig.anon_key;
      const headers = {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      };

      const { data: propRows, error: propError, table } = await fetchFromPropertyTables({
        supabaseConfig,
        headers,
        params: { select: '*', id: `eq.${idPropActiva}`, limit: 1 },
        contextTag: 'PROPERTY_DETAIL_QA'
      });

      // Limpiar bloque previo para evitar datos stale.
      history[0].content = history[0].content.replace(/\n\n---DETALLE_PROPIEDAD---[\s\S]*?---FIN_DETALLE_PROPIEDAD---/g, '');

      if (propError || !Array.isArray(propRows) || propRows.length === 0) {
        history[0].content += `\n\n---DETALLE_PROPIEDAD---\nID:${idPropActiva}\nSIN_DETALLE\nINSTRUCCIÓN: No hay datos actualizados disponibles en base de datos para esta propiedad en este momento. Decilo de forma humana y ofrecé mostrar otras opciones.\n---FIN_DETALLE_PROPIEDAD---`;
        console.log(`⚠️ No se pudo cargar detalle de propiedad ${idPropActiva}:`, propError || 'SIN_FILAS');
      } else {
        const p = propRows[0];
        const fields = {
          id: p.id,
          tipologia: p.tipologia || null,
          operacion: p.operacion || null,
          direccion: p.direccion || null,
          barrio: p.barrio || null,
          ambientes: p.ambientes ?? null,
          dormitorios: p.dormitorios ?? null,
          descripcion: p.descripcion || null,
          apto_banco: p.apto_banco ?? null,
          precio: p.precio ?? null,
          cod_zp: p.cod_zp || null,
          cod_lvi: p.cod_lvi || p.cod_lv || null,
          imagen: p.imagen || null,
          requisitos: p.requisitos || null,
          link_interno: p.link_interno || null
        };

        history[0].content +=
          `\n\n---DETALLE_PROPIEDAD---\n` +
          `TABLA:${table || 'desconocida'}\n` +
          `DATA:${JSON.stringify(fields)}\n` +
          `INSTRUCCIÓN: El usuario está consultando detalles de la propiedad seleccionada. Respondé SOLO con datos de DATA. Si un campo es null o vacío, decí que no lo tenés disponible en sistema. No inventes. Cerrá con una pregunta útil (ej: si quiere agendar).\n` +
          `---FIN_DETALLE_PROPIEDAD---`;
        console.log(`✅ Detalle de propiedad ${idPropActiva} inyectado desde DB`);
      }
    } catch (err) {
      console.error('❌ Error inyectando detalle de propiedad desde DB:', err.message);
    }
  }

  if (history.length > 30) history = [history[0], ...history.slice(1).slice(-29)];
  if (!hayPropiedadSeleccionada && (quiereCancelar || quiereReprogramar)) {
    safeMetadata.propiedadSeleccionadaId = null;
  }
  return { history: [...history, { role: 'user', content: userMessage }], metadata: safeMetadata };
}

// ─── DYNAMODB: loadHistory / saveHistory ─────────────────────────────────────

const dynamoClient = new DynamoDBClient({});
const doc = DynamoDBDocumentClient.from(dynamoClient);
const SESSIONS_TABLE = process.env.SESSIONS_TABLE;

async function loadHistory(botId, sessionId) {
  try {
    if (!SESSIONS_TABLE) return { history: [], metadata: {} };
    const res = await doc.send(new GetCommand({
      TableName: SESSIONS_TABLE,
      Key: { PK: `SESSION#${botId}`, SK: sessionId },
      ConsistentRead: true
    }));
    return {
      history: res.Item?.history || [],
      metadata: res.Item?.metadata || {}
    };
  } catch (err) {
    console.error('Error loading history:', err.message);
    return { history: [], metadata: {} };
  }
}

async function saveHistory(botId, sessionId, history, tokensUsed = 0, metadata = {}) {
  try {
    if (!SESSIONS_TABLE) return;

    const historyWithTimestamp = history.map(msg => ({
      ...msg,
      timestamp: msg.timestamp || new Date().toISOString()
    }));

    // TTL: auto-delete sessions after 30 days of inactivity
    const ttlDays = 30;
    const ttl     = Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60;

    await doc.send(new PutCommand({
      TableName: SESSIONS_TABLE,
      Item: {
        PK: `SESSION#${botId}`,
        SK: sessionId,
        history: historyWithTimestamp,
        metadata,
        ctx: metadata,   // alias used by new orchestrator sessionStore
        tokensUsed,
        updatedAt: new Date().toISOString(),
        ttl
      }
    }));
  } catch (err) {
    console.error('Error saving history:', err.message);
  }
}

async function logConversation(botId, sessionId, userMessage, botReply) {
  console.log(`[${botId}/${sessionId}] ${userMessage} → ${botReply.substring(0, 60)}...`);
}

async function sendWhatsAppReply(userNumber, reply) {
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.log(`📱 Mock WhatsApp → ${userNumber}: ${reply.substring(0, 100)}...`);
    return;
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: userNumber,
          type: 'text',
          text: { body: reply }
        })
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('WhatsApp API error:', error);
    }
  } catch (err) {
    console.error('Error enviando WhatsApp:', err.message);
  }
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

export default {
  memory,
  loadHistory,
  saveHistory,
  logConversation,
  sendWhatsAppReply,
  processReservation,
  handleImplicitConfirmation,
  buscarPropiedades,
  buscarPropiedadPorLink,    // alias de obtenerPropiedadPorCodigo (compatibilidad)
  obtenerPropiedadPorCodigo,
  guardarConsultaLink,
  buscarVisitasUsuario,
  guardarVisita,
  cancelarVisita,
  actualizarVisita,
  detectarLink,
  formatearPropiedad,
  parseFecha,
  parseHora,
  validarDatosReserva,
  formatFechaParaSupabase,
  validarHorarioVisita,
  generarContextoFechas
};
