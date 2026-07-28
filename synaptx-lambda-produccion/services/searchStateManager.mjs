// services/searchStateManager.mjs
// Canonical search state for property flows.
// Backward compatible with legacy ctx.ultimaBusqueda fields.

const DEFAULT_SEARCH_STATE = {
  operacion: null,
  tipologia: null,
  barrio: null,
  direccion: null,
  dormitorios: null,
  dormitoriosOp: 'eq',
  ambientes: null,
  banos: null,
  precioMin: null,
  precioMax: null,
  cochera: null,
  patio: null,
  pileta: null,
  aptoCredito: null,
  mascotas: null,
  superficie: null,
  pagina: 1,
  offset: 0,
  aptoBanco: null,
  presupuesto: null,
};

function _toIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
}

function _toPage(offset) {
  const off = _toIntOrNull(offset);
  if (off === null || off < 0) return 1;
  return Math.floor(off / 5) + 1;
}

function _toOffset(page) {
  const p = _toIntOrNull(page);
  if (p === null || p < 1) return 0;
  return (p - 1) * 5;
}

export function defaultSearchState() {
  return { ...DEFAULT_SEARCH_STATE };
}

export function buildSearchStateFromCtx(ctx = {}) {
  const legacy = ctx.ultimaBusqueda || {};
  const fromCtx = ctx.searchState || {};

  const merged = {
    ...DEFAULT_SEARCH_STATE,
    ...legacy,
    ...fromCtx,
  };

  if (merged.pagina == null) merged.pagina = _toPage(merged.offset);
  if (merged.offset == null) merged.offset = _toOffset(merged.pagina);

  // Compatibility: map legacy apto_banco semantics into canonical aptoCredito when absent.
  if (merged.aptoCredito == null && merged.aptoBanco != null) {
    merged.aptoCredito = merged.aptoBanco;
  }
  if (merged.aptoBanco == null && merged.aptoCredito != null) {
    merged.aptoBanco = merged.aptoCredito;
  }

  return merged;
}

export function mergeSearchState(currentState = {}, patch = {}) {
  const current = { ...DEFAULT_SEARCH_STATE, ...(currentState || {}) };
  const next = { ...current };

  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    next[k] = v;
  }

  if (patch?.pagina !== undefined && patch?.offset === undefined) {
    next.offset = _toOffset(next.pagina);
  }
  if (patch?.offset !== undefined && patch?.pagina === undefined) {
    next.pagina = _toPage(next.offset);
  }

  if (next.aptoCredito == null && next.aptoBanco != null) next.aptoCredito = next.aptoBanco;
  if (next.aptoBanco == null && next.aptoCredito != null) next.aptoBanco = next.aptoCredito;

  return next;
}

export function toLegacyUltimaBusqueda(searchState = {}) {
  const s = { ...DEFAULT_SEARCH_STATE, ...(searchState || {}) };
  return {
    operacion: s.operacion || null,
    tipologia: s.tipologia || null,
    barrio: s.barrio || '',
    direccion: s.direccion || '',
    offset: Number.isInteger(s.offset) ? s.offset : _toOffset(s.pagina),
    ambientes: s.ambientes ?? null,
    dormitorios: s.dormitorios ?? null,
    dormitoriosOp: s.dormitoriosOp || 'eq',
    aptoBanco: s.aptoBanco ?? s.aptoCredito ?? null,
    precioMax: s.precioMax ?? null,
    precioMin: s.precioMin ?? null,
    presupuesto: s.presupuesto ?? null,
  };
}
