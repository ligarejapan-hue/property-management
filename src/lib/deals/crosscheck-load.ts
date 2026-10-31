import prisma from "@/lib/prisma";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { parseRegistryOwnerTable } from "@/lib/registry-owner-table";
import { isFullCertificateText, summarizeRegistryRights } from "@/lib/registry-strike";
import type { BasePropertyKind } from "./constants";
import type { RegistryFacts } from "./crosscheck";
import { readRegistryPdf } from "./registry-rights-load";

/** 見る添付の数(新しい順)。全部事項と所有者事項が混ざるので、登記の現況より少し多めに見る。 */
const CANDIDATES = 8;

/**
 * 照合に使う謄本の値を集める(読み取りの部品は変えず、呼ぶだけ)。
 * - 面積・担保は全部事項だけ(所有者事項には載らない)。担保は登記の現況と同じ「全部事項の最新の1件」。
 * - 売主名と比べる所有者は、いちばん新しい謄本から。読み取りが怪しければ confirmed=false(比べない)。
 * ⚠結果には氏名が入る。ログ・監査に出さない(例外の中身も出さない)。includeOwners=false なら氏名を持たない。
 */
export async function loadCrosscheckRegistry(
  propertyId: string, o: { kindBase: BasePropertyKind | null; includeOwners: boolean },
): Promise<RegistryFacts> {
  const rows = await prisma.attachment.findMany({
    where: { propertyId, type: "registry", isDeleted: false },
    orderBy: { createdAt: "desc" },
    take: CANDIDATES,
    select: { fileUrl: true, registryCertificateType: true, createdAt: true },
  });
  if (!rows.length) return { status: "none" };

  const needUnit = o.kindBase === "unit";
  const needLand = o.kindBase === "land" || o.kindBase === "house" || o.kindBase === "building";
  const needBuilding = o.kindBase === "house" || o.kindBase === "building";
  let unit: string | null = null;
  let land: string | null = null;
  let building: string | null = null;
  let areaDate: string | null = null;
  let rights: Extract<RegistryFacts, { status: "ok" }>["rights"] = null;
  let owners: Extract<RegistryFacts, { status: "ok" }>["owners"] = null;
  let readAny = false;

  const areasDone = () => (!needUnit || unit !== null) && (!needLand || land !== null) && (!needBuilding || building !== null);
  const done = () => rights !== null && (!o.includeOwners || owners !== null) && areasDone();

  for (const a of rows) {
    const at = a.createdAt.toISOString();
    const pdf = await readRegistryPdf(a.fileUrl);
    const full = !!pdf && isFullCertificateText(pdf.text);
    if (!full && a.registryCertificateType === "all") {
      // 全部事項と分かっている添付が読めない=登記の現況と同じく判定できない。
      rights ??= { activeRights: 0, readable: false, attachmentCreatedAt: at };
      if (o.includeOwners) owners ??= { list: [], confirmed: false, attachmentCreatedAt: at };
      readAny = true;
      if (done()) break;
      continue;
    }
    if (!pdf) {
      // 所有者事項と分かっている添付が読めないのに古い謄本で比べない。種別が空なら次を見る。
      if (a.registryCertificateType === "owner" && o.includeOwners) owners ??= { list: [], confirmed: false, attachmentCreatedAt: at };
      continue;
    }
    readAny = true;
    if (full) {
      const parsed = parseRegistryText(pdf.text);
      if (needUnit) unit ??= parsed.unitFloorArea ?? null;
      if (needLand) land ??= parsed.landAreaRegistry ?? null;
      if (needBuilding) building ??= parsed.buildingFloorArea ?? null;
      areaDate ??= at;
      // 面積が2通の謄本に分かれるときは、古いほうの日付を出す(古い謄本の注意が漏れないように)。
      if (at < areaDate) areaDate = at;
      if (rights === null || (o.includeOwners && owners === null)) {
        const summary = await summarizeRegistryRights({ pdf: pdf.body, text: pdf.text });
        rights ??= summary
          ? { activeRights: summary.activeRights.length, readable: summary.hasKouku, attachmentCreatedAt: at }
          : { activeRights: 0, readable: false, attachmentCreatedAt: at };
        if (o.includeOwners) {
          owners ??= {
            list: summary ? summary.currentOwners.map((x) => ({ name: x.name, share: x.share })) : [],
            confirmed: !!summary && summary.hasKouku && summary.ownersConfirmed,
            attachmentCreatedAt: at,
          };
        }
      }
    } else if (o.includeOwners && owners === null) {
      const list = parseRegistryOwnerTable(pdf.text);
      // 種別が空で所有者の表も無い添付は謄本として扱わない(次を見る)。
      if (list?.length || a.registryCertificateType === "owner") {
        owners = { list: (list ?? []).map((x) => ({ name: x.name, share: x.share })), confirmed: !!list?.length, attachmentCreatedAt: at };
      }
    }
    if (done()) break;
  }

  if (!readAny) return { status: "unreadable" };
  return {
    status: "ok",
    areas: areaDate ? { unit, land, building, attachmentCreatedAt: areaDate } : null,
    rights,
    owners,
  };
}
