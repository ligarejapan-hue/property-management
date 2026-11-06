import prisma from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import type { PermissionEntry } from "@/lib/api-helpers";
import type { BasePropertyKind } from "./constants";
import { isLandedKind, registryGapText } from "./crosscheck";
import { loadLandedCertificates } from "./crosscheck-load";
import { loadDealRegistryRights } from "./registry-rights-load";
import { registryDocInfo } from "./registry-rights";

/**
 * 書類確認書に使う形(名前なし)。読み取りが壊れても書類は出す=判定できない扱い(計画の読み替え 5)。
 * 土地のある物件は、土地と建物の全筆の合計(照合と同じ数え方。発行し直せば照合と合うように)。
 * targetParcels=この取引の土地・建物(null=全部)。選んでいれば、その筆・棟の謄本だけ(照合と同じ)。
 */
export async function loadRegistryDocInfo(
  propertyId: string | null, kindBase: BasePropertyKind | null = null, targetParcels: readonly string[] | null = null,
): Promise<{ activeRights: number; caution: string | null }> {
  try {
    if (propertyId && isLandedKind(kindBase)) {
      const data = await loadLandedCertificates(propertyId, { kindBase, includeOwners: false, targetParcels });
      if (!data.hasRows) return { activeRights: 0, caution: null };
      const infos = data.certs.map((c) => registryDocInfo(
        c.summary ? { status: "ok", attachmentCreatedAt: c.createdAt, summary: c.summary } : { status: "unreadable" },
      ));
      const gap = registryGapText(data.missing, data.uncertain, data.missingParcels);
      const cautions = [...new Set(infos.map((i) => i.caution).filter((c): c is string => !!c))];
      return {
        activeRights: infos.reduce((n, i) => n + i.activeRights, 0),
        caution: [...cautions, ...(gap ? [`謄本を確認してください(${gap})`] : [])].join("/ ") || null,
      };
    }
    return registryDocInfo(await loadDealRegistryRights(propertyId));
  } catch {
    return registryDocInfo({ status: "unreadable" });
  }
}

/**
 * 謄本を読んでよい物件(読んでよくなければ null=何も読まない)。
 * 謄本の中身は物件の情報なので、物件の閲覧があり、その物件を見られる人だけ(物件を開くリンクと同じ判定)。
 * さらに謄本を見る権限(registry_pdf:preview)も要る(既存の謄本の画面と同じ)。
 */
export async function registryPropertyFor(
  session: { id: string; role: string }, perms: PermissionEntry[], propertyId: string | null,
): Promise<string | null> {
  if (!propertyId || !hasPermission(perms, "property", "read") || !hasPermission(perms, "registry_pdf", "preview")) return null;
  const p = await prisma.property.findUnique({ where: { id: propertyId }, select: { createdBy: true, assignedTo: true } });
  return p && canAccessPropertyRecord(session, p) ? propertyId : null;
}
