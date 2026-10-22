import type { ReportModel, ReportParams } from '@bfms/shared';

/** Phase 12 hook point: save a server snapshot / finalize from the viewer. */
export function SnapshotActions(_props: { model: ReportModel; params: ReportParams }) {
  return null;
}
