import { ApiError } from "@/lib/api-helpers";
import { isScenarioCampaign } from "@/lib/sale-dm-letter/scenario-campaign";

/**
 * 「組を書き換えうる」既存route を種類つきの発送(dm_campaigns.default_scenario_id が入っている)
 * では塞ぐ共通ガード2本(設計 2026-09-27 §3.4)。手紙の型とLPの型の組は作成時に一度だけ決まるので、
 * 画面を通さず個別APIを叩いて型の割当・追加・削除・写した型の変更をされると組が壊れる。
 * 種類なしの発送(defaultScenarioId=null)では何もしない(既存の挙動を一切変えない)。
 */
export function assertNotScenarioCampaign(c: { defaultScenarioId: string | null }): void {
  if (isScenarioCampaign(c)) {
    throw new ApiError(
      409,
      "DMの種類で作った発送では、型の割り当て・追加・削除はできません。宛先の種類は「種類を変える」で切り替えてください",
      "SCENARIO_CAMPAIGN_LOCKED",
    );
  }
}

/** DMの種類から写した型(dm_variants/dm_lp_variants.scenario_id が入っている)は PATCH できない。 */
export function assertNotScenarioVariant(v: { scenarioId: string | null }): void {
  if (v.scenarioId !== null) {
    throw new ApiError(
      409,
      "DMの種類から写した型は変更できません。文面の手直しは貼り直しで行えます",
      "SCENARIO_VARIANT_LOCKED",
    );
  }
}
