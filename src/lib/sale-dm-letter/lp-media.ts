/**
 * LP型の「写真と図」の枠(設計 2026-09-08 §2.3)。DB を触らない純関数のみ。
 *  - validateMediaPlan: 枠の整合(本文に無い小見出し・重複・写真10枚・未知の図)
 *  - reconcileSectionMedia: 貼り直しで小見出しが変わったとき、同じ見出しの行だけ引き継ぐ
 *  - buildImagePrompt: 生成AI向けの画像プロンプト(所有者・物件の事実は引数に無い)
 */
import { FIGURE_KINDS, type FigureKind } from "./lp-figures";
import { APPEAL_JA } from "./prompt";
import { LETTER_TAGS, propertyTypeLabel } from "./tags";

export const LP_MEDIA_MAX_ASSETS = 10;

export type MediaRef = { kind: "asset"; assetId: string } | { kind: "figure"; figureKind: FigureKind };
export interface MediaPlan {
  hero: { assetId: string } | null;
  sections: Array<{ heading: string; media: MediaRef | null }>;
}

export type MediaPlanIssue =
  | { code: "UNKNOWN_HEADING"; heading: string }
  | { code: "DUPLICATE_HEADING"; heading: string }
  | { code: "TOO_MANY_ASSETS"; limit: number }
  | { code: "UNKNOWN_FIGURE"; figureKind: string };

export function referencedAssetIds(plan: MediaPlan): string[] {
  const ids = new Set<string>();
  if (plan.hero) ids.add(plan.hero.assetId);
  for (const s of plan.sections) if (s.media?.kind === "asset") ids.add(s.media.assetId);
  return [...ids].sort();
}

export function validateMediaPlan(plan: MediaPlan, headings: string[]): MediaPlanIssue | null {
  const known = new Set(headings);
  const seen = new Set<string>();
  for (const s of plan.sections) {
    if (!known.has(s.heading)) return { code: "UNKNOWN_HEADING", heading: s.heading };
    if (seen.has(s.heading)) return { code: "DUPLICATE_HEADING", heading: s.heading };
    seen.add(s.heading);
    if (s.media?.kind === "figure" && !(FIGURE_KINDS as readonly string[]).includes(s.media.figureKind)) {
      return { code: "UNKNOWN_FIGURE", figureKind: String(s.media.figureKind) };
    }
  }
  if (referencedAssetIds(plan).length > LP_MEDIA_MAX_ASSETS) return { code: "TOO_MANY_ASSETS", limit: LP_MEDIA_MAX_ASSETS };
  return null;
}

export function mediaPlanIssueMessage(issue: MediaPlanIssue): string {
  switch (issue.code) {
    case "UNKNOWN_HEADING": return `小見出し「${issue.heading}」は本文にありません。文章を保存し直してから写真を選んでください`;
    case "DUPLICATE_HEADING": return `小見出し「${issue.heading}」に2つ以上の写真や図が付いています`;
    case "TOO_MANY_ASSETS": return `写真は1つのLP型につき ${issue.limit} 枚までです`;
    case "UNKNOWN_FIGURE": return "知らない図の種類です";
  }
}

/** 貼り直し後の小見出し列に合わせて枠を引き継ぐ(見出し文字列の完全一致のみ)。 */
export function reconcileSectionMedia(
  _oldHeadings: string[],
  newHeadings: string[],
  sections: MediaPlan["sections"],
): MediaPlan["sections"] {
  const byHeading = new Map(sections.map((s) => [s.heading, s.media] as const));
  return newHeadings.map((heading) => ({ heading, media: byHeading.get(heading) ?? null }));
}

export type ImageSlot = { kind: "hero" } | { kind: "section"; heading: string };
export type ImageStyle = "photo" | "illustration" | "flat";
export interface ImagePromptInput {
  slot: ImageSlot;
  leadSummary: string | null;
  appeal: string;
  propertyKind: string | null;
  style: ImageStyle;
}

const STYLE_JA: Record<ImageStyle, string> = { photo: "写真風", illustration: "イラスト風", flat: "フラットな図解" };
const STYLE_EN: Record<ImageStyle, string> = { photo: "photorealistic photograph", illustration: "soft illustration", flat: "flat vector illustration" };

function stripTags(s: string): string {
  return LETTER_TAGS.reduce((acc, tag) => acc.split(`{{${tag}}}`).join(""), s).replace(/\s{2,}/g, " ").trim();
}

/** 生成AI(画像)へ貼るプロンプト。引数は LP型の設定値と文章の要旨だけ(所有者・物件の事実は渡せない)。 */
export function buildImagePrompt(input: ImagePromptInput): string {
  const aspect = input.slot.kind === "hero" ? "16:9(横長)" : "4:3";
  const aspectEn = input.slot.kind === "hero" ? "16:9" : "4:3";
  const kind = input.propertyKind ? propertyTypeLabel(input.propertyKind) : null;
  const scene = input.slot.kind === "hero" ? "ページの一番上に出る、印象を決める1枚" : `「${stripTags(input.slot.heading)}」の節の下に置く1枚`;
  const summary = input.leadSummary ? stripTags(input.leadSummary) : "";
  return [
    `不動産の売却をご案内するページに載せる画像を作ってください。用途: ${scene}。`,
    `画風: ${STYLE_JA[input.style]}。縦横比: ${aspect}。`,
    `雰囲気: 日本の住宅街。${kind ? `${kind}をお持ちの方が` : "所有者の方が"}安心して相談できる、明るく落ち着いた印象。`,
    `訴求の軸: ${APPEAL_JA[input.appeal] ?? input.appeal}。`,
    summary ? `ページの要旨: ${summary}` : "",
    "",
    "【必ず守ること】",
    "- 画像の中に文字を入れない(看板・標識・書類の文字も読めない程度に)。",
    "- 実在の人物・企業のロゴ・実在の住所や地名が分かるものを出さない。",
    "- 特定の家を写した写真のように見せない(一般的な街並み・室内・相談風景にする)。",
    "",
    `English: ${STYLE_EN[input.style]}, Japanese residential neighborhood, warm natural light, aspect ratio ${aspectEn}, no text, no logos, no readable signage, no identifiable real people.`,
  ].filter((l) => l !== "").join("\n");
}
