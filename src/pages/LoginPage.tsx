import { sendPasswordResetEmail } from 'firebase/auth';
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Icon } from '../components/ui';
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
  const [showPw, setShowPw] = useState(false);
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
    if (!email.trim()) {
      setError('Enter your email above, then select “Forgot password?” again.');
      document.getElementById('email')?.focus();
      return;
    }
    setError(null);
    await sendPasswordResetEmail(auth, email.trim()).catch(() => undefined);
    notify('If that email is registered, a password-reset link has been sent.', 'info');
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-navy-800 to-navy-900 px-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <img src="/seal.svg" alt="" className="mx-auto mb-3 h-14 w-14" />
          <p className="text-xs uppercase tracking-widest text-slate-600">Republic of the Philippines</p>
          <p className="text-xs text-slate-600">Province of Negros Occidental · Municipality of Candoni</p>
          <h1 className="mt-3 font-serif text-xl font-bold text-navy-800">Barangay Financial Management System</h1>
          <div className="mx-auto mt-3 h-0.5 w-12 bg-gold-500" />
        </div>
        <form onSubmit={submit} className="space-y-4" aria-describedby={error ? 'login-error' : undefined}>
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} className="input" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={error ? true : undefined} required />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <div className="relative">
              <input id="password" type={showPw ? 'text' : 'password'} autoComplete="current-password" className="input pr-11" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={error ? true : undefined} required />
              <button type="button" className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-slate-500 hover:text-navy-700" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? 'Hide password' : 'Show password'} aria-pressed={showPw}>
                <Icon name={showPw ? 'eyeOff' : 'eye'} />
              </button>
            </div>
          </div>
          {error && (
            <p id="login-error" role="alert" className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              <Icon name="alert" className="mt-0.5 h-4 w-4" />
              {error}
            </p>
          )}
          <button type="submit" className="btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <button type="button" className="btn-ghost w-full text-sm" onClick={() => void reset()}>Forgot password?</button>
        </form>
      </div>
    </div>
  );
}
