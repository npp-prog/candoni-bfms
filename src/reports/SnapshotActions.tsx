import type { ReportModel, ReportParams } from '@bfms/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { api, errorMessage } from '../services/functions/api';

/**
 * Save the report as a server snapshot (generatedReports): the server rebuilds it from the
 * database, hashes it and stores a new version — the copy that can be submitted and finalized.
 */
export function SnapshotActions({ model, params }: { model: ReportModel; params: ReportParams }) {
  const { can } = useAuth();
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ id: string; version: number } | null>(null);
  if (!can('report.generate', params.barangayId)) return null;
  async function save() {
    setBusy(true);
    try {
      const r = await api.generateReportSnapshot({ code: model.code, params });
      setSaved(r);
      notify(r.reused ? `No changes since version ${r.version}; kept it.` : `Saved as version ${r.version}.`, 'success');
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()} title="Store an official, versioned copy built by the server">
        {busy ? 'Saving…' : 'Save version'}
      </button>
      {saved && <Link className="btn-ghost" to={`/reports/snapshot/${saved.id}`}>Open v{saved.version}</Link>}
    </>
  );
}
