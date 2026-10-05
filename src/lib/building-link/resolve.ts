/**
 * 物件をどの棟へつなぐかの判断(設計 2026-10-04 §4.2)。DB を触らない純関数。
 * DB への適用は apply.ts。全部の保存の入口が apply.ts を通る。
 */

export const BUILDING_LINK_TARGET_TYPE = "apartment_unit";

export type BuildingChoice =
  | { kind: "auto" }
  | { kind: "existing"; buildingId: string }
  | { kind: "new" };

export const AUTO_CHOICE: BuildingChoice = { kind: "auto" };

export type BuildingLinkWarning = "duplicate_names" | "area_unknown";

export interface LinkCandidate {
  id: string;
  name: string;
  unitCount: number;
  createdAt: Date;
}

export interface DecideInput {
  propertyType: string;
  buildingName: string | null;
  nameKey: string | null;
  areaKey: string | null;
  choice: BuildingChoice;
  current: { id: string; name: string; nameKey: string | null } | null;
  chosen: { id: string; name: string } | null;
  candidates: LinkCandidate[];
}

export type BuildingLinkDecision =
  | { kind: "keep" }
  | { kind: "unlink" }
  | { kind: "link"; buildingId: string; buildingName: string; warnings: BuildingLinkWarning[] }
  | { kind: "create"; warnings: BuildingLinkWarning[] }
  | { kind: "chosen_missing" };

export function decideBuildingLink(i: DecideInput): BuildingLinkDecision {
  if (i.propertyType !== BUILDING_LINK_TARGET_TYPE) {
    // ⚠旧値「区分(旧)」は**今の棟を残す**。住所だけ直した保存で棟から外れないように。
    return i.propertyType === "unit" ? { kind: "keep" } : { kind: "unlink" };
  }
  if (!i.buildingName || !i.nameKey) return { kind: "unlink" };
  if (i.choice.kind === "existing") {
    return i.chosen
      ? { kind: "link", buildingId: i.chosen.id, buildingName: i.chosen.name, warnings: [] }
      : { kind: "chosen_missing" };
  }
  if (i.choice.kind === "new") return { kind: "create", warnings: [] };
  // 今の棟と比べる形が同じ=同じ建物の打ち直し。付け替えない(D4 の「名前を変える」に当たらない)。
  if (i.current && i.current.nameKey === i.nameKey) {
    return { kind: "link", buildingId: i.current.id, buildingName: i.current.name, warnings: [] };
  }
  if (i.areaKey === null) return { kind: "create", warnings: ["area_unknown"] };
  if (i.candidates.length === 0) return { kind: "create", warnings: [] };
  const [best] = [...i.candidates].sort(
    (a, b) =>
      b.unitCount - a.unitCount ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : 1),
  );
  return {
    kind: "link",
    buildingId: best.id,
    buildingName: best.name,
    warnings: i.candidates.length > 1 ? ["duplicate_names"] : [],
  };
}

/** 同時保存の順番待ちに使う鍵。町丁目が無いときは名前だけ(§4.3)。 */
export function buildingLinkLockKey(areaKey: string | null, nameKey: string): string {
  return `building-link:${areaKey ?? ""}:${nameKey}`;
}
