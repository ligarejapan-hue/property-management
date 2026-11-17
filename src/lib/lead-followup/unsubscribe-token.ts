import crypto from "crypto";
import { buildUnsubscribeUrl } from "@/lib/sale-dm-letter/unsubscribe-token";

/**
 * 追客メールの配信停止トークン(設計 2026-11-16 §5)。
 *
 * 形 = `f<追客の行 UUID から '-' を除いた32桁の小文字16進>.<署名22文字>`。
 *  - 宛名CSVの `c<32桁16進>` と同じ作り。先頭の `f` で見分ける。売却DMの形式門前払い
 *    (`parseUnsubscribeToken`)の内側に収まるので、`/u/` の入口(proxy・nginx)はそのまま使える。
 *  - 署名は今の配信停止の鍵(`deriveUnsubscribeKey`)で、**用途ラベルを分ける**(`lead-followup-unsub:`)。
 *    手紙・宛名CSV の署名をこちらへ流用できない(逆も同じ)。
 *  - 推測できない: 行の id は乱数の UUID、署名は秘密の鍵が無いと作れない。
 */

const PREFIX = "f";
const SIG_BYTES = 16;
const FOLLOWUP_TOKEN_RE = /^f([0-9a-f]{32})\.([A-Za-z0-9_-]{22})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function compact(id: string): string {
  const lower = id.toLowerCase();
  if (!UUID_RE.test(lower)) throw new Error("followupId は UUID であること");
  return lower.replace(/-/g, "");
}

function expand(hex32: string): string {
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
}

function sign(followupId: string, key: Buffer): string {
  return crypto
    .createHmac("sha256", key)
    .update(`lead-followup-unsub:${followupId}`, "utf8")
    .digest()
    .subarray(0, SIG_BYTES)
    .toString("base64url");
}

export function isFollowupUnsubscribeToken(raw: string): boolean {
  return FOLLOWUP_TOKEN_RE.test(raw);
}

export function buildFollowupUnsubscribeToken(followupId: string, key: Buffer): string {
  const hex = compact(followupId);
  return `${PREFIX}${hex}.${sign(expand(hex), key)}`;
}

/** 署名を timing-safe に確かめ、正しければ追客の行の id(ハイフン付き小文字)を返す。 */
export function verifyFollowupUnsubscribeToken(raw: string, key: Buffer): string | null {
  const m = FOLLOWUP_TOKEN_RE.exec(raw);
  if (!m) return null;
  const id = expand(m[1]);
  const expected = Buffer.from(sign(id, key), "utf8");
  const actual = Buffer.from(m[2], "utf8");
  if (expected.length !== actual.length) return null;
  if (!crypto.timingSafeEqual(expected, actual)) return null;
  return id;
}

export function buildFollowupUnsubscribeUrl(followupId: string, baseUrl: string, key: Buffer): string {
  return buildUnsubscribeUrl(buildFollowupUnsubscribeToken(followupId, key), baseUrl);
}
