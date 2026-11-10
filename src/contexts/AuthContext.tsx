import {
  BARANGAY_IDS,
  canAccessBarangay,
  hasPermission,
  scopedRolesFromClaims,
  type BarangayScope,
  type Permission,
  type ScopedRoles,
  type UserDoc,
} from '@bfms/shared';
import { GoogleAuthProvider, getRedirectResult, onIdTokenChanged, signInWithEmailAndPassword, signInWithPopup, signInWithRedirect, signOut as fbSignOut, type User } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { auth, db } from '../services/firebase/app';
import { api } from '../services/functions/api';

interface AuthState {
  loading: boolean;
  user: User | null;
  profile: UserDoc | null;
  assignments: ScopedRoles[];
  /** Barangays this user may open (ALL expands to the nine). */
  accessibleBarangays: readonly string[];
  isAllScope: boolean;
  can(permission: Permission, barangayId: BarangayScope): boolean;
  signIn(email: string, password: string): Promise<void>;
  /** Sign in (or sign up) with Google. Returns false when the person closed the Google window. */
  signInWithGoogle(): Promise<boolean>;
  signOut(): Promise<void>;
}

const CANCELLED = ['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled'];

/** After a Google sign-in: register the person (access request) if new, then record the login. */
async function afterGoogleSignIn() {
  try {
    const r = await api.requestAccess({});
    if (r.status !== 'PENDING') await api.recordLogin({}).catch(() => undefined);
  } catch {
    /* the pending-access page retries */
  }
}

const Ctx = createContext<AuthState | null>(null);

/**
 * Auth state from Firebase Auth + custom claims. Claims drive UI VISIBILITY ONLY;
 * the server re-checks every permission. When users/{uid}.claimsVersion exceeds the token's
 * `v`, we force-refresh the ID token so role changes apply without re-login.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserDoc | null>(null);
  const [assignments, setAssignments] = useState<ScopedRoles[]>([]);
  const [tokenVersion, setTokenVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const refreshing = useRef(false);

  useEffect(
    () =>
      onIdTokenChanged(auth, async (u) => {
        setUser(u);
        if (!u) {
          setAssignments([]);
          setProfile(null);
          setLoading(false);
          return;
        }
        const t = await u.getIdTokenResult();
        setAssignments(scopedRolesFromClaims(t.claims.a as Record<string, string[]> | undefined));
        setTokenVersion(Number(t.claims.v ?? 0));
        setLoading(false);
      }),
    [],
  );

  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, 'users', user.uid), async (snap) => {
      const p = snap.exists() ? (snap.data() as UserDoc) : null;
      setProfile(p);
      if (p && p.claimsVersion > tokenVersion && !refreshing.current) {
        refreshing.current = true;
        try {
          await user.getIdToken(true);
        } finally {
          refreshing.current = false;
        }
      }
    });
  }, [user, tokenVersion]);

  // A popup-blocked sign-in falls back to a redirect; finish it when the page comes back.
  useEffect(() => {
    getRedirectResult(auth)
      .then((r) => r && afterGoogleSignIn())
      .catch(() => undefined);
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const provider = new GoogleAuthProvider();
    // Always ask which account, so a shared office computer does not sign in as the last user.
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (CANCELLED.includes(code)) return false;
      if (code === 'auth/popup-blocked') {
        await signInWithRedirect(auth, provider);
        return true;
      }
      throw e;
    }
    await afterGoogleSignIn();
    return true;
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
    api.recordLogin({}).catch(() => undefined); // audit LOGIN; non-blocking
  }, []);

  const value = useMemo<AuthState>(() => {
    const isAllScope = assignments.some((a) => a.scope === 'ALL');
    const accessibleBarangays = isAllScope ? BARANGAY_IDS : BARANGAY_IDS.filter((b) => canAccessBarangay(assignments, b));
    return {
      loading,
      user,
      profile,
      assignments,
      accessibleBarangays,
      isAllScope,
      can: (p, b) => hasPermission(assignments, p, b),
      signIn,
      signInWithGoogle,
      signOut: () => fbSignOut(auth),
    };
  }, [loading, user, profile, assignments, signIn, signInWithGoogle]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
