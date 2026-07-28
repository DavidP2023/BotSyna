import appConfig from './config.json';
import { supabase } from './lib/supabaseClient.js';

export const TABLES = {
  properties: appConfig?.tables?.properties || 'propiedades_v2',
  visits: appConfig?.tables?.visits || 'visitas',
  tenants: appConfig?.tables?.tenants || 'inquilinos',
  neighborhoods: appConfig?.tables?.neighborhoods || 'barrios',
};

// Filtros simples tipo PostgREST usados en este proyecto: "campo=eq.valor" (con o sin "&" inicial)
function parseFilter(filter) {
  const clean = filter.replace(/^&/, '');
  const [column, rest] = clean.split('=');
  const [op, value] = rest.split('.');
  return { column, op, value };
}

export const supabaseFetch = async (table, params = '') => {
  let query = supabase.from(table).select('*').order('id', { ascending: false });
  if (params) {
    const { column, op, value } = parseFilter(params);
    query = query[op](column, value);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
};

export const supabasePatch = async (table, id, data) => {
  const { data: res, error } = await supabase.from(table).update(data).eq('id', id).select();
  if (error) throw new Error(error.message);
  return res;
};

export const supabasePost = async (table, data) => {
  const { data: res, error } = await supabase.from(table).insert(data).select();
  if (error) throw new Error(error.message);
  return res;
};

export const supabaseDelete = async (table, id) => {
  const { error } = await supabase.from(table).delete().eq('id', id);
  if (error) throw new Error(error.message);
};

export const supabaseDeleteBy = async (table, filter) => {
  const { column, op, value } = parseFilter(filter);
  const { error } = await supabase.from(table).delete()[op](column, value);
  if (error) throw new Error(error.message);
};

// Workaround para secuencia de IDs desincronizada en Supabase:
// obtiene el ID más alto actual y devuelve max+1
export const getNextId = async (table) => {
  const { data, error } = await supabase
    .from(table)
    .select('id')
    .order('id', { ascending: false })
    .limit(1);
  if (error) return undefined; // dejamos que la DB lo asigne
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
