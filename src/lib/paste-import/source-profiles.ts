/**
 * 段4: 送り元ごとの癖を直す。純関数のみ。
 *
 * ⚠**同じ提供元でも書式が複数ある**（HOME4U に「空き家相談」と「査定依頼」の
 *   2書式がある）。送り元の判定は URL やファイル名ではなく、**見出しの顔ぶれ**で行う。
 *   貼り付け方式では URL もファイル名も当てにならないため。
 */
import { toHalfWidth } from "./normalize";

export type SourceProfileId =
  | "home4u_assessment"
  | "home4u_vacant_house"
  | "generic";

export const SOURCE_PROFILE_LABELS: Record<SourceProfileId, string> = {
  home4u_assessment: "HOME4U 査定依頼",
  home4u_vacant_house: "HOME4U 空き家相談",
  generic: "その他（共通の読み取り）",
};

function has(labels: readonly string[], needle: string): boolean {
  return labels.some((l) => l.replace(/[\s　]/g, "").includes(needle));
}

export function detectSourceProfile(labels: readonly string[]): SourceProfileId {
  if (has(labels, "査定ナンバー")) return "home4u_assessment";
  if (has(labels, "空き家所有者との関係性")) return "home4u_vacant_house";
  return "generic";
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
