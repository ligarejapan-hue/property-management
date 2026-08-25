/**
 * 段3: 見出し名 → 下書きの欄。純関数のみ。
 *
 * **他社の書式が増えたときは、この辞書に行を足すだけで対応できる。**
 * それがこの方式を選んだ理由なので、正規表現で凝らずに素の文字列で並べる。
 */
import { toHalfWidth } from "./normalize";

export type DraftFieldKey =
  | "address"
  | "lotNumber"
  | "buildingName"
  | "propertyTypeRaw"
  | "exclusiveArea"
  | "landArea"
  | "layoutType"
  | "occupancyRaw"
  | "builtYearRaw"
  | "externalLinkKey"
  | "ownerName"
  | "ownerNameKana"
  | "ownerPhone"
  | "ownerEmail"
  | "ownerAddress";

export const LABEL_DICTIONARY: Record<DraftFieldKey, readonly string[]> = {
  address: ["物件所在地", "所在地", "物件住所", "物件の所在地"],
  lotNumber: ["地番"],
  buildingName: ["物件名称", "建物名", "マンション名", "物件名"],
  propertyTypeRaw: ["物件種別", "種別", "物件の種類"],
  exclusiveArea: ["建物（専有）面積", "専有面積", "建物面積", "建物(専有)面積"],
  landArea: ["土地面積", "敷地面積"],
  layoutType: ["間取り", "間取"],
  occupancyRaw: ["現況", "入居状況", "利用状況"],
  builtYearRaw: ["築年数", "築年", "築年（西暦）", "築年(西暦)", "建築年"],
  externalLinkKey: ["査定ナンバー", "査定番号", "問合せ番号", "反響番号"],
  ownerName: ["お名前", "氏名", "ご氏名", "お客様名"],
  ownerNameKana: ["フリガナ", "ふりがな", "カナ", "お名前カナ"],
  ownerPhone: ["電話番号", "TEL", "連絡先電話番号", "ご連絡先"],
  ownerEmail: ["E-mail", "Email", "メールアドレス", "メール"],
  // ⚠「住所」単独はここに入れない。物件所在地と紛れるため（テストで固定）。
  ownerAddress: ["ご住所", "お客様住所", "現住所"],
};

/** 比較用に見出しを均す（全角半角・空白・記号ゆれを吸収）。 */
function normalizeLabel(label: string): string {
  return toHalfWidth(label)
    .replace(/[\s　]/g, "")
    .replace(/[()（）]/g, "")
    .toLowerCase();
}

const LOOKUP: Map<string, DraftFieldKey> = (() => {
  const m = new Map<string, DraftFieldKey>();
  for (const [key, labels] of Object.entries(LABEL_DICTIONARY)) {
    for (const label of labels) m.set(normalizeLabel(label), key as DraftFieldKey);
  }
  return m;
})();

export function fieldKeyForLabel(label: string): DraftFieldKey | null {
  if (label.trim() === "") return null;
  return LOOKUP.get(normalizeLabel(label)) ?? null;
}
