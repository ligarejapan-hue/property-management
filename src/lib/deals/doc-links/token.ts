import crypto from "crypto";

/**
 * 提出用リンクのトークン = `<publicId(16バイトの乱数)>.<HMAC-SHA256 全長>`。
 *
 * トークンそのものは DB に置かない。DB が漏れても publicId だけではリンクを作れない。
 * 署名方式にしたのは、担当者が再案内の文面にリンクを出し直せるようにするため(ハッシュだけの保存では出し直せない)。
 * 鍵は専用の環境変数だけ。⚠未設定や短いときは null=提出の機能を動かさない(既定の鍵は持たない)。
 * ⚠nginx の見本の正規表現(deploy/nginx/property-management.conf.example)と同じ形。変えたら両方を直す。
 */

export const SUBMIT_PATH_PREFIX = "/submit/";
export const DOC_LINK_SECRET_MIN_LENGTH = 32;
export const DOC_LINK_TOKEN_SOURCE = "[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}";
const TOKEN_RE = new RegExp(`^(${DOC_LINK_TOKEN_SOURCE.split("\\.")[0]})\\.(${DOC_LINK_TOKEN_SOURCE.split("\\.")[1]})$`);

/** 環境変数から署名鍵を読む。無ければ null(fail-closed)。 */
export function docLinkKey(secret: string | undefined = process.env.DEAL_DOC_LINK_SECRET): Buffer | null {
  const s = secret?.trim();
  if (!s || s.length < DOC_LINK_SECRET_MIN_LENGTH) return null;
  return Buffer.from(s, "utf8");
}

export const newDocLinkPublicId = (): string => crypto.randomBytes(16).toString("base64url");

const signPublicId = (publicId: string, key: Buffer): string =>
  crypto.createHmac("sha256", key).update(`deal-doc-link:v1:${publicId}`, "utf8").digest("base64url");

export const buildDocLinkToken = (publicId: string, key: Buffer): string => `${publicId}.${signPublicId(publicId, key)}`;

/** 形と署名が正しければ publicId を返す。DB を見る前に落とす。 */
export function verifyDocLinkToken(raw: string, key: Buffer): string | null {
  const m = TOKEN_RE.exec(raw);
  if (!m) return null;
  const expected = Buffer.from(signPublicId(m[1], key), "utf8");
  const actual = Buffer.from(m[2], "utf8");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  return m[1];
}

export const buildSubmitUrl = (baseUrl: string, token: string): string => `${baseUrl.replace(/\/+$/, "")}${SUBMIT_PATH_PREFIX}${token}`;
