/**
 * 取り込みの入口(どこから来た反響か)→ 物件の導入ルート。純関数のみ。
 *
 * 査定サイト(HOME4U・タカウル)の反響と、その顧客管理表(Excel)からのまとめ取込は
 * 「一括査定」。どこから来たか分からない貼り付け(generic・未指定・知らない値)は
 * 今までどおり「Web問い合わせ」(発注者依頼 2026-10-19)。
 */
import type { IntroductionRouteValue } from "@/lib/property-types";
import type { SourceProfileId } from "./source-profiles";

/** 登録APIの leadSource に入る値。貼り付けは読み取った書式、Excel まとめ取込は "excel_lead"。 */
export type LeadSource = SourceProfileId | "excel_lead";

const BULK_ASSESSMENT_SOURCES: ReadonlySet<string> = new Set<LeadSource>([
  "excel_lead",
  "home4u_assessment",
  "home4u_vacant_house",
  "takauru_assessment",
]);

export function introductionRouteForLeadSource(
  leadSource: unknown,
): Extract<IntroductionRouteValue, "bulk_assessment" | "web_inquiry"> {
  return typeof leadSource === "string" && BULK_ASSESSMENT_SOURCES.has(leadSource)
    ? "bulk_assessment"
    : "web_inquiry";
}
