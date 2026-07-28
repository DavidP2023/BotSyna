import { useEffect, useState } from 'react';
import { supabaseFetch, supabasePatch, supabaseDelete, fmt, TABLES } from '../lib.js';
import { Navbar, Spinner, EmptyState, ErrorPanel, Badge, StatCard, Btn } from './UI.jsx';
import { ModalVisita } from './ModalVisita.jsx';

export default function Visitas({ onBack }) {
  const [visitas, setVisitas] = useState([]);
  const [propiedades, setPropiedades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busqueda, setBusqueda] = useState('');
  const [filtro, setFiltro] = useState('todas');
  const [procesando, setProcesando] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editItem, setEditItem] = useState(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [v, p] = await Promise.all([supabaseFetch(TABLES.visits), supabaseFetch(TABLES.properties)]);
      setVisitas(v || []); setPropiedades(p || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    load();

    // Keep dashboard in sync with bot writes to Supabase.
    const intervalId = setInterval(() => {
      load();
    }, 10000);

    return () => clearInterval(intervalId);
  }, []);

  const cambiarOp = async (id, op) => {
    if (op === 'cancelado' && !confirm('¿Cancelar visita?')) return;
    setProcesando(id);
    try { await supabasePatch(TABLES.visits, id, { operacion: op }); await load(); }
    catch (e) { alert('Error: ' + e.message); }
    finally { setProcesando(null); }
  };

  const eliminar = async (id) => {
    if (!confirm('¿Eliminar esta visita definitivamente?')) return;
    setProcesando(id);
    try { await supabaseDelete(TABLES.visits, id); await load(); }
    catch (e) { alert('Error al eliminar: ' + e.message); }
    finally { setProcesando(null); }
  };

  const filtradas = visitas.filter(v => {
    if (filtro === 'pendientes' && v.operacion !== 'pendiente') return false;
    if (filtro === 'confirmadas' && v.operacion !== 'confirmado') return false;
    if (filtro === 'canceladas' && v.operacion !== 'cancelado') return false;
    if (busqueda) { const s = busqueda.toLowerCase(); return v.nombre?.toLowerCase().includes(s) || v.telefono?.toString().includes(s); }
    return true;
  });

  const pendientes = visitas.filter(v => v.operacion === 'pendiente').length;
  const confirmadas = visitas.filter(v => v.operacion === 'confirmado').length;
  const canceladas = visitas.filter(v => v.operacion === 'cancelado').length;

  const filters = [
    { id: 'todas', label: 'Todas' },
    { id: 'pendientes', label: '⏳ Pendientes' },
    { id: 'confirmadas', label: '✓ Confirmadas' },
    { id: 'canceladas', label: '✕ Canceladas' },
  ];

  return (
    <div className="min-h-screen bg-[#0f0f0f]">
      <Navbar
        title="Visitas"
        onBack={onBack}
        onRefresh={load}
        extra={<Btn onClick={() => setShowAdd(true)} className="mr-1 text-xs">📅 Agregar visita</Btn>}
      />
      <div className="max-w-screen-xl mx-auto p-6">
        <div className="grid grid-cols-4 gap-4 mb-6">
          <StatCard label="Total" value={visitas.length} color="gold" />
          <StatCard label="Pendientes" value={pendientes} color="amber" />
          <StatCard label="Confirmadas" value={confirmadas} color="green" />
          <StatCard label="Canceladas" value={canceladas} color="red" />
        </div>

        <div className="flex gap-3 flex-wrap mb-5">
          <input
            value={busqueda}
            onChange={e => setBusqueda(e.target.value)}
            placeholder="🔍 Buscar nombre o teléfono..."
            className="flex-1 min-w-[200px] bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#c4a36f] transition-colors"
          />
          <div className="flex gap-2 flex-wrap">
            {filters.map(f => (
              <button
                key={f.id}
                onClick={() => setFiltro(f.id)}
                className={`px-4 py-2 rounded-xl text-xs font-medium transition-all ${filtro === f.id ? 'bg-[#c4a36f] text-white' : 'bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/80'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white/4 border border-white/8 rounded-2xl overflow-hidden">
          {loading ? <Spinner /> : error ? <ErrorPanel msg={error} onRetry={load} />
            : filtradas.length === 0 ? <EmptyState icon="📅" text="Sin visitas" />
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/8">
                      {['ID','Fecha','Hora','Nombre','Teléfono','Propiedad','Estado','Acciones'].map(h => (
                        <th key={h} className="px-4 py-3.5 text-left text-xs text-white/30 uppercase tracking-widest font-medium whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtradas.map((v, i) => {
                      const prop = propiedades.find(p => p.id === v.id_propiedad);
                      const es = { pendiente: v.operacion === 'pendiente', confirmado: v.operacion === 'confirmado', cancelado: v.operacion === 'cancelado' };
                      return (
                        <tr key={v.id} className={`border-b border-white/5 hover:bg-white/4 transition-colors ${i % 2 === 0 ? '' : 'bg-white/2'}`}>
                          <td className="px-4 py-3 text-white/30 text-xs font-mono">#{v.id}</td>
                          <td className="px-4 py-3 text-white font-medium">{fmt.fecha(v.fecha)}</td>
                          <td className="px-4 py-3 text-white/60">{fmt.hora(v.hora)}</td>
                          <td className="px-4 py-3 text-white font-medium">{v.nombre}</td>
                          <td className="px-4 py-3 text-white/60 font-mono text-xs">{v.telefono || '—'}</td>
                          <td className="px-4 py-3 text-white/60 text-xs">
                            {prop ? <span>{prop.direccion} <span className="text-white/30">({prop.barrio})</span></span> : <span className="text-white/20">#{v.id_propiedad || '—'}</span>}
                          </td>
                          <td className="px-4 py-3"><Badge type={v.operacion || 'pendiente'} /></td>
                          <td className="px-4 py-3">
                            <div className="flex gap-2">
                              <button onClick={() => setEditItem(v)} className="px-2.5 py-1 bg-blue-500/15 hover:bg-blue-500/25 text-blue-400 text-xs rounded-lg transition-colors">✏️</button>
                              {es.pendiente && <>
                                <button onClick={() => cambiarOp(v.id, 'confirmado')} disabled={procesando === v.id} className="px-2.5 py-1 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-xs rounded-lg transition-colors disabled:opacity-40">✓</button>
                                <button onClick={() => cambiarOp(v.id, 'cancelado')} disabled={procesando === v.id} className="px-2.5 py-1 bg-red-500/15 hover:bg-red-500/25 text-red-400 text-xs rounded-lg transition-colors disabled:opacity-40">✕</button>
                              </>}
                              {(es.confirmado || es.cancelado) && (
                                <button onClick={() => cambiarOp(v.id, 'pendiente')} disabled={procesando === v.id} className="px-2.5 py-1 bg-white/8 hover:bg-white/12 text-white/50 text-xs rounded-lg transition-colors disabled:opacity-40">↺</button>
                              )}
                              <button onClick={() => eliminar(v.id)} disabled={procesando === v.id} className="px-2.5 py-1 bg-red-500/10 hover:bg-red-500/20 text-red-500 text-xs rounded-lg transition-colors disabled:opacity-40">🗑️</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </div>
        <p className="text-center text-white/20 text-xs mt-4 tracking-wider">
          Mostrando {filtradas.length} de {visitas.length} visitas
        </p>
      </div>

      {showAdd && <ModalVisita onClose={() => setShowAdd(false)} onSaved={load} propiedades={propiedades} />}
      {editItem && <ModalVisita onClose={() => setEditItem(null)} onSaved={load} initial={editItem} propiedades={propiedades} />}
    </div>
  );
}
