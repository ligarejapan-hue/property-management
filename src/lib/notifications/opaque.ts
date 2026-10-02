import crypto from "crypto";

/**
 * 通知 段階2の「見たかどうか」の印とカーソルを、画面から中身が読めない不透明な値にする
 * (設計書 §5.2)。**サーバー専用**。
 *
 * - 画面(localStorage)には生の ID・期限を置かない。共用 PC で前の人のタブが後片付けの後に
 *   書き戻しても、次の人には前の人の申込 ID・次回対応の期限が読めないようにするため。
 * - 鍵は NEXTAUTH_SECRET から HKDF で用途別に導出する(新しい env を足さない。配信停止
 *   トークンと同じ考え方・`sale-dm-letter/unsubscribe-token.ts`)。
 *   ⚠NEXTAUTH_SECRET を変えると、画面に保存されたカーソルが読めなくなる(400 → 画面は
 *   その区分を初回として取り直す)。見た印も変わるので、今の次回対応の回が1回出直す。
 */

export type SeenKind = "next_action" | "inquiry" | "registry_job";
export type CursorKind = "inquiry" | "registry_job";

export interface NotificationKeys {
  seen: Buffer;
  cursor: Buffer;
}

/** 初期カーソルの ID(正しい UUID の形の境界値)。DB の UUID 列とも比べられる。 */
export const BOUNDARY_UUID = "00000000-0000-0000-0000-000000000000";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hkdf(secret: string, label: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from(label, "utf8"), Buffer.from("v1", "utf8"), 32));
}

/** 未設定・空は throw(fail-closed)。 */
export function deriveNotificationKeys(secret: string | undefined = process.env.NEXTAUTH_SECRET): NotificationKeys {
  if (!secret || secret.trim().length === 0) {
    throw new Error("NEXTAUTH_SECRET が未設定のため通知の印を作れません");
  }
  return { seen: hkdf(secret, "notifications-seen"), cursor: hkdf(secret, "notifications-cursor") };
}

/** 見たかどうかの印(HMAC-SHA256 の先頭16バイト・base64url 22文字)。利用者ごとに値が違う。 */
export function seenKey(keys: NotificationKeys, userId: string, kind: SeenKind, parts: string[]): string {
  return crypto
    .createHmac("sha256", keys.seen)
    .update([userId, kind, ...parts].join("|"), "utf8")
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

export interface EventCursor {
  t: Date;
  i: string;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** カーソル = base64url(iv | AES-256-GCM 暗号文 | tag)。追加認証データに「種類|利用者ID」。 */
export function encodeEventCursor(keys: NotificationKeys, userId: string, kind: CursorKind, c: EventCursor): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", keys.cursor, iv);
  cipher.setAAD(Buffer.from(`${kind}|${userId}`, "utf8"));
  const body = Buffer.concat([cipher.update(JSON.stringify({ t: c.t.toISOString(), i: c.i }), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

/** 読めない(壊れた・改ざん・別の人/種類)ときは null。呼び出し側は 400 にする(黙って初期化しない)。 */
export function decodeEventCursor(keys: NotificationKeys, userId: string, kind: CursorKind, raw: string): EventCursor | null {
  if (!raw || raw.length > 400 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const buf = Buffer.from(raw, "base64url");
    if (buf.length <= IV_BYTES + TAG_BYTES) return null;
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(buf.length - TAG_BYTES);
    const body = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
    const decipher = crypto.createDecipheriv("aes-256-gcm", keys.cursor, iv);
    decipher.setAAD(Buffer.from(`${kind}|${userId}`, "utf8"));
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(json) as { t?: unknown; i?: unknown };
    if (typeof parsed.t !== "string" || typeof parsed.i !== "string" || !UUID_RE.test(parsed.i)) return null;
    const t = new Date(parsed.t);
    if (Number.isNaN(t.getTime())) return null;
    return { t, i: parsed.i.toLowerCase() };
  } catch {
    return null;
  }
}
