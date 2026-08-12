/**
 * 所有者の統合（名寄せ）で、現住所をどう引き継ぐか。
 *
 * 設計: docs/superpowers/specs/2026-08-10-owner-current-address-design.md §7
 *
 * ## なぜ要るのか
 * 統合は source を archive するだけで、住所を master へ移していない。
 * 現住所の欄を足したまま何もしないと、**現住所を持つ source を統合した瞬間に
 * その現住所が消える**（復元手段なし＝以後の DM は登記上の住所へ飛ぶ）。
 *
 * ## 引き継ぎ方（master の状態で決まる）
 * | master | source | 引き継ぎ |
 * |---|---|---|
 * | 現住所が空 | 現住所あり | ペアごと引き継ぐ |
 * | 現住所あり・郵便番号が空 | 同じ住所＋郵便番号あり | ⚠郵便番号だけ引き継ぐ |
 * | 現住所あり | 住所が違う | 引き継がない → **統合を拒否**（どちらが新しいか決められない） |
 * | 現住所あり・郵便番号もあり | 同じ住所・郵便番号が違う | **統合を拒否** |
 *
 * ⚠最後の行を素通りさせると、統合前は「食い違い＝どちらも信用できない」として
 * 郵便番号を空で刷っていたのに、統合後は master の番号だけが残って
 * 「正しい番号」として刷られる。**食い違っていた証拠を黙って捨てて信用度を上げる**
 * 動きなので、担当者に決めさせる。
 */
import { normalizeAddress } from "@/lib/normalize";
import { normalizeZipForGroup } from "@/lib/owner-mailing-address";

export interface CurrentAddressState {
  currentZip: string | null;
  currentAddress: string | null;
}

export type CurrentAddressHandover =
  /** 引き継ぐものが無い（source に現住所が無い）。 */
  | { kind: "none" }
  /** master が空。ペアごと移す。 */
  | { kind: "pair"; currentAddress: string; currentZip: string | null }
  /** 同じ宛先で master の郵便番号だけが空。番号だけ移す。 */
  | { kind: "zip_only"; currentZip: string }
  /** 住所が食い違う。統合させない。 */
  | { kind: "conflict_address" }
  /** 同じ住所なのに郵便番号が食い違う。統合させない。 */
  | { kind: "conflict_zip" };

function trimmed(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

export function resolveCurrentAddressHandover(
  master: CurrentAddressState,
  source: CurrentAddressState,
): CurrentAddressHandover {
  const srcAddress = trimmed(source.currentAddress);
  const srcZip = trimmed(source.currentZip);
  const masterAddress = trimmed(master.currentAddress);
  const masterZip = trimmed(master.currentZip);

  // source に現住所が無ければ、失われるものが無い。
  // ⚠住所の無い郵便番号だけは引き継がない（宛先にならない番号だけが残る）。
  if (srcAddress === "") return { kind: "none" };

  if (masterAddress === "") {
    return {
      kind: "pair",
      currentAddress: srcAddress,
      currentZip: srcZip === "" ? null : srcZip,
    };
  }

  const sameDestination =
    normalizeAddress(masterAddress) === normalizeAddress(srcAddress);
  if (!sameDestination) return { kind: "conflict_address" };

  if (srcZip === "") return { kind: "none" };
  if (masterZip === "") return { kind: "zip_only", currentZip: srcZip };
  if (normalizeZipForGroup(masterZip) !== normalizeZipForGroup(srcZip)) {
    return { kind: "conflict_zip" };
  }
  return { kind: "none" };
}

/** 実際に master へ書き込みが発生する引き継ぎか。 */
export function handoverWrites(h: CurrentAddressHandover): boolean {
  return h.kind === "pair" || h.kind === "zip_only";
}

/**
 * 変更履歴の項目が「現住所の2列だけ」か。
 *
 * ⚠この判定が要る理由: 現住所は**通常の編集や補正で後から入る**ので、必ず
 * 変更履歴が付き version も上がる。統合の門が「履歴があれば拒否」のままだと、
 * 現住所を持つ source はほぼ全部弾かれ、引き継ぎ処理は書いても一度も動かない。
 */
export function isCurrentAddressOnlyChangeLog(
  fieldNames: readonly string[],
): boolean {
  if (fieldNames.length === 0) return false;
  return fieldNames.every(
    (f) => f === "currentAddress" || f === "currentZip",
  );
}
