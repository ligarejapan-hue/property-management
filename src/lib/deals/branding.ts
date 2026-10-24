/** 取引の設定のロゴ・角印(設計 §2.4・§4.2)。画像の種類・保存場所の鍵・書類への埋め込み。純関数だけ。 */

export const DEAL_IMAGE_KINDS = ["logo", "seal"] as const;
export type DealImageKind = (typeof DEAL_IMAGE_KINDS)[number];
export const DEAL_IMAGE_LABELS: Record<DealImageKind, string> = { logo: "ロゴ", seal: "角印" };
/** DB の列(deal_settings.logo_key / seal_key)。 */
export const DEAL_IMAGE_KEY_FIELD = { logo: "logoKey", seal: "sealKey" } as const satisfies Record<DealImageKind, string>;

/** 受け取る形式。書類の PDF にそのまま埋め込める形だけ。 */
export const DEAL_IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg" } as const;
export type DealImageMime = keyof typeof DEAL_IMAGE_EXT;
export const DEAL_IMAGE_MAX_BYTES = 1024 * 1024;
export const DEAL_IMAGE_MAX_EDGE = 2000;

export const isDealImageKind = (v: string): v is DealImageKind => (DEAL_IMAGE_KINDS as readonly string[]).includes(v);
export const isDealImageMime = (v: string): v is DealImageMime => Object.hasOwn(DEAL_IMAGE_EXT, v);

/** 保存場所の鍵。お客様や会社の名前は入れない。 */
export function dealImageKey(kind: DealImageKind, id: string, mime: DealImageMime): string {
  return `deal-settings/${kind}-${id}.${DEAL_IMAGE_EXT[mime]}`;
}

/** `/uploads` からは配らない鍵(専用の道でだけ出す)。先頭の ./ や / の付け足し・大文字小文字の違いも同じに扱う。 */
export function isDealSettingsStorageKey(key: string): boolean {
  return /^(?:\.?\/+)*deal-settings\//i.test(key);
}

/** 鍵の拡張子から形式を決める(保存したときに決めた形式)。知らない形なら null。 */
export function dealImageMimeFromKey(key: string): DealImageMime | null {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg") return "image/jpeg";
  return null;
}

/** 書類の HTML に埋め込む形。PDF を作るブラウザは外の URL を読まないため、中身ごと入れる。 */
export function imageDataUri(mime: DealImageMime, body: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(body).toString("base64")}`;
}
