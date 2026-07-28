import appConfig from './config.json';

// Supabase config & helpers
export const SUPABASE_URL = appConfig?.supabase?.url || '';
export const SUPABASE_ANON_KEY = appConfig?.supabase?.anon_key || '';
export const SUPABASE_SERVICE_KEY = appConfig?.supabase?.service_role_key || '';

export const TABLES = {
  properties: appConfig?.tables?.properties || 'propiedades_v2',
  visits: appConfig?.tables?.visits || 'visitas',
  tenants: appConfig?.tables?.tenants || 'inquilinos',
  neighborhoods: appConfig?.tables?.neighborhoods || 'barrios',
};

const authHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

export const supabaseFetch = async (table, params = '') => {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=*&order=id.desc${params}`;
  const res = await fetch(url, { headers: authHeaders });
  if (!res.ok) throw new Error(`Error ${res.status}`);
  return res.json();
};

export const supabasePatch = async (table, id, data) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...authHeaders, Prefer: 'return=representation' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Error ${res.status}`);
  return res.json();
};

export const supabasePost = async (table, data) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...authHeaders, Prefer: 'return=representation' },
    body: JSON.stringify(data),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Error ${res.status}: ${t}`); }
  return res.json();
};

export const supabaseDelete = async (table, id) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'DELETE',
    headers: authHeaders,
  });
  if (!res.ok) throw new Error(`Error ${res.status}`);
};

export const supabaseDeleteBy = async (table, filter) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'DELETE',
    headers: authHeaders,
  });
  if (!res.ok) throw new Error(`Error ${res.status}`);
};

// Workaround para secuencia de IDs desincronizada en Supabase:
// obtiene el ID más alto actual y devuelve max+1
export const getNextId = async (table) => {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?select=id&order=id.desc&limit=1`,
    { headers: authHeaders }
  );
  if (!res.ok) return undefined; // dejamos que la DB lo asigne
  const data = await res.json();
  return data.length > 0 ? data[0].id + 1 : 1;
};

// Formatters
export const fmt = {
  fecha: (f) => { if (!f) return '—'; const [y, m, d] = f.split('-'); return `${d}/${m}/${y}`; },
  hora: (h) => h ? h.substring(0, 5) : '—',
  precio: (p) => p ? `$${Number(p).toLocaleString('es-AR')}` : 'Consultar',
  monto: (v) => v != null && v !== '' ? `$${Number(v).toLocaleString('es-AR')}` : '—',
};

export const BARRIOS = [
  'Alberdi','Alta Córdoba','Argüello','Cerro de las Rosas','Cofico',
  'General Paz','Güemes','Jardín','Las Rosas','Los Boulevares',
  'Nueva Córdoba','Poeta Lugones','Quintas de Santa Ana','San Vicente',
  'Urca','Valle Escondido','Villa Allende Parque','Villa Belgrano',
  'Villa Cabrera','Villa Eucarística','Villa Los Troncos','Villa Warcalde',
];
