/**
 * 「この物件で、いま何を取りに行くのか（土地/建物）」の分類。
 *
 * 設計: docs/superpowers/specs/2026-08-12-registry-chiban-popup-design.md §3.1.1 / §3.1.2
 *
 * ## 決め方
 * **持っている番号**で決まる（provider の判定と同じ）。物件の種別では決めない。
 *  - 家屋番号がある → 建物の登記
 *  - 家屋番号が無く地番がある → 土地の登記
 *  - どちらも無い（読めない形も含む）→ 決められない
 *
 * ## 種別は「警告の材料」にしか使わない
 * ⚠ **止めない**（発注者判断 2026-08-12）。建物の物件でも、地番があれば土地の謄本は
 * 取れる（所有者を調べる用途ではむしろそれが要る場面がある）。止めると
 * 「使えていたものが使えなくなる」。食い違うときは**見せて、それでも実行できる**。
 *
 * ## これは参考情報ではない
 * ⚠ 「土地と建物のどちらを買うのか」は**買う対象そのもの**。画面はこれが読めるまで
 * 実行させない（fail closed）。取得済み・所有者ありのような参考情報とは扱いが違う。
 */
import { isReadableChiban } from "./chiban-input";

function trimToNull(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export type RegistryTargetKind = "land" | "building" | "none";

export interface RegistryTarget {
  kind: RegistryTargetKind;
  /** 種別と食い違うときの警告文。食い違わない／決められない種別なら null。 */
  mismatchWarning: string | null;
}

/**
 * 建物として期待される種別。
 * ⚠ PropertyType は14値ある。土地・建物の2値ではないので、ここに載らない種別
 * （駐車場・その他・不明）は「決められない」として警告を出さない。
 */
const BUILDING_TYPES = new Set([
  "house",
  "apartment_unit",
  "apartment_building",
  "apartment_block",
  "store",
  "office",
  "warehouse",
  "factory",
  "building",
  "unit",
]);

/** 土地として期待される種別。 */
const LAND_TYPES = new Set(["land"]);

export function classifyRegistryTarget(input: {
  propertyType: string;
  lotNumber: string | null;
  buildingNumber: string | null;
}): RegistryTarget {
  // ⚠**検索の入口(buildRegistrySearchRequest)とまったく同じ選び方**にする。
  //   あちらは家屋番号を優先し、それが読めない形なら**地番へ落とさず**弾く。
  //   ここだけ地番へ落とすと、画面は「土地の登記を取得します」と言うのに
  //   検索は弾く、という食い違いになる(@codex #372 R2 P2)。
  const building = trimToNull(input.buildingNumber);
  const lot = trimToNull(input.lotNumber);
  const effective = building ?? lot;

  // ⚠読めない形の番号は「持っていない」と同じ扱い。
  //   通すと、正規化で潰れた別の筆を取りに行くことになる。
  const kind: RegistryTargetKind = !effective
    ? "none"
    : !isReadableChiban(effective)
      ? "none"
      : building
        ? "building"
        : "land";

  if (kind === "none") return { kind, mismatchWarning: null };

  if (kind === "building" && LAND_TYPES.has(input.propertyType)) {
    return {
      kind,
      mismatchWarning:
        "この物件は土地ですが、建物の登記を取得します（家屋番号が入っているため）",
    };
  }
  if (kind === "land" && BUILDING_TYPES.has(input.propertyType)) {
    return {
      kind,
      mismatchWarning:
        "この物件は建物ですが、土地の登記を取得します（建物の謄本には家屋番号が必要です）",
    };
  }

  // 駐車場・その他・不明はどちらもあり得るので警告を出さない
  // （何を取りに行くかは kind で分かる）。
  return { kind, mismatchWarning: null };
}
