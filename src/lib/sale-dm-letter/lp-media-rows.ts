/**
 * LP本文の「写真と図」の行(DB) ⇄ 枠(MediaPlan)の変換。DB を触らない純関数のみ。
 *
 * 元は lp-variants/[lpId]/media/route.ts にあった実装(campaign 用の LP型)。台帳(DmScenario)の
 * lp-template route でも同じ変換が要るため、ここへ移設して両方から使う(campaign の route は
 * このファイルを re-export するだけにして、既存の呼び出し/挙動は変えない)。
 *
 * ⚠campaign 版と違い、ここでは「本文の全小見出し」へのパディングと、行を作るときの外部キー
 * (lpVariantId / scenarioId)の付与は行わない。パディングは呼び出し側が headings と組み合わせて
 * 行い、外部キーは呼び出し側が返り値へ spread で足す(台帳と LP型で列名が違うため=
 * dm_scenario_media.scenario_id / dm_lp_variant_media.lp_variant_id)。
 */
import { isFigureKind } from "./lp-figures";
import type { MediaPlan } from "./lp-media";

export type MediaRow = {
  slot: string;
  heading: string | null;
  assetId: string | null;
  figureKind: string | null;
  sortOrder: number;
};

/** DB行(保存済みの分だけ)→ 枠。見出しの無い行・不明な図の行は落とす。節は sortOrder 順。 */
export function rowsToPlan(rows: MediaRow[]): MediaPlan {
  const hero = rows.find((r) => r.slot === "hero" && r.assetId);
  const sections = rows
    .filter((r) => r.slot === "section" && r.heading)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => ({
      heading: r.heading as string,
      media: r.assetId
        ? { kind: "asset" as const, assetId: r.assetId }
        : r.figureKind && isFigureKind(r.figureKind)
          ? { kind: "figure" as const, figureKind: r.figureKind }
          : null,
    }));
  return { hero: hero ? { assetId: hero.assetId as string } : null, sections };
}

/** 枠 → DB行(media:null の節は行を作らない)。外部キー列は呼び出し側で足す。 */
export function planToRows(plan: MediaPlan): MediaRow[] {
  const rows: MediaRow[] = [];
  if (plan.hero) {
    rows.push({ slot: "hero", heading: null, assetId: plan.hero.assetId, figureKind: null, sortOrder: 0 });
  }
  plan.sections.forEach((s, i) => {
    if (!s.media) return;
    rows.push({
      slot: "section",
      heading: s.heading,
      assetId: s.media.kind === "asset" ? s.media.assetId : null,
      figureKind: s.media.kind === "figure" ? s.media.figureKind : null,
      sortOrder: i + 1,
    });
  });
  return rows;
}
