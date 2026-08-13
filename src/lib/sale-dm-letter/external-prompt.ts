/**
 * 外部AI（手元のブラウザのAI）へ渡すプロンプトの組み立て
 * （設計 2026-08-08-sale-dm-external-paste-design.md §2.2）。
 *
 * ⚠**この関数の引数に、宛先・物件・差出人・追加指示は無い**。渡せないので載らない、
 * という形で「プロンプトに個人情報と個別物件の事実を載せない」を構造的に保証する
 * （@codex R11/R12）。1つの型の本文は複数物件の宛先にまたがるため、特定の物件の
 * 事実を書かせると別の物件へ送られてしまう。
 *
 * 文体の言い回しは既存の AI 直結プロンプト（prompt.ts）と同じ表を使う
 * （同じ表を2か所に書かない）。
 */
import { sha256Hex } from "@/lib/dm-batch/csv";
import { APPEAL_JA, LENGTH_JA, STRENGTH_JA, TONE_JA } from "./prompt";
import { LETTER_TAGS } from "./tags";

export interface ExternalPromptOptions {
  tone: string;
  length: string;
  appeal: string;
  strength: string;
}

/** 型の設定から、そのまま外部AIへ貼れる日本語のプロンプトを作る。 */
export function buildExternalPrompt(options: ExternalPromptOptions): string {
  const tagLines = LETTER_TAGS.map(
    (tag) => `  - {{${tag}}}（システムが宛先ごとに差し込みます）`,
  );

  return [
    "あなたは日本の不動産会社の営業担当者です。所有者へ「不動産の売却」を促す日本語のダイレクトメール本文を作成してください。",
    "",
    "【文体の方針】",
    `- トーン: ${TONE_JA[options.tone] ?? options.tone}`,
    `- 長さ: ${LENGTH_JA[options.length] ?? options.length}`,
    `- 訴求の軸: ${APPEAL_JA[options.appeal] ?? options.appeal}`,
    `- 押しの強さ: ${STRENGTH_JA[options.strength] ?? options.strength}`,
    "",
    "【必ず守ること】",
    "- 誇大な表現や誇張を避ける。価格や売却の確実性を断定しない（「必ず高く売れます」等は書かない）。",
    "- 宅地建物取引業法に照らして問題となる断定・誇張をしない。",
    "- **宛名は本文に書かない**（宛名はシステムが別に差し込みます）。",
    "- **署名・社名・連絡先は本文に書かない**（差出人欄は印刷時にシステムが付けます）。自社に触れる場合も「弊社」等にとどめる。",
    "- 無料査定など、相手の負担なく行動できる導線を一つ入れる。",
    "- 出力は手紙の本文のみ。前置きや説明、マークダウン記法は付けない。",
    "",
    "【場所や種別に触れたいとき】",
    "この本文は複数の宛先で共通して使います。特定の物件の情報は書かず、次の記号をそのまま書いてください。",
    ...tagLines,
    "使わなくても構いません（その場合は完全に共通の文面になります）。",
    "",
    "【お願い】",
    "所有者の氏名・住所・電話番号や、物件を特定できる情報は、この画面や外部のAIに入力しないでください。場所と種別は上記の記号で自動的に差し込まれます。",
  ].join("\n");
}

/** プロンプト全文の指紋。貼り付け時に「表示したときの設定と同じか」を照合するために使う。 */
export function promptDigest(prompt: string): string {
  return sha256Hex(prompt);
}
