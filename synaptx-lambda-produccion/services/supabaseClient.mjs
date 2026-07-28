// services/supabaseClient.mjs
// HTTP client base para Supabase PostgREST API.
// Todos los servicios del bot usan esta clase como capa de acceso a datos.

export class SupabaseError extends Error {
  constructor(op, table, status, body) {
    super(`Supabase ${op} ${table}: HTTP ${status} — ${String(body).slice(0, 200)}`);
    this.name   = 'SupabaseError';
    this.status = status;
    this.table  = table;
    this.op     = op;
  }
}

export class SupabaseClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.url              - Supabase project URL
   * @param {string} [cfg.service_role_key]
   * @param {string} [cfg.anon_key]
   */
  constructor({ url, service_role_key, anon_key } = {}) {
    if (!url) throw new Error('SupabaseClient: url is required');
    this.base = url.replace(/\/$/, '');
    this.key  = service_role_key || anon_key || '';
    this.headers = {
      apikey:          this.key,
      Authorization:   `Bearer ${this.key}`,
      'Content-Type':  'application/json',
      Prefer:          'return=representation',
    };
  }

  // ─── URL builder ─────────────────────────────────────────────────────────

  _url(table, params = {}) {
    const qp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qp.append(k, String(v));
    }
    const qs = qp.toString();
    return `${this.base}/rest/v1/${table}${qs ? '?' + qs : ''}`;
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  /**
   * SELECT rows from a table.
   * @param {string} table
   * @param {object} params - PostgREST query params (select, filters, limit, order…)
   * @returns {Promise<object[]>}
   */
  async select(table, params = {}) {
    const res = await fetch(this._url(table, params), { headers: this.headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new SupabaseError('select', table, res.status, body);
    }
    return res.json();
  }

  /**
   * INSERT a row (or rows) into a table.
   * @param {string} table
   * @param {object|object[]} data
   * @returns {Promise<object|object[]>}
   */
  async insert(table, data) {
    const res = await fetch(this._url(table), {
      method:  'POST',
      headers: this.headers,
      body:    JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new SupabaseError('insert', table, res.status, body);
    }
    return res.json();
  }

  /**
   * PATCH rows matching filters.
   * @param {string} table
   * @param {object} filters - PostgREST filters (e.g. { id: 'eq.5' })
   * @param {object} data    - Fields to update
   * @returns {Promise<object[]>}
   */
  async update(table, filters, data) {
    const res = await fetch(this._url(table, filters), {
      method:  'PATCH',
      headers: this.headers,
      body:    JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new SupabaseError('update', table, res.status, body);
    }
    return res.json();
  }

  /**
   * DELETE rows matching filters.
   * @param {string} table
   * @param {object} filters
   * @returns {Promise<true>}
   */
  async delete(table, filters) {
    const hdrs = { ...this.headers, Prefer: 'return=minimal' };
    const res = await fetch(this._url(table, filters), { method: 'DELETE', headers: hdrs });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new SupabaseError('delete', table, res.status, body);
    }
    return true;
  }
}
