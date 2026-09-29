/**
 * 売却DM「DMの種類」の画面用の純関数(設計 2026-09-27 §2.3・PR-S2 Task 6)。DB を読まない・React を使わない。
 *  - 作成画面の初期選択
 *  - 発送の画面上部の注意(本文が空の下書き・LPが未登録の種類)
 *  - 「DMの種類を開く」リンクの行き先(管理者だけに出す。判定は呼び出し側)
 */
import { isScenarioCampaign } from "./scenario-campaign";

export type ScenarioOptionLike = { id: string; sortOrder: number; ready: boolean };

/**
 * 作成画面の初期選択 = 手紙の文面が登録済み(ready)の最初の種類(並び順)。無ければ null(=種類を使わない)。
 * 選択肢の口は並び順で返すが、ここでも並べ直す(並びに頼らない)。
 */
export function pickDefaultScenario(options: ReadonlyArray<ScenarioOptionLike>): string | null {
  const sorted = [...options].sort((a, b) => a.sortOrder - b.sortOrder);
  return sorted.find((o) => o.ready)?.id ?? null;
}

/**
 * 画面から見た「種類つきの発送」の判定。判定そのものは isScenarioCampaign 1つに任せ、
 * 画面では値が欠けている(古い応答・mock)ときに種類なしへ倒すだけ。
 */
export function isScenarioCampaignView(c: { defaultScenarioId?: string | null }): boolean {
  return isScenarioCampaign({ defaultScenarioId: c.defaultScenarioId ?? null });
}

/**
 * 発送の画面上部の注意。開くたびに取り直した発送(=DB)から数える。
 *  - blankDrafts: 本文が空の下書き
 *  - lpMissingNames: 宛先のいる種類のうち、LPの写しが無いもの(手紙の型の label=種類名)
 */
export function scenarioCampaignNotices(campaign: {
  variants: ReadonlyArray<{ id: string; label: string; scenarioId?: string | null }>;
  lpVariants: ReadonlyArray<{ scenarioId?: string | null }>;
  recipients: ReadonlyArray<{ variantId: string; status: string; body: string }>;
}): { blankDrafts: number; lpMissingNames: string[] } {
  const blankDrafts = campaign.recipients.filter((r) => r.status === "draft" && r.body === "").length;
  const lpScenarios = new Set(
    campaign.lpVariants.map((l) => l.scenarioId ?? null).filter((s): s is string => s !== null),
  );
  const used = new Set(campaign.recipients.map((r) => r.variantId));
  const lpMissingNames = campaign.variants
    .filter((v) => (v.scenarioId ?? null) !== null && used.has(v.id) && !lpScenarios.has(v.scenarioId as string))
    .map((v) => v.label);
  return { blankDrafts, lpMissingNames };
}

/** 種類の登録を直す画面へのリンク(理由が「種類の登録が足りない」ときだけ)。出すのは管理者だけ。 */
export function scenarioFixLinkFor(code: string | null): { href: string; label: string } | null {
  if (code === "SCENARIO_NOT_READY" || code === "SCENARIO_UNAVAILABLE" || code === "PROPERTY_SCENARIO_MISSING") {
    return { href: "/admin/dm-scenarios", label: "DMの種類を開く" };
  }
  return null;
}

/** 「種類を変える」の確認文。 */
export function scenarioChangeConfirmText(recipientCount: number): string {
  return `この物件の宛先(${recipientCount}人)の手紙とLPを切り替えます。確定済みの宛先は下書きに戻ります。物件の『DMの種類』欄も変わります。`;
}
