import { sendPasswordResetEmail } from 'firebase/auth';
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Icon } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { auth } from '../services/firebase/app';

export function LoginPage() {
  const { user, signIn, signInWithGoogle } = useAuth();
  const { notify } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  if (user) return <Navigate to="/dashboard" replace />;

  async function google() {
    setBusy(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (e) {
      // In the browser console (F12) for whoever has to work out why.
      console.error('Google sign-in failed', e);
      const code = (e as { code?: string }).code ?? '';
      setError(
        code === 'auth/operation-not-allowed'
          ? 'Google sign-in is not turned on for BFMS yet. Ask the Municipal Accountant.'
          : code === 'auth/unauthorized-domain'
            ? 'This web address is not allowed for Google sign-in yet. Ask the Municipal Accountant.'
            : code === 'auth/network-request-failed'
              ? 'No connection. Check the internet and try again.'
              : 'Google sign-in did not finish. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

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
          <div className="my-5 flex items-center gap-3 text-xs text-muted" aria-hidden="true">
            <span className="h-px flex-1 bg-line-2" />
            or
            <span className="h-px flex-1 bg-line-2" />
          </div>
          <button type="button" className="btn-secondary h-12 w-full text-[15px]" disabled={busy} onClick={() => void google()}>
            <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden="true">
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.4-.4-3.5z" />
              <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
              <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.4-.4-3.5z" />
            </svg>
            Continue with Google
          </button>
          <p className="mt-3 text-center text-xs text-muted">
            New to BFMS? Continue with Google to request access. The Municipal Accountant assigns your role.
          </p>
        </div>
      </div>
    </div>
  );
}
