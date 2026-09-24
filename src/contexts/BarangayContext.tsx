import { barangayName, manilaToday, type BarangayId } from '@bfms/shared';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';

interface BarangayState {
  barangayId: BarangayId | null;
  barangayLabel: string;
  fiscalYear: number;
  setBarangayId(id: BarangayId): void;
  setFiscalYear(fy: number): void;
}

const Ctx = createContext<BarangayState | null>(null);
const KEY = 'bfms.selectedBarangay';

/** Current working barangay + fiscal year. Barangay users are pinned to their own barangay. */
export function BarangayProvider({ children }: { children: ReactNode }) {
  const { accessibleBarangays, profile } = useAuth();
  const [barangayId, setBarangay] = useState<BarangayId | null>(null);
  const [fiscalYear, setFiscalYear] = useState<number>(Number(manilaToday().slice(0, 4)));

  useEffect(() => {
    if (!accessibleBarangays.length) return setBarangay(null);
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {
      /* storage unavailable */
    }
    const preferred = [saved, profile?.defaultBarangayId].find((b) => b && accessibleBarangays.includes(b));
    setBarangay((preferred ?? accessibleBarangays[0]) as BarangayId);
  }, [accessibleBarangays, profile?.defaultBarangayId]);

  const value = useMemo<BarangayState>(
    () => ({
      barangayId,
      barangayLabel: barangayId ? `Barangay ${barangayName(barangayId)}` : '—',
      fiscalYear,
      setBarangayId: (id) => {
        if (!accessibleBarangays.includes(id)) return;
        setBarangay(id);
        try {
          localStorage.setItem(KEY, id);
        } catch {
          /* ignore */
        }
      },
      setFiscalYear,
    }),
    [barangayId, fiscalYear, accessibleBarangays],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBarangay(): BarangayState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBarangay must be used inside BarangayProvider');
  return v;
}
