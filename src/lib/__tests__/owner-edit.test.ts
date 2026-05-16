import { describe, it, expect } from "vitest";
import { createOwnerSchema, updateOwnerSchema } from "../validators";
import { maskEmail, applyOwnerDisplayLevel, FIELD_STAFF_OWNER_DISPLAY } from "../display-level";
import { OWNER_TRACKED_FIELDS } from "../change-log";
import * as fs from "fs";
import * as path from "path";

// ── 1. バリデータ — email フィールド ─────────────────────────────────────────

describe("createOwnerSchema — email", () => {
  it("有効なメールアドレスを accept する", () => {
    const result = createOwnerSchema.safeParse({
      name: "山田太郎",
      email: "yamada@example.com",
    });
    expect(result.success).toBe(true);
  });

  it("null を accept する（任意フィールド）", () => {
    const result = createOwnerSchema.safeParse({ name: "山田太郎", email: null });
    expect(result.success).toBe(true);
  });

  it("email 未指定でも accept する", () => {
    const result = createOwnerSchema.safeParse({ name: "山田太郎" });
    expect(result.success).toBe(true);
  });

  it("不正な形式を reject する", () => {
    const result = createOwnerSchema.safeParse({
      name: "山田太郎",
      email: "not-an-email",
    });
    expect(result.success).toBe(false);
  });
});

describe("updateOwnerSchema — email", () => {
  it("有効なメールアドレスを accept する", () => {
    const result = updateOwnerSchema.safeParse({
      email: "yamada@example.com",
      version: 1,
    });
    expect(result.success).toBe(true);
  });

  it("null を accept する", () => {
    const result = updateOwnerSchema.safeParse({ email: null, version: 1 });
    expect(result.success).toBe(true);
  });

  it("不正な形式を reject する", () => {
    const result = updateOwnerSchema.safeParse({
      email: "bad@@email",
      version: 1,
    });
    expect(result.success).toBe(false);
  });

  it("version なしを reject する", () => {
    const result = updateOwnerSchema.safeParse({ email: "a@b.com" });
    expect(result.success).toBe(false);
  });
});

// ── 2. maskEmail ─────────────────────────────────────────────────────────────

describe("maskEmail", () => {
  it("通常のメールアドレスをマスクする", () => {
    expect(maskEmail("yamada@example.com")).toBe("yam***@example.com");
  });

  it("ローカルパートが3文字ちょうど", () => {
    expect(maskEmail("abc@example.com")).toBe("abc***@example.com");
  });

  it("ローカルパートが2文字（先頭0文字表示）", () => {
    expect(maskEmail("ab@example.com")).toBe("***@example.com");
  });

  it("ローカルパートが1文字", () => {
    expect(maskEmail("a@example.com")).toBe("***@example.com");
  });

  it("@ がない文字列は *** を返す", () => {
    expect(maskEmail("notanemail")).toBe("***");
  });
});

// ── 3. applyOwnerDisplayLevel — email ────────────────────────────────────────

const baseOwner = {
  id: "1",
  name: "山田太郎",
  nameKana: null,
  phone: null,
  zip: null,
  address: null,
  note: null,
  email: "yamada@example.com",
};

const fullPerms = [
  { resource: "owner", action: "full", granted: true },
] as import("../permissions").PermissionMap;

const maskedPerms = [
  { resource: "owner", action: "masked", granted: true },
] as import("../permissions").PermissionMap;

const noPerms = [] as import("../permissions").PermissionMap;

describe("applyOwnerDisplayLevel — email の表示レベル", () => {
  it("owner:full → email を平文で返す", () => {
    const result = applyOwnerDisplayLevel(baseOwner, fullPerms);
    expect(result.email).toBe("yamada@example.com");
  });

  it("owner:masked → email をマスクして返す", () => {
    const result = applyOwnerDisplayLevel(baseOwner, maskedPerms);
    expect(result.email).toBe("yam***@example.com");
  });

  it("権限なし → email が null（hidden）", () => {
    const result = applyOwnerDisplayLevel(baseOwner, noPerms);
    expect(result.email).toBeNull();
  });

  it("FIELD_STAFF_OWNER_DISPLAY.email は masked", () => {
    expect(FIELD_STAFF_OWNER_DISPLAY.email).toBe("masked");
  });

  it("email が null の場合は null を返す", () => {
    const result = applyOwnerDisplayLevel({ ...baseOwner, email: null }, fullPerms);
    expect(result.email).toBeNull();
  });
});

// ── 4. OWNER_TRACKED_FIELDS に email が含まれること ─────────────────────────

describe("OWNER_TRACKED_FIELDS", () => {
  it("email が含まれる", () => {
    expect(OWNER_TRACKED_FIELDS).toContain("email");
  });

  it("既存フィールドが維持されている", () => {
    for (const f of ["name", "nameKana", "phone", "zip", "address", "note"]) {
      expect(OWNER_TRACKED_FIELDS).toContain(f);
    }
  });
});

// ── 5. migration.sql の確認 ──────────────────────────────────────────────────

describe("20260516000000_add_owner_email migration", () => {
  const migDir = path.resolve(__dirname, "../../../prisma/migrations");
  const sql = () =>
    fs.readFileSync(
      path.join(migDir, "20260516000000_add_owner_email", "migration.sql"),
      "utf8",
    );

  it("migration.sql が存在する", () => {
    expect(() => sql()).not.toThrow();
  });

  it("owners テーブルへの ADD COLUMN email を含む", () => {
    expect(sql()).toMatch(/ADD COLUMN.*email/i);
  });

  it("ALTER TYPE を含まない（enum 変更なし）", () => {
    expect(sql()).not.toMatch(/ALTER TYPE/i);
  });

  it("UPDATE を含まない（backfill なし）", () => {
    expect(sql()).not.toMatch(/^\s*UPDATE/im);
  });
});
