import { z } from "zod";

/**
 * 追客メールの文面(流れ・通)の決まり。純関数(DB・env に触らない)。
 * 設計: docs/superpowers/specs/2026-11-16-inquiry-followup-mail-design.md §2・§4
 *
 * - 流れは2本: new(新規・起点=物件の登録日/申込日)と hold(保留・起点=保留になった日)。
 * - 通ごとに「起点から何日後」「件名」「本文」。文面に申込者の入力は差し込まない(差し込みの記号を持たない)。
 * - 日数は後の通ほど大きい(同じ日は不可=1アドレス1日1通と合わせる)。0日は new の1通目(挨拶)だけ。
 */

export const FOLLOWUP_SERIES = ["new", "hold"] as const;
export type FollowupSeries = (typeof FOLLOWUP_SERIES)[number];

export const FOLLOWUP_SERIES_LABELS: Record<FollowupSeries, string> = {
  new: "新規の流れ",
  hold: "保留の流れ",
};

export const FOLLOWUP_LIMITS = {
  stepsPerSeries: 10,
  subject: 120,
  body: 4000,
  maxDelayDays: 365,
} as const;

/** 発注者のイメージ(2026-11-17)の日数。最初に画面へ出す枠(件名・本文は空)。DB には入れない。 */
export const DEFAULT_FOLLOWUP_DELAYS: Record<FollowupSeries, readonly number[]> = {
  new: [0, 3, 7, 30, 90, 180],
  hold: [7, 30, 90, 180],
};

export type FollowupStepInput = { delayDays: number; subject: string; body: string };
export type FollowupStepsBySeries = Record<FollowupSeries, FollowupStepInput[]>;

export function defaultFollowupSlots(): FollowupStepsBySeries {
  return {
    new: DEFAULT_FOLLOWUP_DELAYS.new.map((d) => ({ delayDays: d, subject: "", body: "" })),
    hold: DEFAULT_FOLLOWUP_DELAYS.hold.map((d) => ({ delayDays: d, subject: "", body: "" })),
  };
}

/** 改行・タブ以外の制御文字を含まない(メールに目に見えない文字を混ぜない)。メール設定と同じ決まり。 */
export function isPlainMailText(v: string): boolean {
  return [...v].every((c) => {
    const n = c.charCodeAt(0);
    return n >= 0x20 ? n !== 0x7f : n === 0x0a || n === 0x0d || n === 0x09;
  });
}

/** 本文の改行を \n にそろえる。前後の空白は削らない(行頭の字下げ・署名を保つ)。 */
export function normalizeFollowupBody(v: string): string {
  return v.replace(/\r\n?/g, "\n");
}

const stepSchema = z.object({
  delayDays: z.number().int().min(0).max(FOLLOWUP_LIMITS.maxDelayDays),
  subject: z
    .string()
    .trim()
    .max(FOLLOWUP_LIMITS.subject, { message: `件名は${FOLLOWUP_LIMITS.subject}字までです` })
    .refine((v) => !/[\r\n]/.test(v) && isPlainMailText(v), { message: "件名は1行で入力してください" }),
  body: z
    .string()
    .max(FOLLOWUP_LIMITS.body, { message: `本文は${FOLLOWUP_LIMITS.body}字までです` })
    .refine(isPlainMailText, { message: "本文に使えない文字が含まれています" })
    .transform(normalizeFollowupBody),
});

/** 並び・日数の決まりの違反を日本語で返す(空=問題なし)。 */
export function followupOrderProblems(steps: FollowupStepsBySeries): string[] {
  const problems: string[] = [];
  for (const series of FOLLOWUP_SERIES) {
    const list = steps[series];
    const label = FOLLOWUP_SERIES_LABELS[series];
    if (list.length > FOLLOWUP_LIMITS.stepsPerSeries) {
      problems.push(`${label}は${FOLLOWUP_LIMITS.stepsPerSeries}通までです`);
    }
    list.forEach((s, i) => {
      if (s.delayDays === 0 && !(series === "new" && i === 0)) {
        problems.push(`${label}の${i + 1}通目: 0日後にできるのは新規の流れの1通目(挨拶)だけです`);
      }
      if (i > 0 && s.delayDays <= list[i - 1].delayDays) {
        problems.push(`${label}の${i + 1}通目: 日数は前の通より大きくしてください`);
      }
    });
  }
  return problems;
}

export const followupStepsSchema = z
  .object({
    new: z.array(stepSchema),
    hold: z.array(stepSchema),
  })
  .superRefine((v, ctx) => {
    for (const message of followupOrderProblems(v)) ctx.addIssue({ code: "custom", message });
  });

/** ON にするときに足りないもの(文面側)。空=ON にしてよい。 */
export function followupStepsEnableProblems(steps: FollowupStepsBySeries): string[] {
  const problems: string[] = [];
  if (steps.new.length + steps.hold.length === 0) problems.push("文面が1通もありません");
  for (const series of FOLLOWUP_SERIES) {
    steps[series].forEach((s, i) => {
      if (s.subject.trim() === "" || s.body.trim() === "") {
        problems.push(`${FOLLOWUP_SERIES_LABELS[series]}の${i + 1}通目の件名か本文が空です`);
      }
    });
  }
  return problems;
}

/** 日数の見出し(画面・記録の表示用)。 */
export function followupDelayLabel(series: FollowupSeries, delayDays: number): string {
  if (delayDays === 0) return "登録の直後";
  const base = series === "new" ? "登録" : "保留になった日";
  return `${base}から${delayDays}日後`;
}
