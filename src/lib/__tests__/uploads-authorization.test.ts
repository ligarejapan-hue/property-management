/**
 * /uploads/[...path] Phase B 権限判定の unit test.
 *
 * key の DB 逆引き → entity scope の判定が
 * 既存 Property API のスコープと整合していることを確認する。
 */

import { describe, it, expect } from "vitest";
import { authorizeUploadAccess } from "@/lib/uploads-authorization";
import type { ApiSession, PermissionEntry } from "@/lib/api-helpers";

type Photo = { fileUrl: string; propertyId: string };
type BPhoto = { fileUrl: string; buildingId: string };
type Att = {
  fileUrl: string;
  isDeleted: boolean;
  targetType: string;
  targetId: string;
  propertyId: string | null;
};
type Prop = { id: string; createdBy: string; assignedTo: string | null };

function makeDb(opts: {
  photos?: Photo[];
  bPhotos?: BPhoto[];
  attachments?: Att[];
  properties?: Prop[];
}) {
  const photos = opts.photos ?? [];
  const bPhotos = opts.bPhotos ?? [];
  const attachments = opts.attachments ?? [];
  const properties = opts.properties ?? [];

  // 必要なメソッドのみ用意した最小 prisma 互換 stub。
  return {
    propertyPhoto: {
      findFirst: async ({ where }: { where: { fileUrl: string } }) =>
        photos.find((p) => p.fileUrl === where.fileUrl) ?? null,
    },
    buildingPhoto: {
      findFirst: async ({ where }: { where: { fileUrl: string } }) =>
        bPhotos.find((p) => p.fileUrl === where.fileUrl) ?? null,
    },
    attachment: {
      findFirst: async ({ where }: { where: { fileUrl: string } }) =>
        attachments.find((a) => a.fileUrl === where.fileUrl) ?? null,
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
});
