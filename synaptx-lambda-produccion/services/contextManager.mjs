// services/contextManager.mjs
// Centralized context normalization with backward compatibility.

import {
  buildSearchStateFromCtx,
  mergeSearchState,
  toLegacyUltimaBusqueda,
} from './searchStateManager.mjs';

function _idResultsToObjects(ids = []) {
  return (Array.isArray(ids) ? ids : [])
    .map(id => ({ id }))
    .filter(x => x.id !== null && x.id !== undefined);
}

function _resultsToIds(results = []) {
  return (Array.isArray(results) ? results : [])
    .map(r => (r && r.id !== undefined ? r.id : null))
    .filter(id => id !== null && id !== undefined);
}

export function normalizeContext(ctx = {}) {
  const base = { ...(ctx || {}) };
  const searchState = buildSearchStateFromCtx(base);

  const selectedProperty = base.selectedProperty
    || (base.propiedadSeleccionadaId ? { id: base.propiedadSeleccionadaId } : null);

  const lastResults = Array.isArray(base.lastResults)
    ? base.lastResults
    : _idResultsToObjects(base.idsPropiedadesMostradas || []);

  const normalized = {
    ...base,
    searchState,
    selectedProperty,
    lastResults,
    lastIntent: base.lastIntent || null,
    pendingAction: base.pendingAction || null,
  };

  return withLegacyCompatibility(normalized);
}

export function withLegacyCompatibility(ctx = {}) {
  const out = { ...(ctx || {}) };
  const searchState = buildSearchStateFromCtx(out);

  out.searchState = searchState;
  out.ultimaBusqueda = toLegacyUltimaBusqueda(searchState);

  const selectedId = out.selectedProperty?.id || null;
  out.propiedadSeleccionadaId = selectedId;

  const ids = _resultsToIds(out.lastResults);
  if (ids.length > 0 || Array.isArray(out.idsPropiedadesMostradas)) {
    out.idsPropiedadesMostradas = ids;
    out.propiedadesMostradas = ids;
  }

  return out;
}

export function applySearchStatePatch(ctx = {}, patch = {}) {
  const norm = normalizeContext(ctx);
  norm.searchState = mergeSearchState(norm.searchState, patch);
  norm.ultimaBusqueda = toLegacyUltimaBusqueda(norm.searchState);
  return withLegacyCompatibility(norm);
}

export function applyPropertyPluginMetadata(ctx = {}, md = {}) {
  const norm = normalizeContext(ctx);

  const selectedId = md?.propiedadSeleccionadaId ?? norm.selectedProperty?.id ?? null;
  norm.selectedProperty = selectedId ? { id: selectedId } : null;

  if (Array.isArray(md?.lastResults)) {
    norm.lastResults = md.lastResults;
  } else if (Array.isArray(md?.idsPropiedadesMostradas)) {
    norm.lastResults = _idResultsToObjects(md.idsPropiedadesMostradas);
  }

  if (md?.ultimaBusqueda && typeof md.ultimaBusqueda === 'object') {
    norm.searchState = mergeSearchState(norm.searchState, md.ultimaBusqueda);
  }

  norm.pendingAction = md?.pendingAction ?? norm.pendingAction ?? null;

  const merged = { ...norm, ...(md || {}) };
  return withLegacyCompatibility(merged);
}
