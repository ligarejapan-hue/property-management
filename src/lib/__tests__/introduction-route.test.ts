import { describe, it, expect } from "vitest";
import {
  INTRODUCTION_ROUTE_VALUES,
  INTRODUCTION_ROUTE_LABELS,
  normalizeIntroductionRouteInput,
} from "../property-types";
import {
  createPropertySchema,
  updatePropertySchema,
  propertyListQuerySchema,
} from "../validators";
import { PROPERTY_CSV_COLUMN_MAP } from "../csv-parser";

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

// ── 4. UPDATABLE_PROPERTY_FIELDS / PROPERTY_TRACKED_FIELDS ───────────────────

import { UPDATABLE_PROPERTY_FIELDS } from "../import-dedupe";
import { PROPERTY_TRACKED_FIELDS } from "../change-log";

describe("UPDATABLE_PROPERTY_FIELDS", () => {
  it("introductionRoute が含まれる", () => {
    expect(UPDATABLE_PROPERTY_FIELDS).toContain("introductionRoute");
  });
});

describe("PROPERTY_TRACKED_FIELDS", () => {
  it("introductionRoute が含まれる", () => {
    expect(PROPERTY_TRACKED_FIELDS).toContain("introductionRoute");
  });
});

// ── 5. CSV 既存物件更新パス — introductionRoute の純粋関数テスト ─────────────

describe("CSV 既存物件更新パス — introductionRoute", () => {
  /**
   * csv/route.ts の更新データ構築ロジックを再現する純粋関数。
   * numericFields / intFields / trimFields に入らない文字列フィールドは raw 値をそのまま入れる。
   */
  function buildUpdateData(mapped: Record<string, string>): Record<string, unknown> {
    const numericFields = new Set(["rosenkaValue", "gpsLat", "gpsLng", "exclusiveArea", "balconyArea"]);
    const intFields = new Set(["floorNo", "managementFee", "repairReserveFee"]);
    const trimFields = new Set(["layoutType", "orientation"]);
    const updateData: Record<string, unknown> = {};
    for (const field of UPDATABLE_PROPERTY_FIELDS) {
      const raw = mapped[field];
      if (raw === undefined || raw === null || raw === "") continue;
      if (numericFields.has(field)) {
        const n = parseFloat(raw);
        if (!Number.isNaN(n)) updateData[field] = n;
      } else if (intFields.has(field)) {
        const n = parseInt(raw);
        if (!Number.isNaN(n)) updateData[field] = n;
      } else if (trimFields.has(field)) {
        const v = raw.trim();
        if (v) updateData[field] = v;
      } else {
        updateData[field] = raw;
      }
    }
    return updateData;
  }

  it("正規化済み値 reception_csv は updateData に入る", () => {
    const mapped = { address: "東京都千代田区1-1", introductionRoute: "reception_csv" };
    const updateData = buildUpdateData(mapped);
    expect(updateData.introductionRoute).toBe("reception_csv");
  });

  it("正規化済み値 dm_response は updateData に入る", () => {
    const mapped = { address: "東京都千代田区1-1", introductionRoute: "dm_response" };
    const updateData = buildUpdateData(mapped);
    expect(updateData.introductionRoute).toBe("dm_response");
  });

  it("normalize 後に削除された不明値は mapped にないので updateData に入らない", () => {
    // csv/route.ts の正規化ブロックで delete mapped.introductionRoute される相当
    const mapped = { address: "東京都千代田区1-1" }; // introductionRoute absent
    const updateData = buildUpdateData(mapped);
    expect(updateData).not.toHaveProperty("introductionRoute");
  });

  it("空文字は updateData に入らない", () => {
    const mapped = { address: "東京都千代田区1-1", introductionRoute: "" };
    const updateData = buildUpdateData(mapped);
    expect(updateData).not.toHaveProperty("introductionRoute");
  });
});

// ── 6. PROPERTY_CSV_COLUMN_MAP — introductionRoute 列名 ──────────────────────

describe("PROPERTY_CSV_COLUMN_MAP — introductionRoute 列名", () => {
  it.each([
    "導入ルート", "流入経路", "獲得経路",
    "introductionRoute", "introduction_route",
    "acquisitionRoute", "acquisition_route",
    "leadSource", "lead_source",
  ])("列名 %s が introductionRoute にマップされる", (col) => {
    expect(PROPERTY_CSV_COLUMN_MAP[col]).toBe("introductionRoute");
  });
});

describe("normalizeIntroductionRouteInput — 表示ラベルの round-trip", () => {
  it.each(Object.entries(INTRODUCTION_ROUTE_LABELS))(
    "表示ラベル '%s' → %s",
    (value, label) => {
      expect(normalizeIntroductionRouteInput(label)).toBe(value);
    },
  );
});

describe("normalizeIntroductionRouteInput — 既存エイリアス互換", () => {
  it("受付帳CSV → reception_csv", () => expect(normalizeIntroductionRouteInput("受付帳CSV")).toBe("reception_csv"));
  it("電話問合 → phone_inquiry", () => expect(normalizeIntroductionRouteInput("電話問合")).toBe("phone_inquiry"));
  it("WEB問合 → web_inquiry", () => expect(normalizeIntroductionRouteInput("WEB問合")).toBe("web_inquiry"));
  it("Web問合 → web_inquiry", () => expect(normalizeIntroductionRouteInput("Web問合")).toBe("web_inquiry"));
});

// ── 8. resolvePropertyField 相当ロジック — 英語エイリアス ─────────────────────
// row/retry route の JAPANESE_FIELD_MAP + directFields と同等のロジックを
// 純粋関数として再現してテストする（ファイルローカル関数なので直接 import 不可）。

describe("resolvePropertyField 相当 — introductionRoute 英語エイリアス", () => {
  const JAPANESE_FIELD_MAP: Record<string, string> = {
    "導入ルート": "introductionRoute",
    "流入経路": "introductionRoute",
    "獲得経路": "introductionRoute",
    "introduction_route": "introductionRoute",
    "acquisitionRoute": "introductionRoute",
    "acquisition_route": "introductionRoute",
    "leadSource": "introductionRoute",
    "lead_source": "introductionRoute",
  };
  const directFields = new Set([
    "address", "lotNumber", "buildingNumber", "realEstateNumber",
    "propertyType", "registryStatus", "dmStatus", "caseStatus",
    "introductionRoute", "zoningDistrict", "rosenkaValue", "gpsLat", "gpsLng",
    "note", "externalLinkKey",
  ]);
  function resolvePropertyField(key: string): string | undefined {
    if (directFields.has(key)) return key;
    return JAPANESE_FIELD_MAP[key];
  }

  it.each([
    "introduction_route",
    "acquisitionRoute",
    "acquisition_route",
    "leadSource",
    "lead_source",
  ])("英語alias %s → introductionRoute", (alias) => {
    expect(resolvePropertyField(alias)).toBe("introductionRoute");
  });

  it.each(["導入ルート", "流入経路", "獲得経路"])(
    "日本語alias %s → introductionRoute",
    (alias) => {
      expect(resolvePropertyField(alias)).toBe("introductionRoute");
    },
  );

  it("introductionRoute (direct) → introductionRoute", () => {
    expect(resolvePropertyField("introductionRoute")).toBe("introductionRoute");
  });

  it("source 単独は introductionRoute にならない", () => {
    expect(resolvePropertyField("source")).toBeUndefined();
  });

  it("route 単独は introductionRoute にならない", () => {
    expect(resolvePropertyField("route")).toBeUndefined();
  });
});

// ── 7. migration ファイルの確認 ───────────────────────────────────────────────

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
