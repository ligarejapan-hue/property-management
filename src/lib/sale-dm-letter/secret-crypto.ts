import crypto from "crypto";

// 売却促進DM の秘匿設定値(APIキー)を DB に保存する際の暗号化(AES-256-GCM)。
// マスターキーは env SALE_DM_SETTINGS_ENC_KEY(base64 エンコードの 32 バイト)= システム内部秘密。
// DB が漏洩しても鍵そのもの(env)が無ければ復号できない。マスターキーは DB に置かない。
const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // GCM 推奨 96bit
const VERSION = "v1";

function getMasterKey(): Buffer | null {
  const raw = process.env.SALE_DM_SETTINGS_ENC_KEY;
  if (!raw || raw.trim().length === 0) return null;
  try {
    const buf = Buffer.from(raw.trim(), "base64");
    // AES-256 = 32 バイト鍵。長さが違う = 設定ミス/弱い鍵 → 未設定扱い(fail-closed)。
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

// マスターキーが正しく設定されているか(=秘匿値の保存/復号が可能か)。
export function isSecretCryptoConfigured(): boolean {
  return getMasterKey() !== null;
}

// 平文 → `v1:<iv_b64>:<tag_b64>:<ciphertext_b64>`。キー未設定/不正は throw(平文で保存させない)。
export function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  if (!key) {
    throw new Error("SALE_DM_SETTINGS_ENC_KEY が未設定または不正(base64 32バイト)です");
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

// `v1:iv:tag:ct` → 平文。形式不正/改ざん(GCM タグ不一致)/キー未設定は throw。
export function decryptSecret(blob: string): string {
  const key = getMasterKey();
  if (!key) {
    throw new Error("SALE_DM_SETTINGS_ENC_KEY が未設定または不正(base64 32バイト)です");
  }
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("暗号文の形式が不正です");
  }
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ct = Buffer.from(parts[3], "base64");
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
