/**
 * 国土地理院 逆ジオコーディング provider（無料・申込不要・APIキー不要）。
 *
 * GET https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=&lon=
 *   応答例: {"results":{"muniCd":"13115","lv01Nm":"西荻北三丁目"}}
 *   海上・国外: {}（エラーではなく空）→ found:false
 *
 * ⚠外部へ送るのは**座標のみ**（所有者名・住所・物件情報など PII は一切送らない）。
 * ⚠muniCd は市区町村**コード**なので、同梱の変換表（municipalities.ts・出典 国土地理院）で
 *   都道府県名+市区町村名へ引き当てて住所を組み立てる。
 * ⚠返るのは**町丁目まで**（番・号は返らない）。番・号は利用者が確認して手入力する前提。
 *
 * 実測（2026-07-30）: 東京駅→丸の内一丁目 / 西荻窪→西荻北三丁目 / 海上→{}。
 */
import { GSI_MUNICIPALITIES } from "./municipalities";
import {
  ReverseGeocodeError,
  type ReverseGeocodeProvider,
  type ReverseGeocodeResult,
} from "./types";

const GSI_ENDPOINT =
  "https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress";

/** 上流タイムアウト（ms）。地図操作の途中で待たせないよう短め。 */
const TIMEOUT_MS = 8_000;

/**
 * muniCd → 「都道府県名+市区町村名」。
 * 変換表のキーは先頭ゼロなし（muni.js 形式）なので、API の "01101" も "1101" も同じ行に落とす。
 * 未知のコード（新設合併等で表が古い場合）は null（呼び出し側で found:false 扱い）。
 */
export function lookupMunicipality(muniCd: string): string | null {
  // 数字のみ・最大5桁を先に検証する（Codex P2: "13115junk" を parseInt が
  // 13115 へ切り詰め、不正な上流データから住所を組み立ててしまうのを防ぐ）。
  if (!/^\d{1,5}$/.test(muniCd)) return null;
  const normalized = String(parseInt(muniCd, 10)); // 先頭ゼロだけ落とす
  return GSI_MUNICIPALITIES[normalized] ?? null;
}

/** GSI 応答（構造は最小限に検証する）。 */
interface GsiResponse {
  results?: {
    muniCd?: unknown;
    lv01Nm?: unknown;
  };
}

/** 応答 JSON → 結果（純関数・テスト対象）。 */
export function parseGsiResponse(json: unknown): ReverseGeocodeResult {
  const results = (json as GsiResponse | null)?.results;
  if (!results) return { found: false }; // {} = 海上・国外（正常な「無し」）
  const muniCd = typeof results.muniCd === "string" ? results.muniCd : "";
  const town = typeof results.lv01Nm === "string" ? results.lv01Nm.trim() : "";
  if (!muniCd || !town) return { found: false };
  const municipality = lookupMunicipality(muniCd);
  if (!municipality) return { found: false }; // 変換表に無いコード=組み立て不能
  return {
    found: true,
    address: `${municipality}${town}`,
    town,
    municipalityCode: String(parseInt(muniCd, 10)),
  };
}

export class GsiReverseGeocodeProvider implements ReverseGeocodeProvider {
  readonly name = "gsi";

  async reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
    const url = `${GSI_ENDPOINT}?lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lng))}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // 認証情報なし・キー不要。Cookie 等も送らない。
        cache: "no-store",
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new ReverseGeocodeError("TIMEOUT");
      }
      throw new ReverseGeocodeError("NETWORK");
    }
    if (!response.ok) {
      throw new ReverseGeocodeError("UPSTREAM_ERROR");
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ReverseGeocodeError("PARSE_ERROR");
    }
    return parseGsiResponse(json);
  }
}
