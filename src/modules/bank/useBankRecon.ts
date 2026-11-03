import { loadBankReconData, runBankRecon, type BankAccountDoc, type BankReconData, type BankReconRun, type WithId } from '@bfms/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientDataSource } from '../../services/datasource';

export interface BankRecon {
  data: BankReconData | null;
  /** The reconciliation with the stored person-made inputs (what Prepare would compute now). */
  run: BankReconRun | null;
  loading: boolean;
  error: string | null;
  reload(): void;
}

/**
 * One load of everything the bank pages show — the journal lines on the account's CIB ledger, the
 * statements of the year, prior-year items, cancelled checks, memos and reconciliations — through
 * the same shared loader the server and the reports use. Reloaded after every action.
 */
export function useBankRecon(bank: WithId<BankAccountDoc> | null, fiscalYear: number, month: number): BankRecon {
  const [state, setState] = useState<{ data: BankReconData | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [nonce, setNonce] = useState(0);
  const bankId = bank?.id;
  const barangayId = bank?.barangayId;
  useEffect(() => {
    if (!bankId || !barangayId) return;
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    loadBankReconData(clientDataSource, { barangayId, bankAccountId: bankId, fiscalYear, month })
      .then((data) => live && setState({ data, loading: false, error: null }))
      .catch((e: unknown) => live && setState({ data: null, loading: false, error: (e as Error).message }));
    return () => {
      live = false;
    };
  }, [bankId, barangayId, fiscalYear, month, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const data = state.data && state.data.period.bankAccountId === bank?.id && state.data.period.month === month ? state.data : null;
  const run = useMemo(() => (data ? runBankRecon(data) : null), [data]);
  return { data, run, loading: state.loading || (!!bank && !data && !state.error), error: state.error, reload };
}
