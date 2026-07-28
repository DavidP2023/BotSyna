// services/intentSchema.mjs
// Structured intent payload helpers (backward compatible with legacy string intents).

const WORD_NUM = { uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };

function _norm(s = '') {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function _intOrNull(v) {
  const n = parseInt(String(v || ''), 10);
  return Number.isNaN(n) ? null : n;
}

function _detectOperacion(normMsg) {
  if (/alquil|arrendar|renta/.test(normMsg)) return 'alquiler';
  if (/compr|venta|vend/.test(normMsg)) return 'venta';
  return null;
}

function _detectTipologia(normMsg) {
  if (/\bdeptos?\b|\bdepartamentos?\b|\bapartamentos?\b/.test(normMsg)) return 'departamento';
  if (/\bphs?\b/.test(normMsg)) return 'ph';
  if (/\bcasas?\b/.test(normMsg)) return 'casa';
  if (/\bduplexes?\b|\bdupl[eé]x\b/.test(normMsg)) return 'duplex';
  if (/\blocales?\b/.test(normMsg)) return 'local';
  if (/\boficinas?\b/.test(normMsg)) return 'oficina';
  if (/\bcocheras?\b|\bgarages?\b|\bgarajes?\b/.test(normMsg)) return 'cochera';
  return null;
}

function _detectDormitorios(normMsg) {
  const re = /\b(\d+|uno|una|dos|tres|cuatro|cinco|seis)\s*(dormitorios?|habitaciones?|cuartos?|piezas?)\b/i;
  const m = normMsg.match(re);
  if (!m) return null;
  const raw = String(m[1] || '').toLowerCase();
  return _intOrNull(raw) ?? WORD_NUM[raw] ?? null;
}

function _detectAmbientes(normMsg) {
  const m = normMsg.match(/\b(\d+)\s*ambientes?\b/i);
  return m ? _intOrNull(m[1]) : null;
}

function _detectPresupuesto(rawMsg) {
  const txt = String(rawMsg || '');
  const max = txt.match(/hasta\s*\$?\s*([\d.]+(?:k|mil)?)/i);
  if (max) {
    const factor = /k|mil/i.test(max[1]) ? 1000 : 1;
    const n = _intOrNull(String(max[1]).replace(/\.|k|mil/gi, ''));
    return n ? { precioMax: n * factor } : null;
  }
  const only = txt.match(/^\s*\$?\s*([\d.]{4,})\s*$/i);
  if (only) {
    const n = _intOrNull(String(only[1]).replace(/\./g, ''));
    return n ? { presupuesto: n } : null;
  }
  return null;
}

function _extractSearchEntities(message = '') {
  const raw = String(message || '');
  const msg = _norm(raw);
  const entities = {};

  const operacion = _detectOperacion(msg);
  const tipologia = _detectTipologia(msg);
  const dormitorios = _detectDormitorios(msg);
  const ambientes = _detectAmbientes(msg);
  const aptoCredito = /\bapto\s*banco\b|\bcredito\s*hipotecario\b|\bhipoteca\b/i.test(msg) ? true : null;
  const presupuesto = _detectPresupuesto(raw);

  if (operacion) entities.operacion = operacion;
  if (tipologia) entities.tipologia = tipologia;
  if (dormitorios != null) entities.dormitorios = dormitorios;
  if (ambientes != null) entities.ambientes = ambientes;
  if (aptoCredito != null) entities.aptoCredito = aptoCredito;
  if (presupuesto) Object.assign(entities, presupuesto);

  return entities;
}

function _isClearFilterMessage(message = '') {
  const msg = _norm(message);
  return /\b(sin preferencia|cualquier barrio|no tengo preferencia|me da igual|no importa|indistinto)\b/.test(msg);
}

function _buildStructuredByIntent(intent, message = '') {
  const entities = _extractSearchEntities(message);

  if (intent === 'search') {
    const operations = Object.entries(entities).map(([field, value]) => ({ op: 'set', field, value }));
    if (_isClearFilterMessage(message)) operations.push({ op: 'set', field: 'barrio', value: '' });
    return { intent: 'search_property', entities, operations };
  }

  if (intent === 'more') {
    return { intent: 'paginate_results', entities: {}, operations: [{ op: 'increment_page' }] };
  }

  if (intent === 'details') {
    return { intent: 'property_details', entities: {}, operations: [] };
  }

  if (intent === 'book') {
    return { intent: 'manage_visit', entities: { action: 'reserve' }, operations: [] };
  }

  if (intent === 'cancel') {
    return { intent: 'manage_visit', entities: { action: 'cancel' }, operations: [] };
  }

  if (intent === 'reschedule') {
    return { intent: 'manage_visit', entities: { action: 'reschedule' }, operations: [] };
  }

  if (intent === 'status') {
    return { intent: 'visit_status', entities: {}, operations: [] };
  }

  if (intent === 'confirm') {
    return { intent: 'confirm', entities: {}, operations: [] };
  }

  if (intent === 'deny') {
    return { intent: 'deny', entities: {}, operations: [] };
  }

  if (intent === 'escalate') {
    return { intent: 'handoff_human', entities: {}, operations: [] };
  }

  if (intent === 'thanks') {
    return { intent: 'thanks', entities: {}, operations: [] };
  }

  if (intent === 'greeting') {
    return { intent: 'greeting', entities: {}, operations: [] };
  }

  return { intent: 'unknown', entities: {}, operations: [] };
}

export function buildStructuredIntent({ intent, message, source = 'pattern', confidence = 0.8 }) {
  return {
    source,
    confidence,
    ..._buildStructuredByIntent(intent, message),
  };
}
