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

/** 「同じ内容」の判定に使う既存の物件1件。所有者の名前は、その物件につながっている人ぶん。 */
export interface SameContentCandidate {
  id: string;
  address: string | null;
  lotNumber: string | null;
  buildingName: string | null;
  roomNo: string | null;
  ownerNames: readonly string[];
}

/** 建物名・氏名の比較用(全角半角・空白・ハイフン類のゆれを均す)。 */
function normalizeTextForCompare(s: string | null): string {
  return normalizeForCompare((s ?? "").normalize("NFKC"));
}

/** 部屋番号の比較用。「901」「９０１号室」「901号」を同じに見る。 */
export function normalizeRoomForCompare(s: string | null): string {
  return normalizeTextForCompare(s).replace(/号室?$/, "");
}

/**
 * **査定ナンバーの無い依頼**が、すでにある物件と「同じ内容」かを見る(2026-11-15 発注者決定)。
 * 住所(+地番)・建物名・部屋番号・所有者の名前が**すべて**同じ物件の id を返す。
 *
 * ⚠これは「止める」ではなく「確認を挟む」ための判定。同じ方から後日あらためて届いた依頼を
 *   登録する道は残す(呼び出し側が確認のチェックを受け取ったら通す)。
 * ⚠誤って引っかけないための決まり:
 *   - 部屋番号が違えば別(同じ建物の別の部屋)。片方だけ空も別。
 *   - 建物名が違えば別。片方だけ空も別。
 *   - 所有者の名前が無い登録は見ない(名前が無いと別の依頼と見分けられない)。
 *   - 名前が違えば別(同じ住所の別の依頼)。
 */
export function findSameContentPropertyIds(
  draft: {
    address: string | null;
    lotNumber: string | null;
    buildingName: string | null;
    roomNo: string | null;
    ownerName: string | null;
  },
  existing: readonly SameContentCandidate[],
): string[] {
  const owner = normalizeTextForCompare(draft.ownerName);
  if (owner === "") return [];
  const building = normalizeTextForCompare(draft.buildingName);
  const room = normalizeRoomForCompare(draft.roomNo);
  // 住所(+地番)の一致は、琥珀色の警告と**同じ判定**を通す(規則を2つ持たない)。
  const sameAddress = new Set(
    judgeDuplicates(
      { address: draft.address, lotNumber: draft.lotNumber, externalLinkKey: null },
      existing.map((e) => ({ id: e.id, address: e.address, lotNumber: e.lotNumber, externalLinkKey: null })),
    ).similarPropertyIds,
  );
  return existing
    .filter((e) => sameAddress.has(e.id))
    .filter((e) => normalizeTextForCompare(e.buildingName) === building)
    .filter((e) => normalizeRoomForCompare(e.roomNo) === room)
    .filter((e) => e.ownerNames.some((n) => normalizeTextForCompare(n) === owner))
    .map((e) => e.id);
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
