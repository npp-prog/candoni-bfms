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
    <div className="flex min-h-screen bg-[#fdfcf9] text-navy-800">
      <section className="relative hidden w-1/2 flex-col overflow-hidden bg-[#eaf2f5] px-[7%] py-8 lg:flex" aria-hidden="true">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_85%_55%,#d4e6ec90,transparent_65%)]" />
        <div className="relative flex items-center gap-3">
          <img src="/seal.svg" alt="" className="h-11 w-11" />
          <div>
            <div className="text-xl font-bold leading-tight text-navy-800">BFMS</div>
            <div className="text-2xs text-slate-500">Municipality of Candoni · Negros Occidental</div>
          </div>
        </div>
        <div className="relative my-auto max-w-lg">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[2px] text-[#6e8794]">
            <span className="h-px w-5 bg-clay" />
            Barangay accounting
          </div>
          <p className="mb-4 mt-5 text-[clamp(2.25rem,3.4vw,3.5rem)] font-semibold leading-[1.08] tracking-tight text-navy-800">
            Every barangay peso, <span className="text-gold-500">accounted for.</span>
          </p>
          <p className="max-w-md text-sm leading-7 text-[#788d97]">
            Journal entries, books, bank reconciliation, schedules and the financial statements of all nine barangays, kept by the Municipal Accounting Office.
          </p>
        </div>
        <p className="relative text-[10px] text-[#8ca1a9]">Municipal Accounting Office · Candoni</p>
      </section>
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8">
            <img src="/seal.svg" alt="" className="mb-4 h-12 w-12 lg:hidden" />
            <p className="text-[10px] font-semibold uppercase tracking-[2px] text-[#77959f]">Barangay Financial Management System</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-navy-800">Welcome back.</h1>
            <p className="mt-2 text-sm text-[#788d97]">Sign in with your BFMS account.</p>
          </div>
          <form onSubmit={submit} className="space-y-4" aria-describedby={error ? 'login-error' : undefined}>
            <div>
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                inputMode="email"
                autoCapitalize="none"
                spellCheck={false}
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={error ? true : undefined}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="password">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPw ? 'text' : 'password'}
                  autoComplete="current-password"
                  className="input pr-11"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={error ? true : undefined}
                  required
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-slate-500 hover:text-navy-700"
                  onClick={() => setShowPw((v) => !v)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                  aria-pressed={showPw}
                >
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
            <button type="submit" className="btn-primary h-12 w-full bg-navy-700 text-[15px] hover:bg-[#38627a]" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <button type="button" className="btn-ghost w-full text-sm" onClick={() => void reset()}>
              Forgot password?
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
