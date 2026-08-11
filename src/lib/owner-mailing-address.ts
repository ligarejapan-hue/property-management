/**
 * 「実際に郵送する宛先」を所有者から決める。
 *
 * 設計: docs/superpowers/specs/2026-08-10-owner-current-address-design.md §4 / §4.0
 *
 * ## なぜこの関数が要るのか
 * `Owner.zip` / `Owner.address` は **登記上** の値で、謄本PDF取込・受付帳取込・
 * 所有者CSV取込が書く。所有者が引っ越して登記を変更していない場合があるため、
 * 実際の送付先は `currentZip` / `currentAddress`（現住所）を優先して決める。
 *
 * ## 絶対に守ること
 * 1. **zip と address は必ず同じ側から取る**。
 *    住所は現住所・郵便番号は登記上、のような混ぜ方をすると
 *    「新しい住所に古い郵便番号」を刷った郵便物ができる。
 * 2. **形式を理由に郵便番号を捨てない**。
 *    `isValidPostalCode` は日本の7桁専用だが、所有者の郵便番号は自由入力で
 *    海外の番号（米 `10001`・仏 `75001`・中 `100000`・英 `SW1A 1AA`）も入る。
 *    構文だけでは「日本の番号の書き損じ」と「正しい海外の番号」を区別できないため、
 *    捨てると国際郵便が届かなくなる。壊れた番号は品質チェック（候補→修正）で人が直す。
 *
 * ⚠ グルーピング用の正規化（`normalizeZipForGroup` / `normalizeAddressForGroup`）は
 * このモジュールが持つ。`dm-export.ts` は互換のため再エクスポートするが、
 * 定義元はここ（dm-export がこの関数を使うため、逆向きに import すると循環する）。
 */

/**
 * グルーピング用に郵便番号を正規化する（比較専用・出力には使わない）。
 *  - trim / ハイフン（半角 "-" / 全角 "－" / 全角マイナス "−"）を除去 / 内部空白を除去
 * 表記揺れ（"100-0001" と "1000001"）を同一視する。
 */
export function normalizeZipForGroup(zip: string | null | undefined): string {
  if (typeof zip !== "string") return "";
  return zip.replace(/[\s　\-−－]/g, "").trim();
}

/**
 * グルーピング用に住所を正規化する（比較専用）。
 *  - trim / 連続する空白（半角・全角・タブ・改行）を 1 つの半角空白へ畳む
 * 空文字（実質「住所なし」）の場合は "" を返す。
 */
export function normalizeAddressForGroup(
  address: string | null | undefined,
): string {
  if (typeof address !== "string") return "";
  return address.replace(/[\s　]+/g, " ").trim();
}

/** 送付に使う宛先。`source` は表示・判定用（この PR では保存しない）。 */
export interface MailingAddress {
  zip: string | null;
  address: string | null;
  /** current=現住所 / registry=登記上 / none=送付先不明 */
  source: "current" | "registry" | "none";
}

export interface OwnerAddressFields {
  zip: string | null;
  address: string | null;
  currentZip: string | null;
  currentAddress: string | null;
}

/** 空白のみ・null を「未設定」とみなす。 */
function blank(v: string | null | undefined): boolean {
  return typeof v !== "string" || v.trim().length === 0;
}

/**
 * 送付に使う宛先を決める。**現住所があればそちら、無ければ登記上**。
 *
 * ⚠ 郵便番号は**選んだ側のものだけ**を返す。現住所が設定されているのに
 * 現住所の郵便番号が空なら、**郵便番号は null**（登記上の番号を混ぜない）。
 */
export function resolveMailingAddress(
  owner: OwnerAddressFields,
): MailingAddress {
  if (!blank(owner.currentAddress)) {
    return {
      zip: blank(owner.currentZip) ? null : owner.currentZip,
      address: owner.currentAddress,
      source: "current",
    };
  }
  if (!blank(owner.address)) {
    return {
      zip: blank(owner.zip) ? null : owner.zip,
      address: owner.address,
      source: "registry",
    };
  }
  return { zip: null, address: null, source: "none" };
}

/**
 * 同一送付先にまとめた1通へ刷る郵便番号を決める（設計 §4.0）。
 *
 * 1通に刷れる番号は1つなので、グループ内の**非空の番号を正規化して**比べ:
 *  - 2種類以上あれば **null**（どれが正しいか決められない。住所だけで配達される）
 *  - 1種類だけなら **その番号**（代表が持っていなくてもよい）
 *  - ゼロなら **null**
 *
 * ⚠ **先に食い違いを検査する**。「代表の番号を優先」を先頭に置くと、代表が
 * 食い違う番号の一方を持っているときに必ず代表が勝ち、食い違いの判定に到達しない
 * （= 設計自身が「信用できない」と言っている番号を刷ってしまう）。
 * ⚠ **正規化してから比べる**。生の値で比べると "1500001" と "150-0001" を
 * 2種類と誤判定し、正しい番号があるのに空で刷る。
 * ⚠ **形式の妥当性は見ない**（海外の番号を捨てないため）。
 *
 * @returns 刷る郵便番号（表記は最初に現れた非空の値をそのまま返す）
 */
export function resolveGroupZip(
  zips: (string | null | undefined)[],
): string | null {
  const seen = new Map<string, string>(); // 正規化した値 -> 最初に現れた生の値
  for (const z of zips) {
    if (blank(z)) continue;
    const key = normalizeZipForGroup(z);
    if (key === "") continue; // ハイフンや空白だけの値は「無い」扱い
    if (!seen.has(key)) seen.set(key, z as string);
  }
  if (seen.size !== 1) return null;
  return seen.values().next().value ?? null;
}
