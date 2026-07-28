// plugins/appointmentPlugin.mjs — Health / services appointment plugin.
// Handles turnos: search available slots, create, cancel, reschedule.
// Uses tenant_config.supabase for data access; enforces tenant_id isolation.

import { BasePlugin } from './basePlugin.mjs';

const INTENT_PATTERNS = {
  search:     [/turnos?\s*disponibles?|qu[eé]\s*turnos?\s*(hay|tienen?)|hay\s*turno|cu[aá]ndo\s*(atienden?|tienen?\s*turno)|disponibilidad/i],
  book:       [/sacar\s*turno|quiero\s*(un\s*)?turno|necesito\s*(un\s*)?turno|agendar\s*(un\s*)?turno|reservar\s*(un\s*)?turno|pedir\s*(un\s*)?turno/i],
  cancel:     [/cancelar\s*(el\s*)?turno|anular\s*(el\s*)?turno|no\s*(voy|puedo)\s*(al\s*)?turno|borr[aá]\s*(el\s*)?turno/i],
  reschedule: [/cambiar\s*(el\s*)?turno|reprogramar\s*(el\s*)?turno|mover\s*(el\s*)?turno|otro\s*d[ií]a\s*para\s*(el\s*)?turno/i],
  status:     [/mis\s*turnos?|tengo\s*turno|turno\s*agendado|ver\s*mis\s*turnos?|qu[eé]\s*turnos?\s*tengo/i],
};

export class AppointmentPlugin extends BasePlugin {
  constructor(tenantConfig) {
    super(tenantConfig);
    this.pluginType = 'appointment';
    this.entityType = 'turno';
  }

  classifyIntent(message, _ctx) {
    const msg = String(message || '');
    for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
      if (patterns.some(p => p.test(msg))) {
        return { intent, confidence: 0.88 };
      }
    }
    return null;
  }

  async prepareHistory(history, message, ctx) {
    history.push({ role: 'user', content: message });

    // Inject active appointment context into system prompt
    if (history[0]?.role === 'system' && ctx.activeEntity?.id) {
      history[0].content = history[0].content
        .replace(/\nCONTEXTO_TURNO:[^\n]*/g, '');
      history[0].content += `\nCONTEXTO_TURNO:${JSON.stringify(ctx.activeEntity.data)}`;
    }

    return { history, ctx };
  }

  async execute(intent, params, ctx) {
    switch (intent) {
      case 'search':     return this._getAvailableSlots(params, ctx);
      case 'book':       return this._createAppointment(params, ctx);
      case 'cancel':     return this._cancelAppointment(params, ctx);
      case 'reschedule': return this._rescheduleAppointment(params, ctx);
      case 'status':     return this._getUserAppointments(ctx);
      default:           return { type: 'unknown' };
    }
  }

  // ─── Actions ─────────────────────────────────────────────────────────────

  async _getAvailableSlots({ fecha } = {}, ctx) {
    const { url, key } = this._dbCreds();
    if (!url || !key) return { type: 'error', reason: 'config_missing' };

    const targetDate = fecha || this._nextWeekday();
    const resp = await fetch(
      `${url}/rest/v1/turnos_disponibles?fecha=eq.${targetDate}&tenant_id=eq.${this.tenantId}&disponible=eq.true&order=hora.asc&limit=10`,
      { headers: this._headers(key) }
    );

    if (!resp.ok) return { type: 'error', reason: 'db_error' };
    const slots = await resp.json();
    return { type: 'slots', data: slots, fecha: targetDate };
  }

  async _createAppointment({ fecha, hora, servicio, nombre, telefono } = {}, ctx) {
    const { url, key } = this._dbCreds();
    if (!url || !key) return { type: 'error', reason: 'config_missing' };

    const missing = [];
    if (!fecha)   missing.push('fecha');
    if (!hora)    missing.push('hora');
    if (!nombre)  missing.push('nombre');
    if (missing.length) return { type: 'missing_fields', fields: missing };

    // Conflict check
    const chk = await fetch(
      `${url}/rest/v1/turnos?fecha=eq.${fecha}&hora=eq.${hora}&tenant_id=eq.${this.tenantId}&operacion=neq.cancelado&limit=1`,
      { headers: this._headers(key) }
    );
    if (chk.ok) {
      const existing = await chk.json();
      if (Array.isArray(existing) && existing.length > 0) {
        return { type: 'error', reason: 'slot_taken' };
      }
    }

    // Insert
    const ins = await fetch(`${url}/rest/v1/turnos`, {
      method:  'POST',
      headers: this._headers(key, true),
      body:    JSON.stringify({
        fecha,
        hora,
        servicio:  servicio || 'Consulta',
        nombre,
        telefono:  telefono || ctx.userId,
        tenant_id: this.tenantId,
        operacion: 'confirmado'
      })
    });

    if (!ins.ok) {
      console.error('appointmentPlugin insert error:', ins.status, await ins.text().catch(() => ''));
      return { type: 'error', reason: 'insert_failed' };
    }

    const turno = await ins.json();
    const created = Array.isArray(turno) ? turno[0] : turno;

    return { type: 'booked', data: created };
  }

  async _cancelAppointment({ id } = {}, ctx) {
    const resolvedId = id || ctx.activeEntity?.id;
    if (!resolvedId) return { type: 'missing_fields', fields: ['id'] };

    const { url, key } = this._dbCreds();
    if (!url || !key) return { type: 'error', reason: 'config_missing' };

    const resp = await fetch(
      `${url}/rest/v1/turnos?id=eq.${resolvedId}&tenant_id=eq.${this.tenantId}`,
      {
        method:  'PATCH',
        headers: this._headers(key, true),
        body:    JSON.stringify({ operacion: 'cancelado' })
      }
    );

    if (!resp.ok) return { type: 'error', reason: 'update_failed' };
    return { type: 'cancelled', id: resolvedId };
  }

  async _rescheduleAppointment({ id, fecha, hora } = {}, ctx) {
    const resolvedId = id || ctx.activeEntity?.id;
    if (!resolvedId || !fecha || !hora) {
      return { type: 'missing_fields', fields: [!resolvedId && 'id', !fecha && 'fecha', !hora && 'hora'].filter(Boolean) };
    }

    const { url, key } = this._dbCreds();
    if (!url || !key) return { type: 'error', reason: 'config_missing' };

    // Conflict check on new slot
    const chk = await fetch(
      `${url}/rest/v1/turnos?fecha=eq.${fecha}&hora=eq.${hora}&tenant_id=eq.${this.tenantId}&operacion=neq.cancelado&id=neq.${resolvedId}&limit=1`,
      { headers: this._headers(key) }
    );
    if (chk.ok) {
      const conflict = await chk.json();
      if (Array.isArray(conflict) && conflict.length > 0) return { type: 'error', reason: 'slot_taken' };
    }

    const resp = await fetch(
      `${url}/rest/v1/turnos?id=eq.${resolvedId}&tenant_id=eq.${this.tenantId}`,
      {
        method:  'PATCH',
        headers: this._headers(key, true),
        body:    JSON.stringify({ fecha, hora })
      }
    );

    if (!resp.ok) return { type: 'error', reason: 'update_failed' };
    return { type: 'rescheduled', id: resolvedId, fecha, hora };
  }

  async _getUserAppointments(ctx) {
    const { url, key } = this._dbCreds();
    if (!url || !key) return { type: 'error', reason: 'config_missing' };

    const phone = ctx.userId;
    const resp  = await fetch(
      `${url}/rest/v1/turnos?telefono=eq.${encodeURIComponent(phone)}&tenant_id=eq.${this.tenantId}&operacion=neq.cancelado&order=fecha.asc,hora.asc&limit=10`,
      { headers: this._headers(key) }
    );

    if (!resp.ok) return { type: 'error', reason: 'db_error' };
    const turnos = await resp.json();
    return { type: 'list', data: turnos };
  }

  // ─── Format ───────────────────────────────────────────────────────────────

  formatResponse(result, _channel) {
    if (!result) return null;

    const ERROR_MSGS = {
      slot_taken:    '❌ Ese horario ya está ocupado. ¿Querés ver otro disponible?',
      config_missing:'⚠️ Error de configuración. Contactanos directamente.',
      db_error:      '⚠️ No pudimos consultar la base de datos. Intentá de nuevo.',
      insert_failed: '⚠️ No pudimos guardar el turno. Intentá de nuevo.',
      update_failed: '⚠️ No pudimos actualizar el turno. Intentá de nuevo.',
    };

    switch (result.type) {
      case 'booked': {
        const t = result.data || {};
        return `✅ Turno confirmado:\n*Fecha:* ${t.fecha}\n*Hora:* ${t.hora}\n*Servicio:* ${t.servicio || 'Consulta'}\n*ID:* ${t.id}\n\nAnotá este número por si necesitás cancelar o reprogramar.`;
      }
      case 'cancelled':
        return '✅ Turno cancelado correctamente.';
      case 'rescheduled':
        return `✅ Turno reprogramado para el ${result.fecha} a las ${result.hora}.`;
      case 'list': {
        if (!result.data?.length) return 'No tenés turnos activos en este momento.';
        const lines = result.data.map(t =>
          `• *${t.fecha}* a las *${t.hora}* — ${t.servicio || 'Consulta'} (ID ${t.id})`
        );
        return `Tus turnos activos:\n${lines.join('\n')}`;
      }
      case 'slots': {
        if (!result.data?.length) return `No hay turnos disponibles para el ${result.fecha}. ¿Querés consultar otra fecha?`;
        const lines = result.data.map(s => `• ${s.hora}`);
        return `Horarios disponibles para el ${result.fecha}:\n${lines.join('\n')}\n\n¿Cuál te viene bien?`;
      }
      case 'missing_fields':
        return `Necesito más información: ${result.fields.join(', ')}.`;
      case 'error':
        return ERROR_MSGS[result.reason] || '⚠️ Ocurrió un error inesperado.';
      default:
        return null;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _dbCreds() {
    const sc  = this.supabaseConfig;
    return {
      url: sc?.url,
      key: sc?.service_role_key || sc?.anon_key
    };
  }

  _headers(key, withWrite = false) {
    const h = {
      apikey:        key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    };
    if (withWrite) h.Prefer = 'return=representation';
    return h;
  }

  _nextWeekday() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 6) d.setDate(d.getDate() + 2);
    if (d.getDay() === 0) d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  }
}
