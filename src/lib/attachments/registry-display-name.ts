/**
 * 謄本(registry)添付の**表示名・保存名を作る唯一の決まりごと**。
 *
 * なぜ1本にまとめるか: 同じ1件の謄本が、画面ごとに違う名前で出ていた。
 *   - 物件詳細の添付タブ : 「謄本(所有者事項).pdf」
 *   - 添付ファイル検索   : 「registry-auto-<受付番号>.pdf」(DBの生の値)
 *   - ゴミ箱             : 「registry.pdf」固定
 *   - ダウンロードの保存名: サーバーの Content-Disposition が付ける「registry.pdf」
 * 名前の作り方が4か所に別々に書かれていたのが原因なので、ここへ集約する。
 *
 * ⚠**生ファイル名は絶対に使わない**。謄本の元ファイル名には所有者名・地番が入り得るため、
 *   名前は「種別(owner|all)」と「登録日」という**非PIIの材料だけ**から組み立てる。
 * ⚠**種別は名前ではなく記録列(registryCertificateType)から取る**。名前と記録の二重管理にしない。
 */

/** 有料取得の請求種別。手動取込は記録されない(null)。 */
export type RegistryCertificateType = "owner" | "all";

/** 種別ラベル。ここに無い値はすべて「種別不明」として扱う(許可リスト方式)。 */
const CERTIFICATE_LABELS: Readonly<Record<RegistryCertificateType, string>> = {
  owner: "(所有者事項)",
  all: "(全部事項)",
};

/**
 * 非ASCIIを解釈しないクライアント向けのフォールバック名。
 * ⚠**従来の保存名と同じ値のまま**にする(挙動を戻す先を残す)。
 */
export const REGISTRY_ASCII_FALLBACK_NAME = "registry.pdf";

/**
 * 自動取得(有料取得)で入った謄本かどうか。
 * 有料取得は必ず種別を owner|all のどちらかに確定させて保存する(auto-fetch の
 * `args.certificateType ?? DEFAULT_CERTIFICATE_TYPE`)。手動取込は undefined を渡すため
 * null のまま残る。よって**種別が記録されていること**が自動取得の印になる。
 */
export function isAutoFetchedRegistry(certType?: string | null): boolean {
  return certType === "owner" || certType === "all";
}

/**
 * 登録日を日本時間の YYYY-MM-DD にする。
 * ⚠サーバーのタイムゾーンは UTC のことがあるため、実行環境のローカル時刻に頼らない。
 *   頼ると、夜に取った謄本の日付が画面(日本時間)と保存名(UTC)で1日ずれる。
 * 読めない値・空の値は null を返し、呼び出し側は日付を付けない。
 * ⚠他の添付の定型名(反響資料など)からも使う。タイムゾーンの決まりを写さない。
 */
export function toJstDateString(
  value?: Date | string | number | null,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA は YYYY-MM-DD 形式。timeZone を明示して日本時間で数える。
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * 謄本の表示名・保存名を組み立てる。
 *   registryDisplayName("owner", 2026-08-25) => "謄本(所有者事項)_2026-08-25.pdf"
 *   registryDisplayName(null,    2026-08-25) => "謄本_2026-08-25.pdf"
 *   registryDisplayName("owner")             => "謄本(所有者事項).pdf"
 */
export function registryDisplayName(
  certType?: string | null,
  createdAt?: Date | string | number | null,
): string {
  const label = isAutoFetchedRegistry(certType)
    ? CERTIFICATE_LABELS[certType as RegistryCertificateType]
    : "";
  const date = toJstDateString(createdAt);
  return `謄本${label}${date ? `_${date}` : ""}.pdf`;
}

/**
 * `/uploads` が返す Content-Disposition の値。
 *
 * ⚠**保存名を決めるのは `<a download>` ではなくこのヘッダ**。同一オリジンでも
 *   Content-Disposition の filename が指定されていればブラウザはそちらを採用するため、
 *   画面側だけ名前を変えても手元に落ちるファイルは変わらない。
 *
 * 日本語名は RFC 5987 の `filename*` で渡し、`filename` には従来どおり ASCII の
 * フォールバックを残す(ヘッダに生の非ASCIIを置かない=文字化け・ヘッダ事故を避ける)。
 */
export function registryContentDisposition(args: {
  downloadIntent: boolean;
  certType?: string | null;
  createdAt?: Date | string | number | null;
}): string {
  if (!args.downloadIntent) return "inline";
  const name = registryDisplayName(args.certType, args.createdAt);
  return [
    "attachment",
    `filename="${REGISTRY_ASCII_FALLBACK_NAME}"`,
    `filename*=UTF-8''${encodeRfc5987(name)}`,
  ].join("; ");
}

/** RFC 5987 attr-char（ここに無い文字はすべて %XX にする＝許可リスト方式）。 */
const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

/**
 * RFC 5987 の ext-value 用の符号化。
 *
 * ⚠`encodeURIComponent` では**足りない**。あれは `( ) ! * ' ~` をそのまま残すが、
 *   RFC 5987 が許すのは attr-char（英数字と `!#$&+-.^_\`|~`）だけで、丸括弧は入っていない。
 *   「謄本(所有者事項)」の括弧が生のままヘッダに出ると、厳しめの実装で壊れ得る。
 *   許可した文字だけを通し、それ以外はすべてバイト単位で %XX にする。
 * ⚠他の添付の Content-Disposition(反響資料など)からも使う。符号化の決まりを写さない。
 */
export function encodeRfc5987(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    out += ATTR_CHAR.test(c)
      ? c
      : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * 謄本PDFを保存するときの generic なファイル名（全経路共通・非PII）。
 *
 * 以前は取得経路ごとに `registry-auto-<受付番号>.pdf` / `registry-recovered-<受付番号>.pdf`
 * とバラバラだった。受付番号は台帳と providerRequestId に残るため、ファイル名に
 * 持たせる必要はない。**画面に出す名前はこの値ではなく `registryDisplayName` が作る**。
 */
export const REGISTRY_STORED_FILE_NAME = "謄本.pdf";
