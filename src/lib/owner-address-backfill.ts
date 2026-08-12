/**
 * 取込による「空欄補完」の規則。
 *
 * 設計: docs/superpowers/specs/2026-08-10-owner-current-address-design.md §6.3(1)
 *
 * ## なぜ項目ごとに埋めてはいけないのか
 * 郵便番号と住所は**一組で1つの宛先**を表す。項目ごとに「空いているところだけ埋める」と、
 * 保存済みが「住所A・郵便番号なし」で取込が「住所B・郵便番号Z」のとき、
 * **郵便番号Zだけ**が入って `A / Z` というズレたペアができる。
 * この封筒は届かないか、別の場所へ届く。
 *
 * ## 規則（保存済みの住所 と 取込の住所 で決める）
 * | 保存済み | 補完 |
 * |---|---|
 * | 両方空 | 取込のペアをそのまま入れる |
 * | 正規化して同じ宛先 | 空いている郵便番号だけ入れてよい（ペアは崩れない） |
 * | 違う宛先（片方だけ空を含む） | ⚠どちらも入れない。人が判断する |
 *
 * この関数は**登記上のペア**にも**現住所のペア**にも同じ形で使う。
 */
import { normalizeAddress } from "@/lib/normalize";
import { normalizeZipForGroup } from "@/lib/owner-mailing-address";

export interface AddressPair {
  zip: string | null | undefined;
  address: string | null | undefined;
}

/** 実際に書き込む分だけを返す。何も書かないときは空オブジェクト。 */
export interface AddressPairPatch {
  zip?: string;
  address?: string;
}

function trimmed(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

export function resolveAddressPairBackfill(
  existing: AddressPair,
  incoming: AddressPair,
): AddressPairPatch {
  const inZip = trimmed(incoming.zip);
  const inAddress = trimmed(incoming.address);
  const exZip = trimmed(existing.zip);
  const exAddress = trimmed(existing.address);

  // 保存済みが両方空 = 何とも矛盾しない。取込のペアをそのまま入れる。
  if (exZip === "" && exAddress === "") {
    const patch: AddressPairPatch = {};
    if (inAddress !== "") patch.address = inAddress;
    if (inZip !== "") patch.zip = inZip;
    return patch;
  }

  // 同じ宛先なら、空いている郵便番号だけ補える（住所は既に入っている）。
  const sameDestination =
    exAddress !== "" &&
    inAddress !== "" &&
    normalizeAddress(exAddress) === normalizeAddress(inAddress);
  if (sameDestination) {
    if (
      exZip === "" &&
      inZip !== "" &&
      normalizeZipForGroup(exZip) !== normalizeZipForGroup(inZip)
    ) {
      return { zip: inZip };
    }
    return {};
  }

  // ⚠それ以外（違う宛先・どちらかだけ空）は何も入れない。
  // 取込の郵便番号が保存済みの住所のものだという保証がないため。
  return {};
}
