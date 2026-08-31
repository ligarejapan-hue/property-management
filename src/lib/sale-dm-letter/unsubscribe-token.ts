import crypto from "crypto";

/**
 * 配信停止トークン = `<trackingToken>.<HMAC署名(base64url 22文字)>`。
 *
 * なぜ追跡トークン(trackingToken)をそのまま使わないか:
 *  追跡URL(/t/)は LP 側のアクセス記録・ブラウザ履歴・共有スクショに残り得る。
 *  それだけで「拒否」を書き込めると、漏れた追跡URLの流用で他人を停止させられる。
 *  停止URLは**手紙の紙面にしか存在しない**署名付きトークンにし、署名鍵は
 *  NEXTAUTH_SECRET から HKDF で導出した**停止専用鍵**を使う(鍵の用途分離)。
 *
 * なぜ NEXTAUTH_SECRET 由来か(SALE_DM_SETTINGS_ENC_KEY でなく):
 *  - migration も新 env も増やさない。
 *  - NEXTAUTH_SECRET はアプリの認証自体の前提=未設定なら app が動かない。
 *    「画面は揃っていると言うのにサーバーは503」という print-ready 分裂(実績107の型)を
 *    構造的に作らない。
 *  ⚠ローテーションすると**配布済みの手紙の停止QRが無効**になる(検証で弾かれ、画面は
 *    連絡先への案内を出す)。ローテーション時は運用へ周知すること。
 */

export const UNSUBSCRIBE_PATH_PREFIX = "/u/";

const SIG_BYTES = 16; // HMAC-SHA256 の先頭16バイト(=128bit)。総当たりは事実上不可能。
const SIG_B64URL_LEN = 22; // 16バイトの base64url(パディング無し)は常に22文字。

/** NEXTAUTH_SECRET から停止専用鍵(32バイト)を導出。未設定/空は throw(fail-closed)。 */
export function deriveUnsubscribeKey(
  secret: string | undefined = process.env.NEXTAUTH_SECRET,
): Buffer {
  if (!secret || secret.trim().length === 0) {
    throw new Error(
      "NEXTAUTH_SECRET が未設定のため配信停止トークンを署名できません",
    );
  }
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.from("sale-dm-unsubscribe", "utf8"), // salt=用途ラベル(鍵の用途分離)
      Buffer.from("v1", "utf8"),
      32,
    ),
  );
}

export function signUnsubscribeToken(trackingToken: string, key: Buffer): string {
  return crypto
    .createHmac("sha256", key)
    .update(`dm-unsub:${trackingToken}`, "utf8")
    .digest()
    .subarray(0, SIG_BYTES)
    .toString("base64url");
}

export function buildUnsubscribeToken(trackingToken: string, key: Buffer): string {
  return `${trackingToken}.${signUnsubscribeToken(trackingToken, key)}`;
}

// 形式門前払い: trackingToken は base64url 6〜64文字(現行生成は 8バイト=11文字)、
// 署名は base64url 22文字ちょうど。形式外は DB にも HMAC にも触らせず null。
const TOKEN_RE = new RegExp(
  `^([A-Za-z0-9_-]{6,64})\\.([A-Za-z0-9_-]{${SIG_B64URL_LEN}})$`,
);

export function parseUnsubscribeToken(
  raw: string,
): { trackingToken: string; sig: string } | null {
  const m = TOKEN_RE.exec(raw);
  if (!m) return null;
  return { trackingToken: m[1], sig: m[2] };
}

/** 署名を timing-safe に検証し、正当なら trackingToken を返す。 */
export function verifyUnsubscribeToken(
  raw: string,
  key: Buffer,
): string | null {
  const parsed = parseUnsubscribeToken(raw);
  if (!parsed) return null;
  const expected = Buffer.from(
    signUnsubscribeToken(parsed.trackingToken, key),
    "utf8",
  );
  const actual = Buffer.from(parsed.sig, "utf8");
  if (expected.length !== actual.length) return null;
  if (!crypto.timingSafeEqual(expected, actual)) return null;
  return parsed.trackingToken;
}

/**
 * 停止URLを組み立てる(buildTrackingUrl と同じ規約: base 末尾スラッシュは1つに正規化)。
 * token は build 済みの `<trackingToken>.<sig>`。'.' '-' '_' は encodeURIComponent で
 * 保存されるため、URL 上もそのままの見た目になる。
 */
export function buildUnsubscribeUrl(token: string, baseUrl?: string): string {
  const path = `${UNSUBSCRIBE_PATH_PREFIX}${encodeURIComponent(token)}`;
  if (!baseUrl) return path;
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}
