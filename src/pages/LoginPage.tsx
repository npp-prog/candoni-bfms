import { sendPasswordResetEmail } from 'firebase/auth';
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { auth } from '../services/firebase/app';

export function LoginPage() {
  const { user, signIn } = useAuth();
  const { notify } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (user) return <Navigate to="/dashboard" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch {
      setError('Incorrect email or password, or the account is disabled.');
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    if (!email) return setError('Enter your email first.');
    await sendPasswordResetEmail(auth, email.trim()).catch(() => undefined);
    notify('If that email is registered, a password-reset link has been sent.', 'info');
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-navy-800 to-navy-900 px-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <img src="/seal.svg" alt="" className="mx-auto mb-3 h-14 w-14" />
          <p className="text-xs uppercase tracking-widest text-slate-500">Republic of the Philippines</p>
          <p className="text-xs text-slate-500">Province of Negros Occidental · Municipality of Candoni</p>
          <h1 className="mt-3 font-serif text-xl font-bold text-navy-800">Barangay Financial Management System</h1>
          <div className="mx-auto mt-3 h-0.5 w-12 bg-gold-500" />
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="username" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <button className="btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <button type="button" className="btn-ghost w-full text-xs" onClick={() => void reset()}>Forgot password?</button>
        </form>
      </div>
    </div>
  );
}
