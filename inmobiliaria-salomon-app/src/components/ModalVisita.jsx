import { useState } from 'react';
import { supabasePost, supabasePatch, TABLES } from '../lib.js';
import { Modal, FormField, Input, Select, Btn } from './UI.jsx';

const emptyForm = {
  nombre: '', telefono: '', fecha: '', hora: '', id_propiedad: '', operacion: 'pendiente',
};

export function ModalVisita({ onClose, onSaved, initial = null, propiedades = [] }) {
  const isEdit = !!initial;
  const [form, setForm] = useState(initial ? {
    nombre: initial.nombre || '',
    telefono: initial.telefono || '',
    fecha: initial.fecha || '',
    hora: initial.hora ? initial.hora.substring(0,5) : '',
    id_propiedad: initial.id_propiedad ?? '',
    operacion: initial.operacion || 'pendiente',
  } : { ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      if (!form.nombre.trim()) throw new Error('El nombre es obligatorio');
      if (!form.fecha) throw new Error('La fecha es obligatoria');
      const data = {
        nombre: form.nombre.trim(),
        telefono: form.telefono.trim() || null,
        fecha: form.fecha,
        hora: form.hora || null,
        id_propiedad: form.id_propiedad ? parseInt(form.id_propiedad) : null,
        operacion: form.operacion,
      };
      if (isEdit) await supabasePatch(TABLES.visits, initial.id, data);
      else await supabasePost(TABLES.visits, data);
      onSaved();
      onClose();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <Modal
      title={isEdit ? '✏️ Editar Visita' : '📅 Nueva Visita'}
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
          <FormField label="Nombre *">
            <Input placeholder="Juan García" value={form.nombre} onChange={e => set('nombre', e.target.value)} />
          </FormField>
          <FormField label="Teléfono">
            <Input placeholder="3512345678" value={form.telefono} onChange={e => set('telefono', e.target.value)} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Fecha *">
            <Input type="date" value={form.fecha} onChange={e => set('fecha', e.target.value)} />
          </FormField>
          <FormField label="Hora">
            <Input type="time" value={form.hora} onChange={e => set('hora', e.target.value)} />
          </FormField>
        </div>
        <FormField label="Propiedad">
          <Select value={form.id_propiedad} onChange={e => set('id_propiedad', e.target.value)}>
            <option value="">Sin asignar</option>
            {propiedades.map(p => (
              <option key={p.id} value={p.id}>#{p.id} — {p.direccion} ({p.barrio})</option>
            ))}
          </Select>
        </FormField>
        <FormField label="Estado">
          <Select value={form.operacion} onChange={e => set('operacion', e.target.value)}>
            <option value="pendiente">Pendiente</option>
            <option value="confirmado">Confirmada</option>
            <option value="cancelado">Cancelada</option>
          </Select>
        </FormField>

      </div>
    </Modal>
  );
}
