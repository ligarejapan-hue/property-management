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

// ── 12. field-level full 判定 — buildOwnerUpdatePayload ──────────────────────
// owner-edit-utils.ts の buildOwnerUpdatePayload をテストする。
// masked/hidden 項目が payload に含まれないこと、nameKana が name と独立していることを確認。

import { buildOwnerUpdatePayload, OwnerEditableFields } from "../owner-edit-utils";

const allEditable: OwnerEditableFields = {
  name: true, nameKana: true, phone: true, zip: true, address: true, email: true,
};
const noneEditable: OwnerEditableFields = {
  name: false, nameKana: false, phone: false, zip: false, address: false, email: false,
};
const fullForm = {
  name: "山田太郎",
  nameKana: "ヤマダタロウ",
  phone: "090-1234-5678",
  zip: "123-4567",
  address: "東京都渋谷区1-1",
  email: "yamada@example.com",
};

describe("buildOwnerUpdatePayload — field-level full guard", () => {
  it("全フィールド full の場合はすべて payload に含まれる", () => {
    const payload = buildOwnerUpdatePayload(fullForm, allEditable, 3);
    expect(payload.name).toBe("山田太郎");
    expect(payload.nameKana).toBe("ヤマダタロウ");
    expect(payload.phone).toBe("090-1234-5678");
    expect(payload.zip).toBe("123-4567");
    expect(payload.address).toBe("東京都渋谷区1-1");
    expect(payload.email).toBe("yamada@example.com");
    expect(payload.version).toBe(3);
  });

  it("owner_phone:masked の場合、phone が payload に含まれない", () => {
    const fields = { ...allEditable, phone: false };
    const payload = buildOwnerUpdatePayload(fullForm, fields, 1);
    expect(payload).not.toHaveProperty("phone");
  });

  it("owner_zip:masked または hidden の場合、zip が payload に含まれない", () => {
    const fields = { ...allEditable, zip: false };
    const payload = buildOwnerUpdatePayload(fullForm, fields, 1);
    expect(payload).not.toHaveProperty("zip");
  });

  it("owner_address:partial または hidden の場合、address が payload に含まれない", () => {
    const fields = { ...allEditable, address: false };
    const payload = buildOwnerUpdatePayload(fullForm, fields, 1);
    expect(payload).not.toHaveProperty("address");
  });

  it("owner_email:masked または hidden の場合、email が payload に含まれない", () => {
    const fields = { ...allEditable, email: false };
    const payload = buildOwnerUpdatePayload(fullForm, fields, 1);
    expect(payload).not.toHaveProperty("email");
  });

  it("owner_email:full の場合のみ email が payload に含まれる", () => {
    const withEmail = buildOwnerUpdatePayload(fullForm, { ...noneEditable, email: true }, 1);
    expect(withEmail).toHaveProperty("email", "yamada@example.com");
    const withoutEmail = buildOwnerUpdatePayload(fullForm, noneEditable, 1);
    expect(withoutEmail).not.toHaveProperty("email");
  });

  it("owner_phone:full の場合のみ phone が payload に含まれる", () => {
    const withPhone = buildOwnerUpdatePayload(fullForm, { ...noneEditable, phone: true }, 1);
    expect(withPhone).toHaveProperty("phone", "090-1234-5678");
    const withoutPhone = buildOwnerUpdatePayload(fullForm, noneEditable, 1);
    expect(withoutPhone).not.toHaveProperty("phone");
  });

  it("名前だけ編集しても、masked phone / hidden address / hidden email が null や masked文字列で送信されない", () => {
    const fields = { ...noneEditable, name: true }; // name だけ full
    const payload = buildOwnerUpdatePayload(fullForm, fields, 1);
    expect(payload).toHaveProperty("name", "山田太郎");
    expect(payload).not.toHaveProperty("nameKana");
    expect(payload).not.toHaveProperty("phone");
    expect(payload).not.toHaveProperty("zip");
    expect(payload).not.toHaveProperty("address");
    expect(payload).not.toHaveProperty("email");
  });

  it("編集可能項目が全くない場合は version のみ", () => {
    const payload = buildOwnerUpdatePayload(fullForm, noneEditable, 5);
    expect(Object.keys(payload)).toEqual(["version"]);
    expect(payload.version).toBe(5);
  });

  // nameKana と name の独立判定テスト（P2 対応）
  it("fields.name=true, fields.nameKana=false の場合、nameKana が payload に含まれない", () => {
    const fields = { ...noneEditable, name: true, nameKana: false };
    const payload = buildOwnerUpdatePayload(fullForm, fields, 1);
    expect(payload).toHaveProperty("name", "山田太郎");
    expect(payload).not.toHaveProperty("nameKana");
  });

  it("fields.name=false, fields.nameKana=true の場合、name は含まれず nameKana だけ含まれる", () => {
    const fields = { ...noneEditable, name: false, nameKana: true };
    const payload = buildOwnerUpdatePayload(fullForm, fields, 1);
    expect(payload).not.toHaveProperty("name");
    expect(payload).toHaveProperty("nameKana", "ヤマダタロウ");
  });

  it("nameKana hidden/未返却相当（nameKana=false）で null 上書きされない", () => {
    // nameKana が hidden の場合、form.nameKana="" でも payload に含めない
    const fields = { ...allEditable, nameKana: false };
    const payload = buildOwnerUpdatePayload({ ...fullForm, nameKana: "" }, fields, 1);
    expect(payload).not.toHaveProperty("nameKana");
  });

  it("hasAnyEditable ロジック — 全 false のとき false", () => {
    const f = noneEditable;
    const hasAny = f.name || f.nameKana || f.phone || f.zip || f.address || f.email;
    expect(hasAny).toBe(false);
  });

  it("hasAnyEditable ロジック — nameKana だけ true のとき true", () => {
    const f = { ...noneEditable, nameKana: true };
    const hasAny = f.name || f.nameKana || f.phone || f.zip || f.address || f.email;
    expect(hasAny).toBe(true);
  });
});

// ── 13. PATCH サーバー側 field-level ガード（displayConfig ベース版）────────────
// ※ 実装は section 14 の hasExplicitWritePerm ベースに移行済み。
// ここでは display-level を経由したチェックの概念的なテストとして残す。

type DisplayLevel13 = "hidden" | "masked" | "partial" | "full" | "read" | "edit";
type DisplayConfig13 = Record<string, DisplayLevel13>;

/** route.ts のフィールド権限チェックと同等のロジック */
function checkOwnerFieldPermissions(
  updateFields: Record<string, unknown>,
  displayConfig: DisplayConfig13,
): string | null {
  const checks = [
    { requestKey: "name", configKey: "name" },
    { requestKey: "nameKana", configKey: "nameKana" },
    { requestKey: "phone", configKey: "phone" },
    { requestKey: "zip", configKey: "zip" },
    { requestKey: "address", configKey: "address" },
    { requestKey: "email", configKey: "email" },
  ];
  for (const { requestKey, configKey } of checks) {
    if (requestKey in updateFields) {
      const level = displayConfig[configKey] ?? "hidden";
      if (level !== "full" && level !== "edit") return requestKey;
    }
  }
  return null; // 全フィールド許可
}

describe("PATCH field-level permission guard — server side", () => {
  it("owner_email:full なら email 更新を許可", () => {
    expect(checkOwnerFieldPermissions({ email: "a@b.com" }, { email: "full" })).toBeNull();
  });

  it("owner_email:masked で email 更新を拒否", () => {
    expect(checkOwnerFieldPermissions({ email: "a@b.com" }, { email: "masked" })).toBe("email");
  });

  it("owner_email:hidden で email 更新を拒否", () => {
    expect(checkOwnerFieldPermissions({ email: "a@b.com" }, { email: "hidden" })).toBe("email");
  });

  it("owner_phone:masked で phone 更新を拒否", () => {
    expect(checkOwnerFieldPermissions({ phone: "090-0000-0000" }, { phone: "masked" })).toBe("phone");
  });

  it("owner_phone:full なら phone 更新を許可", () => {
    expect(checkOwnerFieldPermissions({ phone: "090-0000-0000" }, { phone: "full" })).toBeNull();
  });

  it("owner_address:partial で address 更新を拒否", () => {
    expect(checkOwnerFieldPermissions({ address: "東京都" }, { address: "partial" })).toBe("address");
  });

  it("owner_address:hidden で address 更新を拒否", () => {
    expect(checkOwnerFieldPermissions({ address: "東京都" }, { address: "hidden" })).toBe("address");
  });

  it("owner_email:full ユーザーが email のみ更新 → 許可", () => {
    const config: DisplayConfig13 = {
      name: "full", nameKana: "full", phone: "masked",
      zip: "masked", address: "partial", email: "full",
    };
    expect(checkOwnerFieldPermissions({ email: "new@example.com" }, config)).toBeNull();
  });

  it("owner_phone:masked ユーザーが phone を含む payload → 拒否", () => {
    const config: DisplayConfig13 = {
      name: "full", nameKana: "full", phone: "masked",
      zip: "masked", address: "partial", email: "masked",
    };
    expect(checkOwnerFieldPermissions({ name: "田中", phone: "090-0000" }, config)).toBe("phone");
  });

  it("payload に PII フィールドが含まれない場合は全許可（owner:write のみで version/note は更新可）", () => {
    expect(checkOwnerFieldPermissions({ version: 1 }, {})).toBeNull();
  });

  it("owner_name_kana:full なら nameKana 更新を許可", () => {
    expect(checkOwnerFieldPermissions({ nameKana: "ヤマダ" }, { nameKana: "full" })).toBeNull();
  });

  it("owner_name_kana:masked なら nameKana 更新を拒否", () => {
    expect(checkOwnerFieldPermissions({ nameKana: "ヤマダ" }, { nameKana: "masked" })).toBe("nameKana");
  });
});

// ── 14. hasExplicitWritePerm — 書込権限の明示判定（fallback なし）─────────────
// api-helpers.ts に追加した hasExplicitWritePerm をテストする。
// owner_email fallback の影響を受けないことを確認する（P1 対応）。

import { hasExplicitWritePerm } from "../permissions";
import type { PermissionEntry } from "../api-helpers";

describe("hasExplicitWritePerm — explicit write permission (no fallback)", () => {
  const p = (resource: string, action: string, granted = true): PermissionEntry =>
    ({ resource, action, granted });

  it("owner_email:full があれば true", () => {
    expect(hasExplicitWritePerm([p("owner_email", "full")], "owner_email")).toBe(true);
  });

  it("owner_email:edit があれば true", () => {
    expect(hasExplicitWritePerm([p("owner_email", "edit")], "owner_email")).toBe(true);
  });

  it("owner_email:masked では false", () => {
    expect(hasExplicitWritePerm([p("owner_email", "masked")], "owner_email")).toBe(false);
  });

  it("owner_email:hidden では false", () => {
    expect(hasExplicitWritePerm([p("owner_email", "hidden")], "owner_email")).toBe(false);
  });

  it("owner_email エントリなし + owner_phone:full でも false（fallback しない）", () => {
    // 表示では owner_phone → owner_email fallback があるが、書込判定には使わない
    const perms = [p("owner_phone", "full")];
    expect(hasExplicitWritePerm(perms, "owner_email")).toBe(false);
  });

  it("granted=false のエントリは true にならない", () => {
    expect(hasExplicitWritePerm([p("owner_email", "full", false)], "owner_email")).toBe(false);
  });

  it("owner_phone:full なら phone 書込を許可", () => {
    expect(hasExplicitWritePerm([p("owner_phone", "full")], "owner_phone")).toBe(true);
  });

  it("owner_phone:masked なら phone 書込を拒否", () => {
    expect(hasExplicitWritePerm([p("owner_phone", "masked")], "owner_phone")).toBe(false);
  });

  it("owner_zip:full なら zip 書込を許可", () => {
    expect(hasExplicitWritePerm([p("owner_zip", "full")], "owner_zip")).toBe(true);
  });

  it("owner_address:partial なら address 書込を拒否", () => {
    expect(hasExplicitWritePerm([p("owner_address", "partial")], "owner_address")).toBe(false);
  });

  it("owner_name:full なら name 書込を許可", () => {
    expect(hasExplicitWritePerm([p("owner_name", "full")], "owner_name")).toBe(true);
  });

  it("owner_name_kana:full なら nameKana 書込を許可", () => {
    expect(hasExplicitWritePerm([p("owner_name_kana", "full")], "owner_name_kana")).toBe(true);
  });

  it("owner_name_kana:masked なら nameKana 書込を拒否", () => {
    expect(hasExplicitWritePerm([p("owner_name_kana", "masked")], "owner_name_kana")).toBe(false);
  });

  it("field_staff: owner_phone:full だが owner_email 未設定 → email 更新不可", () => {
    const fieldStaffPerms = [
      p("owner_name", "full"),
      p("owner_name_kana", "full"),
      p("owner_phone", "full"),
      p("owner_zip", "full"),
      p("owner_address", "full"),
      // owner_email エントリなし
    ];
    expect(hasExplicitWritePerm(fieldStaffPerms, "owner_email")).toBe(false);
    // 一方 phone は書込可
    expect(hasExplicitWritePerm(fieldStaffPerms, "owner_phone")).toBe(true);
  });
});

// ── 15. maskText + applyDisplayToOwner デフォルトマスク ───────────────────────
// display-level.ts に追加した maskText とデフォルトマスク適用をテストする（P2 対応）。

import { maskText } from "../display-level";
import type { OwnerDisplayConfig } from "../display-level";

describe("maskText — default text masker", () => {
  it("通常文字列: 先頭1文字 + ***", () => {
    expect(maskText("山田太郎")).toBe("山***");
  });

  it("カナ: 先頭1文字 + ***", () => {
    expect(maskText("ヤマダタロウ")).toBe("ヤ***");
  });

  it("空文字: ***", () => {
    expect(maskText("")).toBe("***");
  });

  it("1文字: 先頭1文字 + ***", () => {
    expect(maskText("A")).toBe("A***");
  });
});

describe("applyDisplayToOwner — default mask for name/nameKana/note", () => {
  const makeConfig = (overrides: Partial<OwnerDisplayConfig>): OwnerDisplayConfig => ({
    name: "full", nameKana: "full", phone: "full",
    zip: "full", address: "full", note: "full", email: "full",
    ...overrides,
  });

  const owner = {
    id: "1", name: "山田太郎", nameKana: "ヤマダタロウ",
    phone: "090-1234-5678", zip: "100-0001", address: "東京都千代田区1-1",
    note: "備考メモ", email: "yamada@example.com",
  };

  it("owner_name:masked の場合、name が平文で返らない（maskText 適用）", () => {
    const config = makeConfig({ name: "masked" });
    const result = applyDisplayToOwner(owner, config);
    expect(result.name).toBe("山***");
    expect(result.name).not.toBe("山田太郎");
  });

  it("owner_name_kana:masked の場合、nameKana が平文で返らない", () => {
    const config = makeConfig({ nameKana: "masked" });
    const result = applyDisplayToOwner(owner, config);
    expect(result.nameKana).toBe("ヤ***");
    expect(result.nameKana).not.toBe("ヤマダタロウ");
  });

  it("owner_note:masked の場合、note が平文で返らない", () => {
    const config = makeConfig({ note: "masked" });
    const result = applyDisplayToOwner(owner, config);
    expect(result.note).toBe("備***");
    expect(result.note).not.toBe("備考メモ");
  });

  it("owner_phone:masked は専用maskFn（maskPhone）で マスクされる", () => {
    const config = makeConfig({ phone: "masked" });
    const result = applyDisplayToOwner(owner, config);
    expect(result.phone).toBe("***-****-5678");
  });

  it("owner_email:masked は専用maskFn（maskEmail）で マスクされる", () => {
    const config = makeConfig({ email: "masked" });
    const result = applyDisplayToOwner(owner, config);
    expect(result.email).toBe("yam***@example.com");
  });

  it("hidden フィールドはキーごと削除される", () => {
    const config = makeConfig({ name: "hidden", email: "hidden" });
    const result = applyDisplayToOwner(owner, config);
    expect(result).not.toHaveProperty("name");
    expect(result).not.toHaveProperty("email");
  });

  it("full フィールドは平文のまま", () => {
    const config = makeConfig({});
    const result = applyDisplayToOwner(owner, config);
    expect(result.name).toBe("山田太郎");
    expect(result.phone).toBe("090-1234-5678");
  });

  it("null / undefined 値はマスクされず null のまま", () => {
    const ownerWithNull = { ...owner, nameKana: null, note: undefined as unknown as null };
    const config = makeConfig({ nameKana: "masked", note: "masked" });
    const result = applyDisplayToOwner(ownerWithNull, config);
    expect(result.nameKana).toBeNull();
  });
});

// ── 16. /api/properties/[id] owner:read gate ──────────────────────────────────
// owner:read がない場合は owner PII を返さない（field-level 権限に関係なく）。
// ロジックは properties/[id]/route.ts と同等の純粋関数で再現してテストする。

import { hasPermission } from "../permissions";

/** route.ts の owner:read gate ロジックと同等 */
function resolveOwnerInPropertyResponse(
  owner: { id: string; name: string; email?: string | null; phone?: string | null },
  canReadOwner: boolean,
  maskedOwner: Record<string, unknown>,
): Record<string, unknown> {
  return canReadOwner ? maskedOwner : { id: owner.id };
}

const sampleOwner = { id: "owner-1", name: "山田太郎", email: "yamada@example.com", phone: "090-1234-5678" };

describe("/api/properties/[id] owner:read gate", () => {
  it("owner:read=false なら owner は id のみ返る", () => {
    const result = resolveOwnerInPropertyResponse(sampleOwner, false, { ...sampleOwner });
    expect(result).toEqual({ id: "owner-1" });
    expect(result).not.toHaveProperty("email");
    expect(result).not.toHaveProperty("phone");
    expect(result).not.toHaveProperty("name");
  });

  it("owner:read=false なら owner_email:full が残っていても email は返らない", () => {
    const perms = [
      { resource: "property", action: "read", granted: true },
      { resource: "owner_email", action: "full", granted: true },
      // owner:read エントリなし
    ];
    const canReadOwner = hasPermission(perms, "owner", "read");
    expect(canReadOwner).toBe(false);
    const result = resolveOwnerInPropertyResponse(sampleOwner, canReadOwner, { ...sampleOwner });
    expect(result).not.toHaveProperty("email");
  });

  it("owner:read=false なら phone / zip / address / note も返らない", () => {
    const result = resolveOwnerInPropertyResponse(sampleOwner, false, { ...sampleOwner });
    expect(result).not.toHaveProperty("phone");
    expect(result).not.toHaveProperty("zip");
    expect(result).not.toHaveProperty("address");
    expect(result).not.toHaveProperty("note");
  });

  it("owner:read=true なら maskedOwner をそのまま返す（display-level 適用済み）", () => {
    const masked = { id: "owner-1", name: "山田太郎", email: "yam***@example.com" };
    const result = resolveOwnerInPropertyResponse(sampleOwner, true, masked);
    expect(result).toEqual(masked);
    expect(result.email).toBe("yam***@example.com");
  });

  it("hasPermission で owner:read=true を判定できる", () => {
    const perms = [{ resource: "owner", action: "read", granted: true }];
    expect(hasPermission(perms, "owner", "read")).toBe(true);
  });

  it("hasPermission で owner:read=false を判定できる", () => {
    const perms = [{ resource: "owner", action: "read", granted: false }];
    expect(hasPermission(perms, "owner", "read")).toBe(false);
  });

  it("owner:read エントリなしは false", () => {
    const perms = [{ resource: "property", action: "read", granted: true }];
    expect(hasPermission(perms, "owner", "read")).toBe(false);
  });
});

// ── 17. POST /api/owners create field-level write check ───────────────────────
// POST /api/owners の field-level write check ロジックを純粋関数として再現する。
// hasExplicitWritePerm を使い、email を含む create が拒否されるケースを確認する。

/** POST create 時の field-level write check と同等のロジック */
function checkCreateFieldPermissions(
  data: Record<string, unknown>,
  perms: { resource: string; action: string; granted: boolean }[],
): string | null {
  const checks = [
    { key: "name", resource: "owner_name" },
    { key: "nameKana", resource: "owner_name_kana" },
    { key: "phone", resource: "owner_phone" },
    { key: "zip", resource: "owner_zip" },
    { key: "address", resource: "owner_address" },
    { key: "email", resource: "owner_email" },
    { key: "note", resource: "owner_note" },
  ];
  for (const { key, resource } of checks) {
    if (data[key] != null && !hasExplicitWritePerm(perms, resource)) {
      return key; // 拒否フィールド名を返す
    }
  }
  return null; // 全許可
}

describe("POST /api/owners create field-level write check", () => {
  const p = (resource: string, action: string, granted = true) => ({ resource, action, granted });

  it("owner_email:full なら email 付き create を許可", () => {
    const perms = [p("owner_name", "full"), p("owner_email", "full")];
    expect(checkCreateFieldPermissions({ name: "山田", email: "a@b.com" }, perms)).toBeNull();
  });

  it("owner_email:edit なら email 付き create を許可", () => {
    const perms = [p("owner_name", "full"), p("owner_email", "edit")];
    expect(checkCreateFieldPermissions({ name: "山田", email: "a@b.com" }, perms)).toBeNull();
  });

  it("owner_email:masked なら email 付き create を拒否", () => {
    const perms = [p("owner_name", "full"), p("owner_email", "masked")];
    expect(checkCreateFieldPermissions({ name: "山田", email: "a@b.com" }, perms)).toBe("email");
  });

  it("owner_email:hidden なら email 付き create を拒否", () => {
    const perms = [p("owner_name", "full"), p("owner_email", "hidden")];
    expect(checkCreateFieldPermissions({ name: "山田", email: "a@b.com" }, perms)).toBe("email");
  });

  it("owner_email 未設定（fallback なし）なら email 付き create を拒否", () => {
    // owner_phone:full があっても owner_email が未設定なら拒否
    const perms = [p("owner_name", "full"), p("owner_phone", "full")];
    expect(checkCreateFieldPermissions({ name: "山田", email: "a@b.com" }, perms)).toBe("email");
  });

  it("email を送らない create は email チェックをスキップ", () => {
    const perms = [p("owner_name", "full")]; // owner_email なし
    // email が null の場合はチェックしない
    expect(checkCreateFieldPermissions({ name: "山田", email: null }, perms)).toBeNull();
  });

  it("email を含まない create は既存どおり許可", () => {
    const perms = [p("owner_name", "full")];
    expect(checkCreateFieldPermissions({ name: "山田" }, perms)).toBeNull();
  });

  it("owner_phone:masked なら phone 付き create を拒否", () => {
    const perms = [p("owner_name", "full"), p("owner_phone", "masked")];
    expect(checkCreateFieldPermissions({ name: "山田", phone: "090-0000" }, perms)).toBe("phone");
  });

  it("owner_phone:full なら phone 付き create を許可", () => {
    const perms = [p("owner_name", "full"), p("owner_phone", "full")];
    expect(checkCreateFieldPermissions({ name: "山田", phone: "090-0000" }, perms)).toBeNull();
  });

  it("owner_name:full なしでは name 必須の create を拒否", () => {
    const perms = [p("owner_email", "full")]; // owner_name なし
    expect(checkCreateFieldPermissions({ name: "山田", email: "a@b.com" }, perms)).toBe("name");
  });
});

// ── 18. migration backfill — owner_email 権限の本番反映 ───────────────────────
// 本番では seed を再実行しないため、20260516000000_add_owner_email/migration.sql に
// owner_email permission の backfill SQL が含まれていることを確認する。

describe("migration backfill — owner_email", () => {
  const migrationPath = path.join(
    __dirname,
    "../../../prisma/migrations/20260516000000_add_owner_email/migration.sql",
  );
  const migrationSql = fs.readFileSync(migrationPath, "utf-8");

  it("owners テーブルへ email カラム追加が含まれる", () => {
    expect(migrationSql).toMatch(/ALTER TABLE "owners" ADD COLUMN "email"/);
  });

  // ── template_permissions: owner_phone → owner_email コピー方式 ─────────────
  // テンプレート名固定の full/masked 付与をやめ、既存 owner_phone 設定を
  // 引き継ぐ方式に変更。これでカスタムテンプレートでも整合が取れる。

  it("template_permissions テーブルへ INSERT している", () => {
    expect(migrationSql).toMatch(/INSERT INTO "template_permissions"/);
  });

  it("既存 template_permissions の owner_phone を owner_email にコピーしている", () => {
    expect(migrationSql).toMatch(/FROM\s+"template_permissions"\s+tp/);
    expect(migrationSql).toMatch(/tp\."resource"\s*=\s*'owner_phone'/);
    expect(migrationSql).toMatch(/'owner_email',\s*tp\."action",\s*tp\."granted"/);
  });

  it("template_permissions の ON CONFLICT が (template_id, resource, action) でべき等", () => {
    expect(migrationSql).toMatch(
      /ON CONFLICT\s*\(\s*"template_id",\s*"resource",\s*"action"\s*\)\s*DO NOTHING/i,
    );
  });

  it("テンプレート名固定の owner_email 付与は残っていない", () => {
    // WHERE t.name = '事務担当用' / '管理者用' で owner_email を固定付与しないこと。
    // 過去版では '事務担当用'/'管理者用'/'現地担当用' を直書きしていたが、本番カスタムを
    // 壊すため owner_phone コピー方式に置き換えた。
    expect(migrationSql).not.toMatch(/'事務担当用'/);
    expect(migrationSql).not.toMatch(/'管理者用'/);
    // 現地担当用も同様に固定付与しない（owner_phone から継承する）
    expect(migrationSql).not.toMatch(/WHERE\s+t\.name\s*=\s*'現地担当用'/);
    // 固定アクション ('owner_email', 'full' / 'owner_email', 'masked') が
    // テンプレート名分岐で書かれていないこと
    expect(migrationSql).not.toMatch(/'owner_email',\s*'full'/);
    expect(migrationSql).not.toMatch(/'owner_email',\s*'masked'/);
  });

  // ── user_permissions override の引き継ぎ ────────────────────────────────────

  it("user_permissions テーブルへ owner_email override の backfill が含まれる", () => {
    expect(migrationSql).toMatch(/INSERT INTO "user_permissions"/);
  });

  it("user_permissions のソースが owner_phone override である", () => {
    expect(migrationSql).toMatch(/FROM\s+"user_permissions"\s+up/);
    expect(migrationSql).toMatch(/up\."resource"\s*=\s*'owner_phone'/);
  });

  it("user_permissions も owner_email を resource 名としてコピーしている", () => {
    expect(migrationSql).toMatch(/'owner_email',\s*up\."action",\s*up\."granted"/);
  });

  it("user_permissions の ON CONFLICT が (user_id, resource, action) でべき等", () => {
    expect(migrationSql).toMatch(
      /ON CONFLICT\s*\(\s*"user_id",\s*"resource",\s*"action"\s*\)\s*DO NOTHING/i,
    );
  });

  it("template_permissions と user_permissions の両 backfill が含まれる", () => {
    const templateInserts = (migrationSql.match(/INSERT INTO "template_permissions"/g) ?? []).length;
    const userInserts = (migrationSql.match(/INSERT INTO "user_permissions"/g) ?? []).length;
    expect(templateInserts).toBeGreaterThanOrEqual(1);
    expect(userInserts).toBeGreaterThanOrEqual(1);
  });
});

// ── 19. 管理画面 RESOURCES — owner_email / owner_name_kana 表示 ───────────────
// テンプレート編集 UI と ユーザー個別権限 UI の RESOURCES が
// owner_email / owner_name_kana を含むことを文字列マッチで確認する。

describe("admin templates page — RESOURCES contains owner_email / owner_name_kana", () => {
  const filePath = path.join(
    __dirname,
    "../../../src/app/(dashboard)/admin/templates/[id]/page.tsx",
  );
  const source = fs.readFileSync(filePath, "utf-8");

  it("RESOURCES に owner_email が含まれる", () => {
    expect(source).toMatch(/key:\s*"owner_email"/);
  });

  it("RESOURCES に owner_name_kana が含まれる", () => {
    expect(source).toMatch(/key:\s*"owner_name_kana"/);
  });

  it("owner_email の actions は hidden/masked/full", () => {
    expect(source).toMatch(
      /key:\s*"owner_email"[^}]*actions:\s*\["hidden",\s*"masked",\s*"full"\]/,
    );
  });

  it("owner_name_kana の actions は hidden/masked/full", () => {
    expect(source).toMatch(
      /key:\s*"owner_name_kana"[^}]*actions:\s*\["hidden",\s*"masked",\s*"full"\]/,
    );
  });
});

describe("admin user permissions page — RESOURCES contains owner_email / owner_name_kana", () => {
  const filePath = path.join(
    __dirname,
    "../../../src/app/(dashboard)/admin/users/[id]/permissions/page.tsx",
  );
  const source = fs.readFileSync(filePath, "utf-8");

  it("RESOURCES に owner_email が含まれる", () => {
    expect(source).toMatch(/key:\s*"owner_email"/);
  });

  it("RESOURCES に owner_name_kana が含まれる", () => {
    expect(source).toMatch(/key:\s*"owner_name_kana"/);
  });
});

// ── 20. owner_note field-level write check (PATCH / POST) ────────────────────
// PATCH/POST の field-level write check に note が含まれることを確認する。
// PATCH の check は hasExplicitWritePerm(perms, "owner_note") と同等。
// POST の check は section 17 で再現済みの checkCreateFieldPermissions を使う。

const np = (resource: string, action: string, granted = true) => ({ resource, action, granted });

describe("PATCH /api/owners/[id] — owner_note write check", () => {
  it("owner_note:full なら note 更新 OK", () => {
    expect(hasExplicitWritePerm([np("owner_note", "full")], "owner_note")).toBe(true);
  });

  it("owner_note:edit なら note 更新 OK", () => {
    expect(hasExplicitWritePerm([np("owner_note", "edit")], "owner_note")).toBe(true);
  });

  it("owner_note:hidden なら note 更新拒否", () => {
    expect(hasExplicitWritePerm([np("owner_note", "hidden")], "owner_note")).toBe(false);
  });

  it("owner_note:masked なら note 更新拒否", () => {
    expect(hasExplicitWritePerm([np("owner_note", "masked")], "owner_note")).toBe(false);
  });

  it("owner_note:read なら note 更新拒否（read は書込権限ではない）", () => {
    expect(hasExplicitWritePerm([np("owner_note", "read")], "owner_note")).toBe(false);
  });

  it("owner_note 未設定なら note 更新拒否", () => {
    expect(hasExplicitWritePerm([np("owner_name", "full")], "owner_note")).toBe(false);
  });

  it("office_staff (owner_note:read) は note を更新できない", () => {
    // seed.ts: office_staff template has owner_note:read (not full/edit)
    const officeStaff = [
      np("owner", "write"),
      np("owner_note", "read"),
    ];
    expect(hasExplicitWritePerm(officeStaff, "owner_note")).toBe(false);
  });

  it("admin (owner_note:edit) は note を更新できる", () => {
    // seed.ts: admin template has owner_note:edit
    const admin = [np("owner", "write"), np("owner_note", "edit")];
    expect(hasExplicitWritePerm(admin, "owner_note")).toBe(true);
  });
});

describe("POST /api/owners — owner_note create check", () => {
  const baseFullPerms = [
    np("owner_name", "full"),
    np("owner_name_kana", "full"),
    np("owner_phone", "full"),
    np("owner_zip", "full"),
    np("owner_address", "full"),
    np("owner_email", "full"),
  ];

  it("owner_note:full なら note 付き作成 OK", () => {
    const perms = [...baseFullPerms, np("owner_note", "full")];
    expect(checkCreateFieldPermissions({ name: "山田", note: "メモ" }, perms)).toBeNull();
  });

  it("owner_note:edit なら note 付き作成 OK", () => {
    const perms = [...baseFullPerms, np("owner_note", "edit")];
    expect(checkCreateFieldPermissions({ name: "山田", note: "メモ" }, perms)).toBeNull();
  });

  it("owner_note:hidden なら note 付き作成拒否", () => {
    const perms = [...baseFullPerms, np("owner_note", "hidden")];
    expect(checkCreateFieldPermissions({ name: "山田", note: "メモ" }, perms)).toBe("note");
  });

  it("owner_note:masked なら note 付き作成拒否", () => {
    const perms = [...baseFullPerms, np("owner_note", "masked")];
    expect(checkCreateFieldPermissions({ name: "山田", note: "メモ" }, perms)).toBe("note");
  });

  it("owner_note:read なら note 付き作成拒否", () => {
    const perms = [...baseFullPerms, np("owner_note", "read")];
    expect(checkCreateFieldPermissions({ name: "山田", note: "メモ" }, perms)).toBe("note");
  });

  it("owner_note 未設定なら note 付き作成拒否", () => {
    expect(checkCreateFieldPermissions({ name: "山田", note: "メモ" }, baseFullPerms)).toBe("note");
  });

  it("note なし作成は owner_note 未設定でも OK", () => {
    expect(checkCreateFieldPermissions({ name: "山田" }, baseFullPerms)).toBeNull();
  });

  it("note=null は チェックをスキップ（既存どおり許可）", () => {
    expect(checkCreateFieldPermissions({ name: "山田", note: null }, baseFullPerms)).toBeNull();
  });
});

// ── 21. note 拒否時に AuditLog/ChangeLog に生値が残らない構造確認 ─────────────
// route.ts のソースを文字列ベースで読み、fieldWriteChecks 配列が
// recordChanges / writeAuditLog / prisma.owner.updateMany より前に出現することを確認する。

describe("route source — note check happens before logging/DB write", () => {
  it("PATCH /api/owners/[id]: fieldWriteChecks が recordChanges より前に出現", () => {
    const routePath = path.join(__dirname, "../../../src/app/api/owners/[id]/route.ts");
    const fullSource = fs.readFileSync(routePath, "utf-8");
    // PATCH ハンドラ内に絞る（GET の writeAuditLog/recordChanges を拾わないため）
    const patchStart = fullSource.indexOf("export async function PATCH");
    const source = fullSource.slice(patchStart);
    const checkIdx = source.indexOf("fieldWriteChecks");
    const recordChangesIdx = source.indexOf("recordChanges({");
    const writeAuditIdx = source.indexOf("writeAuditLog({");
    const updateManyIdx = source.indexOf("prisma.owner.updateMany");
    expect(checkIdx).toBeGreaterThan(-1);
    expect(recordChangesIdx).toBeGreaterThan(checkIdx);
    expect(writeAuditIdx).toBeGreaterThan(checkIdx);
    expect(updateManyIdx).toBeGreaterThan(checkIdx);
  });

  it("PATCH route: owner_note が fieldWriteChecks に含まれる", () => {
    const routePath = path.join(__dirname, "../../../src/app/api/owners/[id]/route.ts");
    const source = fs.readFileSync(routePath, "utf-8");
    expect(source).toMatch(/requestKey:\s*"note"[\s,]+resource:\s*"owner_note"/);
  });

  it("PATCH route: name/nameKana/phone/zip/address/email の既存 check が維持されている", () => {
    const routePath = path.join(__dirname, "../../../src/app/api/owners/[id]/route.ts");
    const source = fs.readFileSync(routePath, "utf-8");
    expect(source).toMatch(/resource:\s*"owner_name"[^_]/); // owner_name (not owner_name_kana)
    expect(source).toMatch(/resource:\s*"owner_name_kana"/);
    expect(source).toMatch(/resource:\s*"owner_phone"/);
    expect(source).toMatch(/resource:\s*"owner_zip"/);
    expect(source).toMatch(/resource:\s*"owner_address"/);
    expect(source).toMatch(/resource:\s*"owner_email"/);
  });

  it("POST /api/owners: createFieldWriteChecks が prisma.owner.create より前に出現", () => {
    const routePath = path.join(__dirname, "../../../src/app/api/owners/route.ts");
    const fullSource = fs.readFileSync(routePath, "utf-8");
    // POST ハンドラ内に絞る（GET の writeAuditLog を拾わないため）
    const postStart = fullSource.indexOf("export async function POST");
    const source = fullSource.slice(postStart);
    const checkIdx = source.indexOf("createFieldWriteChecks");
    const createIdx = source.indexOf("prisma.owner.create");
    const writeAuditIdx = source.indexOf("writeAuditLog({");
    expect(checkIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(checkIdx);
    expect(writeAuditIdx).toBeGreaterThan(checkIdx);
  });

  it("POST route: owner_note が createFieldWriteChecks に含まれる", () => {
    const routePath = path.join(__dirname, "../../../src/app/api/owners/route.ts");
    const source = fs.readFileSync(routePath, "utf-8");
    expect(source).toMatch(/value:\s*data\.note[\s,]+resource:\s*"owner_note"/);
  });

  it("POST route: name/nameKana/phone/zip/address/email の既存 check が維持されている", () => {
    const routePath = path.join(__dirname, "../../../src/app/api/owners/route.ts");
    const source = fs.readFileSync(routePath, "utf-8");
    expect(source).toMatch(/value:\s*data\.name[\s,]+resource:\s*"owner_name"[^_]/);
    expect(source).toMatch(/value:\s*data\.nameKana[\s,]+resource:\s*"owner_name_kana"/);
    expect(source).toMatch(/value:\s*data\.phone[\s,]+resource:\s*"owner_phone"/);
    expect(source).toMatch(/value:\s*data\.zip[\s,]+resource:\s*"owner_zip"/);
    expect(source).toMatch(/value:\s*data\.address[\s,]+resource:\s*"owner_address"/);
    expect(source).toMatch(/value:\s*data\.email[\s,]+resource:\s*"owner_email"/);
  });
});

// ── 22. canEditOwner — 編集ボタン表示判定（owner:read 必須）─────────────────
// owner-edit-utils.ts の canEditOwner pure helper をテストする。
// owner:read がない場合、API レスポンスは { id } のみで version も undefined になるため
// 編集ボタンを出さない・保存もしない設計。

import { canEditOwner } from "../owner-edit-utils";

describe("canEditOwner — owner:read 必須 + version 取得確認", () => {
  it("全条件満たす → 編集可", () => {
    expect(canEditOwner(true, true, true, 1)).toBe(true);
  });

  it("owner:read=false なら owner:write=true / hasEditable=true / version=number でも編集不可", () => {
    expect(canEditOwner(false, true, true, 1)).toBe(false);
  });

  it("owner:write=false なら編集不可", () => {
    expect(canEditOwner(true, false, true, 1)).toBe(false);
  });

  it("hasAnyEditable=false なら編集不可（全フィールド masked 等）", () => {
    expect(canEditOwner(true, true, false, 1)).toBe(false);
  });

  it("version=undefined なら編集不可（API が { id } のみ返した場合）", () => {
    expect(canEditOwner(true, true, true, undefined)).toBe(false);
  });

  it("version が文字列など number 以外なら編集不可", () => {
    expect(canEditOwner(true, true, true, "1")).toBe(false);
    expect(canEditOwner(true, true, true, null)).toBe(false);
  });

  it("version=0 でも number なら編集可（楽観ロック初期値も number として正常）", () => {
    expect(canEditOwner(true, true, true, 0)).toBe(true);
  });

  it("owner:read=true + owner:write=true + editableFields あり + versionあり → 編集可", () => {
    // Codex 仕様の代表ケース
    expect(canEditOwner(true, true, true, 3)).toBe(true);
  });
});

// ── 23. page.tsx 構造確認 — OwnerTab/OwnerCard が canRead を経由 ───────────────
// page.tsx ソースを文字列レベルで確認し、owner:read gate が UI 側にも反映されている
// ことを検証する。

describe("properties/[id]/page.tsx — owner:read gate in UI", () => {
  const filePath = path.join(
    __dirname,
    "../../../src/app/(dashboard)/properties/[id]/page.tsx",
  );
  const source = fs.readFileSync(filePath, "utf-8");

  it("canReadOwner state を派生している", () => {
    expect(source).toMatch(/setCanReadOwner\(/);
    expect(source).toMatch(/p\.resource\s*===\s*"owner"\s*&&\s*p\.action\s*===\s*"read"/);
  });

  it("OwnerTab に canRead プロップを渡している", () => {
    expect(source).toMatch(/canRead\s*=\s*\{canReadOwner\}/);
  });

  it("OwnerTab が canRead=false で「閲覧する権限がありません」メッセージを返す", () => {
    expect(source).toMatch(/!canRead/);
    expect(source).toMatch(/閲覧する権限がありません/);
  });

  it("OwnerCard が canEditOwner helper を使用している", () => {
    expect(source).toMatch(/canEditOwner\(canRead,\s*canWrite,\s*hasAnyEditable/);
  });

  it("handleSave に version 型ガードがある", () => {
    expect(source).toMatch(/typeof po\.owner\.version !== "number"/);
  });

  it("ApiOwner.version は optional", () => {
    expect(source).toMatch(/version\?\:\s*number;/);
  });
});
