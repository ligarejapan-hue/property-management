import { describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma";
import {
  PUBLIC_OWNER_NAME_CASES,
  PUBLIC_OWNER_NAME_PATTERN,
  isPublicOwnerName,
  normalizePublicOwnerName,
  publicOwnerNameSql,
} from "@/lib/public-owner-name";

// 自治体・国が持ち主の所有者は DM 送付不可(2026-11-24 発注者承認)。
// 同じ表 PUBLIC_OWNER_NAME_CASES を本物の Postgres でも当てる(dm-batch/__tests__/agent-name-exclusion-db.test.ts)。

describe("isPublicOwnerName", () => {
  it.each(PUBLIC_OWNER_NAME_CASES)("%s → %s", (name, expected) => {
    expect(isPublicOwnerName(name)).toBe(expected);
  });

  it("名字とぶつかる町・村だけの名前は当たらない(都道府県が付けば当たる)", () => {
    expect(isPublicOwnerName("木村")).toBe(false);
    expect(isPublicOwnerName("野村")).toBe(false);
    expect(isPublicOwnerName("大町")).toBe(false);
    expect(isPublicOwnerName("長野県大町")).toBe(true);
  });

  it("全角・半角や空白の違いをそろえる(NFKC → 空白を全部除く)", () => {
    expect(normalizePublicOwnerName(" 国（ 財務省 ）")).toBe("国(財務省)");
    expect(isPublicOwnerName("　横浜市　")).toBe(true);
    expect(isPublicOwnerName(null)).toBe(false);
    expect(isPublicOwnerName(undefined)).toBe(false);
  });

  it("市区町村の部分は1〜6字まで(長すぎる名前は当てない)", () => {
    expect(isPublicOwnerName("あいうえおか市")).toBe(true);
    expect(isPublicOwnerName("あいうえおかき市")).toBe(false);
  });
});

describe("publicOwnerNameSql", () => {
  it("JS と同じそろえ方・同じ正規表現の文字列を Postgres の ~ に渡す", () => {
    const sql = publicOwnerNameSql(Prisma.sql`o.name`);
    expect(sql.sql).toContain("normalize(coalesce(o.name, ''), NFKC)");
    expect(sql.sql).toContain("'\\s+', '', 'g'");
    expect(sql.sql).toContain(" ~ ");
    expect(sql.values).toEqual([PUBLIC_OWNER_NAME_PATTERN]);
  });
  it("正規表現は全体一致で、Postgres で使えない書き方(後読み・名前付きの組)を使わない", () => {
    expect(PUBLIC_OWNER_NAME_PATTERN.startsWith("^(?:")).toBe(true);
    expect(PUBLIC_OWNER_NAME_PATTERN.endsWith(")$")).toBe(true);
    expect(PUBLIC_OWNER_NAME_PATTERN).not.toMatch(/\(\?<|\(\?=|\(\?!/);
  });
});
