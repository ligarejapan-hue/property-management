import { isPhoneCharsOnly, phoneSearchDigits } from "@/lib/phone-format-jp";

export type AgentQuery = { type: "digits"; digits: string } | { type: "text"; text: string } | { type: "none" };

/**
 * 業者検索の1つの欄に打たれた語を振り分ける(設計 §2.2-1)。
 * 数字と区切りだけで7桁以上 → 代表電話・過去の問い合わせ者の携帯を数字だけで照合。
 * それ以外 → 商号・ふりがな・支店の部分一致。2文字未満は検索しない。
 */
export function classifyAgentQuery(q: string): AgentQuery {
  const digits = phoneSearchDigits(q);
  if (digits) return { type: "digits", digits };
  const text = q.normalize("NFKC").trim();
  if ([...text].length < 2) return { type: "none" };
  return { type: "text", text };
}

/**
 * 画面で「探した」とみなしてよい語か。数字と区切りだけの語は、サーバーが電話番号として照合できる7桁から。
 * それより短いと会社名として探して0件になり、打ちかけの番号で「新しく登録」が出てしまう(@codex #459 R22)。
 */
export function agentQueryReady(q: string): boolean {
  if (isPhoneCharsOnly(q)) return phoneSearchDigits(q) != null;
  return classifyAgentQuery(q).type !== "none";
}
