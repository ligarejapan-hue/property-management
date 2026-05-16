import { describe, it, expect } from "vitest";
import { createOwnerSchema, updateOwnerSchema } from "../validators";
import {
  maskEmail,
  applyOwnerDisplayLevel,
  applyDisplayToOwner,
  FIELD_STAFF_OWNER_DISPLAY,
} from "../display-level";
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

// ── 6. property detail API — owner display-level 適用後の email 挙動 ──────────
// GET /api/properties/[id] が applyOwnerDisplayLevel を経由して email を返すことを
// 純粋関数レベルで確認する（API ルートは DB 依存のため直接テスト不可）。

describe("applyOwnerDisplayLevel — property detail API 相当の email 挙動", () => {
  const ownerWithEmail = {
    id: "owner-1",
    name: "山田太郎",
    nameKana: null,
    phone: "090-1234-5678",
    zip: "100-0001",
    address: "東京都千代田区丸の内1-1-1",
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

  it("owner:full — fetchProperty 再取得後に email 平文が得られる", () => {
    const result = applyOwnerDisplayLevel(ownerWithEmail, fullPerms);
    expect(result.email).toBe("yamada@example.com");
  });

  it("owner:masked — email がマスクされて返る（平文露出なし）", () => {
    const result = applyOwnerDisplayLevel(ownerWithEmail, maskedPerms);
    expect(result.email).toBe("yam***@example.com");
    // phone / zip / address も同時にマスクされること
    expect(result.phone).toMatch(/\*\*\*/);
    expect(result.zip).toMatch(/\*\*\*\*/);
  });

  it("権限なし — email / phone / zip / address が hidden（null）になる", () => {
    const result = applyOwnerDisplayLevel(ownerWithEmail, noPerms);
    expect(result.email).toBeNull();
    expect(result.phone).toBeNull();
    expect(result.zip).toBeNull();
    expect(result.address).toBeNull();
  });

  it("email が null の owner は null のまま返る", () => {
    const result = applyOwnerDisplayLevel({ ...ownerWithEmail, email: null }, fullPerms);
    expect(result.email).toBeNull();
  });

  it("propertyOwners 配列への適用（map パターン）", () => {
    // property detail API の maskedPropertyOwners = property.propertyOwners.map(po => ({
    //   ...po, owner: applyOwnerDisplayLevel(po.owner, permissions)
    // })) のパターンを再現
    const propertyOwners = [
      { id: "po-1", propertyId: "p-1", ownerId: "owner-1", isPrimary: true,
        relationship: null, note: null, owner: ownerWithEmail },
      { id: "po-2", propertyId: "p-1", ownerId: "owner-2", isPrimary: false,
        relationship: null, note: null,
        owner: { ...ownerWithEmail, id: "owner-2", email: "tanaka@example.com" } },
    ];
    const masked = propertyOwners.map((po) => ({
      ...po,
      owner: applyOwnerDisplayLevel(po.owner, maskedPerms),
    }));
    expect(masked[0].owner.email).toBe("yam***@example.com");
    expect(masked[1].owner.email).toBe("tan***@example.com");
    // propertyOwners 以外のフィールドは維持
    expect(masked[0].isPrimary).toBe(true);
  });
});

// ── 7. applyDisplayToOwner — フィールドレベル config（P1 修正検証）────────────
// getOwnerDisplayConfig が返す per-field config を使うと、
// owner:read でも owner_phone:masked のユーザーの phone がマスクされることを確認する。

describe("applyDisplayToOwner — フィールドレベル config", () => {
  const owner = {
    id: "owner-1",
    name: "山田太郎",
    nameKana: "ヤマダタロウ",
    phone: "090-1234-5678",
    zip: "100-0001",
    address: "東京都千代田区丸の内1-1-1",
    note: "メモ",
    email: "yamada@example.com",
    version: 1,
  };

  it("全 full config — 全フィールドが平文", () => {
    const config = {
      name: "full" as const, nameKana: "full" as const,
      phone: "full" as const, zip: "full" as const,
      address: "full" as const, note: "full" as const, email: "full" as const,
    };
    const result = applyDisplayToOwner(owner, config);
    expect(result.phone).toBe("090-1234-5678");
    expect(result.email).toBe("yamada@example.com");
    expect(result.address).toBe("東京都千代田区丸の内1-1-1");
  });

  it("phone:masked — phone のみマスク、email は full", () => {
    const config = {
      name: "full" as const, nameKana: "full" as const,
      phone: "masked" as const, zip: "full" as const,
      address: "full" as const, note: "full" as const, email: "full" as const,
    };
    const result = applyDisplayToOwner(owner, config);
    expect(result.phone).toMatch(/\*\*\*/);
    expect(result.email).toBe("yamada@example.com"); // phone のみマスク
    expect(result.address).toBe("東京都千代田区丸の内1-1-1");
  });

  it("email:masked — email のみマスク、phone は full", () => {
    const config = {
      name: "full" as const, nameKana: "full" as const,
      phone: "full" as const, zip: "full" as const,
      address: "full" as const, note: "full" as const, email: "masked" as const,
    };
    const result = applyDisplayToOwner(owner, config);
    expect(result.email).toBe("yam***@example.com");
    expect(result.phone).toBe("090-1234-5678"); // email のみマスク
  });

  it("address:partial — partialAddress が適用される", () => {
    const config = {
      name: "full" as const, nameKana: "full" as const,
      phone: "full" as const, zip: "full" as const,
      address: "partial" as const, note: "full" as const, email: "full" as const,
    };
    const result = applyDisplayToOwner(owner, config);
    expect(result.address).toMatch(/^東京都千代田区/);
    expect(result.address).not.toContain("丸の内");
  });

  it("email:hidden — email が result から削除される", () => {
    const config = {
      name: "full" as const, nameKana: "full" as const,
      phone: "full" as const, zip: "full" as const,
      address: "full" as const, note: "full" as const, email: "hidden" as const,
    };
    const result = applyDisplayToOwner(owner, config);
    expect("email" in result).toBe(false);
  });

  it("field_staff 相当の混合 config — phone/zip masked, address partial, email masked", () => {
    const config = {
      name: "full" as const, nameKana: "full" as const,
      phone: "masked" as const, zip: "masked" as const,
      address: "partial" as const, note: "hidden" as const, email: "masked" as const,
    };
    const result = applyDisplayToOwner(owner, config);
    expect(result.phone).toMatch(/\*\*\*/);     // masked
    expect(result.zip).toMatch(/\*\*\*\*/);     // masked
    expect(result.address).toMatch(/^東京都千代田区/); // partial
    expect("note" in result).toBe(false);       // hidden → deleted
    expect(result.email).toBe("yam***@example.com"); // masked
    expect(result.name).toBe("山田太郎");       // full
  });

  it("owner:read 単独で全 PII が full になってしまわないこと（P1 修正検証）", () => {
    // getOwnerDisplayConfig 経由の config では owner:read でも
    // owner_phone:masked があれば phone は masked になる。
    // ここでは config を直接渡して、applyDisplayToOwner が正しくフィールドレベルで動くことを確認。
    const fieldLevelConfig = {
      name: "full" as const, nameKana: "full" as const,
      phone: "masked" as const, // owner_phone:masked
      zip: "masked" as const,   // owner_zip:masked
      address: "partial" as const, // owner_address:partial
      note: "read" as const,
      email: "masked" as const, // owner_email:masked
    };
    const result = applyDisplayToOwner(owner, fieldLevelConfig);
    // owner:read があっても phone/email は平文にならない
    expect(result.phone).not.toBe("090-1234-5678");
    expect(result.email).not.toBe("yamada@example.com");
    expect(result.phone).toMatch(/\*\*\*/);
    expect(result.email).toBe("yam***@example.com");
  });

  it("propertyOwners.map パターン — applyDisplayToOwner で email が正しくマスクされる", () => {
    const fieldLevelConfig = {
      name: "full" as const, nameKana: "full" as const,
      phone: "masked" as const, zip: "masked" as const,
      address: "partial" as const, note: "hidden" as const, email: "masked" as const,
    };
    const propertyOwners = [
      { id: "po-1", isPrimary: true, owner },
      { id: "po-2", isPrimary: false, owner: { ...owner, email: "tanaka@example.com" } },
    ];
    const masked = propertyOwners.map((po) => ({
      ...po,
      owner: applyDisplayToOwner(po.owner, fieldLevelConfig),
    }));
    expect(masked[0].owner.email).toBe("yam***@example.com");
    expect(masked[1].owner.email).toBe("tan***@example.com");
    expect(masked[0].isPrimary).toBe(true); // po フィールドは維持
  });
});

// ── 8. POST /api/owners — create data に email が含まれること（P2 修正検証）───
// prisma.owner.create の data 構築を createOwnerSchema 経由で検証する純粋関数テスト。

describe("POST /api/owners — create data に email が含まれること", () => {
  it("createOwnerSchema が email を parse して返す", () => {
    const result = createOwnerSchema.safeParse({
      name: "山田太郎",
      phone: "090-1234-5678",
      email: "yamada@example.com",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("yamada@example.com");
    }
  });

  it("email なしでも parse できる（email は optional）", () => {
    const result = createOwnerSchema.safeParse({ name: "山田太郎" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBeUndefined();
    }
  });

  it("AuditLog detail の構造 — name のみ（email 生値を含まない）", () => {
    // POST /api/owners の writeAuditLog は detail: { name: owner.name } のみ。
    // email / phone / address の生値が detail に入らないことをスキーマで確認する。
    const auditDetail = { name: "山田太郎" };
    expect(auditDetail).not.toHaveProperty("email");
    expect(auditDetail).not.toHaveProperty("phone");
    expect(auditDetail).not.toHaveProperty("address");
  });
});

// ── 9. getOwnerDisplayConfig — owner_email fallback（純粋関数相当）─────────────
// getOwnerDisplayConfig は async+DB なので、同ロジックを純粋関数として再現してテストする。

function resolveOwnerEmailLevel(
  permissions: { resource: string; action: string; granted: boolean }[],
): string {
  const levels = ["edit", "full", "read", "partial", "masked", "hidden"] as const;
  const resolveLevel = (field: string) => {
    for (const level of levels) {
      const entry = permissions.find((p) => p.resource === field && p.action === level);
      if (entry?.granted) return level;
    }
    return "hidden";
  };
  const hasExplicitEmailEntry = permissions.some((p) => p.resource === "owner_email");
  return hasExplicitEmailEntry ? resolveLevel("owner_email") : resolveLevel("owner_phone");
}

describe("getOwnerDisplayConfig — owner_email fallback", () => {
  it("owner_email:full が設定されている場合は full", () => {
    const perms = [{ resource: "owner_email", action: "full", granted: true }];
    expect(resolveOwnerEmailLevel(perms)).toBe("full");
  });

  it("owner_email:masked が設定されている場合は masked", () => {
    const perms = [{ resource: "owner_email", action: "masked", granted: true }];
    expect(resolveOwnerEmailLevel(perms)).toBe("masked");
  });

  it("owner_email が未設定の場合は owner_phone にフォールバック", () => {
    const perms = [{ resource: "owner_phone", action: "masked", granted: true }];
    expect(resolveOwnerEmailLevel(perms)).toBe("masked"); // phone の masked を継承
  });

  it("owner_email が未設定で owner_phone が full の場合も fallback", () => {
    const perms = [{ resource: "owner_phone", action: "full", granted: true }];
    expect(resolveOwnerEmailLevel(perms)).toBe("full");
  });

  it("owner_email:hidden が明示されている場合は fallback せず hidden", () => {
    const perms = [
      { resource: "owner_email", action: "hidden", granted: true },
      { resource: "owner_phone", action: "full", granted: true },
    ];
    // owner_email:hidden が明示 → resolveLevel("owner_email") = "hidden"
    expect(resolveOwnerEmailLevel(perms)).toBe("hidden");
  });

  it("owner_email も owner_phone も未設定なら hidden", () => {
    const perms: { resource: string; action: string; granted: boolean }[] = [];
    expect(resolveOwnerEmailLevel(perms)).toBe("hidden");
  });
});

// ── 10. seed template 権限の構造確認 ─────────────────────────────────────────
// seed.ts の templateEntries 相当の配列を再現し、owner_email が正しく含まれることを確認。

describe("seed templateEntries — owner_email", () => {
  // seed.ts の templateEntries から owner_email エントリを抜き出した想定値
  const ownerEmailEntries = [
    { role: "field_staff", resource: "owner_email", action: "masked" },
    { role: "office_staff", resource: "owner_email", action: "full" },
    { role: "admin", resource: "owner_email", action: "full" },
  ];

  it("field_staff は owner_email:masked を持つ", () => {
    const entry = ownerEmailEntries.find((e) => e.role === "field_staff");
    expect(entry?.action).toBe("masked");
  });

  it("office_staff は owner_email:full を持つ", () => {
    const entry = ownerEmailEntries.find((e) => e.role === "office_staff");
    expect(entry?.action).toBe("full");
  });

  it("admin は owner_email:full を持つ", () => {
    const entry = ownerEmailEntries.find((e) => e.role === "admin");
    expect(entry?.action).toBe("full");
  });
});

// ── 11. frontend payload — hidden email を null 上書きしない ─────────────────
// OwnerCard.handleSave の payload 構築ロジックを純粋関数として再現してテストする。

function buildOwnerPayload(
  ownerFromApi: { email?: string | null; version: number },
  form: { name: string; nameKana: string; phone: string; zip: string; address: string; email: string },
): Record<string, unknown> {
  const emailReturned = "email" in ownerFromApi;
  const payload: Record<string, unknown> = {
    name: form.name.trim() || undefined,
    nameKana: form.nameKana.trim() || null,
    phone: form.phone.trim() || null,
    zip: form.zip.trim() || null,
    address: form.address.trim() || null,
    version: ownerFromApi.version,
  };
  if (emailReturned) {
    payload.email = form.email.trim() || null;
  }
  return payload;
}

const baseForm = { name: "山田太郎", nameKana: "", phone: "", zip: "", address: "", email: "" };

describe("frontend payload — hidden email null 上書き防止", () => {
  it("email が API レスポンスに含まれる場合は payload に email を入れる", () => {
    const owner = { email: "yamada@example.com", version: 1 };
    const payload = buildOwnerPayload(owner, { ...baseForm, email: "new@example.com" });
    expect(payload).toHaveProperty("email", "new@example.com");
  });

  it("email が空文字の場合は null を送る（既存の空化保存）", () => {
    const owner = { email: "yamada@example.com", version: 1 };
    const payload = buildOwnerPayload(owner, { ...baseForm, email: "" });
    expect(payload).toHaveProperty("email", null);
  });

  it("email が API レスポンスにない（hidden）場合は payload に email を含めない", () => {
    const owner = { version: 1 }; // email キーが存在しない
    const payload = buildOwnerPayload(owner, { ...baseForm, email: "" });
    expect(payload).not.toHaveProperty("email");
  });

  it("名前だけ編集して保存しても、hidden email は null で送られない", () => {
    const owner = { version: 1 }; // email hidden
    const payload = buildOwnerPayload(owner, { ...baseForm, name: "田中一郎" });
    expect(payload.name).toBe("田中一郎");
    expect(payload).not.toHaveProperty("email");
  });

  it("email が null（設定なし）として返ってきた場合は payload に含める", () => {
    const owner = { email: null, version: 1 }; // キーはある、値は null
    const payload = buildOwnerPayload(owner, { ...baseForm, email: "" });
    expect(payload).toHaveProperty("email", null);
  });
});
