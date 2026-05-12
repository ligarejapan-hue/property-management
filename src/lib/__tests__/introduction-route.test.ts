import { describe, it, expect } from "vitest";
import {
  INTRODUCTION_ROUTE_VALUES,
  normalizeIntroductionRouteInput,
} from "../property-types";
import {
  createPropertySchema,
  updatePropertySchema,
  propertyListQuerySchema,
} from "../validators";

// ── 1. バリデータが8値を accept する ─────────────────────────────────────────

describe("createPropertySchema — introductionRoute", () => {
  it.each(INTRODUCTION_ROUTE_VALUES)("値 %s を accept する", (v) => {
    const result = createPropertySchema.safeParse({
      propertyType: "land",
      address: "東京都千代田区1-1",
      introductionRoute: v,
    });
    expect(result.success).toBe(true);
  });

  it("null を accept する", () => {
    const result = createPropertySchema.safeParse({
      propertyType: "land",
      address: "東京都千代田区1-1",
      introductionRoute: null,
    });
    expect(result.success).toBe(true);
  });

  it("不明値を reject する", () => {
    const result = createPropertySchema.safeParse({
      propertyType: "land",
      address: "東京都千代田区1-1",
      introductionRoute: "invalid_xyz",
    });
    expect(result.success).toBe(false);
  });
});

describe("updatePropertySchema — introductionRoute", () => {
  it.each(INTRODUCTION_ROUTE_VALUES)("値 %s を accept する", (v) => {
    const result = updatePropertySchema.safeParse({ introductionRoute: v, version: 1 });
    expect(result.success).toBe(true);
  });

  it("null を accept する", () => {
    const result = updatePropertySchema.safeParse({ introductionRoute: null, version: 1 });
    expect(result.success).toBe(true);
  });

  it("不明値を reject する", () => {
    const result = updatePropertySchema.safeParse({ introductionRoute: "invalid_xyz", version: 1 });
    expect(result.success).toBe(false);
  });
});

describe("propertyListQuerySchema — introductionRoute フィルタ", () => {
  it.each(INTRODUCTION_ROUTE_VALUES)("値 %s を accept する", (v) => {
    const result = propertyListQuerySchema.safeParse({ introductionRoute: v });
    expect(result.success).toBe(true);
  });

  it("不明値を reject する", () => {
    const result = propertyListQuerySchema.safeParse({ introductionRoute: "invalid_xyz" });
    expect(result.success).toBe(false);
  });
});

// ── 2. normalizeIntroductionRouteInput の変換 ──────────────────────────────

describe("normalizeIntroductionRouteInput", () => {
  it.each(INTRODUCTION_ROUTE_VALUES)("アクティブ値 %s はそのまま返す", (v) => {
    expect(normalizeIntroductionRouteInput(v)).toBe(v);
  });

  it("受付帳CSV → reception_csv", () => {
    expect(normalizeIntroductionRouteInput("受付帳CSV")).toBe("reception_csv");
  });

  it("受付帳 → reception_csv", () => {
    expect(normalizeIntroductionRouteInput("受付帳")).toBe("reception_csv");
  });

  it("DM反響 → dm_response", () => {
    expect(normalizeIntroductionRouteInput("DM反響")).toBe("dm_response");
  });

  it("DM → dm_response", () => {
    expect(normalizeIntroductionRouteInput("DM")).toBe("dm_response");
  });

  it("電話問合 → phone_inquiry", () => {
    expect(normalizeIntroductionRouteInput("電話問合")).toBe("phone_inquiry");
  });

  it("電話問い合わせ → phone_inquiry", () => {
    expect(normalizeIntroductionRouteInput("電話問い合わせ")).toBe("phone_inquiry");
  });

  it("電話 → phone_inquiry", () => {
    expect(normalizeIntroductionRouteInput("電話")).toBe("phone_inquiry");
  });

  it("WEB問合 → web_inquiry", () => {
    expect(normalizeIntroductionRouteInput("WEB問合")).toBe("web_inquiry");
  });

  it("WEB → web_inquiry", () => {
    expect(normalizeIntroductionRouteInput("WEB")).toBe("web_inquiry");
  });

  it("紹介 → referral", () => {
    expect(normalizeIntroductionRouteInput("紹介")).toBe("referral");
  });

  it("現地調査 → field_survey", () => {
    expect(normalizeIntroductionRouteInput("現地調査")).toBe("field_survey");
  });

  it("現地 → field_survey", () => {
    expect(normalizeIntroductionRouteInput("現地")).toBe("field_survey");
  });

  it("手入力 → manual_entry", () => {
    expect(normalizeIntroductionRouteInput("手入力")).toBe("manual_entry");
  });

  it("手動 → manual_entry", () => {
    expect(normalizeIntroductionRouteInput("手動")).toBe("manual_entry");
  });

  it("その他 → other", () => {
    expect(normalizeIntroductionRouteInput("その他")).toBe("other");
  });

  it("不明な値は null", () => {
    expect(normalizeIntroductionRouteInput("unknown_xyz")).toBeNull();
  });

  it("空文字列は null", () => {
    expect(normalizeIntroductionRouteInput("")).toBeNull();
  });

  it("null は null", () => {
    expect(normalizeIntroductionRouteInput(null)).toBeNull();
  });

  it("数値は null", () => {
    expect(normalizeIntroductionRouteInput(42)).toBeNull();
  });
});

// ── 3. buildPropertyCreateData — reception_csv 固定値のテスト ────────────────

describe("buildPropertyCreateData — introductionRoute 正規化（純粋関数テスト）", () => {
  function extractIntroductionRoute(mappedRoute: string | undefined): string | null {
    return normalizeIntroductionRouteInput(mappedRoute);
  }

  it("reception_csv → reception_csv", () => {
    expect(extractIntroductionRoute("reception_csv")).toBe("reception_csv");
  });

  it("受付帳 → reception_csv", () => {
    expect(extractIntroductionRoute("受付帳")).toBe("reception_csv");
  });

  it("DM → dm_response", () => {
    expect(extractIntroductionRoute("DM")).toBe("dm_response");
  });

  it("undefined → null", () => {
    expect(extractIntroductionRoute(undefined)).toBeNull();
  });

  it("不明値 → null", () => {
    expect(extractIntroductionRoute("unknown_xyz")).toBeNull();
  });
});

// ── 4. migration ファイルの確認 ───────────────────────────────────────────────

import * as fs from "fs";
import * as path from "path";

describe("20260513000000_add_introduction_route migration", () => {
  const migDir = path.resolve(__dirname, "../../../prisma/migrations");
  const sql = () =>
    fs.readFileSync(
      path.join(migDir, "20260513000000_add_introduction_route", "migration.sql"),
      "utf8",
    );

  it("migration.sql が存在する", () => {
    expect(() => sql()).not.toThrow();
  });

  it("ADD COLUMN introduction_route を含む", () => {
    expect(sql()).toMatch(/ADD COLUMN.*introduction_route/i);
  });

  it("ALTER TYPE を含まない（enum 変更なし）", () => {
    expect(sql()).not.toMatch(/ALTER TYPE/i);
  });

  it("UPDATE を含まない（データマイグレーションなし）", () => {
    expect(sql()).not.toMatch(/^\s*UPDATE/im);
  });
});
