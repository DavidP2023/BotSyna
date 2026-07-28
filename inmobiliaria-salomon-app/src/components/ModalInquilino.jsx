import { useState } from 'react';
import { supabaseFetch, supabasePost, supabasePatch, getNextId, fmt, TABLES } from '../lib.js';
import { Modal, FormField, Input, Btn } from './UI.jsx';

const emptyForm = {
  nombre: '', dni: '', contrato: '', id_propiedad: '',
  alquiler: '', impuestos: '', servicios: '',
};

export function ModalInquilino({ onClose, onSaved, initial = null, propiedades = [] }) {
  const isEdit = !!initial;
  const [form, setForm] = useState(initial ? {
    nombre: initial.nombre || '',
    dni: initial.dni ?? '',
    contrato: initial.contrato ?? '',
    id_propiedad: initial.id_propiedad ?? '',
    alquiler: initial.alquiler ?? '',
    impuestos: initial.impuestos ?? '',
    servicios: initial.servicios ?? '',
  } : { ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [propBusqueda, setPropBusqueda] = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const total = (parseFloat(form.alquiler)||0) + (parseFloat(form.impuestos)||0) + (parseFloat(form.servicios)||0);

  const propBusquedaL = propBusqueda.toLowerCase();
  const propiedadesFiltradas = propiedades.filter(p => 
    !propBusquedaL || 
    p.id.toString().includes(propBusquedaL) || 
    p.direccion?.toLowerCase().includes(propBusquedaL)
  );

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      if (!form.nombre.trim()) throw new Error('El nombre es obligatorio');
      if (!form.dni) throw new Error('El DNI es obligatorio');
      const fields = {
        nombre: form.nombre.trim(),
        dni: parseInt(form.dni),
        contrato: form.contrato ? parseInt(form.contrato) : null,
        id_propiedad: form.id_propiedad ? parseInt(form.id_propiedad) : null,
        alquiler: form.alquiler ? parseFloat(form.alquiler) : null,
        impuestos: form.impuestos ? parseFloat(form.impuestos) : null,
        servicios: form.servicios ? parseFloat(form.servicios) : null,
      };

      if (fields.id_propiedad) {
        const exist = await supabaseFetch(TABLES.tenants, `&id_propiedad=eq.${fields.id_propiedad}`);
        const occupier = isEdit ? exist.find(x => x.id !== initial.id) : exist.length > 0;
        if (occupier) {
          throw new Error('Esta propiedad ya tiene un inquilino asignado. Debes desvincular al inquilino actual para poder asignársela a otro.');
        }
      }

      if (isEdit) {
        await supabasePatch(TABLES.tenants, initial.id, fields);
      } else {
        const idToUse = fields.id_propiedad ? fields.id_propiedad : await getNextId(TABLES.tenants);
        try {
          await supabasePost(TABLES.tenants, idToUse ? { id: idToUse, ...fields } : fields);
        } catch (postErr) {
          if (postErr.message.includes('409') || postErr.message.includes('duplicate key')) {
            throw new Error(`El ID ${idToUse} de la propiedad ya está en uso por otro inquilino. Debes eliminarlo primero.`);
          }
          throw postErr;
        }
      }
      onSaved();
      onClose();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <Modal
      title={isEdit ? '✏️ Editar Inquilino' : '👤 Nuevo Inquilino'}
      onClose={onClose}
      footer={
        <>
          <Btn variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Btn>
          <Btn onClick={save} disabled={saving}>{saving ? 'Guardando...' : isEdit ? '✅ Actualizar' : '✅ Crear'}</Btn>
        </>
      }
    >
      {err && <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg">{err}</div>}
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Nombre completo *">
            <Input placeholder="Juan Pérez" value={form.nombre} onChange={e => set('nombre', e.target.value)} />
          </FormField>
          <FormField label="DNI *">
            <Input type="number" placeholder="12345678" value={form.dni} onChange={e => set('dni', e.target.value)} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="N° Contrato">
            <Input type="number" placeholder="1001" value={form.contrato} onChange={e => set('contrato', e.target.value)} />
          </FormField>
          <FormField label="Propiedad">
            <div className="flex flex-col gap-2">
              <input
                type="text"
                placeholder="🔍 Filtrar ID o dirección..."
                value={propBusqueda}
                onChange={e => setPropBusqueda(e.target.value)}
                className="w-full bg-[#1a1a1a] border border-white/10 rounded-lg px-3 py-2 text-white text-xs placeholder-white/20 focus:outline-none focus:border-[#c4a36f] transition-colors"
              />
              <select
                value={form.id_propiedad}
                onChange={e => set('id_propiedad', e.target.value)}
                className="w-full bg-[#1a1a1a] border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-[#c4a36f] transition-colors"
              >
                <option value="">Sin asignar</option>
                {propiedadesFiltradas.map(p => <option key={p.id} value={p.id}>#{p.id} — {p.direccion}</option>)}
              </select>
            </div>
          </FormField>
        </div>
        <div className="p-4 bg-white/4 border border-[#c4a36f]/20 rounded-xl">
          <p className="text-xs text-white/40 uppercase tracking-widest mb-3">💰 Importes mensuales</p>
          <div className="grid grid-cols-3 gap-3">
            <FormField label="🏠 Alquiler"><Input type="number" placeholder="0" value={form.alquiler} onChange={e => set('alquiler', e.target.value)} /></FormField>
            <FormField label="💡 Impuestos"><Input type="number" placeholder="0" value={form.impuestos} onChange={e => set('impuestos', e.target.value)} /></FormField>
            <FormField label="🔧 Servicios"><Input type="number" placeholder="0" value={form.servicios} onChange={e => set('servicios', e.target.value)} /></FormField>
          </div>
          {total > 0 && (
            <div className="mt-3 pt-3 border-t border-white/10 flex justify-between items-center">
              <span className="text-xs text-white/40 uppercase tracking-widest">Total mensual</span>
              <span className="text-[#c4a36f] font-bold text-base">{fmt.monto(total)}</span>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
