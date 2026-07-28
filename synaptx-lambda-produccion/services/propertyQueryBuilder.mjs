// services/propertyQueryBuilder.mjs
// Translates structured intent payload into deterministic property filter hints.

function _intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
}

export function extractPropertyFiltersFromStructuredIntent(structuredIntent = null) {
  const out = {
    operacion: null,
    tipologia: null,
    barrio: null,
    direccion: null,
    ambientes: null,
    dormitorios: null,
    aptoBanco: null,
    precioMin: null,
    precioMax: null,
    presupuesto: null,
    pideMas: false,
    clearBarrio: false,
  };

  if (!structuredIntent || typeof structuredIntent !== 'object') return out;

  const intent = String(structuredIntent.intent || '').toLowerCase();
  const entities = structuredIntent.entities || {};
  const ops = Array.isArray(structuredIntent.operations) ? structuredIntent.operations : [];

  if (intent === 'paginate_results') out.pideMas = true;

  if (entities.operacion) out.operacion = String(entities.operacion).toLowerCase();
  if (entities.tipologia) out.tipologia = String(entities.tipologia).toLowerCase();
  if (entities.barrio !== undefined) out.barrio = entities.barrio;
  if (entities.direccion !== undefined) out.direccion = entities.direccion;
  if (entities.ambientes !== undefined) out.ambientes = _intOrNull(entities.ambientes);
  if (entities.dormitorios !== undefined) out.dormitorios = _intOrNull(entities.dormitorios);
  if (entities.aptoCredito !== undefined) out.aptoBanco = Boolean(entities.aptoCredito);
  if (entities.aptoBanco !== undefined) out.aptoBanco = Boolean(entities.aptoBanco);
  if (entities.precioMin !== undefined) out.precioMin = _intOrNull(entities.precioMin);
  if (entities.precioMax !== undefined) out.precioMax = _intOrNull(entities.precioMax);
  if (entities.presupuesto !== undefined) out.presupuesto = _intOrNull(entities.presupuesto);

  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    const field = String(op.field || '').trim();
    if (op.op === 'increment_page') out.pideMas = true;
    if (op.op === 'set' && field === 'barrio' && String(op.value || '').trim() === '') {
      out.clearBarrio = true;
      out.barrio = '';
    }
  }

  return out;
}
