import { useNavigate } from 'react-router-dom';

const cards = [
  { id: 'propiedades', icon: '🏠', title: 'Propiedades', desc: 'Gestión de stock y disponibilidad' },
  { id: 'visitas',      icon: '📅', title: 'Visitas',      desc: 'Visitas agendadas — manual o bot' },
  { id: 'inquilinos',   icon: '👥', title: 'Inquilinos',   desc: 'Gestión de pagos y expensas' },
];

export default function Home() {
  const navigate = useNavigate();

  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-[#070707] flex flex-col items-center justify-center relative overflow-hidden font-sans">
      {/* Dynamic blurred glowing orbs */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-[#c4a36f]/10 rounded-full blur-[120px] pointer-events-none" />

      {/* Subtle grid */}
      <div className="absolute inset-0 pointer-events-none bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxwYXRoIGQ9Ik02MCAwaC0xdjYwaDFWMHoiIGZpbGw9InJnYmEoMjU1LDI1NSwyNTUsMC4wMykiLz4KPHBhdGggZD0iTTAgNjBoNjB2LTFIMHYxem0wIDBsMS0xLTEgMXoiIGZpbGw9InJnYmEoMjU1LDI1NSwyNTUsMC4wMykiLz4KPC9zdmc+')] opacity-50" />

      {/* Main Container */}
      <div className="relative z-10 w-full max-w-5xl px-6 flex flex-col md:flex-row items-center gap-12 lg:gap-24">

        {/* Left: Branding & Welcome */}
        <div className="flex-1 text-left">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs font-medium text-white/70 mb-6">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            Sistema Activo
          </div>
          <h1 className="font-display text-white text-5xl md:text-7xl font-bold leading-tight mb-4 tracking-tight">
            Gestión <br/>
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#c4a36f] to-[#e8d1a7]">
              de Datos Inmobiliarios
            </span>
          </h1>
          <p className="text-white/50 text-base md:text-lg max-w-sm mb-8 leading-relaxed font-light">
            Control de propiedades, visitas agendadas y gestión de inquilinos.
          </p>
          <div className="flex items-center gap-4 text-sm text-white/40">
            <span className="font-medium text-white/60">Salomon Propiedades</span>
            <span className="w-1 h-1 rounded-full bg-white/20" />
            <span>Córdoba, AR</span>
          </div>
        </div>

        {/* Right: Interactive Modules */}
        <div className="flex-1 w-full grid gap-4">
          {cards.map((c, i) => (
            <button
              key={c.id}
              onClick={() => navigate(`/${c.id}`)}
              className="group relative w-full text-left p-6 rounded-2xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] hover:border-[#c4a36f]/30 transition-all duration-300 overflow-hidden"
              style={{ animationDelay: `${i * 100}ms` }}
            >
              <div className="absolute inset-0 bg-gradient-to-r from-[#c4a36f]/0 via-[#c4a36f]/0 to-[#c4a36f]/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
              <div className="relative z-10 flex items-center justify-between">
                <div className="flex items-center gap-5">
                  <div className="w-14 h-14 rounded-xl bg-black/40 border border-white/10 flex items-center justify-center text-2xl group-hover:scale-110 group-hover:border-[#c4a36f]/50 transition-all duration-300">
                    {c.icon}
                  </div>
                  <div>
                    <h3 className="font-display text-white text-xl font-semibold mb-1 group-hover:text-[#c4a36f] transition-colors">{c.title}</h3>
                    <p className="text-white/40 text-sm">{c.desc}</p>
                  </div>
                </div>
                <div className="w-8 h-8 rounded-full border border-white/10 flex items-center justify-center text-white/30 group-hover:text-[#c4a36f] group-hover:border-[#c4a36f]/30 group-hover:translate-x-1 transition-all duration-300">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="absolute bottom-6 left-0 right-0 text-center pointer-events-none">
        <p className="text-white/20 text-xs font-mono tracking-widest uppercase">
          <a href="https://lucasconti.netlify.app" target="_blank" rel="noopener noreferrer" className="text-white/40 hover:text-[#c4a36f] transition-colors pointer-events-auto">
            Lucas Conti Developer
          </a> © {new Date().getFullYear()} — Dashboard
        </p>
      </div>
    </div>
  );
}
