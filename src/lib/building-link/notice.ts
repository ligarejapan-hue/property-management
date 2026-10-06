/** 保存後の知らせ(設計 §6.2)。新規登録は画面が移るので sessionStorage で1回だけ渡す。 */
import type { BuildingLinkOutcome } from "./apply";

export interface BuildingNoticeLine { tone: "info" | "warn"; text: string; href?: string; hrefLabel?: string }

export function buildingLinkNoticeLines(outcome: BuildingLinkOutcome | null | undefined): BuildingNoticeLine[] {
  if (!outcome) return [];
  const lines: BuildingNoticeLine[] = [];
  const b = outcome.building;
  if (outcome.action === "created" && b) {
    lines.push({ tone: "info", text: `棟「${b.name}」を新しく作りました。正式な表記か確認してください`, href: `/buildings/${b.id}`, hrefLabel: "棟の画面を開く" });
  } else if ((outcome.action === "linked" || (outcome.action === "kept" && outcome.renamedFrom)) && b) {
    lines.push({ tone: "info", text: `棟「${b.name}」につなぎました${outcome.renamedFrom ? `(入力: ${outcome.renamedFrom})` : ""}` });
  } else if (outcome.action === "unlinked") {
    lines.push({ tone: "info", text: "棟から外しました" });
  }
  if (outcome.warnings.includes("duplicate_names")) {
    lines.push({ tone: "warn", text: "同じ名前の棟が複数あります。棟の一覧で確かめてください", href: "/buildings", hrefLabel: "棟の一覧" });
  }
  if (outcome.warnings.includes("area_unknown")) {
    lines.push({ tone: "warn", text: "住所から町丁目を読み取れなかったため、新しい棟として作りました" });
  }
  return lines;
}

const KEY_PREFIX = "building-link-notice:";

export function stashBuildingLinkNotice(propertyId: string, outcome: BuildingLinkOutcome | null | undefined): void {
  if (!outcome || buildingLinkNoticeLines(outcome).length === 0) return;
  try {
    sessionStorage.setItem(KEY_PREFIX + propertyId, JSON.stringify(outcome));
  } catch {
    // 出せなくても保存は済んでいる(知らせが出ないだけ)。
  }
}

export function takeBuildingLinkNotice(propertyId: string): BuildingLinkOutcome | null {
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + propertyId);
    if (!raw) return null;
    sessionStorage.removeItem(KEY_PREFIX + propertyId);
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed || typeof parsed !== "object" ||
      typeof (parsed as { action?: unknown }).action !== "string" ||
      !Array.isArray((parsed as { warnings?: unknown }).warnings)
    ) return null;
    return parsed as BuildingLinkOutcome;
  } catch {
    return null;
  }
}
