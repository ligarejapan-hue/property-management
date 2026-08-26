/**
 * 二重登録の判定。**純関数**（DB 検索の結果を受け取るだけ）。
 *
 * 方針（設計書 §6）: 外部キーが一致したときだけ登録を止める。それ以外は
 * 警告を出すだけで止めない。住所が似ていても別物件のことがあり、人が判断できるため。
 */
import { toHalfWidth, stripLeadingPostalCode } from "./normalize";

export interface ExistingProperty {
  id: string;
  address: string | null;
  lotNumber: string | null;
  externalLinkKey: string | null;
}

export interface DuplicateVerdict {
  blocked: boolean;
  blockedByPropertyId: string | null;
  similarPropertyIds: string[];
}

export function normalizeForCompare(s: string | null): string {
  if (s === null) return "";
  return toHalfWidth(s).replace(/[\s　]/g, "").replace(/[-]+/g, "-");
}

/**
 * **住所専用**の比較用正規化。先頭の郵便番号を無視してから正規化する。
 *
 * ⚠normalizeForCompare 側には入れない。あちらは地番(`552-2`)や外部キーにも
 *   使われており、`123-4567` のような地番が郵便番号と見なされて**丸ごと消える**。
 *   郵便番号の除去は「住所として突き合わせるとき」だけの規則。
 * ⚠保存する住所は貼られたとおりに残す（ここで作るのは比較用の形だけ）。
 */
export function normalizeAddressForCompare(s: string | null): string {
  if (s === null) return "";
  return normalizeForCompare(stripLeadingPostalCode(s));
}

export function judgeDuplicates(
  draft: {
    address: string | null;
    lotNumber: string | null;
    externalLinkKey: string | null;
  },
  existing: readonly ExistingProperty[],
): DuplicateVerdict {
  // ① 外部キー完全一致 → 止める
  if (draft.externalLinkKey !== null && draft.externalLinkKey.trim() !== "") {
    const key = normalizeForCompare(draft.externalLinkKey);
    const hit = existing.find((e) => normalizeForCompare(e.externalLinkKey) === key);
    if (hit) {
      return { blocked: true, blockedByPropertyId: hit.id, similarPropertyIds: [] };
    }
  }

  // ② 住所（+地番）一致 → 警告のみ
  const addr = normalizeAddressForCompare(draft.address);
  if (addr === "") {
    return { blocked: false, blockedByPropertyId: null, similarPropertyIds: [] };
  }
  const lot = normalizeForCompare(draft.lotNumber);

  const similar = existing
    .filter((e) => normalizeAddressForCompare(e.address) === addr)
    .filter((e) => {
      const eLot = normalizeForCompare(e.lotNumber);
      // ⚠片方だけ地番があるときは「似ている」と言わない。同じ住所でも
      //   別の筆であることがあり、誤って同一視すると取り違えを招く。
      if (lot === "" && eLot === "") return true;
      return lot !== "" && lot === eLot;
    })
    .map((e) => e.id);

  return { blocked: false, blockedByPropertyId: null, similarPropertyIds: similar };
}
