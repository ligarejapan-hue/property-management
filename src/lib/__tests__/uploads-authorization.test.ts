/**
 * /uploads/[...path] Phase B 権限判定の unit test.
 *
 * key の DB 逆引き → entity scope の判定が
 * 既存 Property API のスコープと整合していることを確認する。
 */

import { describe, it, expect, vi } from "vitest";
import {
  authorizeUploadAccess,
  resolveRegistryServeMeta,
  escapePrismaLikePattern,
} from "@/lib/uploads-authorization";
import type { ApiSession, PermissionEntry } from "@/lib/api-helpers";

type Photo = { fileUrl: string; propertyId: string };
type BPhoto = { fileUrl: string; buildingId: string };
type Att = {
  fileUrl: string;
  isDeleted: boolean;
  targetType: string;
  targetId: string;
  propertyId: string | null;
  // S1b-4: registry gating / serve-meta 検証用（既存ケースは未指定=非registry扱い）
  id?: string;
  type?: string;
};
type Prop = { id: string; createdBy: string; assignedTo: string | null };

type PinPhoto = { fileUrl: string; pin: { staffUserId: string } | null };

function makeDb(opts: {
  photos?: Photo[];
  bPhotos?: BPhoto[];
  attachments?: Att[];
  properties?: Prop[];
  pinPhotos?: PinPhoto[];
}) {
  const photos = opts.photos ?? [];
  const bPhotos = opts.bPhotos ?? [];
  const attachments = opts.attachments ?? [];
  const properties = opts.properties ?? [];
  const pinPhotos = opts.pinPhotos ?? [];

  // 最小 prisma 互換 stub。Phase B は findMany + JS フィルタで legacy URL /
  // duplicate collision を取りこぼさない設計のため、findMany の contains を再現する。
  // 本番は Prisma → SQL LIKE に展開される。authorize 側で `\` `%` `_` を
  // escape して渡すため、mock 側では default escape char `\` を踏まえて
  // de-escape してから literal substring 一致を見る (PostgreSQL の LIKE escape を簡易に模す)。
  type ContainsWhere = { fileUrl: { contains: string } };
  const unescapeLike = (pattern: string): string =>
    pattern
      .replace(/\\\\/g, "\x00BS\x00")
      .replace(/\\%/g, "%")
      .replace(/\\_/g, "_")
      .replace(/\x00BS\x00/g, "\\");
  const matchContains = (url: string, where: ContainsWhere) =>
    typeof url === "string" && url.includes(unescapeLike(where.fileUrl.contains));

  return {
    propertyPhoto: {
      findMany: async ({ where }: { where: ContainsWhere }) =>
        photos.filter((p) => matchContains(p.fileUrl, where)),
    },
    buildingPhoto: {
      findMany: async ({ where }: { where: ContainsWhere }) =>
        bPhotos.filter((p) => matchContains(p.fileUrl, where)),
    },
    attachment: {
      findMany: async ({ where }: { where: ContainsWhere }) =>
        attachments.filter((a) => matchContains(a.fileUrl, where)),
    },
    fieldSurveyPinPhoto: {
      findMany: async ({
        where,
      }: {
        where: { OR?: ContainsWhere[] };
      }) => {
        const contains = where.OR?.[0]?.fileUrl?.contains ?? "";
        return pinPhotos.filter(
          (p) => typeof p.fileUrl === "string" && p.fileUrl.includes(contains),
        );
      },
    },
    property: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        properties.find((p) => p.id === where.id) ?? null,
    },
  } as unknown as Parameters<typeof authorizeUploadAccess>[0]["prisma"];
}

const fieldStaff: ApiSession = { id: "u-field", email: "", name: "", role: "field_staff" };
const officeStaff: ApiSession = { id: "u-office", email: "", name: "", role: "office_staff" };
const admin: ApiSession = { id: "u-admin", email: "", name: "", role: "admin" };

const permsWithPropertyRead: PermissionEntry[] = [
  { resource: "property", action: "read", granted: true },
];
const permsWithOwnerRead: PermissionEntry[] = [
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];
const permsNoRead: PermissionEntry[] = [
  { resource: "property", action: "read", granted: false },
];

describe("authorizeUploadAccess", () => {
  it("invalid key (traversal) は forbidden", async () => {
    const prisma = makeDb({});
    const decision = await authorizeUploadAccess({
      key: "../etc/passwd",
      session: admin,
      permissions: permsWithPropertyRead,
      prisma,
    });
    expect(decision).toBe("forbidden");
  });

  it("absolute key は forbidden", async () => {
    const prisma = makeDb({});
    const decision = await authorizeUploadAccess({
      key: "/etc/passwd",
      session: admin,
      permissions: permsWithPropertyRead,
      prisma,
    });
    expect(decision).toBe("forbidden");
  });

  it("どこにも該当しない key は not_found", async () => {
    const prisma = makeDb({});
    const decision = await authorizeUploadAccess({
      key: "random/foo.jpg",
      session: admin,
      permissions: permsWithPropertyRead,
      prisma,
    });
    expect(decision).toBe("not_found");
  });

  describe("PropertyPhoto", () => {
    const key = "properties/p1/photos/1.jpg";
    const fileUrl = `/uploads/${key}`;

    it("admin + property:read → ok", async () => {
      const prisma = makeDb({
        photos: [{ fileUrl, propertyId: "p1" }],
        properties: [{ id: "p1", createdBy: "u-x", assignedTo: "u-y" }],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: admin,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("ok");
    });

    it("field_staff が createdBy or assignedTo どちらでも無いと forbidden", async () => {
      const prisma = makeDb({
        photos: [{ fileUrl, propertyId: "p1" }],
        properties: [{ id: "p1", createdBy: "u-x", assignedTo: "u-y" }],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: fieldStaff,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("forbidden");
    });

    it("field_staff が createdBy 一致なら ok", async () => {
      const prisma = makeDb({
        photos: [{ fileUrl, propertyId: "p1" }],
        properties: [{ id: "p1", createdBy: fieldStaff.id, assignedTo: null }],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: fieldStaff,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("ok");
    });

    it("field_staff が assignedTo 一致なら ok", async () => {
      const prisma = makeDb({
        photos: [{ fileUrl, propertyId: "p1" }],
        properties: [{ id: "p1", createdBy: "u-x", assignedTo: fieldStaff.id }],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: fieldStaff,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("ok");
    });

    it("office_staff は createdBy/assignedTo 不一致でも property:read があれば ok", async () => {
      const prisma = makeDb({
        photos: [{ fileUrl, propertyId: "p1" }],
        properties: [{ id: "p1", createdBy: "u-x", assignedTo: "u-y" }],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: officeStaff,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("ok");
    });

    it("property:read が無いと forbidden", async () => {
      const prisma = makeDb({
        photos: [{ fileUrl, propertyId: "p1" }],
        properties: [{ id: "p1", createdBy: "u-x", assignedTo: null }],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: admin,
        permissions: permsNoRead,
        prisma,
      });
      expect(decision).toBe("forbidden");
    });

    it("Property が DB から消えていたら not_found", async () => {
      const prisma = makeDb({
        photos: [{ fileUrl, propertyId: "p1" }],
        properties: [],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: admin,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("not_found");
    });
  });

  describe("BuildingPhoto", () => {
    const key = "buildings/b1/photos/1.jpg";
    const fileUrl = `/uploads/${key}`;

    it("property:read があれば role 問わず ok", async () => {
      const prisma = makeDb({ bPhotos: [{ fileUrl, buildingId: "b1" }] });
      const decision = await authorizeUploadAccess({
        key,
        session: fieldStaff,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("ok");
    });

    it("property:read が無いと forbidden", async () => {
      const prisma = makeDb({ bPhotos: [{ fileUrl, buildingId: "b1" }] });
      const decision = await authorizeUploadAccess({
        key,
        session: admin,
        permissions: permsNoRead,
        prisma,
      });
      expect(decision).toBe("forbidden");
    });
  });

  describe("Property Attachment", () => {
    const key = "properties/p1/attachments/1.pdf";
    const fileUrl = `/uploads/${key}`;
    const att: Att = {
      fileUrl,
      isDeleted: false,
      targetType: "property",
      targetId: "p1",
      propertyId: "p1",
    };

    it("通常 attachment は property scope で判定", async () => {
      const prisma = makeDb({
        attachments: [att],
        properties: [{ id: "p1", createdBy: "u-x", assignedTo: null }],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: admin,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("ok");
    });

    it("isDeleted=true は not_found", async () => {
      const prisma = makeDb({
        attachments: [{ ...att, isDeleted: true }],
        properties: [{ id: "p1", createdBy: "u-x", assignedTo: null }],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: admin,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("not_found");
    });

    it("field_staff 非担当は forbidden", async () => {
      const prisma = makeDb({
        attachments: [att],
        properties: [{ id: "p1", createdBy: "u-x", assignedTo: "u-y" }],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: fieldStaff,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("forbidden");
    });

    it("registry PDF も同じ property scope", async () => {
      const regKey = "properties/p1/registry/1.pdf";
      const regUrl = `/uploads/${regKey}`;
      const prisma = makeDb({
        attachments: [
          { ...att, fileUrl: regUrl, targetType: "property", propertyId: "p1" },
        ],
        properties: [{ id: "p1", createdBy: "u-x", assignedTo: null }],
      });
      const decision = await authorizeUploadAccess({
        key: regKey,
        session: admin,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("ok");
    });
  });

  describe("Owner Attachment", () => {
    const key = "owner-files/o1/1.pdf";
    const fileUrl = `/uploads/${key}`;

    it("owner:read があれば ok", async () => {
      const prisma = makeDb({
        attachments: [
          {
            fileUrl,
            isDeleted: false,
            targetType: "owner",
            targetId: "o1",
            propertyId: null,
          },
        ],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: admin,
        permissions: permsWithOwnerRead,
        prisma,
      });
      expect(decision).toBe("ok");
    });

    it("owner:read が無いと forbidden", async () => {
      const prisma = makeDb({
        attachments: [
          {
            fileUrl,
            isDeleted: false,
            targetType: "owner",
            targetId: "o1",
            propertyId: null,
          },
        ],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: admin,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("forbidden");
    });
  });

  it("不明な targetType は forbidden (安全側)", async () => {
    const key = "comments/c1/1.png";
    const fileUrl = `/uploads/${key}`;
    const prisma = makeDb({
      attachments: [
        {
          fileUrl,
          isDeleted: false,
          targetType: "comment",
          targetId: "c1",
          propertyId: null,
        },
      ],
    });
    const decision = await authorizeUploadAccess({
      key,
      session: admin,
      permissions: permsWithOwnerRead,
      prisma,
    });
    expect(decision).toBe("forbidden");
  });

  // -------------------------------------------------------------------
  // Codex P1-1: legacy absolute fileUrl / query 付きの取りこぼし防止
  // -------------------------------------------------------------------
  describe("legacy fileUrl 形式", () => {
    const key = "properties/p1/photos/legacy.jpg";

    it("http:// 絶対URL でも認可される", async () => {
      const prisma = makeDb({
        photos: [
          {
            fileUrl: `http://example.com/uploads/${key}`,
            propertyId: "p1",
          },
        ],
        properties: [{ id: "p1", createdBy: "u-x", assignedTo: null }],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: admin,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("ok");
    });

    it("https:// 絶対URL + query suffix でも認可される", async () => {
      const prisma = makeDb({
        photos: [
          {
            fileUrl: `https://example.com/uploads/${key}?v=1`,
            propertyId: "p1",
          },
        ],
        properties: [{ id: "p1", createdBy: "u-x", assignedTo: null }],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: admin,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("ok");
    });

    it("相対 + query suffix でも認可される", async () => {
      const prisma = makeDb({
        photos: [
          { fileUrl: `/uploads/${key}?v=1`, propertyId: "p1" },
        ],
        properties: [{ id: "p1", createdBy: "u-x", assignedTo: null }],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: admin,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("ok");
    });

    it("data: / blob: / file: / /api/ は候補から除外され not_found", async () => {
      const prisma = makeDb({
        photos: [
          { fileUrl: `data:image/png;base64,xxx`, propertyId: "p1" },
          { fileUrl: `blob:http://example.com/abc`, propertyId: "p1" },
          { fileUrl: `file:///etc/passwd`, propertyId: "p1" },
          { fileUrl: `/api/properties/p1/photos/legacy.jpg`, propertyId: "p1" },
        ],
        properties: [{ id: "p1", createdBy: "u-x", assignedTo: null }],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: admin,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("not_found");
    });
  });

  // -------------------------------------------------------------------
  // Codex P1-2: duplicate collision で bypass しない
  // -------------------------------------------------------------------
  describe("duplicate collision", () => {
    const key = "properties/p1/photos/dup.jpg";
    const fileUrl = `/uploads/${key}`;

    it("PropertyPhoto 同 key 複数 + 片方 forbidden → 全体 forbidden", async () => {
      const prisma = makeDb({
        photos: [
          { fileUrl, propertyId: "p-allowed" },
          { fileUrl, propertyId: "p-forbidden" },
        ],
        properties: [
          { id: "p-allowed", createdBy: fieldStaff.id, assignedTo: null },
          { id: "p-forbidden", createdBy: "u-x", assignedTo: "u-y" },
        ],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: fieldStaff,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("forbidden");
    });

    it("PropertyPhoto 同 key 複数 + 全て allowed → ok", async () => {
      const prisma = makeDb({
        photos: [
          { fileUrl, propertyId: "p1" },
          { fileUrl, propertyId: "p2" },
        ],
        properties: [
          { id: "p1", createdBy: fieldStaff.id, assignedTo: null },
          { id: "p2", createdBy: "u-x", assignedTo: fieldStaff.id },
        ],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: fieldStaff,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("ok");
    });

    it("Attachment 同 key で allowed + forbidden が混在 → forbidden", async () => {
      const prisma = makeDb({
        attachments: [
          {
            fileUrl,
            isDeleted: false,
            targetType: "property",
            targetId: "p-allowed",
            propertyId: "p-allowed",
          },
          {
            fileUrl,
            isDeleted: false,
            targetType: "property",
            targetId: "p-forbidden",
            propertyId: "p-forbidden",
          },
        ],
        properties: [
          { id: "p-allowed", createdBy: fieldStaff.id, assignedTo: null },
          { id: "p-forbidden", createdBy: "u-x", assignedTo: "u-y" },
        ],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: fieldStaff,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("forbidden");
    });

    it("Attachment 同 key で deleted のみ → not_found", async () => {
      const prisma = makeDb({
        attachments: [
          {
            fileUrl,
            isDeleted: true,
            targetType: "property",
            targetId: "p1",
            propertyId: "p1",
          },
          {
            fileUrl,
            isDeleted: true,
            targetType: "property",
            targetId: "p2",
            propertyId: "p2",
          },
        ],
        properties: [
          { id: "p1", createdBy: fieldStaff.id, assignedTo: null },
          { id: "p2", createdBy: fieldStaff.id, assignedTo: null },
        ],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: admin,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("not_found");
    });

    it("Attachment 同 key で deleted と active allowed が混在 → active 側で ok", async () => {
      const prisma = makeDb({
        attachments: [
          {
            fileUrl,
            isDeleted: true,
            targetType: "property",
            targetId: "p1",
            propertyId: "p1",
          },
          {
            fileUrl,
            isDeleted: false,
            targetType: "property",
            targetId: "p1",
            propertyId: "p1",
          },
        ],
        properties: [
          { id: "p1", createdBy: fieldStaff.id, assignedTo: null },
        ],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: fieldStaff,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("ok");
    });

    it("Attachment 同 key で deleted + active forbidden が混在 → forbidden", async () => {
      const prisma = makeDb({
        attachments: [
          {
            fileUrl,
            isDeleted: true,
            targetType: "property",
            targetId: "p1",
            propertyId: "p1",
          },
          {
            fileUrl,
            isDeleted: false,
            targetType: "property",
            targetId: "p2",
            propertyId: "p2",
          },
        ],
        properties: [
          { id: "p1", createdBy: fieldStaff.id, assignedTo: null },
          { id: "p2", createdBy: "u-x", assignedTo: "u-y" },
        ],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: fieldStaff,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("forbidden");
    });
  });

  // -------------------------------------------------------------------
  // Codex P1: LIKE wildcard escape (`%` / `_` / `\`)
  // -------------------------------------------------------------------
  describe("escapePrismaLikePattern", () => {
    it("% は literal として escape される", () => {
      expect(escapePrismaLikePattern("foo%bar")).toBe("foo\\%bar");
    });

    it("_ は literal として escape される", () => {
      expect(escapePrismaLikePattern("foo_bar")).toBe("foo\\_bar");
    });

    it("\\ は二重化される", () => {
      expect(escapePrismaLikePattern("foo\\bar")).toBe("foo\\\\bar");
    });

    it("通常の key は変更されない", () => {
      expect(escapePrismaLikePattern("properties/p1/photos/1.jpg")).toBe(
        "properties/p1/photos/1.jpg",
      );
    });

    it("複合 (`\\`, `%`, `_` 同時) でも順序依存しない", () => {
      // `\` を最初に二重化 → `%`/`_` を escape: `a\\b\%c\_d`
      expect(escapePrismaLikePattern("a\\b%c_d")).toBe("a\\\\b\\%c\\_d");
    });
  });

  describe("DB lookup 引数 (wildcard escape)", () => {
    it("% を含む key は contains に literal escape された値が渡る (3 テーブル全て)", async () => {
      const calls: { table: string; contains: string }[] = [];
      // pin photo は fileUrl/thumbnailUrl の OR で問い合わせるため where 形が異なる。
      // どちらの形でも escape 済み contains 値を取り出す。
      const containsOf = (where: {
        fileUrl?: { contains: string };
        OR?: { fileUrl?: { contains: string } }[];
      }): string =>
        where.fileUrl?.contains ?? where.OR?.[0]?.fileUrl?.contains ?? "";
      const recorder = (table: string) =>
        vi.fn(async ({ where }: { where: Parameters<typeof containsOf>[0] }) => {
          calls.push({ table, contains: containsOf(where) });
          return [];
        });
      const prisma = {
        propertyPhoto: { findMany: recorder("propertyPhoto") },
        buildingPhoto: { findMany: recorder("buildingPhoto") },
        fieldSurveyPinPhoto: { findMany: recorder("fieldSurveyPinPhoto") },
        attachment: { findMany: recorder("attachment") },
        property: { findUnique: async () => null },
      } as unknown as Parameters<typeof authorizeUploadAccess>[0]["prisma"];

      await authorizeUploadAccess({
        key: "weird%key_test",
        session: admin,
        permissions: permsWithPropertyRead,
        prisma,
      });

      expect(calls.map((c) => c.table)).toEqual([
        "propertyPhoto",
        "buildingPhoto",
        "fieldSurveyPinPhoto",
        "attachment",
      ]);
      for (const c of calls) {
        expect(c.contains).toBe("weird\\%key\\_test");
      }
    });

    it("`%` 単独 key でも contains に escape された値が渡る", async () => {
      const containsValues: string[] = [];
      const recorder = vi.fn(
        async ({
          where,
        }: {
          where: {
            fileUrl?: { contains: string };
            OR?: { fileUrl?: { contains: string } }[];
          };
        }) => {
          containsValues.push(
            where.fileUrl?.contains ?? where.OR?.[0]?.fileUrl?.contains ?? "",
          );
          return [];
        },
      );
      const prisma = {
        propertyPhoto: { findMany: recorder },
        buildingPhoto: { findMany: recorder },
        fieldSurveyPinPhoto: { findMany: recorder },
        attachment: { findMany: recorder },
        property: { findUnique: async () => null },
      } as unknown as Parameters<typeof authorizeUploadAccess>[0]["prisma"];

      await authorizeUploadAccess({
        key: "%",
        session: admin,
        permissions: permsWithPropertyRead,
        prisma,
      });

      for (const v of containsValues) {
        expect(v).toBe("\\%");
      }
    });
  });

  describe("wildcard scan 防御 (挙動)", () => {
    it("% を含む実 fileUrl は正規化 key 完全一致なら ok", async () => {
      const key = "properties/p1/photos/has%pct.jpg";
      const prisma = makeDb({
        photos: [{ fileUrl: `/uploads/${key}`, propertyId: "p1" }],
        properties: [{ id: "p1", createdBy: "u-x", assignedTo: null }],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: admin,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("ok");
    });

    it("_ を含む実 fileUrl は正規化 key 完全一致なら ok", async () => {
      const key = "properties/p1/photos/has_us.jpg";
      const prisma = makeDb({
        photos: [{ fileUrl: `/uploads/${key}`, propertyId: "p1" }],
        properties: [{ id: "p1", createdBy: "u-x", assignedTo: null }],
      });
      const decision = await authorizeUploadAccess({
        key,
        session: admin,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("ok");
    });

    it("key=`%` で別レコードを wildcard マッチして認可しない (not_found)", async () => {
      const prisma = makeDb({
        photos: [
          { fileUrl: "/uploads/properties/p1/photos/a.jpg", propertyId: "p1" },
          { fileUrl: "/uploads/properties/p2/photos/b.jpg", propertyId: "p2" },
        ],
        properties: [
          { id: "p1", createdBy: "u-x", assignedTo: null },
          { id: "p2", createdBy: "u-y", assignedTo: null },
        ],
      });
      const decision = await authorizeUploadAccess({
        key: "%",
        session: admin,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("not_found");
    });

    it("key=`_` (単独) で別レコードを wildcard マッチして認可しない (not_found)", async () => {
      const prisma = makeDb({
        attachments: [
          {
            fileUrl: "/uploads/properties/p1/attachments/a.pdf",
            isDeleted: false,
            targetType: "property",
            targetId: "p1",
            propertyId: "p1",
          },
        ],
        properties: [{ id: "p1", createdBy: "u-x", assignedTo: null }],
      });
      const decision = await authorizeUploadAccess({
        key: "_",
        session: admin,
        permissions: permsWithPropertyRead,
        prisma,
      });
      expect(decision).toBe("not_found");
    });
  });
});

// ============================================================
// S1b-4: 謄本PDF(registry) preview/download の server-side enforcement
// ============================================================
describe("authorizeUploadAccess — registry_pdf gating (S1b-4)", () => {
  const REG_KEY = "properties/p1/registry/100.pdf";
  const regAtt = (over: Partial<Att> = {}): Att => ({
    id: "att-reg-1",
    fileUrl: `/uploads/${REG_KEY}`,
    isDeleted: false,
    targetType: "property",
    targetId: "p1",
    propertyId: "p1",
    type: "registry",
    ...over,
  });
  const prop: Prop = { id: "p1", createdBy: "u-office", assignedTo: null };
  const base: PermissionEntry[] = [
    { resource: "property", action: "read", granted: true },
  ];
  const withPreview: PermissionEntry[] = [
    ...base,
    { resource: "registry_pdf", action: "preview", granted: true },
  ];
  const withPreviewDownload: PermissionEntry[] = [
    ...withPreview,
    { resource: "registry_pdf", action: "download", granted: true },
  ];

  it("registry + preview 有 → ok（property scope も満たす）", async () => {
    const prisma = makeDb({ attachments: [regAtt()], properties: [prop] });
    expect(
      await authorizeUploadAccess({ key: REG_KEY, session: officeStaff, permissions: withPreview, prisma }),
    ).toBe("ok");
  });

  it("registry + preview 無 → forbidden（property:read だけでは取得不可＝hard boundary）", async () => {
    const prisma = makeDb({ attachments: [regAtt()], properties: [prop] });
    expect(
      await authorizeUploadAccess({ key: REG_KEY, session: officeStaff, permissions: base, prisma }),
    ).toBe("forbidden");
  });

  it("registry + downloadIntent + download 無 → forbidden", async () => {
    const prisma = makeDb({ attachments: [regAtt()], properties: [prop] });
    expect(
      await authorizeUploadAccess({ key: REG_KEY, session: officeStaff, permissions: withPreview, downloadIntent: true, prisma }),
    ).toBe("forbidden");
  });

  it("registry + downloadIntent + download 有 → ok", async () => {
    const prisma = makeDb({ attachments: [regAtt()], properties: [prop] });
    expect(
      await authorizeUploadAccess({ key: REG_KEY, session: officeStaff, permissions: withPreviewDownload, downloadIntent: true, prisma }),
    ).toBe("ok");
  });

  it("registry + preview 有 でも field_staff scope 外 → forbidden（perm と scope の AND）", async () => {
    const prisma = makeDb({
      attachments: [regAtt()],
      properties: [{ id: "p1", createdBy: "u-someone", assignedTo: null }],
    });
    expect(
      await authorizeUploadAccess({ key: REG_KEY, session: fieldStaff, permissions: withPreview, prisma }),
    ).toBe("forbidden");
  });

  it("registry isDeleted → not_found（registry gate より前に判定）", async () => {
    const prisma = makeDb({ attachments: [regAtt({ isDeleted: true })], properties: [prop] });
    expect(
      await authorizeUploadAccess({ key: REG_KEY, session: officeStaff, permissions: base, prisma }),
    ).toBe("not_found");
  });

  it("非 registry(type='general') は registry gate を通らず従来どおり ok", async () => {
    const genKey = "properties/p1/attachments/9.pdf";
    const prisma = makeDb({
      attachments: [regAtt({ id: "att-gen", fileUrl: `/uploads/${genKey}`, type: "general" })],
      properties: [prop],
    });
    expect(
      await authorizeUploadAccess({ key: genKey, session: officeStaff, permissions: base, prisma }),
    ).toBe("ok");
  });

  it("downloadIntent 未指定（既定 false）なら download 権限無でも preview として ok", async () => {
    const prisma = makeDb({ attachments: [regAtt()], properties: [prop] });
    expect(
      await authorizeUploadAccess({ key: REG_KEY, session: officeStaff, permissions: withPreview, prisma }),
    ).toBe("ok");
  });
});

describe("resolveRegistryServeMeta (S1b-4)", () => {
  const REG_KEY = "properties/p1/registry/100.pdf";

  it("active registry 添付 → { isRegistry, attachmentId, propertyId } を返す", async () => {
    const prisma = makeDb({
      attachments: [
        { id: "att-reg-1", fileUrl: `/uploads/${REG_KEY}`, isDeleted: false, targetType: "property", targetId: "p1", propertyId: "p1", type: "registry" },
      ],
    });
    expect(await resolveRegistryServeMeta(REG_KEY, prisma)).toEqual({
      isRegistry: true,
      attachmentId: "att-reg-1",
      propertyId: "p1",
    });
  });

  it("非 registry(general) → null（route は従来ヘッダ・監査なし）", async () => {
    const GEN_KEY = "properties/p1/attachments/9.pdf";
    const prisma = makeDb({
      attachments: [
        { id: "att-gen", fileUrl: `/uploads/${GEN_KEY}`, isDeleted: false, targetType: "property", targetId: "p1", propertyId: "p1", type: "general" },
      ],
    });
    expect(await resolveRegistryServeMeta(GEN_KEY, prisma)).toBeNull();
  });

  it("deleted registry → null", async () => {
    const prisma = makeDb({
      attachments: [
        { id: "att-reg-1", fileUrl: `/uploads/${REG_KEY}`, isDeleted: true, targetType: "property", targetId: "p1", propertyId: "p1", type: "registry" },
      ],
    });
    expect(await resolveRegistryServeMeta(REG_KEY, prisma)).toBeNull();
  });

  it("invalid key(traversal) → null", async () => {
    const prisma = makeDb({});
    expect(await resolveRegistryServeMeta("../etc/passwd", prisma)).toBeNull();
  });
});
