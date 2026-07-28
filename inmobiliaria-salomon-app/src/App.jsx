import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import DashboardLayout from './components/layout/DashboardLayout.jsx';
import Login from './components/Login.jsx';
import Home from './pages/Home.jsx';
import Configuracion from './pages/Configuracion.jsx';
import Usuarios from './pages/Usuarios.jsx';
import Propiedades from './components/Propiedades.jsx';
import Visitas from './components/Visitas.jsx';
import Inquilinos from './components/Inquilinos.jsx';

function LoginRoute() {
  const { session } = useAuth();
  const navigate = useNavigate();

  if (session) return <Navigate to="/dashboard" replace />;

  return <Login onSuccess={() => navigate('/dashboard', { replace: true })} />;
}

function PropiedadesRoute() {
  const navigate = useNavigate();
  return <Propiedades onBack={() => navigate('/dashboard')} />;
}

function VisitasRoute() {
  const navigate = useNavigate();
  return <Visitas onBack={() => navigate('/dashboard')} />;
}

function InquilinosRoute() {
  const navigate = useNavigate();
  return <Inquilinos onBack={() => navigate('/dashboard')} />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<DashboardLayout />}>
          <Route path="/dashboard" element={<Home />} />
          <Route path="/propiedades" element={<PropiedadesRoute />} />
          <Route path="/visitas" element={<VisitasRoute />} />
          <Route path="/inquilinos" element={<InquilinosRoute />} />
          <Route path="/configuracion" element={<Configuracion />} />
          <Route path="/usuarios" element={<Usuarios />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
