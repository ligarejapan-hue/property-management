import crypto from "crypto";

/**
 * 広告用の公開ページ(/lp/<公開名>)の申込フォームのボット対策(2026-11-24 発注者依頼)。**サーバー専用**。
 *
 * 背景: ホームページで、ボットの送信が完了画面に飛ばされ Google 広告の成果として誤計上された(申込0件・成果35件)。
 *
 * フォームに隠し欄を3つ出す:
 *  - lp_t  = ページを描いた時刻(UNIX 秒)
 *  - lp_ts = lp_t と公開名への署名(HMAC-SHA256 の先頭16バイト・base64url 22文字)。改ざん防止。
 *  - lp_js = 入力欄に触れた・押した・キーを押したときに画面の JS が "1" を入れる(初期は空)。
 *
 * 受け口での扱い(evaluateLpBotSignals):
 *  - 署名が正しく、表示から送信まで2秒未満 → blocked(too_fast)=honeypot と同じ(「受け付けました」・silent・何も残さない)。
 *  - lp_js が無い・署名が無い/不正 → suspect(no_js / bad_sig)。申込は今までどおり受け付ける(取りこぼさない)。
 *    JS を切っている人・古い端末・キャッシュされたページの人を落とさないため、止めるのは「署名が正しくて速すぎる」だけ。
 *
 * 鍵は NEXTAUTH_SECRET から HKDF で用途別に導出する(新しい env を足さない。配信停止トークン
 * `unsubscribe-token.ts`・通知の印 `notifications/opaque.ts` と同じ考え方)。鍵が無いときは署名を出さず、
 * 受け口では bad_sig=受け付けて記録だけ(止めない側に倒す)。
 * ⚠NEXTAUTH_SECRET を変えると、変える前に開かれたページからの送信は bad_sig になる(受け付けはされる)。
 */

export const LP_STAMP_TIME_FIELD = "lp_t";
export const LP_STAMP_SIG_FIELD = "lp_ts";
export const LP_JS_FIELD = "lp_js";

/** 表示から送信までこれより短ければ機械の送信とみなす(ミリ秒)。 */
export const LP_MIN_FILL_MS = 2_000;

export interface LpFormStamp {
  t: string;
  sig: string;
}

const SIG_BYTES = 16;
const SIG_RE = /^[A-Za-z0-9_-]{22}$/;
const T_RE = /^[0-9]{9,11}$/;

/** 未設定・空は null(署名を出さない・検証は bad_sig)。 */
export function deriveLpFormStampKey(secret: string | undefined = process.env.NEXTAUTH_SECRET): Buffer | null {
  if (!secret || secret.trim().length === 0) return null;
  return Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("lp-form-stamp", "utf8"), Buffer.from("v1", "utf8"), 32),
  );
}

function sign(slug: string, t: string, key: Buffer): string {
  return crypto.createHmac("sha256", key).update(`lp-form:v1:${slug}:${t}`, "utf8").digest().subarray(0, SIG_BYTES).toString("base64url");
}

/** ページを描くときの印。鍵が無ければ null(隠し欄の lp_t・lp_ts を出さない)。 */
export function issueLpFormStamp(slug: string, nowMs: number, key: Buffer | null): LpFormStamp | null {
  if (!key) return null;
  const t = String(Math.floor(nowMs / 1000));
  return { t, sig: sign(slug, t, key) };
}

export type LpBotReason = "honeypot" | "too_fast" | "no_js" | "bad_sig";

export type LpBotVerdict =
  | { kind: "ok" }
  | { kind: "blocked"; reason: "too_fast" }
  | { kind: "suspect"; reasons: ("no_js" | "bad_sig")[] };

/** 署名が正しいか(=この公開名のページを本当にこのサーバーが描いたか)。timing-safe。 */
export function isLpFormStampValid(slug: string, t: string | null, sig: string | null, key: Buffer | null): boolean {
  const tt = (t ?? "").trim();
  const ss = (sig ?? "").trim();
  if (!key || !T_RE.test(tt) || !SIG_RE.test(ss)) return false;
  const expected = Buffer.from(sign(slug, tt, key), "utf8");
  const got = Buffer.from(ss, "utf8");
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

/** 送信の印を判定する純関数。値は表示にも記録にも使わない(判定だけ)。 */
export function evaluateLpBotSignals(input: {
  slug: string;
  t: string | null;
  sig: string | null;
  js: string | null;
  nowMs: number;
  key: Buffer | null;
}): LpBotVerdict {
  const t = (input.t ?? "").trim();
  const sigOk = isLpFormStampValid(input.slug, input.t, input.sig, input.key);
  if (sigOk && input.nowMs - Number(t) * 1000 < LP_MIN_FILL_MS) return { kind: "blocked", reason: "too_fast" };
  const reasons: ("no_js" | "bad_sig")[] = [];
  if ((input.js ?? "").trim() !== "1") reasons.push("no_js");
  if (!sigOk) reasons.push("bad_sig");
  return reasons.length ? { kind: "suspect", reasons } : { kind: "ok" };
}

/** フォームの隠し欄(公開ページだけ)。lp_js は空で出し、画面の JS が操作を見て "1" にする。 */
export function lpStampHiddenFields(stamp: LpFormStamp | null | undefined, selfClose: boolean): string {
  const end = selfClose ? " />" : ">";
  // t は数字だけ・sig は base64url だけ=どちらも HTML で意味を持つ文字を含まない(念のため形を確かめてから出す)。
  const ok = stamp && T_RE.test(stamp.t) && SIG_RE.test(stamp.sig);
  return (ok
    ? `<input type="hidden" name="${LP_STAMP_TIME_FIELD}" value="${stamp.t}"${end}<input type="hidden" name="${LP_STAMP_SIG_FIELD}" value="${stamp.sig}"${end}`
    : "") + `<input type="hidden" name="${LP_JS_FIELD}" value=""${end}`;
}
