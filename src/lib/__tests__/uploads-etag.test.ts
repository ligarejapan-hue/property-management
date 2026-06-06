/**
 * uploads-etag.ts（/uploads 条件付き GET 用ヘルパー）の単体テスト。
 *
 * ETag は immutable な storage key のみから決定的に生成される strong validator
 * （根拠と運用上の注意は uploads-etag.ts のヘッダコメント参照）。
 * If-None-Match の評価は RFC 9110 の weak comparison（W/ 無視・リスト・`*` 対応）。
 */
import { describe, it, expect } from "vitest";
import { buildUploadsEtag, ifNoneMatchMatches } from "@/lib/uploads-etag";

describe("buildUploadsEtag", () => {
  it("同一 key からは常に同一の ETag（決定的）", () => {
    const a = buildUploadsEtag("properties/p1/photos/100.png");
    const b = buildUploadsEtag("properties/p1/photos/100.png");
    expect(a).toBe(b);
  });

  it("異なる key からは異なる ETag", () => {
    expect(buildUploadsEtag("properties/p1/photos/100.png")).not.toBe(
      buildUploadsEtag("properties/p1/photos/101.png"),
    );
  });

  it("quoted な strong ETag 形式（\"<32 hex>\"・W/ なし）", () => {
    const etag = buildUploadsEtag("field-survey/pins/x/photos/u.jpg");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(etag.startsWith('W/')).toBe(false);
  });

  it("key の生文字列を ETag に含めない（一方向ハッシュ）", () => {
    const key = "properties/secret-id/photos/123.png";
    expect(buildUploadsEtag(key)).not.toContain("secret-id");
  });
});

describe("ifNoneMatchMatches", () => {
  const etag = buildUploadsEtag("properties/p1/photos/100.png");

  it("ヘッダ未指定（null / 空文字 / 空白のみ）は false", () => {
    expect(ifNoneMatchMatches(null, etag)).toBe(false);
    expect(ifNoneMatchMatches("", etag)).toBe(false);
    expect(ifNoneMatchMatches("   ", etag)).toBe(false);
  });

  it("完全一致で true・不一致で false", () => {
    expect(ifNoneMatchMatches(etag, etag)).toBe(true);
    expect(ifNoneMatchMatches('"deadbeef"', etag)).toBe(false);
  });

  it("`*` は true", () => {
    expect(ifNoneMatchMatches("*", etag)).toBe(true);
  });

  it("カンマ区切りリスト内の一致を拾う", () => {
    expect(ifNoneMatchMatches(`"deadbeef", ${etag}, "cafebabe"`, etag)).toBe(
      true,
    );
    expect(ifNoneMatchMatches('"deadbeef", "cafebabe"', etag)).toBe(false);
  });

  it("W/ プレフィクスは weak comparison として無視して一致させる", () => {
    expect(ifNoneMatchMatches(`W/${etag}`, etag)).toBe(true);
    expect(ifNoneMatchMatches(`W/"deadbeef"`, etag)).toBe(false);
  });

  it("前後空白を許容する", () => {
    expect(ifNoneMatchMatches(`  ${etag}  `, etag)).toBe(true);
  });
});
