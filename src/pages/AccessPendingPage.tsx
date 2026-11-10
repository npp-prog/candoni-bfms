import { useEffect, useState } from 'react';
import { Icon } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { api, errorMessage } from '../services/functions/api';

/**
 * Shown to a signed-in person with no BFMS role: a new Google sign-up waiting for the Municipal
 * Accountant, or an account whose roles were removed. Opens BFMS by itself once a role is assigned
 * (the profile listener refreshes the token when claimsVersion changes).
 */
export function AccessPendingPage() {
  const { user, profile, signOut } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const google = user?.providerData.some((p) => p.providerId === 'google.com') ?? false;

  // Register the request if the sign-in did not get to it (redirect sign-in, dropped connection).
  useEffect(() => {
    if (!google || profile) return;
    api.requestAccess({}).catch((e) => setError(errorMessage(e)));
  }, [google, profile]);

  const pending = profile?.accessRequest?.status === 'PENDING';
  const inactive = profile && !profile.active;
  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4">
      <div className="w-full max-w-md text-center">
        <img src="/candoni-seal.png" alt="Seal of the Municipality of Candoni" className="mx-auto mb-5 h-20 w-20" />
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gold-50 text-gold-700">
          <Icon name={inactive ? 'alert' : 'calendar'} className="h-6 w-6" />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          {inactive ? 'Your account is turned off' : pending || (google && !profile) ? 'Waiting for access' : 'No role assigned yet'}
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          {inactive
            ? 'Ask the Municipal Accounting Office to turn your BFMS account back on.'
            : pending || (google && !profile)
              ? 'Your request has been sent to the Municipal Accounting Office. BFMS opens here by itself once they assign your role and barangay.'
              : 'Ask the Municipal Accounting Office to assign your role and barangay.'}
        </p>
        <div className="mt-5 rounded-xl2 border border-line bg-sunken px-4 py-3 text-left text-sm">
          <div className="text-xs text-muted">Signed in as</div>
          <div className="font-medium text-ink">{profile?.displayName ?? user?.displayName ?? ''}</div>
          <div className="text-muted">{user?.email}</div>
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
        <button type="button" className="btn-secondary mt-5" onClick={() => void signOut()}>
          <Icon name="logout" /> Sign out
        </button>
      </div>
    </div>
  );
}
