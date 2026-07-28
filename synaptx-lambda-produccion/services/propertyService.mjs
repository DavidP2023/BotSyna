// services/propertyService.mjs
// Todas las operaciones sobre propiedades: búsqueda, detalle, detección de barrio y portal.
// Los barrios se cargan dinámicamente desde Supabase (tabla `barrios`) con cache por instancia.

import { SupabaseClient } from './supabaseClient.mjs';

// ─── Barrios cache (warm Lambda instances comparten este módulo) ───────────────
let _barriosCache  = null;    // string[] normalizados a minúsculas sin tildes
let _barriosCachedAt = 0;
const BARRIOS_TTL_MS = 10 * 60 * 1000; // 10 minutos

// ─── Regex helpers ────────────────────────────────────────────────────────────

const TIPOLOGIA_MAP = [
  [/\bdeptos?\b|\bdepartamentos?\b|\bapartamentos?\b/,          'departamento'],
  [/\bphs?\b/,                                                   'ph'],
  [/\bcasas?\b/,                                                 'casa'],
  [/\bduplexes?\b|\bdúplexes?\b|\bdupl[eé]x\b/,                'duplex'],
  [/\blocales?\b/,                                               'local'],
  [/\boficinas?\b/,                                              'oficina'],
  [/\bcocheras?\b|\bgarages?\b|\bgarajes?\b/,                   'cochera'],
];

// ─── Visualización dinámica de propiedades ────────────────────────────────────

// Campos técnicos/identificadores de portal: nunca se muestran en el texto al cliente.
const CAMPOS_OCULTOS_TEXTO = new Set(['id', 'cod_zp', 'cod_lvi', 'cod_lv', 'link_interno', 'imagen']);

// Campos que nunca deben llegar al LLM como referencia (identificadores internos de portal).
// `id` se mantiene porque el LLM lo necesita para el JSON de reserva.
const CAMPOS_OCULTOS_LLM = new Set(['cod_zp', 'cod_lvi', 'cod_lv', 'link_interno', 'imagen']);

// Orden preferido de los campos "cortos" (una línea). Los que no existan en el
// registro simplemente no se muestran — no hace falta tocar este array a futuro
// salvo que se quiera fijar la posición de un campo nuevo.
const ORDEN_CAMPOS = ['direccion', 'barrio', 'ambientes', 'dormitorios', 'banos', 'baños', 'superficie', 'antiguedad', 'antigüedad', 'expensas', 'precio', 'apto_banco'];

// Campos de texto largo: la etiqueta va en su propia línea y el valor abajo.
const CAMPOS_BLOQUE = new Set(['descripcion', 'requisitos', 'caracteristicas', 'características', 'observaciones']);

const ETIQUETAS_CAMPO = {
  direccion: 'Dirección', barrio: 'Barrio', ambientes: 'Ambientes', dormitorios: 'Dormitorios',
  banos: 'Baños', 'baños': 'Baños', superficie: 'Superficie', antiguedad: 'Antigüedad', 'antigüedad': 'Antigüedad',
  expensas: 'Expensas', precio: 'Precio', apto_banco: 'Apto bancario',
  descripcion: 'Descripción', requisitos: 'Requisitos',
  caracteristicas: 'Características', 'características': 'Características', observaciones: 'Observaciones',
};

function _etiquetaCampo(campo) {
  if (ETIQUETAS_CAMPO[campo]) return ETIQUETAS_CAMPO[campo];
  const s = String(campo).replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : campo;
}

function _valorVacio(v) {
  if (v === null || v === undefined) return true;
  const s = String(v).trim();
  return s === '' || /^(null|nan|n\/a|na)$/i.test(s);
}

function _normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _splitWords(value) {
  return _normalizeText(value).split(' ').filter(w => w.length >= 3);
}

function _levenshtein(a, b) {
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
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

function _isCloseWord(a, b) {
  if (!a || !b) return false;
  const maxLen = Math.max(a.length, b.length);
  const dist = _levenshtein(a, b);
  if (maxLen <= 5) return dist <= 1;
  if (maxLen <= 9) return dist <= 2;
  return dist <= 3;
}

function _direccionFuzzyMatch(inputDireccion, rowDireccion) {
  const inputWords = _splitWords(inputDireccion);
  if (inputWords.length === 0) return false;

  const rowNorm = _normalizeText(rowDireccion);
  if (!rowNorm) return false;
  if (rowNorm.includes(_normalizeText(inputDireccion))) return true;

  const rowWords = _splitWords(rowDireccion);
  if (rowWords.length === 0) return false;

  return inputWords.every(iw => rowWords.some(rw => _isCloseWord(iw, rw)));
}

// ─── Detección de links de portales ──────────────────────────────────────────

/**
 * Detecta si un mensaje contiene un link de Zonaprop o La Voz y extrae el código.
 * @param {string} mensaje
 * @returns {{ fuente: string, codigo: string, link: string } | null}
 */
export function detectarLink(mensaje) {
  if (!mensaje || typeof mensaje !== 'string') return null;

  if (/zonaprop\.com\.ar/i.test(mensaje)) {
    const urlMatch = mensaje.match(/(?:https?:\/\/)?(?:www\.)?zonaprop\.com\.ar([^\s"'#<>\]]*)/i);
    if (urlMatch) {
      const path    = urlMatch[1].split('?')[0].split('#')[0];
      const numeros = path.match(/\d{6,}/g);
      if (numeros?.length > 0) {
        const codigo = numeros[numeros.length - 1];
        return { fuente: 'zonaprop', codigo, link: `https://www.zonaprop.com.ar${urlMatch[1]}` };
      }
    }
  }

  if (/lavoz\.com\.ar/i.test(mensaje)) {
    const urlMatch = mensaje.match(/(?:https?:\/\/)?(?:(?:clasificados|www)\.)?lavoz\.com\.ar([^\s"'#<>\]]*)/i);
    if (urlMatch) {
      const path    = urlMatch[1].split('?')[0].split('#')[0];
      const numeros = path.match(/\d{5,}/g);
      if (numeros?.length > 0) {
        const codigo = numeros[numeros.length - 1];
        return { fuente: 'lavoz', codigo, link: `https://clasificados.lavoz.com.ar${urlMatch[1]}` };
      }
    }
  }

  return null;
}

// ─── PropertyService ──────────────────────────────────────────────────────────

export class PropertyService {
  /**
   * @param {object} config - tenantConfig completo (necesita config.supabase)
   */
  constructor(config) {
    this.db     = new SupabaseClient(config.supabase || config);
    this.tables = config.supabase?.property_tables || ['propiedades_v2'];
  }

  // ─── Barrios dinámicos ───────────────────────────────────────────────────

  /**
   * Carga los barrios desde Supabase con cache de 10 minutos.
   * Retorna array de nombres normalizados (sin tildes, minúsculas).
   */
  async getBarrios() {
    const now = Date.now();
    if (_barriosCache && (now - _barriosCachedAt) < BARRIOS_TTL_MS) return _barriosCache;

    try {
      const rows = await this.db.select('barrios', { select: 'nombre', order: 'nombre.asc' });
      _barriosCache    = (Array.isArray(rows) ? rows : [])
        .map(r => String(r.nombre || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
      _barriosCachedAt = now;
      console.log(`[PropertyService] barrios loaded: ${_barriosCache.length}`);
    } catch (err) {
      console.warn('[PropertyService] getBarrios DB error — using stale cache:', err.message);
    }

    return _barriosCache || [];
  }

  /**
   * Detecta el barrio mencionado en el texto del usuario.
   * @param {string} text  - Mensaje normalizado (sin tildes, minúsculas)
   * @param {string[]} barriosList
   * @returns {string|null}
   */
  detectBarrio(text, barriosList) {
    const norm = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    // Buscar de más largo a más corto para evitar matches parciales
    const sorted = [...barriosList].sort((a, b) => b.length - a.length);
    return sorted.find(b => norm.includes(b)) || null;
  }

  /**
   * Detecta la tipología de propiedad mencionada en el mensaje.
   * @param {string} norm - Mensaje normalizado
   * @returns {string|null} - 'departamento', 'casa', etc. o null
   */
  detectTipologia(norm) {
    const encontradas = [];
    for (const [re, tipo] of TIPOLOGIA_MAP) {
      if (re.test(norm) && !encontradas.includes(tipo)) encontradas.push(tipo);
    }
    if (encontradas.length === 0) return null;
    return encontradas.length === 1 ? encontradas[0] : encontradas.join(',');
  }

  /**
   * Detecta una referencia a calle/dirección en el mensaje.
   * @param {string} raw
   * @returns {string|null}
   */
  detectDireccion(raw) {
    if (!raw || typeof raw !== 'string') return null;

    // Explícito: "calle X" / "dirección X" — puede venir seguido de otra cláusula
    // ("calle San Martín en el barrio tal"), por eso se recorta ahí. "de" se excluye
    // de los cortes porque es parte habitual de nombres de calle ("9 de Julio").
    const mExplicito = raw.match(/(?:\bcalle\b|\bdireccion\b|\bdirección\b)\s+([a-z0-9áéíóúüñ.\-\s]{3,80})/i);
    if (mExplicito?.[1]) {
      let dir = String(mExplicito[1]).trim()
        .replace(/\b(en|del|para|con|y)\b.*$/i, '').trim()
        .replace(/\s+/g, ' ');
      return dir.length >= 3 ? dir : null;
    }

    // Implícito: "tenés algo en X", "hay algo en X", "mostrame propiedades sobre X" —
    // solo cuando el mensaje tiene intención de búsqueda, para evitar falsos positivos
    // en frases sueltas que también usan "en/sobre/por" sin relación a una dirección.
    // El capture queda anclado al final del mensaje, así que no hace falta recortar cláusulas.
    const tieneIntencionBusqueda = /\b(ten[eé]s|tienen|hay|busco|busc[aá]s?|mostrame|mostr[aá]|quiero\s+ver|algo)\b/i.test(raw);
    if (!tieneIntencionBusqueda) return null;

    const mImplicito = raw.match(/\b(?:en|sobre|por)\s+(?:la\s+)?(?:calle\s+|avenida\s+|av\.?\s+)?([a-zA-ZÁÉÍÓÚáéíóúÑñ0-9°ª.\-]{1,40}(?:\s+[a-zA-ZÁÉÍÓÚáéíóúÑñ0-9°ª.\-]{1,40}){0,4})\s*[?¿.!]*$/i);
    if (!mImplicito?.[1]) return null;

    const dir = String(mImplicito[1]).trim().replace(/\s+/g, ' ');

    // Descarta capturas que en realidad son referencias temporales, no direcciones.
    const RUIDO = /^(la\s+)?(tarde|ma[nñ]ana|noche|hoy|ese\s+dia|ese\s+momento|pasado\s+ma[nñ]ana|lunes|martes|miercoles|mi[eé]rcoles|jueves|viernes|sabado|s[aá]bado|domingo)$/i;
    if (RUIDO.test(dir)) return null;

    return dir.length >= 3 ? dir : null;
  }

  /**
   * Detecta si el mensaje refiere a operación de alquiler o venta.
   * @param {string} norm
   * @returns {'alquiler'|'venta'|null}
   */
  detectOperacion(norm) {
    if (/alquil|arrendar|renta/.test(norm)) return 'alquiler';
    if (/compr|venta|vend/.test(norm))      return 'venta';
    return null;
  }

  /**
   * Detecta el presupuesto / precio mencionado en el mensaje.
   * Retorna { presupuesto, precioMin, precioMax } — todos opcionalmente null.
   */
  detectPresupuesto(norm, raw) {
    // Rango explícito: "entre 200 y 400 mil", "de 200000 a 600000", "desde 250k hasta 500k"
    const rangoMatch =
      norm.match(/(?:entre|rango\s+de|desde)\s*\$?\s*([\d.]+)\s*(k|mil)?\s*(?:y|a|hasta)\s*\$?\s*([\d.]+)\s*(k|mil)?\b/i) ||
      norm.match(/\b([\d.]{3,})\s*(k|mil)?\s*(?:a|hasta)\s*([\d.]{3,})\s*(k|mil)?\b/i);

    if (rangoMatch) {
      const parse = (v, sfx) => {
        let n = parseInt(String(v || '').replace(/\./g, ''), 10);
        if (isNaN(n)) return null;
        if (/k|mil/i.test(sfx || '')) n *= 1000;
        return n > 0 ? n : null;
      };
      let lo = parse(rangoMatch[1], rangoMatch[2]);
      let hi = parse(rangoMatch[3], rangoMatch[4]);
      if (lo && hi && !rangoMatch[2] && /k|mil/i.test(rangoMatch[4] || '') && lo < 1000) lo *= 1000;
      return { presupuesto: null, precioMin: lo, precioMax: hi };
    }

    // Techo duro: "hasta X", "máximo X", "no más de X"
    const hardMax = norm.match(
      /hasta\s*(?:\$|pesos|u[sd]\$|dolares?)?\s*([\d.]+(?:k|mil)?)\b|m[aá]ximo\s*(?:\$)?\s*([\d.]+(?:k|mil)?)\b|(?:no\s+m[aá]s\s+de|tope\s*(?:de)?)\s*(?:\$)?\s*([\d.]+(?:k|mil)?)\b/
    );
    if (hardMax) {
      const rawV = (hardMax[1] || hardMax[2] || hardMax[3] || '').replace(/\./g, '');
      let v = parseInt(rawV, 10);
      if (!isNaN(v)) {
        if (/k\b|mil/i.test(hardMax[0])) v *= 1000;
        return { presupuesto: null, precioMin: null, precioMax: v > 0 ? v : null };
      }
    }

    // Presupuesto flexible: "tengo X", "cuento con X", "presupuesto X", "por X"
    const flex = norm.match(
      /presupuesto\s*(?:de\s*hasta\s*|de\s*|es\s*|hasta\s*)?(?:\$|pesos|u[sd]\$|dolares?)?\s*([\d.]+(?:k|mil)?)\b|(?:tengo|cuento\s+con)\s*(?:hasta\s*)?(?:\$|pesos|u[sd]\$|dolares?)?\s*([\d.]+(?:k|mil)+)\b|(?:tengo|cuento\s+con)\s*(?:hasta\s*)?(?:\$)?\s*(\d{5,})\b|por\s*(?:\$)?\s*([\d.]+(?:k|mil)+)\b/
    );
    if (flex) {
      const rawV = (flex[1] || flex[2] || flex[3] || flex[4] || '').replace(/\./g, '');
      let v = parseInt(rawV, 10);
      if (!isNaN(v)) {
        if (/k\b|mil/i.test(flex[0])) v *= 1000;
        return { presupuesto: v > 0 ? v : null, precioMin: null, precioMax: null };
      }
    }

    // Número suelto (ej: "70.000", "390000") — presupuesto directo
    const soloNum = raw.match(/^\s*\$?\s*([\d.,']+)\s*(?:dolares?|usd|u[sd]\$)?\s*$/i);
    if (soloNum) {
      const v = parseInt(soloNum[1].replace(/[.,]/g, ''), 10);
      if (v > 1000) return { presupuesto: v, precioMin: null, precioMax: null };
    }

    return { presupuesto: null, precioMin: null, precioMax: null };
  }

  // ─── Búsqueda ────────────────────────────────────────────────────────────

  /**
   * Busca propiedades en Supabase con los filtros dados.
   * @param {object}  filters
   * @param {string}  [filters.operacion]
   * @param {string}  [filters.tipologia]     - puede ser "departamento,casa" (CSV)
   * @param {string}  [filters.barrio]
  * @param {string}  [filters.direccion]
   * @param {number}  [filters.presupuesto]   - budget flexible (±45 % si no hay resultados exactos)
   * @param {number}  [filters.precioMin]
   * @param {number}  [filters.precioMax]
   * @param {number}  [filters.ambientes]
   * @param {number}  [filters.dormitorios]
   * @param {string}  [filters.dormitoriosOp] - 'eq' | 'gte'
   * @param {boolean} [filters.aptoBanco]
   * @param {number}  [filters.offset]
   * @param {number}  [filters.limit]
   * @returns {Promise<{ props: object[], expanded: boolean }>}
   */
  async search(filters = {}) {
    const { offset = 0, limit = 5 } = filters;

    const raw = await this._queryAll(filters);

    if (raw.length === 0 && filters.presupuesto && offset === 0) {
      // Fallback con rango ampliado ±45 %
      const fbMin = Math.round(filters.presupuesto * 0.55);
      const fbMax = Math.round(filters.presupuesto * 1.45);
      const fb = await this._queryAll({ ...filters, presupuesto: null, precioMin: fbMin, precioMax: fbMax });
      return { props: fb.slice(offset, offset + limit), expanded: fb.length > 0, total: fb.length };
    }

    return { props: raw.slice(offset, offset + limit), expanded: false, total: raw.length };
  }

  /** Ejecuta la query en todas las tablas configuradas y devuelve array deduplicado. */
  async _queryAll(filters) {
    const { operacion, tipologia, barrio, direccion, presupuesto, precioMin, precioMax, ambientes, dormitorios, dormitoriosOp, aptoBanco } = filters;

    const results = [];
    for (const table of this.tables) {
      try {
        // order: 'id.asc' es obligatorio — sin ORDER BY explícito, PostgREST/Postgres
        // no garantiza el mismo orden de filas entre ejecuciones idénticas de la
        // misma query, lo que hacía que "opción 2" pudiera referirse a una propiedad
        // distinta si la búsqueda se repetía (ej. al re-listar tras un refresco de
        // contexto). Con orden estable, "opción N" es siempre la misma fila.
        const params = { select: '*', order: 'id.asc', limit: 300 };

        if (operacion) params['operacion'] = `ilike.${operacion}`;
        if (barrio)    params['barrio']    = `ilike.%${barrio}%`;
        if (direccion) params['direccion'] = `ilike.%${direccion}%`;
        if (ambientes) params['ambientes'] = `eq.${ambientes}`;
        if (dormitorios) {
          const op = dormitoriosOp === 'gte' ? 'gte' : 'eq';
          params['dormitorios'] = `${op}.${dormitorios}`;
        }
        if (aptoBanco) params['apto_banco'] = 'eq.true';

        let rows = await this.db.select(table, params);
        if (!Array.isArray(rows)) rows = [];

        if (direccion && rows.length === 0) {
          const relaxedParams = { ...params };
          delete relaxedParams['direccion'];
          let relaxedRows = await this.db.select(table, relaxedParams);
          if (!Array.isArray(relaxedRows)) relaxedRows = [];

          // Fallback: además de la dirección, revisar barrio/descripción (texto libre,
          // sin acentos, parcial) y ordenar lo encontrado por relevancia.
          const dirNorm = _normalizeText(direccion);
          const _puntaje = (p) => {
            let score = 0;
            if (_direccionFuzzyMatch(direccion, p?.direccion || '')) {
              score += _normalizeText(p?.direccion || '').includes(dirNorm) ? 3 : 2;
            }
            if (dirNorm && _normalizeText(p?.barrio || '').includes(dirNorm)) score += 1;
            if (dirNorm && _normalizeText(p?.descripcion || '').includes(dirNorm)) score += 1;
            return score;
          };

          rows = relaxedRows
            .map(p => ({ p, score: _puntaje(p) }))
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score)
            .map(({ p }) => p);
        }

        // Tipología (puede ser CSV, ej. "departamento,casa")
        if (tipologia) {
          const tipos = tipologia.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
          rows = rows.filter(p => tipos.some(t => (p.tipologia || '').toLowerCase().includes(t)));
        }

        // Precio (columna TEXT → filtro en JS)
        const lo = precioMin || null;
        const hi = precioMax || presupuesto || null;
        if (lo || hi) {
          rows = rows.filter(p => {
            const price = parseInt(String(p.precio || '').replace(/[^0-9]/g, ''), 10);
            if (!price || price <= 0) return false;
            if (lo && price < lo) return false;
            if (hi && price > hi) return false;
            return true;
          });
        }

        results.push(...rows);
      } catch (err) {
        console.error(`[PropertyService] search error on table "${table}":`, err.message);
      }
    }

    // Deduplicar por id
    const seen = new Set();
    return results.filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }

  /**
   * Obtiene una propiedad por ID.
   * @param {number|string} id
   * @returns {Promise<object|null>}
   */
  async getById(id) {
    for (const table of this.tables) {
      try {
        const rows = await this.db.select(table, { select: '*', id: `eq.${id}`, limit: 1 });
        if (Array.isArray(rows) && rows.length > 0) return rows[0];
      } catch (err) {
        console.warn(`[PropertyService] getById(${id}) on "${table}":`, err.message);
      }
    }
    return null;
  }

  /**
   * Busca una propiedad por código de portal (Zonaprop / La Voz).
   * @param {'zonaprop'|'lavoz'} portal
   * @param {string} codigo
   * @returns {Promise<object|null>}
   */
  async searchByPortalCode(portal, codigo) {
    const cols = portal === 'zonaprop' ? ['cod_zp'] : ['cod_lvi', 'cod_lv'];
    for (const table of this.tables) {
      for (const col of cols) {
        try {
          const rows = await this.db.select(table, { select: '*', [col]: `eq.${codigo}`, limit: 1 });
          if (Array.isArray(rows) && rows.length > 0) return rows[0];
        } catch { /* intenta siguiente columna */ }
      }
    }
    return null;
  }

  // ─── Formato para el LLM ──────────────────────────────────────────────────

  /**
   * Formatea una propiedad en texto plano, profesional y dinámico: muestra todos los
   * campos con información real disponible en el registro (excepto los técnicos),
   * en el orden Propiedad/Operación/Dirección/Barrio/.../Precio/Apto bancario,
   * luego Descripción y Requisitos, luego cualquier otro campo no contemplado
   * (a prueba de futuro: nuevas columnas se incluyen automáticamente), y por
   * último el link. Sin emojis ni iconos.
   * @param {object} prop
   * @param {number} index  - Número de opción (1, 2, …)
   * @param {number} total  - cantidad total de propiedades en la tanda
   * @returns {string}
   */
  format(prop, index, total = 2) {
    if (!prop) return '';

    const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
    const lineas = [];

    if (Number(total) > 1) lineas.push(`Opción ${index}`, '');

    const tipologia = String(prop.tipologia || '').trim();
    const operacion = String(prop.operacion || '').trim();
    if (tipologia) lineas.push(`Propiedad: ${cap(tipologia)}`);
    if (operacion) lineas.push(`Operación: ${cap(operacion)}`);

    const yaRenderizados = new Set(['tipologia', 'operacion', ...CAMPOS_OCULTOS_TEXTO]);

    for (const campo of ORDEN_CAMPOS) {
      yaRenderizados.add(campo);
      if (campo === 'precio') {
        const rawPrecio = parseInt(String(prop.precio || '').replace(/[^0-9]/g, ''), 10);
        if (rawPrecio > 0) lineas.push(`Precio: $${rawPrecio.toLocaleString('es-AR')}`);
        continue;
      }
      if (campo === 'apto_banco') {
        if (!_valorVacio(prop.apto_banco)) {
          const esApto = prop.apto_banco === true || prop.apto_banco === 1 || prop.apto_banco === '1'
            || /^(si|sí|true)$/i.test(String(prop.apto_banco));
          lineas.push(`Apto bancario: ${esApto ? 'Sí' : 'No'}`);
        }
        continue;
      }
      if (!_valorVacio(prop[campo])) lineas.push(`${_etiquetaCampo(campo)}: ${prop[campo]}`);
    }

    for (const campo of ['descripcion', 'requisitos']) {
      yaRenderizados.add(campo);
      const v = String(prop[campo] || '').trim();
      if (v) lineas.push('', `${_etiquetaCampo(campo)}:`, v);
    }

    // Cualquier otro campo con información real, no contemplado arriba (a prueba de futuro).
    for (const [campo, valor] of Object.entries(prop)) {
      if (yaRenderizados.has(campo) || CAMPOS_OCULTOS_TEXTO.has(campo) || _valorVacio(valor)) continue;
      yaRenderizados.add(campo);
      if (CAMPOS_BLOQUE.has(campo)) lineas.push('', `${_etiquetaCampo(campo)}:`, String(valor).trim());
      else lineas.push(`${_etiquetaCampo(campo)}: ${valor}`);
    }

    const linkRaw = String(prop.link_interno || prop.imagen || '').trim();
    if (linkRaw) lineas.push('', 'Más información:', linkRaw);

    return lineas.join('\n');
  }

  /**
   * Devuelve los campos de una propiedad listos para pasarle al LLM como referencia
   * (PASO 8 / detalle), excluyendo siempre los identificadores internos de portal
   * (cod_zp, cod_lvi) e incluyendo un campo `link` ya resuelto. Dinámico: cualquier
   * columna nueva de la tabla se incluye automáticamente sin tocar este método.
   * @param {object} prop
   * @returns {object|null}
   */
  toLLMFields(prop) {
    if (!prop) return null;
    const out = {};
    for (const [campo, valor] of Object.entries(prop)) {
      if (CAMPOS_OCULTOS_LLM.has(campo)) continue;
      out[campo] = valor;
    }
    out.link = String(prop.link_interno || prop.imagen || '').trim() || null;
    return out;
  }
}
