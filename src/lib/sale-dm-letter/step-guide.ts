/**
 * 売却DMの画面の「次にやること」を決める(純関数)。
 *
 * 2026-09-27 発注者決定(おすすめで): 次に押すボタンを光らせ、一言のアドバイスを出す。案内はいつも出し、
 * 各自が消せる。順番の違うボタンも押せるが、先にやることを一言で教える。AIで文章を作る手順も案内する。
 * 背景: 2026-09-26 の実機テストで、LP型のラベル・割当の前の適用・送付済みにした後の印刷などで繰り返し詰まった。
 *
 * 段は画面のデータ(宛先・型・LP型)から決める=どの端末で開いても同じ段にいる。
 * 印刷だけはデータに残らない(GET で開くだけ)ので、画面で「印刷」を押したかを printed で受け取る。
 */

export type SaleDmGuideStepKey =
  | "add_lp"
  | "lp_text"
  | "dm_body"
  | "assign"
  | "apply"
  | "confirm"
  | "print"
  | "sent";

export type SaleDmGuideState = SaleDmGuideStepKey | "no_recipients" | "done";

export interface SaleDmGuideInput {
  recipients: ReadonlyArray<{ status: string; body: string; lpVariantId: string | null; variantId: string }>;
  variants: ReadonlyArray<{ id: string; bodyTemplate?: string | null }>;
  lpVariants: ReadonlyArray<{ id: string; headline: string | null }>;
  /** この画面で「印刷」を押したか(確定の後・送付済みの前)。 */
  printed: boolean;
}

export interface SaleDmGuideStep {
  key: SaleDmGuideStepKey;
  /** 画面上部の帯に出す短い名前。 */
  label: string;
  /** 光らせたボタンの横に出す一言。 */
  tip: string;
}

export const SALE_DM_GUIDE_STEPS: readonly SaleDmGuideStep[] = [
  { key: "add_lp", label: "LP型を作る", tip: "まずご案内ページの型を1つ作ります。「LP型を追加」を押し、ラベル(社内で見分ける名前・例: 相続向けA)を入れて「保存」してください。" },
  { key: "lp_text", label: "LP型の文章", tip: "できたLP型の行の書類のアイコンから、ご案内ページの文章を入れます。指示文をコピー → お手元のAIに貼る → 返ってきた文章を貼って「文章を保存」。" },
  { key: "dm_body", label: "お手紙の本文", tip: "次はお手紙の本文です。型の行の書類のアイコンを押し、指示文をコピー → お手元のAIに貼る → 返ってきた本文を貼って「本文を保存」。" },
  { key: "assign", label: "均等に割り当て", tip: "宛先に、お手紙の型とLP型を割り当てます。「均等に割り当て」を押してください。" },
  { key: "apply", label: "本文を宛先へ", tip: "型の書類のアイコンを開き、「この型の全宛先に適用」を押すと、割り当てた宛先のお手紙に本文が入ります。" },
  { key: "confirm", label: "確定", tip: "お手紙の内容がよければ「確定」を押します。確定した手紙だけが印刷できます。" },
  { key: "print", label: "印刷", tip: "「印刷」で手紙とQR(申込用・配信停止用)を確かめます。送付済みにした手紙は印刷に出ないので、先に印刷してください。" },
  { key: "sent", label: "送付済みに", tip: "投函したら「確定分を送付済みに」を押します。これでQRからの申込を受け付けます。" },
];

export function guideStepIndex(state: SaleDmGuideState): number {
  return SALE_DM_GUIDE_STEPS.findIndex((s) => s.key === state);
}

export function computeSaleDmGuideStep(input: SaleDmGuideInput): SaleDmGuideState {
  const { recipients, variants, lpVariants, printed } = input;
  if (recipients.length === 0) return "no_recipients";
  // 送付済みの宛先はもう変えられない=それ以前の段の判定には入れない。
  const unsent = recipients.filter((r) => r.status !== "sent");
  if (unsent.length === 0) return "done";

  const confirmed = unsent.filter((r) => r.status === "confirmed");
  const drafts = unsent.filter((r) => r.status === "draft");

  // 準備(LP型・本文)は、まだ確定していない宛先が残っているあいだだけ案内する。
  if (drafts.length > 0) {
    if (lpVariants.length === 0) return "add_lp";
    if (!lpVariants.some((l) => (l.headline ?? "").trim() !== "")) return "lp_text";
    const withTemplate = new Set(
      variants.filter((v) => (v.bodyTemplate ?? "").trim() !== "").map((v) => v.id),
    );
    if (withTemplate.size === 0) return "dm_body";
    if (drafts.some((r) => r.lpVariantId === null)) return "assign";
    // 割り当てた先のLP型に文章が無い下書きがあれば、そのLP型の文章を入れる段に戻す
    // (A/B でLP型を2つ以上作り、片方の文章がまだのとき。その宛先のQRはご案内ページにならない)。
    const lpWithText = new Set(
      lpVariants.filter((l) => (l.headline ?? "").trim() !== "").map((l) => l.id),
    );
    if (drafts.some((r) => r.lpVariantId !== null && !lpWithText.has(r.lpVariantId))) return "lp_text";
    if (drafts.some((r) => r.body === "" && withTemplate.has(r.variantId))) return "apply";
    if (drafts.some((r) => r.body !== "")) return "confirm";
  }
  if (confirmed.length > 0) return printed ? "sent" : "print";
  // 下書きはあるが本文の原本が無い型の宛先だけが残っている=本文を入れる段。
  return "dm_body";
}

/**
 * 光らせるボタンの目印(data-guide)の候補を、優先の順に返す。
 * 入力の枠が開いていれば枠の中の「保存」を、閉じていれば枠を開くボタンを光らせる。
 * 「本文を宛先へ」は、文面の枠が閉じていれば型の書類のアイコン(=枠を開く)を光らせる。
 */
export function guideTargetCandidates(key: SaleDmGuideStepKey): string[] {
  switch (key) {
    case "add_lp": return ["add_lp_save", "add_lp"];
    case "lp_text": return ["lp_text_save", "lp_text"];
    case "dm_body": return ["dm_body_save", "dm_body"];
    case "apply": return ["apply", "dm_body"];
    default: return [key];
  }
}

/**
 * 押されたボタン(data-guide)が、いまの段より先の段のものか。先なら「先にやること」を一言出す
 * (発注者決定: 順番の違うボタンも押せるが、先にやることを一言で教える)。済んだ段のボタンは黙って通す。
 */
export function isAheadOfGuide(clicked: string, state: SaleDmGuideState): boolean {
  const cur = guideStepIndex(state);
  if (cur < 0) return false;
  const base = clicked.replace(/_save$/, "") as SaleDmGuideStepKey;
  const idx = guideStepIndex(base);
  return idx > cur;
}

/**
 * 光らせる型・LP型を決める(先頭固定にしない・@codex #449 R1)。
 *  - dmVariantId: 「お手紙の本文」の段では、原本が無く未確定の宛先がいる型(無ければ原本の無い型・先頭)。
 *    「本文を宛先へ」の段では、原本があり本文の空いた宛先がいる型。
 *  - lpVariantId: 「LP型の文章」の段では、文章の無いLP型を割り当てた宛先がいればそのLP型
 *    (無ければ文章の無いLP型・先頭)。
 */
export function guideTargetIds(input: Omit<SaleDmGuideInput, "printed">): {
  dmVariantId: string | null;
  lpVariantId: string | null;
} {
  const state = computeSaleDmGuideStep({ ...input, printed: false });
  const drafts = input.recipients.filter((r) => r.status === "draft");
  const hasTemplate = (id: string) =>
    (input.variants.find((v) => v.id === id)?.bodyTemplate ?? "").trim() !== "";
  let dmVariantId: string | null = input.variants[0]?.id ?? null;
  if (state === "dm_body") {
    dmVariantId =
      drafts.find((r) => !hasTemplate(r.variantId))?.variantId ??
      input.variants.find((v) => !hasTemplate(v.id))?.id ??
      dmVariantId;
  } else if (state === "apply") {
    dmVariantId = drafts.find((r) => r.body === "" && hasTemplate(r.variantId))?.variantId ?? dmVariantId;
  }
  const lpHasText = (id: string) =>
    (input.lpVariants.find((l) => l.id === id)?.headline ?? "").trim() !== "";
  const lpVariantId =
    drafts.find((r) => r.lpVariantId !== null && !lpHasText(r.lpVariantId))?.lpVariantId ??
    input.lpVariants.find((l) => !lpHasText(l.id))?.id ??
    input.lpVariants[0]?.id ??
    null;
  return { dmVariantId, lpVariantId };
}
