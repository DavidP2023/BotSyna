import { useEffect, useState, useRef } from 'react';
import { supabaseFetch, supabaseDelete, supabasePost, fmt, TABLES } from '../lib.js';
import { Navbar, Spinner, EmptyState, ErrorPanel, StatCard, Btn } from './UI.jsx';
import { ModalInquilino } from './ModalInquilino.jsx';
import { exportToExcel, importFromExcel } from '../excelUtils.js';

export default function Inquilinos({ onBack }) {
  const [inquilinos, setInquilinos] = useState([]);
  const [propiedades, setPropiedades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busqueda, setBusqueda] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [procesando, setProcesando] = useState(null);
  const fileInputRef = useRef(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [inq, props] = await Promise.all([supabaseFetch(TABLES.tenants), supabaseFetch(TABLES.properties)]);
      setInquilinos(inq || []);
      setPropiedades(props || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleExport = () => {
    // Para inquilinos, tal vez sea útil exportar también la dirección de la propiedad
    // pero el usuario pidió "como está la base de datos", así que exportamos el array directo.
    exportToExcel(inquilinos, 'Inquilinos');
  };

  const handleImport = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    if (!confirm('¿Estás seguro de que deseas importar estos datos? Se añadirán como nuevos inquilinos.')) {
      e.target.value = '';
      return;
    }

    setLoading(true);
    try {
      const data = await importFromExcel(file);
      if (data.length === 0) throw new Error('El archivo está vacío');

      await supabasePost(TABLES.tenants, data);
      alert(`${data.length} inquilinos importados con éxito`);
      await load();
    } catch (err) {
      alert('Error en la importación: ' + err.message);
    } finally {
      setLoading(false);
      e.target.value = '';
    }
  };

  const eliminar = async (id) => {
    if (!confirm('¿Eliminar este inquilino definitivamente?')) return;
    setProcesando(id);
    try { await supabaseDelete(TABLES.tenants, id); await load(); }
    catch (e) { alert('Error al eliminar: ' + e.message); }
    finally { setProcesando(null); }
  };

  const filtrados = inquilinos.filter(i => {
    if (!busqueda) return true;
    const s = busqueda.toLowerCase().trim();
    return i.dni?.toString().startsWith(s) || i.id_propiedad?.toString().startsWith(s);
  });

  const totalAlquiler = inquilinos.reduce((s, i) => s + (Number(i.alquiler) || 0), 0);

  return (
    <div className="min-h-screen bg-[#0f0f0f]">
      <Navbar
        title="Inquilinos"
        onBack={onBack}
        onRefresh={load}
        extra={<Btn onClick={() => setShowAdd(true)} className="mr-1 text-xs">👤 Agregar inquilino</Btn>}
      />
      <div className="max-w-screen-xl mx-auto p-6">
        <div className="grid grid-cols-2 gap-4 mb-6">
          <StatCard label="Total inquilinos" value={inquilinos.length} color="gold" />
          <StatCard label="Recaudación mensual" value={fmt.monto(totalAlquiler)} color="blue" />
        </div>

        <div className="flex gap-3 mb-5">
          <input
            value={busqueda}
            onChange={e => setBusqueda(e.target.value)}
            placeholder="🔍 Buscar por DNI o ID Propiedad..."
            className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#c4a36f] transition-colors"
          />
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

        <div className="bg-white/4 border border-white/8 rounded-2xl overflow-hidden">
          {loading ? <Spinner /> : error ? <ErrorPanel msg={error} onRetry={load} />
            : filtrados.length === 0 ? <EmptyState icon="👥" text="Sin inquilinos" />
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/8">
                      {['ID','Nombre','DNI','Contrato','ID Prop.','Dirección','🏠 Alquiler','💡 Impuestos','🔧 Servicios','💰 Total','Acciones'].map(h => (
                        <th key={h} className="px-4 py-3.5 text-left text-xs text-white/30 uppercase tracking-widest font-medium whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtrados.map((inq, i) => {
                      const total = (Number(inq.alquiler)||0) + (Number(inq.impuestos)||0) + (Number(inq.servicios)||0);
                      const prop = propiedades.find(p => p.id === inq.id_propiedad);
                      return (
                        <tr key={inq.id} className={`border-b border-white/5 hover:bg-white/4 transition-colors ${i % 2 === 0 ? '' : 'bg-white/2'}`}>
                          <td className="px-4 py-3 text-white/30 text-xs font-mono">#{inq.id}</td>
                          <td className="px-4 py-3 text-white font-medium">{inq.nombre}</td>
                          <td className="px-4 py-3 text-white/60 font-mono text-xs">{inq.dni}</td>
                          <td className="px-4 py-3 text-white/40">{inq.contrato || '—'}</td>
                          <td className="px-4 py-3 text-[#c4a36f] text-xs font-mono font-medium">{inq.id_propiedad ? `#${inq.id_propiedad}` : '—'}</td>
                          <td className="px-4 py-3 text-white/50 text-xs">
                            {prop ? prop.direccion : '—'}
                          </td>
                          <td className="px-4 py-3 text-blue-400 font-semibold">{fmt.monto(inq.alquiler)}</td>
                          <td className="px-4 py-3 text-amber-400 font-semibold">{fmt.monto(inq.impuestos)}</td>
                          <td className="px-4 py-3 text-emerald-400 font-semibold">{fmt.monto(inq.servicios)}</td>
                          <td className="px-4 py-3">
                            <span className="text-[#c4a36f] font-bold">{total > 0 ? fmt.monto(total) : '—'}</span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex gap-2">
                              <button
                                onClick={() => setEditItem(inq)}
                                className="px-3 py-1 bg-blue-500/15 hover:bg-blue-500/25 text-blue-400 text-xs rounded-lg transition-colors"
                              >✏️</button>
                              <button
                                onClick={() => eliminar(inq.id)}
                                disabled={procesando === inq.id}
                                className="px-3 py-1 bg-red-500/10 hover:bg-red-500/20 text-red-500 text-xs rounded-lg transition-colors disabled:opacity-40"
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

        {/* Resumen */}
        {filtrados.length > 0 && (
          <div className="mt-4 p-4 bg-white/4 border border-white/8 rounded-xl flex flex-wrap gap-6">
            <div>
              <p className="text-xs text-white/30 uppercase tracking-widest mb-1">Total alquileres</p>
              <p className="text-blue-400 font-bold">{fmt.monto(filtrados.reduce((s,i) => s+(Number(i.alquiler)||0), 0))}</p>
            </div>
            <div>
              <p className="text-xs text-white/30 uppercase tracking-widest mb-1">Total impuestos</p>
              <p className="text-amber-400 font-bold">{fmt.monto(filtrados.reduce((s,i) => s+(Number(i.impuestos)||0), 0))}</p>
            </div>
            <div>
              <p className="text-xs text-white/30 uppercase tracking-widest mb-1">Total servicios</p>
              <p className="text-emerald-400 font-bold">{fmt.monto(filtrados.reduce((s,i) => s+(Number(i.servicios)||0), 0))}</p>
            </div>
            <div className="ml-auto">
              <p className="text-xs text-white/30 uppercase tracking-widest mb-1">Total general</p>
              <p className="text-[#c4a36f] font-bold text-lg">{fmt.monto(filtrados.reduce((s,i) => s+(Number(i.alquiler)||0)+(Number(i.impuestos)||0)+(Number(i.servicios)||0), 0))}</p>
            </div>
          </div>
        )}
        <p className="text-center text-white/20 text-xs mt-4 tracking-wider">
          Mostrando {filtrados.length} de {inquilinos.length} inquilinos
        </p>
      </div>

      {showAdd && <ModalInquilino onClose={() => setShowAdd(false)} onSaved={load} propiedades={propiedades} />}
      {editItem && <ModalInquilino onClose={() => setEditItem(null)} onSaved={load} initial={editItem} propiedades={propiedades} />}
    </div>
  );
}
