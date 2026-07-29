import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';

const links = [
  { to: '/dashboard', label: 'Inicio' },
  { to: '/propiedades', label: 'Propiedades' },
  { to: '/visitas', label: 'Visitas' },
  { to: '/inquilinos', label: 'Inquilinos' },
];

export default function DashboardLayout() {
  const { profile, user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen bg-[#070707] font-sans">
      <header className="h-14 sticky top-0 z-50 bg-[#0f0f0f]/90 backdrop-blur-xl border-b border-white/8 px-6 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <span className="text-[#c4a36f] font-display text-sm font-bold">Salomon</span>
          <nav className="hidden md:flex items-center gap-1">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    isActive ? 'text-[#c4a36f] bg-white/5' : 'text-white/50 hover:text-white/80'
                  }`
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-white/40 text-xs hidden sm:inline">
            {profile ? `${profile.nombre} ${profile.apellido}` : user?.email}
          </span>
          <button
            onClick={handleSignOut}
            className="px-3 py-1.5 border border-white/10 hover:border-white/20 text-white/60 hover:text-white/80 rounded-lg text-sm transition-colors"
          >
            Salir
          </button>
        </div>
      </header>

      <Outlet />
    </div>
  );
}
