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

export type RegistryTargetKind =
  | "land"
  | "building"
  /** ⚠不動産番号がある＝**所在で探す経路の対象外**（番号があれば所在も地番も要らない）。 */
  | "number"
  /**
   * ⚠所在（住所）が入っていない。
   *
   * 検索の入口は住所を番号より先に見る。ここで見落とすと「地番が必要です」と尋ねてしまい、
   * 利用者が地図で地番を調べて保存しても、**次の検索が住所不足で弾かれる**（二度手間）。
   */
  | "no_address"
  /**
   * ⚠番号は入っているが**読めない形**。
   *
   * "none"（そもそも入っていない）と分ける理由（@codex #373 R2 P2）:
   * 「地番が必要です」のポップアップは**地番しか保存できない**。読めない家屋番号が
   * 入ったままだと、正しい地番を保存しても分類は家屋番号を優先して読めないままなので、
   * **同じポップアップが何度でも出て先へ進めない**。直すのは入っている番号のほう。
   */
  | "malformed"
  | "none";

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

/**
 * 土地だと分かっている種別か。
 * ⚠ポップアップの「2つの道」を出すかの判定に使う（@codex #373 R10 P2）。
 * 駐車場・その他・不明は**どちらもあり得る**ので、建物の道も見せる必要がある。
 * 建物側の一覧で判定すると、これらの種別が土地の入力へ直行してしまい、
 * 建物の謄本に家屋番号が要ることを知る機会が無くなる。
 */
export function isLandPropertyType(propertyType: string): boolean {
  return LAND_TYPES.has(propertyType);
}

/**
 * この分類で**所在検索を始めてよい**か。
 *
 * ⚠これ以外の分類（住所が無い・番号が読めない・不動産番号がある・番号が無い）で
 * 検索を投げると、サーバーが必ず弾く。押せてしまうと「押したのに毎回断られる」
 * だけなので、画面は実行の導線自体を出さない。
 */
export function isSearchableTarget(kind: RegistryTargetKind): boolean {
  return kind === "land" || kind === "building";
}

/**
 * ⚠この分類は **buildRegistrySearchRequest とまったく同じ順序・同じ条件**で書く。
 * ずれると「画面が案内したとおりに直したのに、検索は別の理由で弾く」二度手間になる。
 *   1. 不動産番号がある → 所在検索の対象外
 *   2. 住所が無い → 検索できない
 *   3. 地番も家屋番号も無い → 地番を尋ねる
 *   4. 使う番号が読めない形 → その番号を直してもらう
 *   5. それ以外 → 土地 / 建物
 */
export function classifyRegistryTarget(input: {
  propertyType: string;
  /** ⚠所在（住所）。検索の入口は番号より先にこれを見る。 */
  address: string | null;
  lotNumber: string | null;
  buildingNumber: string | null;
  /** ⚠あれば所在検索の対象外。地番を尋ねてはいけない（設計 §3.1 / §3.1.1）。 */
  realEstateNumber: string | null;
}): RegistryTarget {
  // ⚠**最初に見る**。検索の入口(buildRegistrySearchRequest)も番号を最優先で見て
  //   has_real_estate_number を返す。ここで見落とすと「地番が必要です」と尋ねてしまい、
  //   利用者は外部の地図で地番を調べて保存したのに、検索は結局「番号があります」と
  //   返す＝**要らない地番が物件に残るだけ**になる。
  if (trimToNull(input.realEstateNumber)) {
    return { kind: "number", mismatchWarning: null };
  }
  // ⚠住所は番号より先。地番を入れてもらっても住所が無ければ検索は弾かれる。
  if (!trimToNull(input.address)) {
    return { kind: "no_address", mismatchWarning: null };
  }
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
      ? // ⚠「入っていない」とは分ける。直すのは入っている番号のほうで、
        //   地番を足しても解決しない。
        "malformed"
      : building
        ? "building"
        : "land";

  if (kind === "none" || kind === "malformed") {
    return { kind, mismatchWarning: null };
  }

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
