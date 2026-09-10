/**
 * LP型の「写真と図」パネルの純関数(設計 2026-09-08 §2.3)。DB・fetch を触らない。
 *  - SlotChoice = 画面の <select> 1個ぶんの状態(なし/写真/図)。SaleDmLpMediaRef との相互変換。
 *  - setSectionChoice/setHero = 元の plan を壊さず1箇所だけ変えた新しい plan を返す。
 *  - assetCountOf = ヒーロー+各節で使っている写真の枚数(重複なし)。
 *  - figureDataUrl = 図の見本を data URL の SVG として返す(外部参照なし・決定的)。
 */
import type { SaleDmLpMediaPlan, SaleDmLpMediaRef } from "@/lib/api-client";
import { renderFigureSvg, type FigureKind } from "@/lib/sale-dm-letter/lp-figures";

export type SlotChoice = { kind: "none" } | { kind: "asset"; assetId: string } | { kind: "figure"; figureKind: string };

export function choiceFromMedia(m: SaleDmLpMediaRef | null): SlotChoice {
  return m ?? { kind: "none" };
}
export function mediaFromChoice(c: SlotChoice): SaleDmLpMediaRef | null {
  return c.kind === "none" ? null : c;
}
export function setSectionChoice(plan: SaleDmLpMediaPlan, heading: string, c: SlotChoice): SaleDmLpMediaPlan {
  return { ...plan, sections: plan.sections.map((s) => (s.heading === heading ? { heading, media: mediaFromChoice(c) } : s)) };
}
export function setHero(plan: SaleDmLpMediaPlan, assetId: string | null): SaleDmLpMediaPlan {
  return { ...plan, hero: assetId ? { assetId } : null };
}
export function assetCountOf(plan: SaleDmLpMediaPlan): number {
  const ids = new Set<string>();
  if (plan.hero) ids.add(plan.hero.assetId);
  for (const s of plan.sections) if (s.media?.kind === "asset") ids.add(s.media.assetId);
  return ids.size;
}
export function figureDataUrl(kind: FigureKind): string {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(renderFigureSvg(kind));
}
export function isPlanDirty(saved: SaleDmLpMediaPlan, current: SaleDmLpMediaPlan): boolean {
  return JSON.stringify(saved) !== JSON.stringify(current);
}
