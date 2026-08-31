import { describe, it, expect } from "vitest";
import {
  deriveUnsubscribeKey,
  signUnsubscribeToken,
  buildUnsubscribeToken,
  parseUnsubscribeToken,
  verifyUnsubscribeToken,
  buildUnsubscribeUrl,
  UNSUBSCRIBE_PATH_PREFIX,
} from "../sale-dm-letter/unsubscribe-token";

// 配信停止トークン = `<trackingToken>.<HMAC署名>`。
// 追跡トークン単体(LPアクセス記録・ブラウザ履歴に残り得る)では停止できないよう、
// 署名鍵は NEXTAUTH_SECRET から HKDF で導出した停止専用鍵を使う。

const KEY = deriveUnsubscribeKey("test-secret-for-unsubscribe");

describe("deriveUnsubscribeKey", () => {
  it("同じ secret からは同じ鍵、違う secret からは違う鍵", () => {
    const a = deriveUnsubscribeKey("s1");
    const b = deriveUnsubscribeKey("s1");
    const c = deriveUnsubscribeKey("s2");
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.length).toBe(32);
  });

  it("secret 未設定/空は throw(署名できない状態で手紙を刷らせない=fail-closed)", () => {
    // ⚠引数 undefined は既定値経由で process.env.NEXTAUTH_SECRET へフォールバックする。
    //   CI は env を設定している(ci.yml)ため、env を消してから検証しないと環境で結果が変わる
    //   (実際にローカル緑・CI赤の食い違いを起こした)。env は必ず元へ戻す。
    const saved = process.env.NEXTAUTH_SECRET;
    try {
      delete process.env.NEXTAUTH_SECRET;
      expect(() => deriveUnsubscribeKey(undefined)).toThrow();
    } finally {
      if (saved === undefined) delete process.env.NEXTAUTH_SECRET;
      else process.env.NEXTAUTH_SECRET = saved;
    }
    // 明示的な空・空白は env に依存せず常に throw。
    expect(() => deriveUnsubscribeKey("")).toThrow();
    expect(() => deriveUnsubscribeKey("  ")).toThrow();
  });
});

describe("sign/build/parse/verify", () => {
  it("署名は base64url 22文字(16バイト)で決定的", () => {
    const s1 = signUnsubscribeToken("trk_12345", KEY);
    const s2 = signUnsubscribeToken("trk_12345", KEY);
    expect(s1).toBe(s2);
    expect(s1).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("build → parse → verify が往復する", () => {
    const token = buildUnsubscribeToken("AbC-123_xyz", KEY);
    const parsed = parseUnsubscribeToken(token);
    expect(parsed?.trackingToken).toBe("AbC-123_xyz");
    expect(verifyUnsubscribeToken(token, KEY)).toBe("AbC-123_xyz");
  });

  it("parse は形式門前払い(DBに触る前に落とす): 形式外は null", () => {
    expect(parseUnsubscribeToken("")).toBeNull();
    expect(parseUnsubscribeToken("no-dot")).toBeNull();
    expect(parseUnsubscribeToken("a.b.c")).toBeNull();
    expect(parseUnsubscribeToken("ok." + "x".repeat(21))).toBeNull(); // 署名長不足
    expect(parseUnsubscribeToken("日本語." + "x".repeat(22))).toBeNull(); // 文字種
    expect(parseUnsubscribeToken("x".repeat(100) + "." + "y".repeat(22))).toBeNull(); // 長すぎ
  });

  it("署名が違えば verify は null(別トークンの署名の付け替え・改ざんを拒否)", () => {
    const token = buildUnsubscribeToken("token-a", KEY);
    const other = buildUnsubscribeToken("token-b", KEY);
    const sigOfOther = other.split(".")[1];
    expect(verifyUnsubscribeToken(`token-a.${sigOfOther}`, KEY)).toBeNull();
    // 末尾1文字改ざん
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyUnsubscribeToken(tampered, KEY)).toBeNull();
  });

  it("違う鍵(=secret ローテーション後)では検証できない", () => {
    const token = buildUnsubscribeToken("token-a", KEY);
    expect(verifyUnsubscribeToken(token, deriveUnsubscribeKey("rotated"))).toBeNull();
  });
});

describe("buildUnsubscribeUrl", () => {
  it("base 指定時は絶対URL、末尾スラッシュは正規化", () => {
    expect(buildUnsubscribeUrl("t.s", "https://example.com/")).toBe(
      `https://example.com${UNSUBSCRIBE_PATH_PREFIX}t.s`,
    );
  });

  it("token は URL エンコードされる(手紙面のURLに予期せぬ区切りを漏らさない)", () => {
    expect(buildUnsubscribeUrl("a.b", "https://x.jp")).toBe(
      "https://x.jp/u/a.b",
    );
    // '.' は encodeURIComponent で保存される(トークン区切りとして安全)
  });
});
