import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient.js';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    setLoading(false);

    if (resetError) {
      setError('No se pudo enviar el email. Intentá de nuevo.');
      return;
    }

    setSent(true);
  };

  return (
    <div className="min-h-screen bg-[#070707] flex items-center justify-center px-6 font-sans">
      <div className="w-full max-w-sm">
        <h1 className="font-display text-white text-3xl font-bold mb-8 text-center">
          Recuperar contraseña
        </h1>

        {sent ? (
          <p className="text-white/60 text-sm text-center">
            Si el email existe, te enviamos un link para restablecer tu contraseña.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-white/50 text-sm mb-1" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-white/10 text-white placeholder-white/30 focus:outline-none focus:border-[#c4a36f]/50"
                placeholder="tu@email.com"
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
              {loading ? 'Enviando…' : 'Enviar link de recuperación'}
            </button>
          </form>
        )}

        <p className="text-center mt-6">
          <Link to="/login" className="text-white/40 text-sm hover:text-[#c4a36f] transition-colors">
            Volver a iniciar sesión
          </Link>
        </p>
      </div>
    </div>
  );
}
