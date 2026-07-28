import { useState, useEffect } from 'react';
import { supabaseFetch, supabasePost, supabasePatch, getNextId, fmt, TABLES } from '../lib.js';
import { Modal, FormField, Input, Select, Textarea, Btn } from './UI.jsx';

const emptyForm = {
  tipologia: 'departamento', operacion: 'alquiler', direccion: '', barrio: '',
  ambientes: '', dormitorios: '', descripcion: '', apto_banco: false,
  precio: '', cod_zp: '', cod_lvi: '', link_interno: '', requisitos: '',
};

export function ModalPropiedad({ onClose, onSaved, initial = null }) {
  const isEdit = !!initial;
  const [form, setForm] = useState(initial ? {
    tipologia: initial.tipologia || 'departamento',
    operacion: initial.operacion || 'alquiler',
    direccion: initial.direccion || '',
    barrio: initial.barrio || '',
    ambientes: initial.ambientes ?? '',
    dormitorios: initial.dormitorios ?? '',
    descripcion: initial.descripcion || '',
    apto_banco: initial.apto_banco || false,
    precio: initial.precio ?? '',
    cod_zp: initial.cod_zp || '',
    cod_lvi: initial.cod_lvi || '',
    link_interno: initial.link_interno || '',
    requisitos: initial.requisitos || '',
  } : { ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [dbBarrios, setDbBarrios] = useState([]);
  const [otroBarrio, setOtroBarrio] = useState('');

  useEffect(() => {
    supabaseFetch(TABLES.neighborhoods)
      .then(res => {
        let list = res.map(b => b.nombre).filter(Boolean);
        list = list.filter(b => b.toLowerCase() !== 'otros');
        list.sort((a, b) => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' }));
        setDbBarrios(list);
      })
      .catch(console.error);
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      if (!form.direccion.trim()) throw new Error('La dirección es obligatoria');
      
      let finalBarrio = form.barrio;
      if (form.barrio === 'Otros') {
         if (!otroBarrio.trim()) throw new Error('Debe especificar el nombre del nuevo barrio');
         finalBarrio = otroBarrio.trim();
         try {
           await supabasePost(TABLES.neighborhoods, { nombre: finalBarrio });
         } catch(e) {
           console.log('Error agregando nuevo barrio:', e);
         }
      } else if (!finalBarrio) {
         throw new Error('El barrio es obligatorio');
      }

      const data = {
        tipologia: form.tipologia,
        operacion: form.operacion || null,
        direccion: form.direccion.trim(),
        barrio: finalBarrio,
        ambientes: form.ambientes ? parseInt(form.ambientes) : null,
        dormitorios: form.dormitorios ? parseInt(form.dormitorios) : null,
        descripcion: form.descripcion.trim() || null,
        apto_banco: form.apto_banco ? 1 : 0,
        precio: form.precio ? parseFloat(form.precio) : null,
        cod_zp: form.cod_zp.trim() || null,
        cod_lvi: form.cod_lvi.trim() || null,
        link_interno: form.link_interno.trim() || null,
        requisitos: form.requisitos.trim() || null,
      };
      if (isEdit) {
        await supabasePatch(TABLES.properties, initial.id, data);
      } else {
        const nextId = await getNextId(TABLES.properties);
        await supabasePost(TABLES.properties, nextId ? { id: nextId, ...data } : data);
      }
      onSaved();
      onClose();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <Modal
      title={isEdit ? '✏️ Editar Propiedad' : '➕ Nueva Propiedad'}
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
          <FormField label="Tipología">
            <Select value={form.tipologia} onChange={e => set('tipologia', e.target.value)}>
              {['departamento','casa','ph','local','cochera'].map(v => <option key={v} value={v}>{v.charAt(0).toUpperCase()+v.slice(1)}</option>)}
            </Select>
          </FormField>
          <FormField label="Operación">
            <Select value={form.operacion} onChange={e => set('operacion', e.target.value)}>
              <option value="alquiler">Alquiler</option>
              <option value="venta">Venta</option>
            </Select>
          </FormField>
        </div>
        <FormField label="Dirección *">
          <Input placeholder="Av. Colón 1234" value={form.direccion} onChange={e => set('direccion', e.target.value)} />
        </FormField>
        <FormField label="Barrio *">
          <Select value={form.barrio} onChange={e => { set('barrio', e.target.value); if(e.target.value !== 'Otros') setOtroBarrio(''); }}>
            <option value="">Seleccionar...</option>
            {dbBarrios.map(b => <option key={b} value={b}>{b}</option>)}
            <option value="Otros">⚡ Otros (ingresar manualmente...)</option>
          </Select>
          {form.barrio === 'Otros' && (
            <div className="mt-2">
              <Input placeholder="Nombre del nuevo barrio..." value={otroBarrio} onChange={e => setOtroBarrio(e.target.value)} />
            </div>
          )}
        </FormField>
        <div className="grid grid-cols-3 gap-3">
          <FormField label="Ambientes"><Input type="number" value={form.ambientes} onChange={e => set('ambientes', e.target.value)} /></FormField>
          <FormField label="Dormitorios"><Input type="number" value={form.dormitorios} onChange={e => set('dormitorios', e.target.value)} /></FormField>
          <FormField label="Precio ($)"><Input type="number" value={form.precio} onChange={e => set('precio', e.target.value)} /></FormField>
        </div>
        <FormField label="Descripción">
          <Textarea value={form.descripcion} onChange={e => set('descripcion', e.target.value)} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Cód. Zonaprop"><Input value={form.cod_zp} onChange={e => set('cod_zp', e.target.value)} /></FormField>
          <FormField label="Cód. La Voz"><Input value={form.cod_lvi} onChange={e => set('cod_lvi', e.target.value)} /></FormField>
        </div>
        <FormField label="URL Imagen"><Input value={form.link_interno} onChange={e => set('link_interno', e.target.value)} /></FormField>
        <FormField label="Requisitos"><Textarea value={form.requisitos} onChange={e => set('requisitos', e.target.value)} /></FormField>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" className="w-4 h-4 accent-[#c4a36f]" checked={form.apto_banco} onChange={e => set('apto_banco', e.target.checked)} />
          <span className="text-sm text-white/70">Apto Banco</span>
        </label>
      </div>
    </Modal>
  );
}
