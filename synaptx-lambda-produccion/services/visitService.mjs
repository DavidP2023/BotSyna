// services/visitService.mjs
// CRUD completo de visitas a propiedades con validación de disponibilidad y horarios.
// Los horarios de atención se leen del tenantConfig (no son hardcodeados).

import { SupabaseClient } from './supabaseClient.mjs';

const DEFAULT_HOURS = {
  weekdays: { open: '09:00', close: '17:00' },
  saturday: { open: '09:00', close: '11:00' },
  sunday:   null,
};

export class VisitService {
  /**
   * @param {object} config - tenantConfig completo
   */
  constructor(config) {
    this.db    = new SupabaseClient(config.supabase || config);
    this.hours = config.businessHours || DEFAULT_HOURS;
  }

  // ─── Consulta ─────────────────────────────────────────────────────────────

  /**
   * Devuelve las visitas activas del usuario por número de teléfono.
   * Prueba variantes del número (con/sin código de país) para mayor cobertura.
   * @param {string} phone
   * @param {number} [limit=5]
   * @returns {Promise<object[]>}
   */
  async getByPhone(phone, limit = 5) {
    const variants = this._phoneVariants(phone);
    for (const v of variants) {
      try {
        const rows = await this.db.select('visitas', {
          select:    'id,id_propiedad,nombre,telefono,fecha,hora,operacion',
          telefono:  `ilike.%${v}%`,
          operacion: 'neq.cancelado',
          order:     'fecha.desc',
          limit,
        });
        if (Array.isArray(rows) && rows.length > 0) return rows;
      } catch (err) {
        console.warn('[VisitService] getByPhone variant error:', err.message);
      }
    }
    return [];
  }

  // ─── Disponibilidad ───────────────────────────────────────────────────────

  /**
   * Verifica si el horario está disponible para la propiedad dada.
   * @param {string} fechaISO    - 'YYYY-MM-DD'
   * @param {string} horaHHMMSS - 'HH:MM:SS' o 'HH:MM'
   * @param {number} idPropiedad
   * @param {number|null} [excludeId] - ID de visita a excluir (útil en updates)
   * @returns {Promise<boolean>} true = disponible
   */
  async checkAvailability(fechaISO, horaHHMMSS, idPropiedad, excludeId = null) {
    try {
      const rows = await this.db.select('visitas', {
        select:       'id',
        id_propiedad: `eq.${idPropiedad}`,
        fecha:        `eq.${fechaISO}`,
        hora:         `eq.${horaHHMMSS}`,
        operacion:    'neq.cancelado',
        limit:        5,
      });
      const conflicts = (Array.isArray(rows) ? rows : []).filter(r => r.id !== excludeId);
      return conflicts.length === 0;
    } catch (err) {
      console.error('[VisitService] checkAvailability error:', err.message);
      return true; // fail-open: no bloquear al usuario por error técnico
    }
  }

  // ─── Crear visita ──────────────────────────────────────────────────────────

  /**
   * Crea una visita tras validar fecha, horario comercial, existencia de propiedad
   * y conflictos de disponibilidad.
   *
   * @param {object} data
   * @param {number}  data.id_propiedad
   * @param {string}  data.nombre
   * @param {string}  data.telefono
   * @param {string}  data.fecha   - DD/MM/YYYY o YYYY-MM-DD
   * @param {string}  data.hora    - HH:MM
   * @returns {Promise<VisitResult>}
   */
  async create({ id_propiedad, nombre, telefono, fecha, hora }) {
    // 1. Parsear fecha
    const fechaISO = this._parseDate(fecha);
    if (!fechaISO) return _err('fecha_invalida', 'La fecha no tiene formato válido (DD/MM/YYYY).');

    // 2. Parsear hora
    const horaFmt = this._parseTime(hora);
    if (!horaFmt) return _err('hora_invalida', 'La hora no tiene formato válido (HH:MM).');
    if (!this._isQuarterHour(horaFmt)) {
      return _err('hora_intervalo_invalido', 'Los horarios disponibles son cada 15 minutos (por ejemplo: 16:00, 16:15, 16:30, 16:45).');
    }

    // 3. Validar horario comercial
    const hoursCheck = this._validateBusinessHours(fechaISO, horaFmt);
    if (!hoursCheck.ok) return hoursCheck;

    const horaDB = horaFmt + ':00';

    // 4. Propiedad existe
    try {
      const prop = await this.db.select('propiedades_v2', {
        select: 'id', id: `eq.${id_propiedad}`, limit: 1,
      });
      if (!Array.isArray(prop) || prop.length === 0)
        return _err('propiedad_inexistente', `No encontré la propiedad #${id_propiedad} en el sistema.`);
    } catch { /* non-fatal: seguir si Supabase falla en validación */ }

    // 5. Idempotencia: misma combinación teléfono + propiedad + fecha + hora
    for (const v of this._phoneVariants(telefono)) {
      try {
        const dup = await this.db.select('visitas', {
          select:       'id',
          id_propiedad: `eq.${id_propiedad}`,
          fecha:        `eq.${fechaISO}`,
          hora:         `eq.${horaDB}`,
          telefono:     `ilike.%${v}%`,
          operacion:    'neq.cancelado',
          limit:        1,
        });
        if (Array.isArray(dup) && dup.length > 0)
          return { ok: true, visitaId: dup[0].id, duplicate: true };
      } catch { /* non-fatal */ }
    }

    // 6. Conflicto de horario para la propiedad
    const available = await this.checkAvailability(fechaISO, horaDB, id_propiedad);
    if (!available)
      return _err('horario_ocupado', `El horario ${fecha} ${hora} ya está reservado para esta propiedad. ¿Querés otro horario?`);

    // 7. Insertar
    let row;
    try {
      row = await this.db.insert('visitas', {
        id_propiedad,
        nombre:    String(nombre).trim(),
        telefono:  String(telefono).trim(),
        fecha:     fechaISO,
        hora:      horaDB,
        operacion: 'pendiente',
      });
    } catch (err) {
      console.error('[VisitService] insert error:', err.message);
      return _err('insert_error', `Error al guardar la visita: ${err.message}`);
    }

    const id = Array.isArray(row) ? row[0]?.id : row?.id;
    return {
      ok: true, visitaId: id,
      data: { id_propiedad, nombre, telefono, fecha: fechaISO, hora: horaFmt },
    };
  }

  // ─── Modificar visita ──────────────────────────────────────────────────────

  /**
   * Modifica fecha y/u hora de una visita existente.
   * @param {number}  id
   * @param {object}  updates  - { fecha?, hora?, id_propiedad? }
   * @returns {Promise<VisitResult>}
   */
  async update(id, updates = {}) {
    if (!id) return _err('id_requerido', 'Necesito el ID de la visita para modificarla.');

    const patch = {};

    if (updates.fecha) {
      const fechaISO = this._parseDate(updates.fecha);
      if (!fechaISO) return _err('fecha_invalida', 'La fecha no tiene formato válido.');
      patch.fecha = fechaISO;
    }
    if (updates.hora) {
      const horaFmt = this._parseTime(updates.hora);
      if (!horaFmt) return _err('hora_invalida', 'La hora no tiene formato válido.');
      if (!this._isQuarterHour(horaFmt)) {
        return _err('hora_intervalo_invalido', 'Los horarios disponibles son cada 15 minutos (por ejemplo: 16:00, 16:15, 16:30, 16:45).');
      }
      patch.hora = horaFmt + ':00';
    }
    if (updates.id_propiedad) patch.id_propiedad = updates.id_propiedad;

    if (Object.keys(patch).length === 0)
      return _err('sin_cambios', 'No recibí ningún dato para actualizar la visita.');

    // Completar con valores actuales si el update es parcial
    let currentFecha, currentHora, currentPropId;
    try {
      const rows = await this.db.select('visitas', {
        select: 'fecha,hora,id_propiedad,operacion', id: `eq.${id}`, limit: 1,
      });
      if (!Array.isArray(rows) || rows.length === 0)
        return _err('visita_no_encontrada', 'No encontré una visita con ese ID.');
      if (rows[0].operacion === 'cancelado')
        return _err('visita_cancelada', 'Esa visita ya fue cancelada y no se puede modificar.');
      currentFecha  = rows[0].fecha;
      currentHora   = rows[0].hora;
      currentPropId = rows[0].id_propiedad;
    } catch (err) {
      return _err('db_error', `No pude acceder a la visita: ${err.message}`);
    }

    const checkFecha  = patch.fecha  || currentFecha;
    const checkHora   = patch.hora   || currentHora;
    const checkPropId = patch.id_propiedad || currentPropId;

    // Validar horario comercial
    const hoursCheck = this._validateBusinessHours(checkFecha, checkHora.slice(0, 5));
    if (!hoursCheck.ok) return hoursCheck;

    // Validar disponibilidad (excluyendo la visita actual)
    const available = await this.checkAvailability(checkFecha, checkHora, checkPropId, id);
    if (!available)
      return _err('horario_ocupado', 'Ese nuevo horario ya está reservado. ¿Querés elegir otro?');

    patch.operacion = 'pendiente';
    await this.db.update('visitas', { id: `eq.${id}` }, patch);
    return { ok: true, visitaId: id };
  }

  // ─── Cancelar visita ───────────────────────────────────────────────────────

  /**
   * Cancela (soft delete) una visita por ID.
   * @param {number} id
   * @returns {Promise<VisitResult>}
   */
  async cancel(id) {
    if (!id) return _err('id_requerido', 'Necesito el ID de la visita para cancelarla.');

    try {
      const rows = await this.db.select('visitas', {
        select: 'id,operacion', id: `eq.${id}`, limit: 1,
      });
      if (!Array.isArray(rows) || rows.length === 0)
        return _err('visita_no_encontrada', 'No encontré una visita con ese ID.');
      if (rows[0].operacion === 'cancelado')
        return _err('ya_cancelada', 'Esa visita ya estaba cancelada.');
    } catch { /* non-fatal */ }

    await this.db.update('visitas', { id: `eq.${id}` }, { operacion: 'cancelado' });
    return { ok: true, visitaId: id };
  }

  // ─── Helpers privados ─────────────────────────────────────────────────────

  _parseDate(str) {
    if (!str) return null;
    const m = String(str).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    return null;
  }

  _parseTime(str) {
    if (!str) return null;
    const m = String(str).match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (!m) return null;
    const h = parseInt(m[1], 10), mn = parseInt(m[2], 10);
    if (h < 0 || h > 23 || mn < 0 || mn > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}`;
  }

  _isQuarterHour(horaHHMM) {
    const m = String(horaHHMM || '').match(/^(\d{2}):(\d{2})$/);
    if (!m) return false;
    const minutes = parseInt(m[2], 10);
    return minutes % 15 === 0;
  }

  _toMinutes(timeStr) {
    const [h, m] = (timeStr || '09:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  _validateBusinessHours(fechaISO, horaHHMM) {
    if (!fechaISO || !horaHHMM) return { ok: true };

    const date  = new Date(`${fechaISO}T00:00:00`);
    const dow   = date.getDay();  // 0 = Dom, 6 = Sáb
    const total = this._toMinutes(horaHHMM);

    if (dow === 0) {
      if (!this.hours.sunday)
        return _err('cerrado_domingo', 'No atendemos los domingos. ¿Te parece si buscamos otro día?');
      const { open, close } = this.hours.sunday;
      if (total < this._toMinutes(open) || total >= this._toMinutes(close))
        return _err('fuera_horario', `Los domingos atendemos de ${open} a ${close} hs.`);
    } else if (dow === 6) {
      if (!this.hours.saturday)
        return _err('cerrado_sabado', 'No atendemos los sábados. ¿Te parece si elegimos un día de semana?');
      const { open, close } = this.hours.saturday;
      if (total < this._toMinutes(open) || total >= this._toMinutes(close))
        return _err('fuera_horario', `Los sábados atendemos de ${open} a ${close} hs. ¿Querés otro horario?`);
    } else {
      const { open, close } = this.hours.weekdays || DEFAULT_HOURS.weekdays;
      if (total < this._toMinutes(open) || total > this._toMinutes(close))
        return _err('fuera_horario', `Atendemos de lunes a viernes de ${open} a ${close} hs. ¿Querés otro horario?`);
    }

    return { ok: true };
  }

  _phoneVariants(phone) {
    const clean = String(phone || '').replace(/\D/g, '');
    const variants = new Set([clean]);
    if (clean.length >= 10) variants.add(clean.slice(-10));
    if (clean.startsWith('549')) variants.add(clean.slice(3));
    if (clean.startsWith('54'))  variants.add(clean.slice(2));
    return [...variants].filter(Boolean);
  }
}

// ─── Helper interno ───────────────────────────────────────────────────────────
/** @typedef {{ ok: boolean, visitaId?: number, error?: string, msg?: string, duplicate?: boolean }} VisitResult */
function _err(error, msg) { return { ok: false, error, msg }; }
