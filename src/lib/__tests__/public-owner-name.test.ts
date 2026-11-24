import { describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma";
import {
  PREFECTURE_NAMES,
  PUBLIC_OWNER_NAMES,
  PUBLIC_OWNER_NAME_CASES,
  STATE_OWNER_NAME_PATTERN,
  isPublicOwnerName,
  normalizePublicOwnerName,
  publicOwnerNameSql,
} from "@/lib/public-owner-name";
import { GSI_MUNICIPALITIES } from "@/lib/reverse-geocode/municipalities";

// 自治体・国が持ち主の所有者は DM 送付不可(2026-11-24 発注者承認)。
// 同じ表 PUBLIC_OWNER_NAME_CASES を本物の Postgres でも当てる(dm-batch/__tests__/agent-name-exclusion-db.test.ts)。

describe("isPublicOwnerName", () => {
  it.each(PUBLIC_OWNER_NAME_CASES)("%s → %s", (name, expected) => {
    expect(isPublicOwnerName(name)).toBe(expected);
  });

  it("「市」で終わる人の名前・一覧に無い市は当たらない(公式の一覧だけで決める)", () => {
    expect(isPublicOwnerName("山田善市")).toBe(false);
    expect(isPublicOwnerName("善市")).toBe(false);
    expect(isPublicOwnerName("存在しない市")).toBe(false);
  });

  it("名字とぶつかる町・村は都道府県が付いたときだけ当たる", () => {
    expect(isPublicOwnerName("木村")).toBe(false);
    expect(isPublicOwnerName("奥多摩町")).toBe(false);
    expect(isPublicOwnerName("東京都奥多摩町")).toBe(true);
  });

  it("全角・半角や空白の違いをそろえる(NFKC → 空白を全部除く)", () => {
    expect(normalizePublicOwnerName(" 国（ 財務省 ）")).toBe("国(財務省)");
    expect(isPublicOwnerName("　横浜市　")).toBe(true);
    expect(isPublicOwnerName(null)).toBe(false);
    expect(isPublicOwnerName(undefined)).toBe(false);
  });
});

describe("公式の市区町村の一覧から作る集合", () => {
  it("都道府県は一覧の頭から取った47個(〇〇県の当て推量はしない)", () => {
    expect(PREFECTURE_NAMES.size).toBe(47);
    for (const p of ["東京都", "北海道", "京都府", "大阪府", "神奈川県", "和歌山県", "鹿児島県", "沖縄県"]) {
      expect(PREFECTURE_NAMES.has(p)).toBe(true);
    }
  });
  it("一覧の値はすべて当たり、都道府県なしの町・村は集合に入らない", () => {
    for (const v of Object.values(GSI_MUNICIPALITIES)) expect(PUBLIC_OWNER_NAMES.has(v)).toBe(true);
    for (const n of PUBLIC_OWNER_NAMES) {
      if (PREFECTURE_NAMES.has(n) || [...PREFECTURE_NAMES].some((p) => n.startsWith(p))) continue;
      expect(n).toMatch(/(市|区|省|庁|^内閣府|^国)$/u);
    }
  });
});

describe("publicOwnerNameSql", () => {
  it("JS と同じそろえ方・同じ集合(text[])と同じ国(…)の形を Postgres に渡す", () => {
    const sql = publicOwnerNameSql(Prisma.sql`o.name`);
    expect(sql.sql).toContain("normalize(coalesce(o.name, ''), NFKC)");
    expect(sql.sql).toContain("'\\s+', '', 'g'");
    expect(sql.sql).toContain("= ANY(");
    expect(sql.sql).toContain("::text[]");
    expect(sql.values).toContainEqual([...PUBLIC_OWNER_NAMES].sort());
    expect(sql.values).toContain(STATE_OWNER_NAME_PATTERN);
  });
});
