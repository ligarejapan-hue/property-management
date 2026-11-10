/**
 * 「査定のご報告」各ページの見出しの既定の文(数字から作る)。担当者が書いた見出しがあればそちらを使う。
 * 確認画面の入力欄の薄い字(placeholder)にも同じ文を出す。純関数。
 */
import type { mergeAppraisal } from "./overrides";

export type MergedAppraisal = ReturnType<typeof mergeAppraisal>;
export type HeadlineKey = "result" | "basis" | "plans" | "fund";

const f = (n: number) => Math.round(n).toLocaleString("ja-JP");

export const KIND_LABEL: Record<string, string> = { house: "戸建", mansion: "マンション", land: "土地" };

function priceSpan(m: MergedAppraisal): { lo: number; hi: number; count: number; range: boolean } | null {
  if (m.plans && m.plans.length > 0) {
    const ps = m.plans.map((p) => p.price);
    return { lo: Math.min(...ps), hi: Math.max(...ps), count: ps.length, range: false };
  }
  if (m.range) return { lo: m.range.min, hi: m.range.max, count: 2, range: true };
  return null;
}

export function defaultHeadlines(m: MergedAppraisal): Record<HeadlineKey, string> {
  const exp = m.expected.total;
  const ai = m.ai.total;
  const kind = (m.kind && KIND_LABEL[m.kind]) || "物件";
  const span = priceSpan(m);
  const pct = m.adjustment.landPercent;

  const result =
    exp == null
      ? "査定の結果をご報告します"
      : `ご所有の${kind}の成約想定価格を${f(exp)}万円と査定し、` +
        (span
          ? span.range
            ? `売出しは${f(span.lo)}〜${f(span.hi)}万円の価格帯をご提案します`
            : `売出しは${f(span.lo)}〜${f(span.hi)}万円の${span.count}案をご提案します`
          : "売出しの価格をご提案します");

  let basis = "周辺の取引事例をもとに査定しました";
  if (exp != null && ai != null) {
    if (pct != null && pct !== 0) {
      basis = `周辺の事例から出したAI査定${f(ai)}万円に、土地の評価の補正（${pct > 0 ? "+" : "−"}${Math.abs(pct)}%）を反映した${f(exp)}万円を成約想定価格としました`;
    } else if (exp !== ai) {
      basis = `周辺の事例から出したAI査定${f(ai)}万円に、物件の評価を反映した${f(exp)}万円を成約想定価格としました`;
    } else {
      basis = `周辺の事例から出したAI査定${f(ai)}万円を、そのまま成約想定価格としました`;
    }
  }

  const plans = !span
    ? "売出しの価格をご提案します"
    : span.range
      ? `売出しは${f(span.lo)}〜${f(span.hi)}万円の価格帯をご提案します。売却の時期と価格の優先度でご相談ください`
      : `${span.count}案の価格差は${f(span.hi - span.lo)}万円です。売却の時期と価格のどちらを優先されるかで案をお選びください`;

  const fund = "売却の手取りに自己資金と新しい借入を足し、購入価格と諸費用を差し引くと、お住み替えの資金の過不足がわかります";
  return { result, basis, plans, fund };
}

/** 未接道の補正として「接道の条件で比べる」図を使えるか。 */
export function isUnconnectedCase(m: MergedAppraisal): boolean {
  const pct = m.adjustment.landPercent;
  if (pct == null || pct >= 0) return false;
  const road = `${m.roadAccess ?? ""} ${m.notes ?? ""} ${m.adjustment.landReason ?? ""}`;
  return /接道なし|未接道|無道路|接道状況/.test(road);
}
