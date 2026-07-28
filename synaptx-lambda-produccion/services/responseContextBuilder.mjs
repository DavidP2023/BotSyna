// services/responseContextBuilder.mjs
// Builds deterministic backend facts for LLM response generation.

function _pick(obj = {}, keys = []) {
  const out = {};
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function _resultIds(lastResults) {
  if (!Array.isArray(lastResults)) return [];
  return lastResults
    .map(r => (r && r.id !== undefined ? r.id : null))
    .filter(id => id !== null && id !== undefined);
}

function _compactResults(lastResults = [], max = 5) {
  if (!Array.isArray(lastResults)) return [];
  return lastResults
    .slice(0, max)
    .map(r => _pick(r || {}, [
      'id',
      'direccion',
      'barrio',
      'tipologia',
      'operacion',
      'ambientes',
      'dormitorios',
      'precio',
      'link',
    ]));
}

function _selectedPropertyFacts(selectedProperty, compactResults = []) {
  const selectedId = selectedProperty?.id;
  if (!selectedId) return null;
  const byId = compactResults.find(r => String(r?.id) === String(selectedId));
  return byId || { id: selectedId };
}

export function buildResponseContextBlock({ message, ctx }) {
  const safeCtx = ctx || {};
  const compactResults = _compactResults(safeCtx.lastResults || []);
  const selectedProperty = safeCtx.selectedProperty || (safeCtx.propiedadSeleccionadaId ? { id: safeCtx.propiedadSeleccionadaId } : null);
  const facts = {
    user_question: String(message || ''),
    selectedProperty,
    selectedPropertyFacts: _selectedPropertyFacts(selectedProperty, compactResults),
    lastResultsIds: _resultIds(safeCtx.lastResults || []),
    lastResults: compactResults,
    lastIntent: safeCtx.lastIntent || null,
    pendingAction: safeCtx.pendingAction || null,
    searchState: _pick(safeCtx.searchState || safeCtx.ultimaBusqueda || {}, [
      'operacion',
      'tipologia',
      'barrio',
      'direccion',
      'dormitorios',
      'ambientes',
      'precioMin',
      'precioMax',
      'presupuesto',
      'pagina',
      'offset',
      'aptoCredito',
      'aptoBanco',
    ]),
  };

  return [
    '---DATA_BACKEND---',
    JSON.stringify(facts),
    'INSTRUCCION: Respondé usando solo hechos de DATA_BACKEND y del bloque de propiedades inyectado por backend en el system prompt.',
    'INSTRUCCION: Si falta un dato, decilo y pedilo; no inventes propiedades, precios, links, direcciones ni IDs.',
    '---FIN_DATA_BACKEND---',
  ].join('\n');
}
