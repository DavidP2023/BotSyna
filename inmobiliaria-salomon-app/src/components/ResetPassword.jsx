import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient.js';

export default function ResetPassword() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setReady(Boolean(session));
    });
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (password !== confirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }

    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (updateError) {
      setError('No se pudo actualizar la contraseña. El link puede haber expirado.');
      return;
    }

    setDone(true);
    setTimeout(() => navigate('/login', { replace: true }), 2000);
  };

  if (!ready) {
    return (
      <div className="min-h-screen bg-[#070707] flex items-center justify-center px-6 font-sans">
        <p className="text-white/40 text-sm">
          Link inválido o expirado. Pedí uno nuevo desde "¿Olvidaste tu contraseña?".
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#070707] flex items-center justify-center px-6 font-sans">
      <div className="w-full max-w-sm">
        <h1 className="font-display text-white text-3xl font-bold mb-8 text-center">
          Nueva contraseña
        </h1>

        {done ? (
          <p className="text-white/60 text-sm text-center">Contraseña actualizada. Redirigiendo…</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-white/50 text-sm mb-1" htmlFor="password">
                Nueva contraseña
              </label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-white/10 text-white placeholder-white/30 focus:outline-none focus:border-[#c4a36f]/50"
                placeholder="••••••••"
              />
            </div>

            <div>
              <label className="block text-white/50 text-sm mb-1" htmlFor="confirm">
                Confirmar contraseña
              </label>
              <input
                id="confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-white/10 text-white placeholder-white/30 focus:outline-none focus:border-[#c4a36f]/50"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <p className="text-red-400 text-sm" role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl bg-[#c4a36f] text-black font-semibold hover:bg-[#d4b483] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Guardando…' : 'Guardar contraseña'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
