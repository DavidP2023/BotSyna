// plugins/propertyPlugin.mjs — Autonomous real estate plugin.
// Uses PropertyService + VisitService directly. No delegation to functions.mjs monolith.

import { BasePlugin }    from './basePlugin.mjs';
import { PropertyService, detectarLink } from '../services/propertyService.mjs';
import { VisitService }  from '../services/visitService.mjs';
import { normalizeContext, applyPropertyPluginMetadata } from '../services/contextManager.mjs';
import { buildStructuredIntent } from '../services/intentSchema.mjs';
import { extractPropertyFiltersFromStructuredIntent } from '../services/propertyQueryBuilder.mjs';

const CONSULTA_DETALLE_RE = /\b(detalles?|direccion|precio|valor|cuanto|expensas|barrio|ambientes|dormitorios|apto\s*banco|requisitos|im[aá]gen(?:es)?|link|enlace|ubicacion|disponible|estado|fotos?|videos?|galer[ií]a|recorrido(?:\s+virtual)?|publicaci[oó]n|aviso|informaci[oó]n)\b/i;

// Subconjunto de CONSULTA_DETALLE_RE específico para pedidos de material (fotos/video/link/etc.),
// sin las palabras de datos estructurados (precio, dirección, ambientes, etc.).
const PIDE_MATERIAL_RE = /\b(im[aá]gen(?:es)?|link|enlace|fotos?|videos?|galer[ií]a|recorrido(?:\s+virtual)?|publicaci[oó]n|aviso|informaci[oó]n)\b/i;

// Vencimiento del contexto de búsqueda/selección de propiedad por inactividad.
// Evita que una búsqueda de hace varios días (precios/disponibilidad desactualizados) se reuse indefinidamente.
const BUSQUEDA_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas

const INTENT_PATTERNS = {
  search:     [/buscar|quiero\s*ver|mostr[aá]|ten[eé]s\s*(algo|propiedades|departamentos|casas)|hay\s*.*(disponible|en\s*venta|en\s*alquiler)|busco\s*(depto|departamento|casa|local|ph|duplex|terreno|oficina)/i],
  book:       [/reservar|agendar|quiero\s*(visitar|ver\s*el|ir\s*a|coordinar)|hacer\s*(una\s*)?visita|visita\s*para/i],
  cancel:     [/cancelar\s*(visita|reserva)|anular\s*visita|no\s*(voy|puedo\s*ir)\s*(a\s*la)?\s*visita|borr[aá]\s*(la\s*)?visita/i],
  reschedule: [/cambiar\s*(la\s*)?visita|reprogramar|mover\s*(la\s*)?visita|otro\s*d[ií]a\s*para\s*(la\s*)?visita/i],
  status:     [/mis\s*visitas|tengo\s*visita|visita\s*agendada|ver\s*mis\s*visitas/i],
  more:       [/m[aá]s\s*(opciones|propiedades)|ver\s*m[aá]s|otras\s*propiedades|siguiente/i],
};

// ─── Utility helpers ──────────────────────────────────────────────────────────

function _norm(str) {
  return String(str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function _trim(history, max = 30) {
  if (history.length <= max) return history;
  return [history[0], ...history.slice(1).slice(-(max - 1))];
}

function _snapshotPropForCtx(prop) {
  if (!prop || typeof prop !== 'object') return null;
  const precio = parseInt(String(prop.precio || '').replace(/[^0-9]/g, ''), 10);
  return {
    id: prop.id,
    direccion: prop.direccion || null,
    barrio: prop.barrio || null,
    tipologia: prop.tipologia || null,
    operacion: prop.operacion || null,
    ambientes: prop.ambientes ?? null,
    dormitorios: prop.dormitorios ?? null,
    precio: Number.isNaN(precio) ? null : precio,
    link: String(prop.link_interno || prop.imagen || '').trim() || null,
  };
}

function _upsertFiltro(prompt, key, value) {
  const tag = `FILTRO_${key}:`;
  if (prompt.includes(tag)) return prompt.replace(new RegExp(`${tag}[^\\n]*`), `${tag}${value}`);
  return `${prompt}\n${tag}${value}`;
}

function _resolvePropertyIdFromHistory(history = []) {
  const m = (history[0]?.content || '').match(/PROPIEDAD_SELECCIONADA_ID:(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function _extractActionJSON(text) {
  const s = String(text || '');
  const actionRe = /"action"\s*:\s*"(?:reserve|update_visit|cancel_visit)"/;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '{') {
      let depth = 0, j = i;
      while (j < s.length) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') { depth--; if (depth === 0) break; }
        j++;
      }
      const candidate = s.slice(i, j + 1);
      if (actionRe.test(candidate)) {
        try { return JSON.parse(candidate); } catch { i++; continue; }
      }
    }
    i++;
  }
  return null;
}

function _isConfirmacion(msg = '') {
  const m = _norm(msg).replace(/[.!?,;:]+$/g, '').replace(/\s+/g, ' ');
  return /^(si|s|dale|ok|okay|confirmo|confirmado|de una|perfecto|listo|hagamoslo|hacelo|procede|proceda|claro|va|sale|bueno|exacto)$/.test(m)
    || /\b(si|dale|ok|confirmo|confirmado|procede)\b/.test(m);
}

function _isRechazo(msg = '') {
  return /^(no|nope|nel|para|cancela|cancelar|no gracias|no quiero|no por ahora)$/i.test(_norm(msg).trim());
}

const MENSAJE_CONFIRMACION_ASESOR = 'Gracias por su solicitud,  quedo agendada. Un asesor se comunicará con usted para confirmar la visita.';

// ─── Text extraction helpers ──────────────────────────────────────────────────

function _extractTelefono(text = '', sessionId = '') {
  const chunks = String(text).match(/\d{8,15}/g) || [];
  if (chunks.length > 0) return chunks.sort((a, b) => b.length - a.length)[0];
  const sid = String(sessionId || '').replace(/\D/g, '');
  return sid.length >= 8 ? sid : null;
}

function _extractHora(text = '') {
  const aLas = String(text).match(/a\s+las\s+(\d{1,2})(?::(\d{2}))?\s*(?:hs?|h)?/i);
  if (aLas) {
    return `${String(parseInt(aLas[1], 10)).padStart(2, '0')}:${String(parseInt(aLas[2] || '0', 10)).padStart(2, '0')}`;
  }
  const hhmm = String(text).match(/\b(\d{1,2}):(\d{2})\b/);
  if (hhmm) {
    return `${String(parseInt(hhmm[1], 10)).padStart(2, '0')}:${String(parseInt(hhmm[2], 10)).padStart(2, '0')}`;
  }
  return null;
}

function _extractFecha(text = '') {
  const t = _norm(text);

  if (/\bpasado\s+ma[nñ]ana\b/.test(t)) {
    const d = new Date(); d.setDate(d.getDate() + 2);
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  }
  if (/\bma[nñ]ana\b/.test(t)) {
    const d = new Date(); d.setDate(d.getDate() + 1);
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const ddmm = text.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (ddmm) {
    const dd = String(parseInt(ddmm[1], 10)).padStart(2, '0');
    const mm = String(parseInt(ddmm[2], 10)).padStart(2, '0');
    const yyyy = ddmm[3] ? String(parseInt(ddmm[3], 10)).padStart(4, '20') : String(new Date().getFullYear());
    return `${dd}/${mm}/${yyyy}`;
  }

  // YYYY-MM-DD (ISO — common in LLM output)
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;

  const MESES = { enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6, julio:7, agosto:8, septiembre:9, setiembre:9, octubre:10, noviembre:11, diciembre:12 };
  const conMes = t.match(/\b(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?\b/);
  if (conMes && MESES[conMes[2]]) {
    return `${String(parseInt(conMes[1], 10)).padStart(2,'0')}/${String(MESES[conMes[2]]).padStart(2,'0')}/${conMes[3] || String(new Date().getFullYear())}`;
  }

  // "viernes 22", "el lunes 15" — weekday + day number
  const DIAS = { lunes:1, martes:2, miercoles:3, miércoles:3, jueves:4, viernes:5, sabado:6, sábado:6, domingo:0 };
  const conDiaSemana = t.match(/\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\s+(\d{1,2})\b/);
  if (conDiaSemana) {
    const targetDow = DIAS[conDiaSemana[1]];
    const targetDay = parseInt(conDiaSemana[2], 10);
    const now = new Date();
    for (let i = 0; i <= 60; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      if (d.getDate() === targetDay && d.getDay() === targetDow) {
        return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
      }
    }
    // Fallback: trust weekday name — find next occurrence of that day of week
    for (let i = 0; i <= 14; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      if (d.getDay() === targetDow) {
        return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
      }
    }
  }

  // "próximo viernes", "este martes", "el viernes" (sin número) o solo "viernes" —
  // todas se resuelven igual: la próxima ocurrencia de ese día a partir de mañana.
  const proxDia = t.match(/\b(?:pr[oó]ximo|siguiente|este|el)?\s*(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/);
  if (proxDia) {
    const targetDow = DIAS[proxDia[1]];
    if (targetDow !== undefined) {
      const now = new Date();
      for (let i = 1; i <= 7; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        if (d.getDay() === targetDow) {
          return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
        }
      }
    }
  }

  // "para el dia X", "el X", "dia X"
  const soloDia = t.match(/(?:para\s+el\s+dia|dia|fecha|el)\s+(\d{1,2})\b/);
  if (soloDia) {
    const now = new Date();
    let day = parseInt(soloDia[1], 10);
    let month = now.getMonth() + 1;
    let year = now.getFullYear();
    if (day < now.getDate()) { month += 1; if (month > 12) { month = 1; year += 1; } }
    return `${String(day).padStart(2,'0')}/${String(month).padStart(2,'0')}/${year}`;
  }

  return null;
}

function _extractNombre(text = '', fallback = 'Cliente') {
  const t = String(text).trim();
  if (!t) return fallback;
  const byComma = t.split(',')[0].trim();
  if (/^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]{3,60}$/.test(byComma)) return byComma;
  const soy = t.match(/\b(?:soy|me llamo)\s+([a-zA-ZáéíóúÁÉÍÓÚñÑ\s]{3,60})/i);
  if (soy?.[1]) return soy[1].trim();
  return fallback;
}

// ─── Inference helpers ────────────────────────────────────────────────────────

function _inferirReservaDesdeHistorial({ history, sessionId, ctx }) {
  const idPropiedad = ctx.propiedadSeleccionadaId || _resolvePropertyIdFromHistory(history);
  if (!idPropiedad) return null;
  const userMsgs = history.filter(m => m.role === 'user').map(m => String(m.content || ''));
  for (let i = userMsgs.length - 1; i >= 0; i--) {
    const t = userMsgs[i];
    const tel = _extractTelefono(t, sessionId);
    const fecha = _extractFecha(t);
    const hora = _extractHora(t);
    if (tel && (fecha || hora)) {
      return { id_propiedad: parseInt(String(idPropiedad), 10), nombre: _extractNombre(t), telefono: tel, fecha: fecha || null, hora: hora || null };
    }
  }
  return null;
}

function _inferirModificacionDesdeHistorial({ history, ctx }) {
  const idVisit = parseInt(String(ctx.visitaSeleccionadaId || ''), 10);
  if (!idVisit) return null;
  const userMsgs = history.filter(m => m.role === 'user').map(m => String(m.content || '')).filter(Boolean);
  if (!/modificar|cambiar|reprogram|mover|pasar|nueva fecha|nuevo horario/i.test(_norm(userMsgs.slice(-6).join(' ')))) return null;
  let fecha = null, hora = null;
  for (let i = userMsgs.length - 1; i >= Math.max(0, userMsgs.length - 6); i--) {
    if (!fecha) fecha = _extractFecha(userMsgs[i]);
    if (!hora)  hora  = _extractHora(userMsgs[i]);
    if (fecha && hora) break;
  }
  const updateData = {};
  if (fecha) updateData.fecha = fecha;
  if (hora)  updateData.hora  = hora;
  if (!Object.keys(updateData).length) return null;
  return { id: idVisit, updateData };
}

function _inferirCancelacionDesdeHistorial({ history, ctx }) {
  const idVisit = parseInt(String(ctx.visitaSeleccionadaId || ''), 10)
    || (Array.isArray(ctx.visitasMostradas) && ctx.visitasMostradas.length === 1
      ? parseInt(String(ctx.visitasMostradas[0] || ''), 10) : 0);
  if (!idVisit) return null;
  const userMsgs = history.filter(m => m.role === 'user').map(m => _norm(m.content || '')).filter(Boolean).slice(-8);
  const reCancel = /\b(cancelar|cancela|cancele|cancelalo|anular|anula|dar de baja)\b/;
  const reUpdate = /\b(modificar|modifica|cambiar|cambia|reprogramar|mover)\b/;
  let lastC = -1, lastU = -1;
  for (let i = 0; i < userMsgs.length; i++) {
    if (reCancel.test(userMsgs[i])) lastC = i;
    if (reUpdate.test(userMsgs[i])) lastU = i;
  }
  if (lastC === -1 || lastC < lastU) return null;
  return { id: idVisit };
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export class PropertyPlugin extends BasePlugin {
  constructor(tenantConfig, _functions) {
    super(tenantConfig);
    this.pluginType = 'property';
    this.entityType = 'property';
    this._propSvc  = new PropertyService(tenantConfig);
    this._visitSvc = new VisitService(tenantConfig);
  }

  classifyIntent(message, ctx) {
    const msg = String(message || '');
    // Atajo determinístico: si pide fotos/video/info y ya hay un link resuelto para la
    // propiedad activa (calculado en prepareHistory, PASO 8), responder directo sin IA —
    // así nunca depende de que el modelo decida bien usar el link.
    if (ctx?.materialLinkActivo && PIDE_MATERIAL_RE.test(msg)) {
      return { intent: 'material_propiedad', confidence: 0.95 };
    }
    for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
      if (patterns.some(p => p.test(msg))) return { intent, confidence: 0.88 };
    }
    return null;
  }

  // ─── prepareHistory ────────────────────────────────────────────────────────

  async prepareHistory(history, message, ctx) {
    const baseCtx = normalizeContext(ctx);
    const sessionId = baseCtx.sessionId || '';

    // Safe metadata copy from ctx
    const md = {
      // Se recalcula en cada turno (PASO 8) — nunca se arrastra de turnos anteriores,
      // así classifyIntent solo lo usa cuando el link es válido para el mensaje actual.
      materialLinkActivo:       null,
      propiedadSeleccionadaId:  baseCtx.propiedadSeleccionadaId  || null,
      propiedadesMostradas:     Array.isArray(baseCtx.propiedadesMostradas)     ? baseCtx.propiedadesMostradas     : [],
      visitaSeleccionadaId:     baseCtx.visitaSeleccionadaId     || null,
      visitasMostradas:         Array.isArray(baseCtx.visitasMostradas)         ? baseCtx.visitasMostradas         : [],
      idsPropiedadesMostradas:  Array.isArray(baseCtx.idsPropiedadesMostradas)  ? baseCtx.idsPropiedadesMostradas  : [],
      lastResults:              Array.isArray(baseCtx.lastResults)              ? baseCtx.lastResults              : [],
      origen:                   baseCtx.origen                   || null,
      pendingAction:            baseCtx.pendingAction             || null,
      busquedaTimestamp:        baseCtx.busquedaTimestamp         || null,
      ultimaBusqueda: {
        operacion:    baseCtx.ultimaBusqueda?.operacion    || null,
        tipologia:    baseCtx.ultimaBusqueda?.tipologia    || null,
        barrio:       baseCtx.ultimaBusqueda?.barrio       || '',
        offset:       Number.isInteger(baseCtx.ultimaBusqueda?.offset) ? baseCtx.ultimaBusqueda.offset : 0,
        ambientes:    baseCtx.ultimaBusqueda?.ambientes    || null,
        dormitorios:  baseCtx.ultimaBusqueda?.dormitorios  || null,
        dormitoriosOp:baseCtx.ultimaBusqueda?.dormitoriosOp || 'eq',
        aptoBanco:    baseCtx.ultimaBusqueda?.aptoBanco    || null,
        precioMax:    baseCtx.ultimaBusqueda?.precioMax    || null,
        precioMin:    baseCtx.ultimaBusqueda?.precioMin    || null,
        presupuesto:  baseCtx.ultimaBusqueda?.presupuesto  || null,
      },
    };

    // ── PASO 0: Clean stale prompt tags + refresh date ──────────────────────
    const visitasBuscadasAntes = history.filter(h => h.role === 'assistant').slice(-3)
      .some(m => /visita agendada|tenés una visita|visita actualizada|visita cancelada/i.test(m.content));

    if (history[0]?.role === 'system') {
      const hoy = new Date();
      const fechaHoy = `${String(hoy.getDate()).padStart(2,'0')}/${String(hoy.getMonth()+1).padStart(2,'0')}/${hoy.getFullYear()}`;

      history[0].content = history[0].content
        .replace(/\nBUSQUEDA_VISITAS_USUARIO:[^\n]*/g, '')
        .replace(/\n\n---VISITAS_USUARIO---[\s\S]*?---FIN_VISITAS_USUARIO---/g, '')
        .replace(/\{\{current_date\}\}/g, fechaHoy)
        .replace(/Hoy es \d{2}\/\d{2}\/\d{4}/g, `Hoy es ${fechaHoy}`)
        .replace(/\nINSTRUCCIÓN CRÍTICA: El usuario (?:quiere ver|busca)\b[^\n]*/g, '')
        .replace(/\nINSTRUCCIÓN CRÍTICA: El usuario hizo una referencia ambigua[^\n]*/g, '');

      // Clean PROPIEDAD_SELECCIONADA_ID if last interaction was a visit action
      const hayGestionReciente = history.slice(-4).some(m =>
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
      }

      // Re-inject propiedadSeleccionadaId from metadata if not in prompt
      if (md.propiedadSeleccionadaId && !history[0].content.includes('PROPIEDAD_SELECCIONADA_ID:')) {
        const id = md.propiedadSeleccionadaId;
        history[0].content += `\n\nPROPIEDAD_SELECCIONADA_ID:${id}\nINSTRUCCIÓN: El usuario ya eligió la propiedad ID ${id}. Usar este id_propiedad en el JSON de reserva.`;
      }

      // Always keep visitaSeleccionadaId visible so the LLM uses the correct id in update_visit/cancel_visit JSON
      history[0].content = history[0].content.replace(/\nVISITA_SELECCIONADA_ID:[^\n]*/g, '');
      if (md.visitaSeleccionadaId) {
        history[0].content += `\nVISITA_SELECCIONADA_ID:${md.visitaSeleccionadaId}\nINSTRUCCIÓN: Usá id: ${md.visitaSeleccionadaId} en el JSON de update_visit o cancel_visit.`;
      }
    }

    const msgNorm = _norm(message);

    // Expire stale pendingAction
    if (md.pendingAction && !this.isPendingValid(md.pendingAction)) {
      md.pendingAction = null;
    }

    // Expire stale search/selection context (inactivity) — see BUSQUEDA_TTL_MS
    if (md.busquedaTimestamp && (Date.now() - md.busquedaTimestamp > BUSQUEDA_TTL_MS)) {
      md.propiedadSeleccionadaId = null;
      md.propiedadesMostradas    = [];
      md.idsPropiedadesMostradas = [];
      md.lastResults             = [];
      md.ultimaBusqueda = { operacion: null, tipologia: null, barrio: '', offset: 0, ambientes: null, dormitorios: null, dormitoriosOp: 'eq', aptoBanco: null, precioMax: null, precioMin: null, presupuesto: null };
      md.busquedaTimestamp = null;
      if (history[0]?.role === 'system') {
        history[0].content = history[0].content
          .replace(/\n\n---PROPIEDADES---[\s\S]*?---FIN_PROPIEDADES---/g, '')
          .replace(/\n*PROPIEDAD_SELECCIONADA_ID:[^\n]*/g, '')
          .replace(/\n*INSTRUCCIÓN: El usuario eligió[^\n]*/g, '')
          .replace(/\nFILTRO_OPERACION:[^\n]*/g, '')
          .replace(/\nFILTRO_TIPOLOGIA:[^\n]*/g, '')
          .replace(/\nFILTRO_BARRIO:[^\n]*/g, '')
          .replace(/\nFILTRO_OFFSET:[^\n]*/g, '')
          .replace(/\nLINK_BUSCADO:[^\n]*/g, '')
          .replace(/\nID_INTERNO:[^\n]*/g, '');
      }
    }

    // Inject active pendingAction into system prompt
    if (md.pendingAction && history[0]?.role === 'system') {
      const pa = md.pendingAction;
      const jsonPendiente = pa.type === 'reserve'
        ? JSON.stringify({ action: 'reserve', ...pa.data })
        : pa.type === 'cancel_visit'
          ? JSON.stringify({ action: 'cancel_visit', id: pa.data?.id })
          : JSON.stringify({ action: 'update_visit', id: pa.data?.id, ...(pa.data?.updateData || {}) });

      history[0].content = history[0].content.replace(/\nPENDING_ACTION:[\s\S]*?END_PENDING_ACTION/g, '');
      history[0].content +=
        `\nPENDING_ACTION:\nHay una acción pendiente (${pa.type}).\nSi el usuario confirma claramente (si, dale, ok), respondé SOLO con este JSON:\n${jsonPendiente}\nSi no confirma, NO emitas JSON.\nEND_PENDING_ACTION`;

      if (_isRechazo(message)) md.pendingAction = null;
    }

    // ── Early property selection detection (before visit management) ─────────
    let propPreseleccionadaId = null, propPreseleccionadaNum = null, seleccionAmbigua = false;
    {
      const promptPrev = history[0]?.content || '';
      const idsMeta    = md.idsPropiedadesMostradas.map(String);
      const idsPrompt  = (promptPrev.match(/IDS_PROPIEDADES_MOSTRADAS:\[([^\]]+)\]/) || [])[1]?.split(',').map(s => s.trim()) || [];
      const idsPrev    = idsMeta.length > 0 ? idsMeta : idsPrompt;

      if (idsPrev.length > 0) {
        const selOp = message.match(/opci[oó]n\s*([1-9])|\bla\s+([1-9])\b|\bel\s+([1-9])\b|^([1-9])$/i);
        const selNum = selOp ? parseInt(selOp[1] || selOp[2] || selOp[3] || selOp[4], 10) : null;
        let preId = selNum ? idsPrev[selNum - 1] : null;
        let preNum = selNum;

        // Inferencia por dirección/texto SOLO si todavía no hay una propiedad bloqueada.
        // Una vez seleccionada (md.propiedadSeleccionadaId), nunca se vuelve a inferir por similitud de texto.
        if (!preId && !md.propiedadSeleccionadaId) {
          const dirsMatch = (promptPrev.match(/DIRS_PROPIEDADES_MOSTRADAS:\[([^\]]*)\]/) || [])[1];
          if (dirsMatch) {
            const dirs = dirsMatch.split('|');
            for (let i = 0; i < dirs.length; i++) {
              const dn = _norm(dirs[i]);
              const words = dn.split(/\s+/).filter(w => w.length > 3);
              if (words.filter(w => msgNorm.includes(w)).length >= 2) { preId = idsPrev[i]; preNum = i + 1; break; }
            }
          }
        }

        propPreseleccionadaId  = preId  || null;
        propPreseleccionadaNum = preNum || null;
        if (/\b(ese|esa|eso|uno|una|quiero ese|me interesa ese|la de ahi|la otra)\b/i.test(message) && !propPreseleccionadaId) {
          seleccionAmbigua = true;
        }
      }
    }

    if (seleccionAmbigua && history[0]?.role === 'system') {
      history[0].content += '\nINSTRUCCIÓN CRÍTICA: El usuario hizo una referencia ambigua a una propiedad. Pedir aclaración: número de opción o dirección exacta. NO asumir propiedad.';
    }

    // ── PASO 1: Portal link detection ─────────────────────────────────────────
    const linkDetectado = detectarLink(message);
    if (linkDetectado) {
      const yaFueBuscado = (history[0]?.content || '').includes(`LINK_BUSCADO:${linkDetectado.codigo}`);
      if (!yaFueBuscado) {
        try {
          const prop = await this._propSvc.searchByPortalCode(linkDetectado.fuente, linkDetectado.codigo);
          if (prop) {
            md.propiedadSeleccionadaId = prop.id;
            md.idsPropiedadesMostradas = [prop.id];
            md.propiedadesMostradas    = [prop.id];
            md.lastResults             = [_snapshotPropForCtx(prop)].filter(Boolean);
            md.origen = 'link';
            md.busquedaTimestamp = Date.now();
            console.log(`[PropertyPlugin] Propiedad seleccionada (link ${linkDetectado.fuente}): ID=${prop.id} Dirección=${prop.direccion || '—'}`);
            if (history[0]?.role === 'system') {
              history[0].content = history[0].content
                .replace(/\n\n---PROPIEDADES---[\s\S]*?---FIN_PROPIEDADES---/g, '')
                .replace(/\n*PROPIEDAD_SELECCIONADA_ID:[^\n]*/g, '')
                .replace(/\n*INSTRUCCIÓN: El usuario eligió[^\n]*/g, '');
              history[0].content +=
                `\n\nLINK_BUSCADO:${linkDetectado.codigo}` +
                `\n\n---PROPIEDADES---\n**PROPIEDAD ENCONTRADA POR LINK (${linkDetectado.fuente})**\n\n` +
                `${this._propSvc.format(prop, 1, 1)}\nID interno: ${prop.id}\n\n` +
                `IDS_PROPIEDADES_MOSTRADAS:[${prop.id}]\n` +
                `DIRS_PROPIEDADES_MOSTRADAS:[${(prop.direccion || '').replace(/\|/g, ' ')}]\n\n` +
                `PROPIEDAD_SELECCIONADA_ID:${prop.id}\n` +
                `INSTRUCCIÓN: El usuario compartió un link del portal ${linkDetectado.fuente}. Mostrar los datos y preguntar si quiere coordinar una visita. Usar id_propiedad: ${prop.id} en el JSON.\n` +
                `---FIN_PROPIEDADES---`;
            }
          } else {
            md.origen = 'link_fallback';
            if (history[0]?.role === 'system') {
              history[0].content +=
                `\n\nLINK_BUSCADO:${linkDetectado.codigo}` +
                `\n\nINSTRUCCIÓN PARA LINK SIN MATCH: El usuario compartió un link de ${linkDetectado.fuente}. Esta propiedad no está cargada aún. NUNCA decir "no encontré la propiedad". Respondé calurosamente: "¡Gracias por compartir! La estoy revisando. ¿Querés coordinar una visita? Solo necesito tu nombre y cuándo te vendría bien." NO emitir JSON.`;
            }
          }
        } catch (err) {
          console.error('[PropertyPlugin] link search error:', err.message);
        }
      }
      history = _trim(history);
      return { history: [...history, { role: 'user', content: message }], ctx: applyPropertyPluginMetadata(baseCtx, md) };
    }

    // ── PASO 1.5: Visit management detection ──────────────────────────────────
    const ultimoAsistente = history.filter(h => h.role === 'assistant').slice(-1)[0]?.content || '';
    const contextoEsVisita = /visita|fecha|hora|cambiar|cancelar|confirmar|reprogramar/i.test(ultimoAsistente);
    const quiereGestionarVisita =
      /\b(cancelar|confirmar|cambiar|cambia|modificar|reprogramar|mi visita|tengo visita|visita agendada|quiero cancelar|quiero cambiar|mis visitas|mis turnos|tengo turno)\b/.test(msgNorm)
      || (visitasBuscadasAntes && contextoEsVisita);
    const quiereCancelar        = /\bcancelar|cancelo|anular|dar de baja\b/.test(msgNorm);
    const quiereReprogramar     = /\breprogramar|cambiar|modificar|mover\b/.test(msgNorm);
    const gestionExplicita      = /\b(mi visita|mis visitas|visita agendada|tengo visita|tengo turno|mis turnos)\b/.test(msgNorm);
    const hayPropSeleccionada   = Boolean(md.propiedadSeleccionadaId) || (history[0]?.content || '').includes('PROPIEDAD_SELECCIONADA_ID:');
    const botRecopilandoReserva = history.filter(h => h.role === 'assistant').slice(-2)
      .some(m => /nombre.*tel[eé]fono|tel[eé]fono.*nombre|cu[aá]l es tu nombre|d[ií]a y hora/i.test(m.content));
    const bloquearGestion = hayPropSeleccionada && !quiereCancelar && !quiereReprogramar && !gestionExplicita;

    if (quiereGestionarVisita && !bloquearGestion && !botRecopilandoReserva && !propPreseleccionadaId && sessionId) {
      const yaFueBuscadoVisitas = (history[0]?.content || '').includes('BUSQUEDA_VISITAS_USUARIO:');
      if (!yaFueBuscadoVisitas) {
        try {
          const visitas = await this._visitSvc.getByPhone(sessionId, 5);
          if (history[0]?.role === 'system') {
            history[0].content = history[0].content.replace(/\n\n---VISITAS_USUARIO---[\s\S]*?---FIN_VISITAS_USUARIO---/g, '');
            history[0].content += '\nBUSQUEDA_VISITAS_USUARIO:done';
            if (visitas.length > 0) {
              const txt = visitas.map(v =>
                `[ID:${v.id}] Fecha: ${v.fecha} | Hora: ${v.hora ? v.hora.substring(0,5) : '—'} | Estado: ${v.operacion}`
              ).join('\n');
              history[0].content += `\n\n---VISITAS_USUARIO---\nVisitas del usuario:\n${txt}\n\nINSTRUCCIÓN: Presentá las visitas (sin el ID numérico) con fecha, hora y estado. Preguntá cuál quiere gestionar. Pedí confirmación antes de emitir JSON.\n---FIN_VISITAS_USUARIO---`;
              md.visitasMostradas = visitas.map(v => v.id);
              if (visitas.length === 1) md.visitaSeleccionadaId = visitas[0].id;
            } else {
              history[0].content += `\n\n---VISITAS_USUARIO---\n⚠️ BASE DE DATOS CONSULTADA: SIN VISITAS ACTIVAS\n\nINSTRUCCIÓN OBLIGATORIA: Respondé EXACTAMENTE: "No encontré visitas pendientes o confirmadas para tu número. ¿Querés agendar una nueva visita?" PROHIBIDO emitir JSON de update_visit o cancel_visit.\n---FIN_VISITAS_USUARIO---`;
              md.visitasMostradas = []; md.visitaSeleccionadaId = null;
            }
          }
        } catch (err) {
          console.error('[PropertyPlugin] getByPhone error:', err.message);
        }
      }
    }

    // Visit selection by index
    if (Array.isArray(md.visitasMostradas) && md.visitasMostradas.length > 0) {
      const sel = message.match(/opci[oó]n\s*([1-9])|\bla\s+([1-9])\b|\bel\s+([1-9])\b|^([1-9])$/i);
      const n   = sel ? parseInt(sel[1] || sel[2] || sel[3] || sel[4], 10) : null;
      if (n && md.visitasMostradas[n - 1]) md.visitaSeleccionadaId = md.visitasMostradas[n - 1];
    }

    // ── PASO 3-4.5: Detect filters ────────────────────────────────────────────
    const pluginIntentNow = this.classifyIntent(message, baseCtx);
    const structuredCurrent = buildStructuredIntent({
      intent: pluginIntentNow?.intent || 'unknown',
      message,
      source: 'plugin',
      confidence: pluginIntentNow?.confidence || 0,
    });
    const structuredFilters = extractPropertyFiltersFromStructuredIntent(structuredCurrent);

    const esAlquiler = /alquil|arrendar|renta/.test(msgNorm);
    const esVenta    = /compr|venta|vend/.test(msgNorm);

    const TIPOS_MAP = [
      [/\bdeptos?\b|\bdepartamentos?\b|\bapartamentos?\b/, 'departamento'],
      [/\bphs?\b/, 'ph'], [/\bcasas?\b/, 'casa'], [/\bduplexes?\b|\bdupl[eé]x\b/, 'duplex'],
      [/\blocales?\b/, 'local'], [/\boficinas?\b/, 'oficina'], [/\bcocheras?\b|\bgarages?\b/, 'cochera'],
    ];
    const tiposEncontrados = [];
    for (const [re, v] of TIPOS_MAP) { if (re.test(msgNorm) && !tiposEncontrados.includes(v)) tiposEncontrados.push(v); }
    const tipologiaDetectadaLegacy = tiposEncontrados.length === 0 ? null : tiposEncontrados.length === 1 ? tiposEncontrados[0] : tiposEncontrados.join(',');
    const tipologiaDetectada = structuredFilters.tipologia || tipologiaDetectadaLegacy;

    const barrioDetectadoLegacy = await this._detectBarrioAsync(msgNorm);
    const barrioDetectado = structuredFilters.barrio !== null ? structuredFilters.barrio : barrioDetectadoLegacy;
    // Si el mensaje ya matcheó un barrio conocido, no buscar también por dirección con
    // ese mismo texto — evita un AND barrio+dirección que no encontraría nada.
    const direccionDetectadaLegacy = barrioDetectado ? null : this._propSvc.detectDireccion(message);
    const direccionDetectada = structuredFilters.direccion !== null ? structuredFilters.direccion : direccionDetectadaLegacy;
    const sinPreferenciaBarrio = structuredFilters.clearBarrio || /^no$|^da lo mismo$|^me da lo mismo$|^cualquiera$|sin preferencia|cualquier barrio|no tengo preferencia|no importa|me da igual|indistinto/.test(msgNorm.trim());
    const pideMas = Boolean(structuredFilters.pideMas) || /\bver mas\b|\bmas opciones?\b|\bmostrame mas\b|\bsiguientes?\b|\bmas propiedades?\b|\bdame mas\b/.test(msgNorm);

    const ambientesM = msgNorm.match(/\b(\d+)\s*ambientes?\b/);
    const ambientesDetectados = structuredFilters.ambientes ?? (ambientesM ? parseInt(ambientesM[1], 10) : null);

    const _NUM = { uno:1, una:1, dos:2, tres:3, cuatro:4, cinco:5, seis:6 };
    const _parseDorm = s => { const n = parseInt(s, 10); return isNaN(n) ? (_NUM[s] || null) : n; };
    const _DP = '(\\d+|uno|una|dos|tres|cuatro|cinco|seis)', _DN = '(?:dormitorios?|habitaciones?|cuartos?|piezas?)';
    const dormGte = msgNorm.match(new RegExp(`(?:mas\\s+de|al\\s+menos|minimo)\\s+${_DP}\\s*${_DN}`, 'i')) || msgNorm.match(new RegExp(`${_DP}\\s*${_DN}\\s+o\\s+mas`, 'i'));
    const dormEq  = msgNorm.match(new RegExp(`\\b${_DP}\\s*${_DN}\\b`, 'i'));
    let dormitoriosDetectados = null, dormitoriosOpDetectado = null;
    if (dormGte) { dormitoriosDetectados = _parseDorm(dormGte[1]); dormitoriosOpDetectado = 'gte'; }
    else if (dormEq) { dormitoriosDetectados = _parseDorm(dormEq[1]); dormitoriosOpDetectado = 'eq'; }
    if (structuredFilters.dormitorios != null) {
      dormitoriosDetectados = structuredFilters.dormitorios;
      dormitoriosOpDetectado = 'eq';
    }

    const aptoBancoDetectado = structuredFilters.aptoBanco !== null
      ? structuredFilters.aptoBanco
      : (/\bapto\s*banco\b|\bacepta\s*banco\b|\bhipoteca\b|\bcredito\s*hipotecario\b/.test(msgNorm) ? true : null);

    const { presupuesto: presupuestoDetectadoLegacy, precioMin: precioMinDetectadoLegacy, precioMax: precioMaxDetectadoLegacy } =
      this._propSvc.detectPresupuesto(msgNorm, message);
    const presupuestoDetectado = structuredFilters.presupuesto ?? presupuestoDetectadoLegacy;
    const precioMinDetectado = structuredFilters.precioMin ?? precioMinDetectadoLegacy;
    const precioMaxDetectado = structuredFilters.precioMax ?? precioMaxDetectadoLegacy;

    // Búsqueda nueva genérica: evitar arrastrar filtros viejos (zona/dormitorios/precio)
    // cuando el usuario pide una nueva lista base (ej. "mostrame departamentos para alquilar").
    const esBusquedaNuevaGenerica = /\b(busco|buscando|buscar|mostrame|mostrar|quiero\s+ver|quiero\s+buscar)\b/.test(msgNorm) && !pideMas;
    const esRefinamiento = /\b(tambien|también|ademas|además|pero|ahora|con|en)\b/.test(msgNorm);
    const tieneEjePrincipalBusqueda = Boolean(esAlquiler || esVenta || tipologiaDetectada);
    const sinFiltrosEspecificosEnMensaje =
      !barrioDetectado &&
      !direccionDetectada &&
      ambientesDetectados == null &&
      dormitoriosDetectados == null &&
      aptoBancoDetectado == null &&
      !precioMinDetectado &&
      !precioMaxDetectado &&
      !presupuestoDetectado;
    const resetearFiltrosHeredados = esBusquedaNuevaGenerica && !esRefinamiento && tieneEjePrincipalBusqueda && sinFiltrosEspecificosEnMensaje;

    const idInternoM = message.match(/\b(?:id|n[uú]mero|n[uú]m|propiedad|prop)\s*#?\s*(\d{1,6})\b/i);
    const idInternoDetectado = idInternoM ? parseInt(idInternoM[1], 10) : null;

    // ── PASO 5: Retrieve saved filters ────────────────────────────────────────
    const sys = history[0]?.content || '';
    const operacionGuardada = resetearFiltrosHeredados
      ? null
      : (md.ultimaBusqueda.operacion || (sys.match(/FILTRO_OPERACION:(alquiler|venta)/) || [])[1] || null);
    const tipologiaGuardada = resetearFiltrosHeredados
      ? null
      : (md.ultimaBusqueda.tipologia || (sys.match(/FILTRO_TIPOLOGIA:([^\n]+)/) || [])[1]?.trim() || null);
    const barrioGuardado    = resetearFiltrosHeredados
      ? null
      : ((md.ultimaBusqueda.barrio ?? '') !== '' ? md.ultimaBusqueda.barrio : (sys.match(/FILTRO_BARRIO:([^\n]*)/) || [])[1]?.trim() || null);
    const direccionGuardada = resetearFiltrosHeredados
      ? null
      : ((md.ultimaBusqueda.direccion ?? '') !== '' ? md.ultimaBusqueda.direccion : (sys.match(/FILTRO_DIRECCION:([^\n]*)/) || [])[1]?.trim() || null);
    const offsetGuardado    = resetearFiltrosHeredados
      ? 0
      : (Number.isInteger(md.ultimaBusqueda.offset) ? md.ultimaBusqueda.offset : parseInt((sys.match(/FILTRO_OFFSET:(\d+)/) || [])[1] || '0', 10));

    // Si el usuario cambia explícitamente de tipología (ej. de casa a departamento),
    // debe tratarse como nueva búsqueda para no arrastrar filtros viejos.
    const cambioTipologia = Boolean(
      tipologiaDetectada &&
      tipologiaGuardada &&
      String(tipologiaDetectada).toLowerCase() !== String(tipologiaGuardada).toLowerCase()
    );
    const resetFinal = resetearFiltrosHeredados || cambioTipologia;

    const operacionDetectadaEstructurada = structuredFilters.operacion || null;
    const operacionFinal  = operacionDetectadaEstructurada || (esAlquiler ? 'alquiler' : esVenta ? 'venta' : null) || operacionGuardada;
    const TODAS_TIPOLOGIAS = 'departamento,casa,ph,duplex,local,oficina,cochera';
    const pideBusquedaGeneral = /\bpropiedad(?:es)?\b/.test(msgNorm) && !tipologiaDetectada && !/que tipo|tipologia/.test(msgNorm);
    // Si hay operacion, barrio o dirección/calle detectada pero no tipologia, mostrar
    // todas las tipologías en lugar de bloquear la búsqueda.
    const tipologiaFinal  = pideBusquedaGeneral
      ? TODAS_TIPOLOGIAS
      : (tipologiaDetectada || tipologiaGuardada)
        || ((operacionFinal || barrioDetectado || direccionDetectada) && !tipologiaGuardada ? TODAS_TIPOLOGIAS : null);
    // Si en este mensaje se detecta una calle/dirección nueva, no arrastrar un barrio
    // guardado de una búsqueda anterior (y viceversa) — generaban un AND imposible
    // (ej. barrio guardado "Alberdi" + calle nueva "Los Granaderos", que está en otro barrio).
    const barrioFinal     = sinPreferenciaBarrio ? '' : (barrioDetectado || (resetFinal ? null : (direccionDetectada ? null : barrioGuardado)) || null);
    const direccionFinal  = direccionDetectada || (resetFinal ? null : ((barrioDetectado ? null : direccionGuardada) || null));
    const filtroCambiado  = (operacionGuardada && operacionFinal !== operacionGuardada) || (tipologiaGuardada && tipologiaFinal !== tipologiaGuardada) || (barrioGuardado && barrioFinal !== barrioGuardado) || (direccionGuardada && direccionFinal !== direccionGuardada);
    const offsetFinal     = pideMas ? (offsetGuardado + 5) : (filtroCambiado ? 0 : offsetGuardado);

    const ambientesFinal    = ambientesDetectados    || (resetFinal ? null : md.ultimaBusqueda.ambientes)    || null;
    const dormitoriosFinal  = dormitoriosDetectados  || (resetFinal ? null : md.ultimaBusqueda.dormitorios)  || null;
    const dormitoriosOpFinal= dormitoriosOpDetectado || (resetFinal ? 'eq' : md.ultimaBusqueda.dormitoriosOp) || 'eq';
    const aptoBancoFinal    = aptoBancoDetectado     || (resetFinal ? null : md.ultimaBusqueda.aptoBanco)    || null;
    const precioMaxFinal    = precioMaxDetectado     || (resetFinal ? null : md.ultimaBusqueda.precioMax)    || null;
    const precioMinFinal    = precioMinDetectado     || (resetFinal ? null : md.ultimaBusqueda.precioMin)    || null;
    const presupuestoFinal  = presupuestoDetectado   || (resetFinal ? null : md.ultimaBusqueda.presupuesto)  || null;

    // ── PASO 5.5: Guardar filtros detectados (sin bloquear la búsqueda) ──────────
    if (history[0]?.role === 'system') {
      let prompt = history[0].content;
      if (operacionFinal) prompt = _upsertFiltro(prompt, 'OPERACION', operacionFinal);
      if (tipologiaFinal) prompt = _upsertFiltro(prompt, 'TIPOLOGIA', tipologiaFinal);
      if (barrioFinal)    prompt = _upsertFiltro(prompt, 'BARRIO', barrioFinal);
      if (direccionFinal) prompt = _upsertFiltro(prompt, 'DIRECCION', direccionFinal);
      history[0].content = prompt;
    }

    // ── PASO 5.9: Direct internal ID lookup ───────────────────────────────────
    if (idInternoDetectado) {
      const clave = `ID_INTERNO:${idInternoDetectado}`;
      if (!(history[0]?.content || '').includes(clave)) {
        try {
          const prop = await this._propSvc.getById(idInternoDetectado);
          if (history[0]?.role === 'system') {
            history[0].content = history[0].content
              .replace(/\n\n---PROPIEDADES---[\s\S]*?---FIN_PROPIEDADES---/g, '')
              .replace(/\n*PROPIEDAD_SELECCIONADA_ID:[^\n]*/g, '')
              .replace(/\n*INSTRUCCIÓN: El usuario eligió[^\n]*/g, '');
            if (prop) {
              md.propiedadSeleccionadaId = prop.id; md.idsPropiedadesMostradas = [prop.id]; md.propiedadesMostradas = [prop.id];
              md.lastResults = [_snapshotPropForCtx(prop)].filter(Boolean);
              md.busquedaTimestamp = Date.now();
              console.log(`[PropertyPlugin] Propiedad seleccionada (ID interno): ID=${prop.id} Dirección=${prop.direccion || '—'}`);
              history[0].content +=
                `\n\n${clave}\n\n---PROPIEDADES---\n**PROPIEDAD POR ID INTERNO (${idInternoDetectado})**\n\n` +
                `${this._propSvc.format(prop, 1, 1)}\nID interno: ${prop.id}\n\n` +
                `IDS_PROPIEDADES_MOSTRADAS:[${prop.id}]\nDIRS_PROPIEDADES_MOSTRADAS:[${(prop.direccion||'').replace(/\|/g,' ')}]\n\n` +
                `PROPIEDAD_SELECCIONADA_ID:${prop.id}\nINSTRUCCIÓN: Mostrar los datos y preguntar si quiere coordinar una visita. Usar id_propiedad: ${prop.id} en el JSON.\n---FIN_PROPIEDADES---`;
            } else {
              history[0].content += `\n\n${clave}\n\n---PROPIEDADES---\nSIN_RESULTADOS\n\nINSTRUCCIÓN: No encontramos una propiedad con ese número. Decilo de forma natural y ofrecé buscar por tipo y zona.\n---FIN_PROPIEDADES---`;
            }
          }
        } catch (err) { console.error('[PropertyPlugin] getById error:', err.message); }
      }
      history = _trim(history);
      return { history: [...history, { role: 'user', content: message }], ctx: applyPropertyPluginMetadata(baseCtx, md) };
    }

    // ── PASO 6: Full search ────────────────────────────────────────────────────
    // Si ya hay una propiedad activa y el usuario pide material/info de ESA propiedad,
    // no relanzar una búsqueda nueva por una palabra suelta que coincide con una tipología
    // (ej. "casa" en "tenés fotos de la casa?") — eso resetea la selección sin que el
    // usuario lo haya pedido.
    const pidiendoMaterialDeActiva = Boolean(md.propiedadSeleccionadaId) && PIDE_MATERIAL_RE.test(message);
    // Defensa adicional: con una propiedad ya bloqueada y sin cambio real de filtros
    // ni pedido de "más opciones", no hay motivo para re-disparar la búsqueda —
    // evita perder propiedadSeleccionadaId por una re-ejecución espuria de PASO 6
    // (ej. caché de búsqueda invalidado por un refresco del prompt en otro punto).
    const bookingEnCursoSinCambioDeFiltro = Boolean(md.propiedadSeleccionadaId) && !filtroCambiado && !pideMas;

    // propiedades_v2.operacion tiene valores alquiler/venta/NULL (registros viejos sin
    // cargar). Sin operacionFinal, _queryAll no arma el filtro `operacion` y devuelve
    // las tres variantes mezcladas. Si hay intención de búsqueda (tipología/barrio/
    // dirección) pero no se sabe si es alquiler o venta, se pide aclaración y NO se
    // consulta la BD todavía.
    const haySolicitudBusqueda = Boolean(tipologiaFinal || barrioFinal || direccionFinal);
    const necesitaAclararOperacion = haySolicitudBusqueda && !operacionFinal && !pidiendoMaterialDeActiva && !bookingEnCursoSinCambioDeFiltro;

    if (necesitaAclararOperacion && history[0]?.role === 'system') {
      history[0].content += '\nINSTRUCCIÓN CRÍTICA: El usuario busca propiedades pero no especificó si es alquiler o venta. Preguntar cuál de las dos opciones busca antes de mostrar propiedades. NO consultar la base de datos todavía.';
      history = _trim(history);
      return { history: [...history, { role: 'user', content: message }], ctx: applyPropertyPluginMetadata(baseCtx, md) };
    }

    if ((operacionFinal || tipologiaFinal) && !pidiendoMaterialDeActiva && !bookingEnCursoSinCambioDeFiltro) {
      const precioInd = (precioMinFinal || presupuestoFinal || precioMaxFinal) ? 'range' : dormitoriosOpFinal;
      const claveActual = `BUSQUEDA:${operacionFinal}:${tipologiaFinal}:${barrioFinal||'todos'}:${direccionFinal||'todas'}:${ambientesFinal||''}:${dormitoriosFinal||''}:${precioInd}:${aptoBancoFinal||''}:${precioMinFinal||''}:${(precioMaxFinal||presupuestoFinal)||''}:${offsetFinal}`;
      const yaFueBuscado = sys.includes(claveActual);

      const hayBusquedaPrevia = sys.includes(`BUSQUEDA:${operacionFinal}:${tipologiaFinal}:`);
      const esMensajeVago = sinPreferenciaBarrio && !barrioDetectado && !pideMas;
      if (hayBusquedaPrevia && esMensajeVago) {
        history = _trim(history);
        return { history: [...history, { role: 'user', content: message }], ctx: applyPropertyPluginMetadata(baseCtx, md) };
      }

      if (!yaFueBuscado) {
        const ultimaBusquedaAct = {
          operacion: operacionFinal, tipologia: tipologiaFinal, barrio: barrioFinal || '',
          direccion: direccionFinal || '',
          offset: offsetFinal, ambientes: ambientesFinal, dormitorios: dormitoriosFinal,
          dormitoriosOp: dormitoriosOpFinal, aptoBanco: aptoBancoFinal,
          precioMin: precioMinFinal, precioMax: precioMaxFinal, presupuesto: presupuestoFinal
        };
        try {
          const { props, expanded } = await this._propSvc.search({
            operacion: operacionFinal, tipologia: tipologiaFinal, barrio: barrioFinal || '',
            direccion: direccionFinal || '',
            ambientes: ambientesFinal, dormitorios: dormitoriosFinal, dormitoriosOp: dormitoriosOpFinal,
            aptoBanco: aptoBancoFinal, precioMin: precioMinFinal, precioMax: precioMaxFinal,
            presupuesto: presupuestoFinal, limit: 5, offset: offsetFinal,
          });

          if (history[0]?.role === 'system') {
            let prompt = history[0].content;
            if (prompt.includes('FILTRO_OPERACION:')) {
              prompt = prompt
                .replace(/FILTRO_OPERACION:[^\n]*/g, `FILTRO_OPERACION:${operacionFinal}`)
                .replace(/FILTRO_TIPOLOGIA:[^\n]*/g, `FILTRO_TIPOLOGIA:${tipologiaFinal}`)
                .replace(/FILTRO_BARRIO:[^\n]*/g, `FILTRO_BARRIO:${barrioFinal || ''}`)
                .replace(/FILTRO_DIRECCION:[^\n]*/g, `FILTRO_DIRECCION:${direccionFinal || ''}`)
                .replace(/FILTRO_OFFSET:[^\n]*/g, `FILTRO_OFFSET:${offsetFinal}`);
            } else {
              prompt += `\nFILTRO_OPERACION:${operacionFinal}\nFILTRO_TIPOLOGIA:${tipologiaFinal}\nFILTRO_BARRIO:${barrioFinal || ''}\nFILTRO_DIRECCION:${direccionFinal || ''}\nFILTRO_OFFSET:${offsetFinal}`;
            }
            prompt = prompt
              .replace(/\n\n---PROPIEDADES---[\s\S]*?---FIN_PROPIEDADES---/g, '')
              .replace(/\n*PROPIEDAD_SELECCIONADA_ID:[^\n]*/g, '')
              .replace(/\n*INSTRUCCIÓN: El usuario eligió[^\n]*/g, '');

            if (props.length > 0) {
              const propTextos = props.map((p, i) => `[ID:${p.id}]\n${this._propSvc.format(p, i + 1, props.length)}`).join('\n\n---\n\n');
              const ids  = props.map(p => p.id).join(',');
              const dirs = props.map(p => (p.direccion || '').replace(/\|/g, ' ')).join('|');
              const headerExp = expanded ? ' — cercanas al presupuesto' : '';
              prompt +=
                `\n\n---PROPIEDADES---\n**${claveActual}**\n\n⚠️ INSTRUCCIÓN CRÍTICA: Estas son las propiedades de la búsqueda ACTUAL. Ignorá propiedades de mensajes anteriores.\n\n` +
                `**PROPIEDADES ENCONTRADAS (${props.length})${headerExp}:**\n${propTextos}\n\n` +
                `IDS_PROPIEDADES_MOSTRADAS:[${ids}]\nDIRS_PROPIEDADES_MOSTRADAS:[${dirs}]\n\n` +
                `INSTRUCCIÓN: Presentar EXACTAMENTE estas ${props.length} propiedades con sus datos reales. NO inventar datos. Luego preguntar si alguna le interesa.\n---FIN_PROPIEDADES---`;
              md.idsPropiedadesMostradas = props.map(p => p.id);
              md.propiedadesMostradas    = props.map(p => p.id);
              md.lastResults             = props.map(p => _snapshotPropForCtx(p)).filter(Boolean);
              md.propiedadSeleccionadaId = null;
            } else {
              const filtrosDesc = [operacionFinal, tipologiaFinal, barrioFinal || direccionFinal].filter(Boolean).join(' + ');
              let sugerenciasBarrios = [];
              try {
                // Sugerencias reales de BD para mantener respuesta útil cuando no hay resultados
                // en la zona pedida. Se relaja solo zona/dirección y límites de precio.
                const { props: alternativos } = await this._propSvc.search({
                  operacion: operacionFinal,
                  tipologia: tipologiaFinal,
                  barrio: '',
                  direccion: '',
                  ambientes: ambientesFinal,
                  dormitorios: dormitoriosFinal,
                  dormitoriosOp: dormitoriosOpFinal,
                  aptoBanco: aptoBancoFinal,
                  precioMin: null,
                  precioMax: null,
                  presupuesto: null,
                  limit: 12,
                  offset: 0,
                });
                sugerenciasBarrios = [...new Set(
                  (alternativos || [])
                    .map(p => String(p?.barrio || '').trim())
                    .filter(Boolean)
                )].slice(0, 4);
              } catch (err) {
                console.warn('[PropertyPlugin] alternative zones search error:', err.message);
              }

              const sugerenciasTxt = sugerenciasBarrios.length > 0
                ? `\nZONAS_CON_DISPONIBILIDAD_BD:[${sugerenciasBarrios.join(' | ')}]\nINSTRUCCIÓN: Decí que en la zona solicitada no hay disponibilidad ahora y ofrecé buscar en estas zonas reales de BD: ${sugerenciasBarrios.join(', ')}. Pedí que elija una zona.`
                : `\nINSTRUCCIÓN: Decí que en este momento no hay disponibilidad con esa búsqueda y ofrecé ampliar zona o tipo de propiedad.`;

              prompt +=
                `\n\n---PROPIEDADES---\n**${claveActual}**\n\nSIN_RESULTADOS\n\n` +
                `FILTROS_BD_APLICADOS:${filtrosDesc || 'sin filtros explícitos'}${sugerenciasTxt}\nINSTRUCCIÓN: Respuesta breve, dinámica y natural. NO usar la palabra "presupuesto".\n---FIN_PROPIEDADES---`;
              md.idsPropiedadesMostradas = []; md.propiedadesMostradas = []; md.propiedadSeleccionadaId = null;
              md.lastResults = [];
            }

            md.ultimaBusqueda     = ultimaBusquedaAct;
            md.busquedaTimestamp  = Date.now();
            history[0].content    = prompt;
          }
        } catch (err) {
          console.error('[PropertyPlugin] search error:', err.message);
          if (history[0]?.role === 'system') {
            history[0].content += `\n\n---PROPIEDADES---\nERROR_BD\n\nINSTRUCCIÓN: Hubo un error técnico al consultar propiedades. Disculpate brevemente y ofrecé contactar a la inmobiliaria.\n---FIN_PROPIEDADES---`;
          }
        }
      }
    }

    // ── PASO 7: Property selection injection ──────────────────────────────────
    if (propPreseleccionadaId && history[0]?.role === 'system') {
      history[0].content = history[0].content.replace(/\n\nPROPIEDAD_SELECCIONADA_ID:[^\n]*\nINSTRUCCIÓN:[^\n]*/g, '');
      md.busquedaTimestamp = Date.now();
      console.log(`[PropertyPlugin] Propiedad seleccionada (Opción ${propPreseleccionadaNum} de lista mostrada): ID=${propPreseleccionadaId}`);
      const pideInfoEnVezDeVisita = CONSULTA_DETALLE_RE.test(message);
      if (pideInfoEnVezDeVisita) {
        // El usuario identificó la propiedad pero pide fotos/video/info, no agendar — dejar pasar al PASO 8.
        history[0].content += `\n\nPROPIEDAD_SELECCIONADA_ID:${propPreseleccionadaId}\nINSTRUCCIÓN: El usuario eligió la Opción ${propPreseleccionadaNum} (ID: ${propPreseleccionadaId}). Usar id_propiedad: ${propPreseleccionadaId} en el JSON si más adelante coordina una visita.`;
        md.propiedadSeleccionadaId = parseInt(String(propPreseleccionadaId), 10);
        md.propiedadesMostradas    = md.idsPropiedadesMostradas;
      } else {
        history[0].content += `\n\nPROPIEDAD_SELECCIONADA_ID:${propPreseleccionadaId}\nINSTRUCCIÓN: El usuario eligió la Opción ${propPreseleccionadaNum} (ID: ${propPreseleccionadaId}). Pedirle nombre, teléfono y fecha/hora para la visita. Usar id_propiedad: ${propPreseleccionadaId} en el JSON.`;
        history = _trim(history);
        return {
          history: [...history, { role: 'user', content: message }],
          ctx: applyPropertyPluginMetadata(baseCtx, {
            ...md,
            propiedadSeleccionadaId: parseInt(String(propPreseleccionadaId), 10),
            propiedadesMostradas: md.idsPropiedadesMostradas,
          }),
        };
      }
    }

    // ── PASO 8: Property detail on active selection ───────────────────────────
    const consultaDetalle = CONSULTA_DETALLE_RE.test(message);
    const idPropActiva    = md.propiedadSeleccionadaId || _resolvePropertyIdFromHistory(history);
    if (consultaDetalle && idPropActiva && history[0]?.role === 'system') {
      try {
        const prop = await this._propSvc.getById(idPropActiva);
        history[0].content = history[0].content.replace(/\n\n---DETALLE_PROPIEDAD---[\s\S]*?---FIN_DETALLE_PROPIEDAD---/g, '');
        if (prop) {
          // toLLMFields() incluye dinámicamente todos los campos con datos reales (incluso
          // futuros, ej. superficie/baños/expensas) y excluye SIEMPRE cod_zp/cod_lvi —
          // esos códigos de portal nunca deben llegar al cliente.
          const fields = this._propSvc.toLLMFields(prop);
          // Disponible para el atajo determinístico de classifyIntent (sin pasar por la IA).
          md.materialLinkActivo = fields.link || null;
          let instruccion = `Responder SOLO con datos de DATA. Mostrar todos los campos de DATA que tengan información real (omitir los que sean null), en formato "Etiqueta: valor", sin emojis ni iconos. Si preguntan por fotos, video, imágenes o más información de la propiedad, respondé con DATA.link (como "Más información:" seguido del link en su propia línea, sin la palabra "Link"). Si DATA.link es null, decir que todavía no hay material cargado para esa propiedad y ofrecer coordinar una visita. Si preguntan por requisitos, usar de forma literal DATA.requisitos (no reemplazarlo por apto_banco). No inventar datos ni mostrar campos que no estén en DATA. Cerrar con pregunta útil.`;

          // Si el pedido es específicamente de material (fotos/video/link/etc.) y SÍ hay un
          // link disponible, forzar una respuesta literal con ese link — no depender de que
          // el modelo "interprete" bien el JSON de DATA, que a veces falla.
          if (fields.link && PIDE_MATERIAL_RE.test(message)) {
            instruccion = `INSTRUCCIÓN CRÍTICA Y OBLIGATORIA: El usuario pidió fotos, video, imágenes o más información de esta propiedad. SÍ existe material disponible: DATA.link = "${fields.link}". Tu respuesta debe ser EXACTAMENTE este texto (podés agregar una pregunta de cierre después, pero NUNCA digas que no hay material cargado ni que falta información):\nMás información:\n${fields.link}`;
          }

          history[0].content += `\n\n---DETALLE_PROPIEDAD---\nDATA:${JSON.stringify(fields)}\nINSTRUCCIÓN: ${instruccion}\n---FIN_DETALLE_PROPIEDAD---`;
        } else {
          history[0].content += `\n\n---DETALLE_PROPIEDAD---\nSIN_DETALLE\nINSTRUCCIÓN: No hay datos disponibles para esta propiedad. Decilo humanamente y ofrecé otras opciones.\n---FIN_DETALLE_PROPIEDAD---`;
        }
      } catch (err) { console.error('[PropertyPlugin] getById (detail):', err.message); }
    }

    if (!hayPropSeleccionada && (quiereCancelar || quiereReprogramar)) {
      md.propiedadSeleccionadaId = null;
    }

    history = _trim(history);
    return { history: [...history, { role: 'user', content: message }], ctx: applyPropertyPluginMetadata(baseCtx, md) };
  }

  // ─── handleConfirmation ───────────────────────────────────────────────────

  async handleConfirmation(message, history, ctx) {
    if (!this.isPendingValid(ctx.pendingAction)) return null;
    const pa = ctx.pendingAction;

    try {
      if (pa.type === 'reserve') {
        // IMPORTANTE: usar pa.data tal cual quedó bloqueado al crear el pendingAction
        // (lo que el cliente vio y confirmó). Nunca recalcular id_propiedad acá — eso
        // es lo que causaba que se agende contra una propiedad distinta a la elegida.
        const data = { ...pa.data };
        if (!data.telefono && ctx.sessionId) data.telefono = String(ctx.sessionId);
        const result = await this._crearVisitaValidada(data, ctx, 'handleConfirmation');
        const newCtx = { ...ctx, pendingAction: null };
        if (!result.ok) return { handled: true, reply: `No pude agendar la visita: ${result.msg}`, metadata: newCtx };
        newCtx.visitaSeleccionadaId = result.visitaId;
        return { handled: true, reply: MENSAJE_CONFIRMACION_ASESOR, metadata: newCtx };
      }

      if (pa.type === 'cancel_visit') {
        const id = pa.data?.id;
        if (!id) return { handled: true, reply: 'No encontré el ID de la visita a cancelar.', metadata: { ...ctx, pendingAction: null } };
        const result = await this._visitSvc.cancel(id);
        const newCtx = { ...ctx, pendingAction: null, visitaSeleccionadaId: null };
        if (!result.ok) return { handled: true, reply: `No pude cancelar la visita: ${result.msg}`, metadata: newCtx };
        return { handled: true, reply: '✅ *Visita cancelada* con éxito.', metadata: newCtx };
      }

      if (pa.type === 'update_visit') {
        const { id, updateData } = pa.data || {};
        if (!id) return { handled: true, reply: 'No encontré el ID de la visita a modificar.', metadata: { ...ctx, pendingAction: null } };
        const result = await this._visitSvc.update(id, updateData || {});
        const newCtx = { ...ctx, pendingAction: null, visitaSeleccionadaId: id };
        if (!result.ok) return { handled: true, reply: `No pude modificar la visita: ${result.msg}`, metadata: newCtx };
        return { handled: true, reply: '✅ *Visita actualizada* con éxito.', metadata: newCtx };
      }
    } catch (err) {
      console.error('[PropertyPlugin] handleConfirmation error:', err.message);
      return { handled: true, reply: 'Tuvimos un inconveniente al confirmar. Reintentá en un momento.', metadata: { ...ctx, pendingAction: null } };
    }
    return null;
  }

  // ─── processAction ─────────────────────────────────────────────────────────

  async processAction(reply, history, ctx) {
    const actionJSON = _extractActionJSON(reply);
    if (!actionJSON) return null;
    const action = actionJSON.action;
    if (!['reserve', 'cancel_visit', 'update_visit'].includes(action)) return null;

    try {
      if (action === 'reserve') {
        // Support both flat {"action":"reserve","id_propiedad":...} and nested {"action":"reserve","data":{...}}
        const data = (actionJSON.data && typeof actionJSON.data === 'object')
          ? { ...actionJSON.data }
          : (({ action: _a, ...rest }) => rest)(actionJSON);
        if (!data.telefono && ctx.sessionId) data.telefono = String(ctx.sessionId);
        // Siempre confiar en ctx/historial, nunca en el id_propiedad que arma el LLM —
        // puede adivinarlo mal (ej. tomar el código de portal en vez del ID interno, o
        // directamente inventar un número). Si no hay un ID confiable, NO seguir adelante:
        // mejor pedir que confirme la propiedad que agendar contra una equivocada.
        const idConfiable = ctx.propiedadSeleccionadaId || _resolvePropertyIdFromHistory(history);
        if (!idConfiable) {
          console.error('[PropertyPlugin] processAction reserve: sin propiedad seleccionada confiable en ctx/historial — se descarta el id_propiedad propuesto por el modelo para no agendar contra la propiedad equivocada.');
          return { handled: true, reply: 'Para poder agendar necesito confirmar primero qué propiedad te interesa — ¿me indicás el número de opción o la dirección?', metadata: { ...ctx, pendingAction: null } };
        }
        data.id_propiedad = idConfiable;
        if (data.fecha) data.fecha = _extractFecha(String(data.fecha)) || data.fecha;
        const existing = ctx.pendingAction;
        const isSame = existing?.type === 'reserve'
          && String(existing.data?.id_propiedad) === String(data.id_propiedad)
          && String(existing.data?.fecha || '') === String(data.fecha || '')
          && String(existing.data?.hora  || '') === String(data.hora  || '');
        if (!isSame) {
          // Mostrar la dirección real (de la base, no narrada por el modelo) en la
          // confirmación, para que cualquier desajuste de propiedad se note ANTES de
          // agendar — no solo se valide después de que el usuario ya dijo "sí".
          let direccionConfirmacion = '';
          try {
            const propConfirmar = await this._propSvc.getById(data.id_propiedad);
            if (propConfirmar?.direccion) direccionConfirmacion = ` (${propConfirmar.direccion})`;
          } catch (err) { console.error('[PropertyPlugin] processAction reserve: error obteniendo dirección para confirmación:', err.message); }
          return { handled: true, reply: `Confirmo la reserva${direccionConfirmacion} para el ${data.fecha} a las ${data.hora}. Respondé "si" para agendar.`, metadata: { ...ctx, pendingAction: { type: 'reserve', data, timestamp: Date.now() } } };
        }
        if (this.isPendingValid(ctx.pendingAction)) {
          const result = await this._crearVisitaValidada(ctx.pendingAction.data, ctx, 'processAction');
          const newCtx = { ...ctx, pendingAction: null };
          if (!result.ok) return { handled: true, reply: `No pude agendar: ${result.msg}`, metadata: newCtx };
          newCtx.visitaSeleccionadaId = result.visitaId;
          return { handled: true, reply: MENSAJE_CONFIRMACION_ASESOR, metadata: newCtx };
        }
      }

      if (action === 'cancel_visit') {
        const visitId = parseInt(String(actionJSON.id ?? actionJSON.data?.id ?? ''), 10) || parseInt(String(ctx.visitaSeleccionadaId || ''), 10) || null;
        const existing = ctx.pendingAction;
        const isSame = existing?.type === 'cancel_visit' && String(existing.data?.id) === String(visitId);
        if (!isSame) {
          return { handled: true, reply: 'Confirmo que querés cancelar la visita. Respondé "si" para confirmar.', metadata: { ...ctx, pendingAction: { type: 'cancel_visit', data: { id: visitId }, timestamp: Date.now() } } };
        }
        if (this.isPendingValid(ctx.pendingAction)) {
          const result = await this._visitSvc.cancel(visitId);
          const newCtx = { ...ctx, pendingAction: null, visitaSeleccionadaId: null };
          if (!result.ok) return { handled: true, reply: `No pude cancelar: ${result.msg}`, metadata: newCtx };
          return { handled: true, reply: '✅ *Visita cancelada* con éxito.', metadata: newCtx };
        }
      }

      if (action === 'update_visit') {
        const visitId = parseInt(String(actionJSON.id ?? actionJSON.data?.id ?? ''), 10) || parseInt(String(ctx.visitaSeleccionadaId || ''), 10) || null;
        const src = (actionJSON.data && typeof actionJSON.data === 'object') ? actionJSON.data : actionJSON;
        const updateData = {};
        if (src.fecha)     updateData.fecha     = _extractFecha(String(src.fecha)) || src.fecha;
        if (src.hora)      updateData.hora      = src.hora;
        if (src.operacion) updateData.operacion = src.operacion;
        const existing = ctx.pendingAction;
        const isSame = existing?.type === 'update_visit'
          && String(existing.data?.id) === String(visitId)
          && JSON.stringify(existing.data?.updateData || {}) === JSON.stringify(updateData);
        if (!isSame) {
          return { handled: true, reply: 'Confirmo la modificación de la visita. Respondé "si" para confirmar.', metadata: { ...ctx, pendingAction: { type: 'update_visit', data: { id: visitId, updateData }, timestamp: Date.now() } } };
        }
        if (this.isPendingValid(ctx.pendingAction)) {
          const result = await this._visitSvc.update(visitId, ctx.pendingAction.data?.updateData || updateData);
          const newCtx = { ...ctx, pendingAction: null, visitaSeleccionadaId: visitId };
          if (!result.ok) return { handled: true, reply: `No pude modificar: ${result.msg}`, metadata: newCtx };
          return { handled: true, reply: '✅ *Visita actualizada* con éxito.', metadata: newCtx };
        }
      }
    } catch (err) {
      console.error('[PropertyPlugin] processAction error:', err.message);
    }
    return null;
  }

  // ─── handleImplicitConfirmation ───────────────────────────────────────────

  async handleImplicitConfirmation(message, history, ctx) {
    const msgNorm = _norm(message);
    const esCancelDirecta = /\b(cancelar|cancela|cancele|anular|anula|dar de baja)\b/.test(msgNorm);
    const esConfirm = _isConfirmacion(message);
    if (!esConfirm && !esCancelDirecta) return null;
    if (ctx.pendingAction && this.isPendingValid(ctx.pendingAction)) return null;

    const cancelInferida = _inferirCancelacionDesdeHistorial({ history, ctx });
    if (cancelInferida) {
      const result = await this._visitSvc.cancel(cancelInferida.id);
      const newCtx = { ...ctx, pendingAction: null, visitaSeleccionadaId: null };
      if (!result.ok) return { handled: true, reply: `No pude cancelar: ${result.msg}`, metadata: newCtx };
      return { handled: true, reply: '✅ *Visita cancelada* con éxito.', metadata: newCtx };
    }

    if (esCancelDirecta) return null;

    const modInferida = _inferirModificacionDesdeHistorial({ history, ctx });
    if (modInferida) {
      const result = await this._visitSvc.update(modInferida.id, modInferida.updateData);
      const newCtx = { ...ctx, pendingAction: null, visitaSeleccionadaId: modInferida.id };
      if (!result.ok) return { handled: true, reply: `No pude modificar: ${result.msg}`, metadata: newCtx };
      return { handled: true, reply: '✅ *Visita actualizada* con éxito.', metadata: newCtx };
    }

    const reservaInferida = _inferirReservaDesdeHistorial({ history, sessionId: ctx.sessionId, ctx });
    if (!reservaInferida) return null;

    const result = await this._crearVisitaValidada(reservaInferida, ctx, 'handleImplicitConfirmation');
    const newCtx = { ...ctx, pendingAction: null };
    if (!result.ok) return { handled: true, reply: `No pude agendar: ${result.msg}`, metadata: newCtx };
    newCtx.visitaSeleccionadaId = result.visitaId;
    return { handled: true, reply: MENSAJE_CONFIRMACION_ASESOR, metadata: newCtx };
  }

  formatResponse(actionResult, _channel) {
    return actionResult?.reply ?? null;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  async _detectBarrioAsync(msgNorm) {
    try {
      const barrios = await this._propSvc.getBarrios();
      return this._propSvc.detectBarrio(msgNorm, barrios);
    } catch { return null; }
  }

  /**
   * Punto único de creación de visitas. Antes de persistir, valida que la propiedad
   * que se va a agendar sea exactamente la que está bloqueada como "seleccionada" en
   * la sesión (ctx.propiedadSeleccionadaId). Si hay discrepancia, aborta y loguea el error
   * en vez de agendar contra una propiedad distinta a la elegida por el cliente.
   */
  async _crearVisitaValidada(data, ctx, origen) {
    const idSeleccionado = ctx?.propiedadSeleccionadaId ?? null;
    const idAgendar       = data?.id_propiedad ?? null;

    let dirSeleccionada = null, dirAgendar = null;
    try {
      if (idSeleccionado) dirSeleccionada = (await this._propSvc.getById(idSeleccionado))?.direccion || null;
      dirAgendar = (String(idAgendar) === String(idSeleccionado))
        ? dirSeleccionada
        : (idAgendar ? (await this._propSvc.getById(idAgendar))?.direccion || null : null);
    } catch (err) {
      console.error(`[PropertyPlugin][${origen}] Error obteniendo dirección para validación:`, err.message);
    }

    console.log(
      `[PropertyPlugin][${origen}] Validación de agendamiento — ` +
      `Propiedad seleccionada: ID=${idSeleccionado ?? '—'} Dirección="${dirSeleccionada || '—'}" | ` +
      `Propiedad a agendar: ID=${idAgendar ?? '—'} Dirección="${dirAgendar || '—'}"`
    );

    if (!idAgendar) {
      console.error(`[PropertyPlugin][${origen}] ABORTADO: no hay id_propiedad para agendar la visita.`);
      return { ok: false, error: 'sin_propiedad', msg: 'No pude identificar la propiedad para agendar la visita. ¿Podés confirmarme cuál te interesa?' };
    }

    if (idSeleccionado && String(idSeleccionado) !== String(idAgendar)) {
      console.error(
        `[PropertyPlugin][${origen}] ABORTADO: discrepancia de propiedad — ` +
        `seleccionada ID=${idSeleccionado} ("${dirSeleccionada}") vs a agendar ID=${idAgendar} ("${dirAgendar}").`
      );
      return { ok: false, error: 'propiedad_inconsistente', msg: 'Detectamos una inconsistencia con la propiedad seleccionada y no quisimos agendar por error. ¿Podés confirmarme nuevamente cuál propiedad querés visitar?' };
    }

    return await this._visitSvc.create(data);
  }
}
