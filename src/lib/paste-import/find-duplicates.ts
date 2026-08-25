/**
 * 二重登録の判定。**純関数**（DB 検索の結果を受け取るだけ）。
 *
 * 方針（設計書 §6）: 外部キーが一致したときだけ登録を止める。それ以外は
 * 警告を出すだけで止めない。住所が似ていても別物件のことがあり、人が判断できるため。
 */
import { toHalfWidth } from "./normalize";

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
  const addr = normalizeForCompare(draft.address);
  if (addr === "") {
    return { blocked: false, blockedByPropertyId: null, similarPropertyIds: [] };
  }
  const lot = normalizeForCompare(draft.lotNumber);

  const similar = existing
    .filter((e) => normalizeForCompare(e.address) === addr)
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
