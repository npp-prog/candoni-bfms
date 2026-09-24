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
import { onIdTokenChanged, signInWithEmailAndPassword, signOut as fbSignOut, type User } from 'firebase/auth';
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
  signOut(): Promise<void>;
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
      signOut: () => fbSignOut(auth),
    };
  }, [loading, user, profile, assignments, signIn]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
