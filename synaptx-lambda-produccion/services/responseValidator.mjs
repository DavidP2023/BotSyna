// services/responseValidator.mjs
// Lightweight pre-send validator to reduce hallucinated factual details.

function _normalizeUrl(u = '') {
  return String(u || '').trim().replace(/\/$/, '').toLowerCase();
}

function _normalizeText(v = '') {
  return String(v || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _collectAllowedPropertyIds(ctx = {}) {
  const ids = new Set();

  const selected = ctx.selectedProperty?.id ?? ctx.propiedadSeleccionadaId;
  if (selected !== null && selected !== undefined && String(selected).trim() !== '') {
    ids.add(String(selected));
  }

  for (const id of (Array.isArray(ctx.idsPropiedadesMostradas) ? ctx.idsPropiedadesMostradas : [])) {
    if (id !== null && id !== undefined) ids.add(String(id));
  }

  for (const item of (Array.isArray(ctx.lastResults) ? ctx.lastResults : [])) {
    if (item && item.id !== undefined && item.id !== null) ids.add(String(item.id));
  }

  return ids;
}

function _collectAllowedLinks(ctx = {}) {
  const links = new Set();
  const single = ctx.materialLinkActivo;
  if (single && String(single).trim()) links.add(_normalizeUrl(single));
  for (const item of (Array.isArray(ctx.lastResults) ? ctx.lastResults : [])) {
    if (item?.link && String(item.link).trim()) links.add(_normalizeUrl(item.link));
  }
  return links;
}

function _collectAllowedPrices(ctx = {}) {
  const prices = new Set();
  for (const item of (Array.isArray(ctx.lastResults) ? ctx.lastResults : [])) {
    const p = parseInt(String(item?.precio ?? '').replace(/[^0-9]/g, ''), 10);
    if (!Number.isNaN(p) && p > 0) prices.add(String(p));
  }
  return prices;
}

function _collectAllowedDirections(ctx = {}) {
  const dirs = new Set();
  for (const item of (Array.isArray(ctx.lastResults) ? ctx.lastResults : [])) {
    const d = _normalizeText(item?.direccion || '');
    if (d) dirs.add(d);
  }
  return dirs;
}

function _extractUrls(text = '') {
  return (String(text).match(/https?:\/\/[^\s)\]}"']+/gi) || []).map(_normalizeUrl);
}

function _extractPropertyIdsMentioned(text = '') {
  const src = String(text || '');
  const matches = [
    ...src.matchAll(/(?:id\s*(?:interno)?\s*[:#]?\s*|propiedad\s*#?\s*)(\d{1,8})/gi),
  ];
  return matches.map(m => String(m[1]));
}

function _extractExplicitPricesMentioned(text = '') {
  const raw = String(text || '');
  if (!/precio|vale|cuesta/i.test(raw)) return [];
  const nums = [...raw.matchAll(/\$\s*([\d.]{3,})/g)].map(m => String(m[1]).replace(/\./g, ''));
  return nums.filter(Boolean);
}

function _extractExplicitDirectionsMentioned(text = '') {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (const ln of lines) {
    const m = ln.match(/^\s*direcci[oó]n\s*:\s*(.+)$/i);
    if (m?.[1]) out.push(_normalizeText(m[1]));
  }
  return out;
}

function _buildFallback(ctx = {}) {
  const selected = ctx.selectedProperty?.id ?? ctx.propiedadSeleccionadaId ?? null;
  const ids = Array.isArray(ctx.idsPropiedadesMostradas) ? ctx.idsPropiedadesMostradas : [];

  if (ctx.materialLinkActivo) {
    return `Más información:\n${ctx.materialLinkActivo}`;
  }

  if (selected) {
    return `Para evitar errores, te confirmo solo datos verificados. Tengo seleccionada la propiedad ID ${selected}. Si querés, te comparto detalles puntuales o coordinamos una visita.`;
  }

  if (ids.length > 0) {
    return 'Para evitar errores, prefiero confirmar los datos exactos de la propiedad. ¿Querés que te muestre nuevamente las opciones disponibles?';
  }

  return 'Para evitar errores, prefiero confirmar los datos exactos antes de responderte. Si querés, te muestro opciones actualizadas con información verificada.';
}

export function validateAndRepairResponse({ reply, ctx }) {
  const text = String(reply || '').trim();
  if (!text) return { reply: text, blocked: false, reasons: [] };

  const reasons = [];
  const allowedIds = _collectAllowedPropertyIds(ctx || {});
  const allowedLinks = _collectAllowedLinks(ctx || {});
  const allowedPrices = _collectAllowedPrices(ctx || {});
  const allowedDirections = _collectAllowedDirections(ctx || {});

  const mentionedIds = _extractPropertyIdsMentioned(text);
  if (mentionedIds.length > 0 && allowedIds.size > 0) {
    const invalid = mentionedIds.filter(id => !allowedIds.has(String(id)));
    if (invalid.length > 0) reasons.push(`property_id_not_allowed:${invalid.join(',')}`);
  }

  const urls = _extractUrls(text);
  if (urls.length > 0 && allowedLinks.size > 0) {
    const invalid = urls.filter(u => !allowedLinks.has(u));
    if (invalid.length > 0) reasons.push('link_not_allowed');
  }

  const prices = _extractExplicitPricesMentioned(text);
  if (prices.length > 0 && allowedPrices.size > 0) {
    const invalid = prices.filter(p => !allowedPrices.has(String(parseInt(p, 10))));
    if (invalid.length > 0) reasons.push(`price_not_allowed:${invalid.join(',')}`);
  }

  const dirs = _extractExplicitDirectionsMentioned(text);
  if (dirs.length > 0 && allowedDirections.size > 0) {
    const invalid = dirs.filter(d => !allowedDirections.has(d));
    if (invalid.length > 0) reasons.push('direction_not_allowed');
  }

  if (reasons.length === 0) {
    return { reply: text, blocked: false, reasons: [] };
  }

  return {
    reply: _buildFallback(ctx || {}),
    blocked: true,
    reasons,
  };
}
