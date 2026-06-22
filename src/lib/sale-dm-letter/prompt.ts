import type { LetterRecipient, LetterOptions, BuiltPrompt } from "./types";

const TONE_JA: Record<string, string> = {
  formal: "フォーマルで丁寧",
  standard: "標準的な丁寧さ",
  soft: "やわらかく親しみやすい",
};
const LENGTH_JA: Record<string, string> = {
  short: "はがき向けに短く(200〜300字目安)",
  medium: "封書向けに中程度(350〜500字目安)",
  long: "封書向けにやや長め(500〜700字目安)",
};
const APPEAL_JA: Record<string, string> = {
  price: "需要が高く好条件での売却が見込めること",
  inheritance: "相続・税の観点での早めの検討",
  vacant: "空き家・管理負担の軽減",
  buyer: "この地域で購入を希望する顧客がいること",
};
const STRENGTH_JA: Record<string, string> = {
  low: "控えめ・押し付けない",
  medium: "標準的な後押し",
  high: "積極的に売却を勧める(ただし誇張はしない)",
};

// 全通共通・宛先非依存の指示(prompt caching 前提で決定的に保つ)。
function buildSystem(options: LetterOptions): string {
  return [
    "あなたは日本の不動産会社の営業担当者です。所有者へ「不動産の売却」を促す日本語のダイレクトメール本文を作成します。",
    "次の制約を必ず守ってください:",
    "- 誇大広告・誇張表現を避ける。",
    "- 価格や売却の確実性を断定しない(「必ず高く売れます」等は禁止)。",
    "- 宅地建物取引業法に照らして問題となる断定・誇張をしない。",
    "- 敬称は宛名の指定に厳密に従う(個人=様 / 法人=御中)。",
    "- 差出人(会社名・連絡先)を本文末尾に明示する。",
    "- 無料査定など、相手の負担なく行動できる導線を1つ入れる。",
    `文体の方針: トーン=${TONE_JA[options.tone] ?? options.tone} / 長さ=${LENGTH_JA[options.length] ?? options.length} / 訴求の軸=${APPEAL_JA[options.appeal] ?? options.appeal} / 押しの強さ=${STRENGTH_JA[options.strength] ?? options.strength}。`,
    "出力は手紙本文のみ。前置きや説明・マークダウン記法は付けない。",
  ].join("\n");
}

export function buildLetterPrompt(recipient: LetterRecipient, options: LetterOptions): BuiltPrompt {
  const addressee =
    recipient.coOwnerCount > 1
      ? `${recipient.representativeName} ${recipient.honorific} 他共有者様`
      : `${recipient.representativeName} ${recipient.honorific}`;

  const user = [
    `宛名: ${addressee}`,
    `物件の所在地: ${recipient.propertyAddress}`,
    recipient.roomNo ? `部屋番号: ${recipient.roomNo}` : null,
    `物件種別: ${recipient.propertyTypeLabel}`,
    `差出人: ${options.senderName}(連絡先: ${options.senderContact})`,
    options.extraInstruction ? `補足指示: ${options.extraInstruction}` : null,
    "上記の宛名・物件情報・差出人で、売却を促すダイレクトメール本文を作成してください。",
  ]
    .filter((line): line is string => line != null)
    .join("\n");

  return { system: buildSystem(options), user };
}
