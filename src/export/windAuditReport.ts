import type { WindSettings } from '@/contracts/material';
import type { MeshData } from '@/contracts/mesh';
import { auditWindSeams, windAuditMeshFromParts } from '@/viewport/wind/windAudit';
import { defaultWindParams, windParamsFromSettings } from '@/viewport/wind/windParams';

/** Result of the T03 wind-seam audit run on the export meshes (shown in the export report and written to `<name>.kekenik.json`). */
export interface WindExportAudit {
  /** False when the audit was skipped (see `note`). */
  checked: boolean;
  note: string;
  vertices: number;
  /** Largest displacement of any vertex (0 = no wind data / wind off). */
  maxDisplacement: number;
  /** Largest gap (metres) between two vertices that coincide at rest. */
  coincidentMaxGap: number;
  coincidentPairs: number;
  /** Largest gap between vertices of different generators that touch at rest (leaf base on twig ...). */
  contactMaxGap: number;
  contactPairs: number;
  /** Warning threshold in metres (`WIND_SEAM_THRESHOLD x plant height`). */
  threshold: number;
  ok: boolean;
}

/** A seam is a problem when the reference wind pulls two coincident vertices apart by more than this fraction of the plant height. */
export const WIND_SEAM_THRESHOLD = 1e-3;
/** Above this vertex count the audit is skipped (quadratic neighbour search guard). */
export const WIND_AUDIT_MAX_VERTICES = 600_000;

const skipped = (note: string, vertices = 0): WindExportAudit => ({ checked: false, note, vertices, maxDisplacement: 0, coincidentMaxGap: 0, coincidentPairs: 0, contactMaxGap: 0, contactPairs: 0, threshold: 0, ok: true });

/**
 * Runs the wind-seam audit on the pieces that become the export mesh (source space: the transform does not change relative gaps).
 * The wind used is the scene / project wind at its own strength, but never weaker than 1 so a switched-off wind still audits the weights.
 */
export function auditExportWind(parts: readonly { id: string; mesh: MeshData }[], wind: WindSettings | null, height: number): WindExportAudit {
  const withWind = parts.filter((p) => p.mesh.wind !== undefined);
  if (withWind.length === 0) return skipped('No wind data on the exported meshes.');
  const vertices = withWind.reduce((s, p) => s + p.mesh.positions.length / 3, 0);
  if (vertices > WIND_AUDIT_MAX_VERTICES) return skipped(`Skipped: ${vertices} vertices (limit ${WIND_AUDIT_MAX_VERTICES}).`, vertices);
  const base = wind ? windParamsFromSettings(wind) : defaultWindParams();
  const params = { ...base, enabled: true, strength: Math.max(1, base.strength) };
  const mesh = windAuditMeshFromParts(withWind);
  const res = auditWindSeams(mesh, params, { ...(height > 0 ? { height } : {}), samples: 4 });
  const threshold = WIND_SEAM_THRESHOLD * res.height;
  const ok = res.coincident.maxGap <= threshold && res.contact.maxGap <= threshold * 4;
  return {
    checked: true,
    note: ok ? 'No wind seams above the threshold.' : 'Wind seams above the threshold: leaves / branches may tear apart in the game shader (see Wind weights view).',
    vertices,
    maxDisplacement: res.maxDisplacement,
    coincidentMaxGap: res.coincident.maxGap,
    coincidentPairs: res.coincident.pairs,
    contactMaxGap: res.contact.maxGap,
    contactPairs: res.contact.pairs,
    threshold,
    ok,
  };
}

export function windAuditWarning(a: WindExportAudit): string | null {
  if (!a.checked || a.ok) return null;
  return `Wind seam audit: coincident vertices move apart by up to ${(a.coincidentMaxGap * 1000).toFixed(2)} mm and touching pieces by up to ${(a.contactMaxGap * 1000).toFixed(2)} mm (threshold ${(a.threshold * 1000).toFixed(2)} mm).`;
}
