import { barangayName, type BarangayId } from '@bfms/shared';
import { useEffect, useState } from 'react';

/**
 * The barangay's logo from public/logos/barangays/<ID>.png. Renders nothing until that file is
 * added (see the README there), so pages look the same with or without logos.
 */
export function BarangayLogo({ barangayId, className = 'h-8 w-8' }: { barangayId: BarangayId | null; className?: string }) {
  const [missing, setMissing] = useState(false);
  useEffect(() => setMissing(false), [barangayId]);
  if (!barangayId || missing) return null;
  return (
    <img
      src={`/logos/barangays/${barangayId}.png`}
      alt={`Logo of Barangay ${barangayName(barangayId)}`}
      className={`${className} shrink-0 rounded-full object-contain`}
      onError={() => setMissing(true)}
    />
  );
}
