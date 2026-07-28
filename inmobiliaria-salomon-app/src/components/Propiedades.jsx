import { useEffect, useState, useRef } from 'react';
import { supabaseFetch, supabasePatch, supabaseDelete, supabaseDeleteBy, supabasePost, fmt, TABLES } from '../lib.js';
import { Navbar, Spinner, EmptyState, ErrorPanel, Badge, StatCard, Btn } from './UI.jsx';
import { ModalPropiedad } from './ModalPropiedad.jsx';
import { exportToExcel, importFromExcel } from '../excelUtils.js';

export default function Propiedades({ onBack }) {
  const [propiedades, setPropiedades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busqueda, setBusqueda] = useState('');
  const [filtro, setFiltro] = useState('todas');
  const [procesando, setProcesando] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [showOpModal, setShowOpModal] = useState(false);
  const [propTemp, setPropTemp] = useState(null);
  const fileInputRef = useRef(null);

  const load = async () => {
    setLoading(true); setError(null);
    try { setPropiedades(await supabaseFetch(TABLES.properties)); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleExport = () => {
    exportToExcel(propiedades, 'Propiedades');
  };

  const handleImport = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    if (!confirm('¿Estás seguro de que deseas importar estos datos? Se añadirán como nuevas propiedades.')) {
      e.target.value = '';
      return;
    }

    setLoading(true);
    try {
      const data = await importFromExcel(file);
      if (data.length === 0) throw new Error('El archivo está vacío');

      const toInsert = data.map(item => ({
        ...item,
      }));

      await supabasePost(TABLES.properties, toInsert);
      alert(`${toInsert.length} propiedades importadas con éxito`);
      await load();
    } catch (err) {
      alert('Error en la importación: ' + err.message);
    } finally {
      setLoading(false);
      e.target.value = '';
    }
  };

  const toggle = (p) => {
    if (p.operacion === null) { setPropTemp(p); setShowOpModal(true); }
    else { if (!confirm('¿Marcar como ocupada?')) return; cambiarOp(p.id, null); }
  };
  const cambiarOp = async (id, op) => {
    setProcesando(id);
    try { await supabasePatch(TABLES.properties, id, { operacion: op }); await load(); setShowOpModal(false); setPropTemp(null); }
    catch (e) { alert('Error: ' + e.message); }
    finally { setProcesando(null); }
  };

  const eliminar = async (id) => {
    if (!confirm('¿Eliminar esta propiedad definitivamente? Esta acción no se puede deshacer.')) return;
    setProcesando(id);
    try { 
      await supabaseDelete(TABLES.properties, id); 
      await load(); 
    } catch (e) {
      if (e.message.includes('409')) {
        if (confirm('⚠️ Esta propiedad tiene visitas o inquilinos asociados.\n\n¿Deseas FORZAR la eliminación borrando también todo su historial asociado (visitas e inquilinos)?\n\nEsta acción es irreversible.')) {
           try {
             setProcesando(id);
             await supabaseDeleteBy(TABLES.visits, `id_propiedad=eq.${id}`);
             await supabaseDeleteBy(TABLES.tenants, `id_propiedad=eq.${id}`);
             await supabaseDelete(TABLES.properties, id);
             await load();
           } catch (err) {
             alert('Error al forzar la eliminación: ' + err.message);
           }
        }
      } else {
        alert('Error al eliminar: ' + e.message); 
      }
    } finally { 
      setProcesando(null); 
    }
  };

  const filtradas = propiedades.filter(p => {
    if (filtro === 'disponibles' && p.operacion === null) return false;
    if (filtro === 'ocupadas' && p.operacion !== null) return false;
    if (busqueda) { 
      const s = busqueda.toLowerCase().trim(); 
      if (/^\d+$/.test(s)) {
        return p.id?.toString().startsWith(s);
      }
      return p.direccion?.toLowerCase().includes(s) || p.barrio?.toLowerCase().includes(s); 
    }
    return true;
  });
  const disponibles = propiedades.filter(p => p.operacion !== null).length;
  const ocupadas = propiedades.filter(p => p.operacion === null).length;

  const filters = [
    { id: 'todas', label: 'Todas' },
    { id: 'disponibles', label: '🟢 Disponibles' },
    { id: 'ocupadas', label: '🔴 Ocupadas' },
  ];

  return (
    <div className="min-h-screen bg-[#0f0f0f]">
      <Navbar
        title="Propiedades"
        onBack={onBack}
        onRefresh={load}
        extra={<Btn onClick={() => setShowAdd(true)} className="mr-1 text-xs">➕ Agregar propiedad</Btn>}
      />
      <div className="max-w-screen-xl mx-auto p-6">
        <div className="grid grid-cols-3 gap-4 mb-6">
          <StatCard label="Total" value={propiedades.length} color="gold" />
          <StatCard label="Disponibles" value={disponibles} color="green" />
          <StatCard label="Ocupadas" value={ocupadas} color="red" />
        </div>

        {/* Toolbar */}
        <div className="flex gap-3 flex-wrap mb-5">
          <input
            value={busqueda}
            onChange={e => setBusqueda(e.target.value)}
            placeholder="🔍 Buscar por ID, dirección o barrio..."
            className="flex-1 min-w-[200px] bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#c4a36f] transition-colors"
          />
          <div className="flex gap-2">
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

          <div className="flex gap-2 border-l border-white/10 pl-3">
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleImport} 
              accept=".xlsx,.xls,.csv" 
              className="hidden" 
            />
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-xs font-medium rounded-xl transition-all border border-emerald-500/20"
            >
              📥 Importar
            </button>
            <button 
              onClick={handleExport}
              className="px-4 py-2 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 text-xs font-medium rounded-xl transition-all border border-blue-500/20"
            >
              📤 Exportar
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white/4 border border-white/8 rounded-2xl overflow-hidden">
          {loading ? <Spinner /> : error ? <ErrorPanel msg={error} onRetry={load} />
            : filtradas.length === 0 ? <EmptyState icon="🏠" text="Sin propiedades" />
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/8">
                      {['ID','Tipo','Operación','Dirección','Barrio','Amb','Dorm','Precio','Banco','Estado','Acciones'].map(h => (
                        <th key={h} className="px-4 py-3.5 text-left text-xs text-white/30 uppercase tracking-widest font-medium whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtradas.map((p, i) => {
                      const esOcupada = p.operacion === null;
                      return (
                        <tr key={p.id} className={`border-b border-white/5 hover:bg-white/4 transition-colors ${i % 2 === 0 ? '' : 'bg-white/2'}`}>
                          <td className="px-4 py-3 text-white/30 text-xs font-mono">#{p.id}</td>
                          <td className="px-4 py-3"><span className="px-2 py-0.5 bg-white/8 text-white/60 text-xs rounded-md capitalize">{p.tipologia}</span></td>
                          <td className="px-4 py-3 text-white/60 capitalize">{p.operacion || '—'}</td>
                          <td className="px-4 py-3 text-white font-medium">{p.direccion}</td>
                          <td className="px-4 py-3 text-white/60">{p.barrio}</td>
                          <td className="px-4 py-3 text-center text-white/60">{p.ambientes || '—'}</td>
                          <td className="px-4 py-3 text-center text-white/60">{p.dormitorios || '—'}</td>
                          <td className="px-4 py-3 text-[#c4a36f] font-semibold">{fmt.precio(p.precio)}</td>
                          <td className="px-4 py-3 text-center">{p.apto_banco ? <span className="text-emerald-400">✓</span> : <span className="text-white/20">—</span>}</td>
                          <td className="px-4 py-3"><Badge type={esOcupada ? 'ocupado' : 'disponible'} /></td>
                          <td className="px-4 py-3">
                            <div className="flex gap-2">
                              <button
                                onClick={() => setEditItem(p)}
                                className="px-2.5 py-1 bg-blue-500/15 hover:bg-blue-500/25 text-blue-400 text-xs rounded-lg transition-colors"
                              >✏️</button>
                              <button
                                onClick={() => toggle(p)}
                                disabled={procesando === p.id}
                                className={`px-2.5 py-1 text-xs rounded-lg transition-colors disabled:opacity-40 ${esOcupada ? 'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400' : 'bg-red-500/15 hover:bg-red-500/25 text-red-400'}`}
                              >
                                {procesando === p.id ? '...' : esOcupada ? '🟢 Liberar' : '🔴 Ocupar'}
                              </button>
                              <button
                                onClick={() => eliminar(p.id)}
                                disabled={procesando === p.id}
                                className="px-2.5 py-1 bg-red-500/10 hover:bg-red-500/20 text-red-500 text-xs rounded-lg transition-colors disabled:opacity-40"
                              >🗑️</button>
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
          Mostrando {filtradas.length} de {propiedades.length} propiedades
        </p>
      </div>

      {/* Modal operacion */}
      {showOpModal && propTemp && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 w-full max-w-sm shadow-2xl animate-slide-up">
            <h3 className="text-white font-semibold text-lg mb-2">Liberar propiedad</h3>
            <p className="text-white/50 text-sm mb-6">¿Para qué operación deseas marcar esta propiedad como disponible?</p>
            <div className="flex gap-3">
              <button onClick={() => cambiarOp(propTemp.id, 'alquiler')} disabled={!!procesando} className="flex-1 py-3 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-xl font-medium transition-colors disabled:opacity-40">🏠 Alquiler</button>
              <button onClick={() => cambiarOp(propTemp.id, 'venta')} disabled={!!procesando} className="flex-1 py-3 bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 rounded-xl font-medium transition-colors disabled:opacity-40">💰 Venta</button>
            </div>
            <button onClick={() => { setShowOpModal(false); setPropTemp(null); }} className="w-full mt-3 py-2 text-white/40 hover:text-white/60 text-sm transition-colors">Cancelar</button>
          </div>
        </div>
      )}

      {showAdd && <ModalPropiedad onClose={() => setShowAdd(false)} onSaved={load} />}
      {editItem && <ModalPropiedad onClose={() => setEditItem(null)} onSaved={load} initial={editItem} />}
    </div>
  );
}
