/**
 * /uploads/[...path] 認可: FieldSurveyPinPhoto 分岐の unit test (Phase 1-H)。
 *
 * - own pin 写真は field_survey:read で閲覧可
 * - 他人 pin 写真は read_all または manage で閲覧可
 * - read のみで他人 pin 写真は forbidden
 * - 未登録 key は not_found
 * - property / attachment の既存認可が壊れないこと (pin photo が無い key は従来通り)
 */
import { describe, it, expect } from "vitest";
import { authorizeUploadAccess } from "@/lib/uploads-authorization";
import type { ApiSession, PermissionEntry } from "@/lib/api-helpers";

type PinPhoto = { fileUrl: string; pin: { staffUserId: string } | null };
type Photo = { fileUrl: string; propertyId: string };
type Prop = { id: string; createdBy: string; assignedTo: string | null };

function makeDb(opts: {
  pinPhotos?: PinPhoto[];
  photos?: Photo[];
  properties?: Prop[];
}) {
  const pinPhotos = opts.pinPhotos ?? [];
  const photos = opts.photos ?? [];
  const properties = opts.properties ?? [];
  type ContainsWhere = { fileUrl: { contains: string } };
  const matchContains = (url: string, where: ContainsWhere) =>
    typeof url === "string" && url.includes(where.fileUrl.contains);
  return {
    propertyPhoto: {
      findMany: async ({ where }: { where: ContainsWhere }) =>
        photos.filter((p) => matchContains(p.fileUrl, where)),
    },
    buildingPhoto: { findMany: async () => [] },
    attachment: { findMany: async () => [] },
    fieldSurveyPinPhoto: {
      findMany: async ({ where }: { where: ContainsWhere }) =>
        pinPhotos.filter((p) => matchContains(p.fileUrl, where)),
    },
    property: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        properties.find((p) => p.id === where.id) ?? null,
    },
  } as unknown as Parameters<typeof authorizeUploadAccess>[0]["prisma"];
}

const owner: ApiSession = { id: "u-own", email: "", name: "", role: "field_staff" };
const other: ApiSession = { id: "u-other", email: "", name: "", role: "field_staff" };

const fsRead: PermissionEntry[] = [
  { resource: "field_survey", action: "read", granted: true },
];
const fsReadAll: PermissionEntry[] = [
  { resource: "field_survey", action: "read", granted: true },
  { resource: "field_survey", action: "read_all", granted: true },
];
const fsManage: PermissionEntry[] = [
  { resource: "field_survey", action: "read", granted: true },
  { resource: "field_survey", action: "manage", granted: true },
];
const noFs: PermissionEntry[] = [];

const KEY = "field-survey/pins/p1/photos/1.jpg";
const URL = `/uploads/${KEY}`;

describe("authorizeUploadAccess — FieldSurveyPinPhoto", () => {
  it("own pin 写真は field_survey:read で ok", async () => {
    const prisma = makeDb({ pinPhotos: [{ fileUrl: URL, pin: { staffUserId: owner.id } }] });
    expect(
      await authorizeUploadAccess({ key: KEY, session: owner, permissions: fsRead, prisma }),
    ).toBe("ok");
  });

  it("他人 pin 写真は read のみでは forbidden", async () => {
    const prisma = makeDb({ pinPhotos: [{ fileUrl: URL, pin: { staffUserId: other.id } }] });
    expect(
      await authorizeUploadAccess({ key: KEY, session: owner, permissions: fsRead, prisma }),
    ).toBe("forbidden");
  });

  it("他人 pin 写真は read_all で ok", async () => {
    const prisma = makeDb({ pinPhotos: [{ fileUrl: URL, pin: { staffUserId: other.id } }] });
    expect(
      await authorizeUploadAccess({ key: KEY, session: owner, permissions: fsReadAll, prisma }),
    ).toBe("ok");
  });

  it("他人 pin 写真は manage で ok", async () => {
    const prisma = makeDb({ pinPhotos: [{ fileUrl: URL, pin: { staffUserId: other.id } }] });
    expect(
      await authorizeUploadAccess({ key: KEY, session: owner, permissions: fsManage, prisma }),
    ).toBe("ok");
  });

  it("field_survey:read を持たないと own でも forbidden", async () => {
    const prisma = makeDb({ pinPhotos: [{ fileUrl: URL, pin: { staffUserId: owner.id } }] });
    expect(
      await authorizeUploadAccess({ key: KEY, session: owner, permissions: noFs, prisma }),
    ).toBe("forbidden");
  });

  it("未登録 key は not_found", async () => {
    const prisma = makeDb({ pinPhotos: [{ fileUrl: URL, pin: { staffUserId: owner.id } }] });
    expect(
      await authorizeUploadAccess({
        key: "field-survey/pins/p1/photos/zzz.jpg",
        session: owner,
        permissions: fsRead,
        prisma,
      }),
    ).toBe("not_found");
  });

  it("pin photo が無い property 写真 key は従来の property 認可で決まる (回帰なし)", async () => {
    const prisma = makeDb({
      photos: [{ fileUrl: "/uploads/properties/p9/photos/1.jpg", propertyId: "p9" }],
      properties: [{ id: "p9", createdBy: owner.id, assignedTo: null }],
    });
    expect(
      await authorizeUploadAccess({
        key: "properties/p9/photos/1.jpg",
        session: owner,
        permissions: [{ resource: "property", action: "read", granted: true }],
        prisma,
      }),
    ).toBe("ok");
  });
});
