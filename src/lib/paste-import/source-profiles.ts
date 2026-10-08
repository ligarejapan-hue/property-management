/**
 * 段4: 送り元ごとの癖を直す。純関数のみ。
 *
 * ⚠**同じ提供元でも書式が複数ある**（HOME4U に「空き家相談」と「査定依頼」の
 *   2書式がある）。送り元の判定は URL やファイル名ではなく、**見出しの顔ぶれ**で行う。
 *   貼り付け方式では URL もファイル名も当てにならないため。
 */
import { toHalfWidth } from "./normalize";
import type { ParseOptions } from "./parse-labeled-lines";

export type SourceProfileId =
  | "home4u_assessment"
  | "home4u_vacant_house"
  | "takauru_assessment"
  | "generic";

export const SOURCE_PROFILE_LABELS: Record<SourceProfileId, string> = {
  home4u_assessment: "HOME4U 査定依頼",
  home4u_vacant_house: "HOME4U 空き家相談",
  takauru_assessment: "タカウル 査定依頼",
  generic: "その他（共通の読み取り）",
};

function has(labels: readonly string[], needle: string): boolean {
  return labels.some((l) => l.replace(/[\s　]/g, "").includes(needle));
}

export function detectSourceProfile(labels: readonly string[]): SourceProfileId {
  if (has(labels, "査定ナンバー")) return "home4u_assessment";
  if (has(labels, "空き家所有者との関係性")) return "home4u_vacant_house";
  // タカウル(マンションレビュー)の査定依頼メール(実物 2026-10-07 で確認)。
  if (has(labels, "査定物件の所在地")) return "takauru_assessment";
  return "generic";
}

/**
 * 送り元ごとの読み方(段2)。
 * ⚠タカウルは「見出し：値」の値が次の行へ続く(ご住所)・運営会社の署名欄に
 *   `住 所：` `T E L：` が並ぶ。HOME4U の2書式はどちらも無いので従来どおり。
 */
export function parseOptionsFor(profile: SourceProfileId): ParseOptions {
  if (profile === "takauru_assessment") {
    return { joinContinuationLines: true, footerBetweenHeavyRules: true };
  }
  return {};
}

/**
 * 建物名の末尾に付いた「◯◯号室」を切り出す。
 * 実サンプル(タカウル): `建物名：東急サンプルハイツ 305号室`
 *
 * ⚠**「号室」と明記されたものだけ**を部屋番号とみなす。数字で終わる建物名
 *   (`パークハウス2`)は建物名の一部のことがあるので切らない。推測しない。
 */
const ROOM_SUFFIX = /^(.*?)[\s　]*([0-9]{1,5}[A-Za-z]?|[0-9]{1,3}-[0-9]{1,4})号室$/;

export function splitRoomFromBuildingName(buildingName: string): {
  buildingName: string;
  roomNo: string | null;
} {
  const original = buildingName.trim();
  const m = ROOM_SUFFIX.exec(toHalfWidth(original));
  if (!m || m[1].trim() === "") return { buildingName: original, roomNo: null };
  // ⚠建物名は**元の表記のまま**返す(全角数字などを半角に変えない)。
  //   toHalfWidth は1文字を1文字に置き換えるだけなので、長さで切り戻せる。
  return { buildingName: original.slice(0, m[1].length).trim(), roomNo: m[2] };
}

/** 部屋番号として認めてよい形（数字、数字+英字、ハイフン区切り）。 */
const ROOM_NO = /^([0-9]{1,5}[A-Za-z]?|[0-9]{1,3}-[0-9]{1,4})(号室|号)?$/;

/**
 * 所在地の末尾にくっついた建物名と部屋番号を切り出す。
 * 実サンプルB: `…15番12号リーフィアレジデンス等々力303` − `リーフィアレジデンス等々力`
 *              → 住所 `…15番12号` / 部屋番号 `303`
 *
 * ⚠建物名が無い、または住所に含まれていなければ**何もしない**。推測しない。
 */
export function splitBuildingAndRoom(
  address: string,
  buildingName: string | null,
): { address: string; roomNo: string | null } {
  const original = address.trim();
  if (!buildingName || buildingName.trim() === "") {
    return { address: original, roomNo: null };
  }
  const at = original.indexOf(buildingName.trim());
  if (at === -1) return { address: original, roomNo: null };

  const head = original.slice(0, at).trim();
  const tail = toHalfWidth(original.slice(at + buildingName.trim().length)).trim();

  if (tail === "") return { address: head, roomNo: null };

  const m = ROOM_NO.exec(tail);
  if (!m) {
    // 建物名の後ろが部屋番号らしくない → 住所を削らず、そのまま返す
    // （情報を失わないほうを優先する）。
    return { address: original, roomNo: null };
  }
  return { address: head, roomNo: m[1] };
}
