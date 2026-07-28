// Shared UI primitives

export function Spinner() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4">
      <div className="w-10 h-10 rounded-full border-2 border-white/10 border-t-[#c4a36f] animate-spin-smooth" />
      <p className="text-white/40 text-sm tracking-widest uppercase">Cargando...</p>
    </div>
  );
}

export function EmptyState({ icon, text }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4 text-white/30">
      <span className="text-5xl">{icon}</span>
      <p className="text-sm tracking-wider uppercase">{text}</p>
    </div>
  );
}

export function ErrorPanel({ msg, onRetry }) {
  return (
    <div className="m-6 p-6 bg-red-500/10 border border-red-500/30 rounded-lg">
      <p className="text-red-400 font-semibold mb-2">Error</p>
      <p className="text-white/60 text-sm mb-4">{msg}</p>
      <button onClick={onRetry} className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 text-sm rounded-lg transition-colors">
        Reintentar
      </button>
    </div>
  );
}

export function Badge({ type }) {
  const map = {
    disponible: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
    ocupado:    'bg-red-500/15 text-red-400 border border-red-500/30',
    pendiente:  'bg-amber-500/15 text-amber-400 border border-amber-500/30',
    confirmado: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
    cancelado:  'bg-red-500/15 text-red-400 border border-red-500/30',
  };
  const labels = { disponible:'Disponible', ocupado:'Ocupada', pendiente:'Pendiente', confirmado:'Confirmada', cancelado:'Cancelada' };
  return <span className={`px-2.5 py-1 text-xs rounded-full font-medium ${map[type]}`}>{labels[type]}</span>;
}

export function Modal({ title, onClose, children, footer }) {
  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl animate-slide-up">
        <div className="flex items-center justify-between p-6 border-b border-white/10">
          <h3 className="text-white font-semibold text-lg">{title}</h3>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center text-white/40 hover:text-white/90 hover:bg-white/10 rounded-lg transition-colors text-xl leading-none">×</button>
        </div>
        <div className="p-6">{children}</div>
        {footer && <div className="px-6 pb-6 flex gap-3 justify-end">{footer}</div>}
      </div>
    </div>
  );
}

export function FormField({ label, children }) {
  return (
    <div>
      <label className="block text-xs text-white/40 uppercase tracking-widest mb-1.5">{label}</label>
      {children}
    </div>
  );
}

export function Input({ className = '', ...props }) {
  return (
    <input
      className={`w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#c4a36f] transition-colors ${className}`}
      {...props}
    />
  );
}

export function Select({ className = '', children, ...props }) {
  return (
    <select
      className={`w-full bg-[#1a1a1a] border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-[#c4a36f] transition-colors ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

export function Textarea({ className = '', ...props }) {
  return (
    <textarea
      className={`w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#c4a36f] transition-colors resize-y min-h-[80px] ${className}`}
      {...props}
    />
  );
}

export function Btn({ variant = 'primary', className = '', children, ...props }) {
  const variants = {
    primary:   'bg-[#c4a36f] hover:bg-[#d4b88a] text-white',
    secondary: 'bg-white/10 hover:bg-white/15 text-white/80',
    danger:    'bg-red-500/20 hover:bg-red-500/30 text-red-400',
    success:   'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400',
    ghost:     'border border-white/10 hover:border-white/20 text-white/60 hover:text-white/80',
  };
  return (
    <button
      className={`px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-wait ${variants[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function StatCard({ label, value, color = 'gold' }) {
  const colors = {
    gold:    'border-t-[#c4a36f]',
    green:   'border-t-emerald-500',
    red:     'border-t-red-500',
    amber:   'border-t-amber-500',
    blue:    'border-t-blue-500',
  };
  return (
    <div className={`bg-white/5 border border-white/8 rounded-xl p-5 border-t-2 ${colors[color]}`}>
      <p className="text-xs text-white/40 uppercase tracking-widest mb-2">{label}</p>
      <p className="text-3xl font-bold text-white font-display">{value}</p>
    </div>
  );
}

export function Navbar({ title, onBack, onRefresh, extra }) {
  return (
    <nav className="sticky top-0 z-40 bg-[#0f0f0f]/90 backdrop-blur-xl border-b border-white/8 px-6 h-16 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="text-[#c4a36f] font-display text-lg font-bold">Salomon</span>
        <span className="text-white/20">|</span>
        <span className="text-white/70 text-sm">{title}</span>
      </div>
      <div className="flex items-center gap-2">
        {extra}
        <button onClick={onRefresh} className="w-9 h-9 flex items-center justify-center text-white/40 hover:text-white/80 hover:bg-white/8 rounded-lg transition-colors text-base">↺</button>
        <button onClick={onBack} className="flex items-center gap-1.5 px-3 py-1.5 border border-white/10 hover:border-white/20 text-white/60 hover:text-white/80 rounded-lg text-sm transition-colors">
          ← Volver
        </button>
      </div>
    </nav>
  );
}
