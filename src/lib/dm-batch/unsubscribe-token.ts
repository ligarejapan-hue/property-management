import crypto from "crypto";
import { buildUnsubscribeUrl } from "@/lib/sale-dm-letter/unsubscribe-token";

/**
 * 宛名CSV(DM差込CSV出力)の1通ごとの配信停止トークン。
 *
 * 形 = `c<控えの行 UUID から '-' を除いた32桁の小文字16進>.<署名22文字>`。
 *  - 先頭の `c` と長さで売却DMのトークン(追跡トークン=11文字)と判別する。既存の形式門前払い
 *    (`parseUnsubscribeToken`)の内側に収まるので、`/u/` の入口はそのまま使える。
 *  - 署名は売却DMと同じ停止専用鍵(`deriveUnsubscribeKey`)で、**用途ラベルを分ける**
 *    (`dm-unsub-batch-item:`)。片方の署名をもう片方へ流用できない。
 */

const PREFIX = "c";
const SIG_BYTES = 16;
const BATCH_TOKEN_RE = /^c([0-9a-f]{32})\.([A-Za-z0-9_-]{22})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function compact(itemId: string): string {
  const lower = itemId.toLowerCase();
  if (!UUID_RE.test(lower)) throw new Error("itemId は UUID であること");
  return lower.replace(/-/g, "");
}

function expand(hex32: string): string {
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
}

function sign(itemId: string, key: Buffer): string {
  return crypto
    .createHmac("sha256", key)
    .update(`dm-unsub-batch-item:${itemId}`, "utf8")
    .digest()
    .subarray(0, SIG_BYTES)
    .toString("base64url");
}

export function isBatchItemUnsubscribeToken(raw: string): boolean {
  return BATCH_TOKEN_RE.test(raw);
}

export function buildBatchItemUnsubscribeToken(itemId: string, key: Buffer): string {
  const hex = compact(itemId);
  return `${PREFIX}${hex}.${sign(expand(hex), key)}`;
}

/** 署名を timing-safe に検証し、正しければ itemId(ハイフン付き小文字)を返す。 */
export function verifyBatchItemUnsubscribeToken(raw: string, key: Buffer): string | null {
  const m = BATCH_TOKEN_RE.exec(raw);
  if (!m) return null;
  const itemId = expand(m[1]);
  const expected = Buffer.from(sign(itemId, key), "utf8");
  const actual = Buffer.from(m[2], "utf8");
  if (expected.length !== actual.length) return null;
  if (!crypto.timingSafeEqual(expected, actual)) return null;
  return itemId;
}

export function buildBatchItemUnsubscribeUrl(itemId: string, baseUrl: string, key: Buffer): string {
  return buildUnsubscribeUrl(buildBatchItemUnsubscribeToken(itemId, key), baseUrl);
}
