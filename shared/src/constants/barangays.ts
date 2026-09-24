import type { BarangayId } from '../types/common';

export const MUNICIPALITY = 'Candoni';
export const PROVINCE = 'Negros Occidental';
export const TIME_ZONE = 'Asia/Manila';
export const FUNCTIONS_REGION = 'asia-southeast1';

export interface BarangaySeed {
  barangayId: BarangayId;
  barangayCode: string;
  barangayName: string;
}

/** The nine barangays of Candoni, in the Municipal Accounting's official order. */
export const BARANGAYS: readonly BarangaySeed[] = [
  { barangayId: 'AGBOY', barangayCode: '01', barangayName: 'Agboy' },
  { barangayId: 'BANGA', barangayCode: '02', barangayName: 'Banga' },
  { barangayId: 'CABIA-AN', barangayCode: '03', barangayName: 'Cabia-an' },
  { barangayId: 'CANINGAY', barangayCode: '04', barangayName: 'Caningay' },
  { barangayId: 'EAST', barangayCode: '05', barangayName: 'East' },
  { barangayId: 'GATUSLAO', barangayCode: '06', barangayName: 'Gatuslao' },
  { barangayId: 'HABA', barangayCode: '07', barangayName: 'Haba' },
  { barangayId: 'PAYAUAN', barangayCode: '08', barangayName: 'Payauan' },
  { barangayId: 'WEST', barangayCode: '09', barangayName: 'West' },
] as const;

export const BARANGAY_IDS: readonly BarangayId[] = BARANGAYS.map((b) => b.barangayId);

export function isBarangayId(v: unknown): v is BarangayId {
  return typeof v === 'string' && (BARANGAY_IDS as readonly string[]).includes(v);
}

export function barangayName(id: BarangayId): string {
  return BARANGAYS.find((b) => b.barangayId === id)?.barangayName ?? id;
}
