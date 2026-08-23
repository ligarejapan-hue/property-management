/**
 * 非 registry upload key の一意性テスト（uploads ETag/304 の Codex Review P2 対応）。
 *
 * 背景: /uploads の ETag は「同一 key = 同一バイト列（key 非再利用）」を前提に
 * storage key から生成する（uploads-etag.ts）。旧実装の upload key は
 * `${Date.now()}.${ext}` のみで、同一 entity・同一ミリ秒に 2 回 upload されると
 * key が衝突し storage が後勝ち上書きされ、この前提が崩れて 304 が stale bytes を
 * 維持させ得た。対応として key に `randomUUID()` を追加し、同一 ms でも必ず
 * 異なる key になることをロックする。
 *
 * 確認点（route ごと）:
 *  - Date.now() を固定しても 2 回の upload で storage key が異なる
 *  - key の prefix（category / entity id / subdir）が従来のまま
 *  - 元ファイルの拡張子が key 末尾に維持される
 *  - 形式: `{prefix}/{Date.now()}-{uuid}.{ext}`
 * 既存 URL の読み取り互換（保存済み fileUrl の解釈）はこの変更の対象外で不変。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  return { NextRequest: MockNextRequest };
});

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json(
          { error: { message: error.message, code: error.code } },
          { status: error.status },
        );
      }
      return Response.json(
        { error: { message: "Server error", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));

const { storageStub } = vi.hoisted(() => ({
  storageStub: {
    upload: vi.fn(),
    delete: vi.fn(),
    getUrl: vi.fn(),
    read: vi.fn(),
  },
}));
vi.mock("@/lib/storage", () => {
  const MAX = 8 * 1024 * 1024;
  const PHOTO = new Set(["image/jpeg", "image/png", "image/webp"]);
  const ATTACH = new Set(["image/jpeg", "image/png", "application/pdf"]);
  return {
    getStorage: () => storageStub,
    MAX_FILE_SIZE: MAX,
    ALLOWED_PHOTO_MIMES: PHOTO,
    ALLOWED_ATTACHMENT_MIMES: ATTACH,
    validateFile: (size: number, mime: string, allowed: Set<string>) => {
      if (size > MAX) return "ファイルサイズが上限を超えています";
      if (!allowed.has(mime)) return `許可されていないファイル形式です: ${mime}`;
      return null;
    },
  };
});

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    property: { findUnique: vi.fn() },
    propertyPhoto: { aggregate: vi.fn(), create: vi.fn() },
    building: { findUnique: vi.fn() },
    buildingPhoto: { aggregate: vi.fn(), create: vi.fn() },
    attachment: { create: vi.fn() },
  };
  // #402: 添付の作成は「親行ロック → tx.attachment.create」の tx 内になった。
  // callback へ同じ db を渡す(registry-pdf-attachment.test と同型)。
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => [{ id: "p1" }]); // lockPropertyRow の実体
  return { default: db };
});

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { POST as postPropertyPhoto } from "@/app/api/properties/[id]/photos/route";
import { POST as postBuildingPhoto } from "@/app/api/buildings/[id]/photos/route";
import { POST as postAttachment } from "@/app/api/properties/[id]/attachments/route";

const pm = prisma as unknown as {
  property: { findUnique: ReturnType<typeof vi.fn> };
  propertyPhoto: {
    aggregate: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  building: { findUnique: ReturnType<typeof vi.fn> };
  buildingPhoto: {
    aggregate: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  attachment: { create: ReturnType<typeof vi.fn> };
};

const ADMIN = { id: "u-admin", email: "a@a", name: "A", role: "admin" };
const PERMS = [
  { resource: "property", action: "read", granted: true },
  { resource: "property", action: "write", granted: true },
];

const FIXED_NOW = 1750000000000;
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

let nowSpy: ReturnType<typeof vi.spyOn>;

function paramsP(id: string) {
  return { params: Promise.resolve({ id }) };
}

function multipartReq(
  url: string,
  fileName: string,
  mime: string,
  extra: Record<string, string> = {},
) {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(16)], { type: mime }), fileName);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return new Request(url, { method: "POST", body: fd }) as unknown as NextRequest;
}

/** storage.upload に渡された key を順に返す。 */
function uploadedKeys(): string[] {
  return storageStub.upload.mock.calls.map(
    (c) => (c[1] as { key: string }).key,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Date.now() を固定: 旧実装（`${Date.now()}.${ext}` のみ）なら 2 回の upload で
  // 必ず同一 key になる条件を作り、UUID による一意化を直接ロックする。
  nowSpy = vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);

  vi.mocked(getApiSession).mockResolvedValue(ADMIN as never);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS as never);
  storageStub.upload.mockImplementation(
    async (_buf: Buffer, opts: { key: string }) => ({
      url: `/uploads/${opts.key}`,
    }),
  );

  pm.property.findUnique.mockResolvedValue({
    id: "p-1",
    createdBy: "u-x",
    assignedTo: null,
  });
  pm.propertyPhoto.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
  pm.propertyPhoto.create.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      id: "ph-1",
      ...args.data,
    }),
  );
  pm.building.findUnique.mockResolvedValue({ id: "b-1" });
  pm.buildingPhoto.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
  pm.buildingPhoto.create.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      id: "bph-1",
      ...args.data,
    }),
  );
  pm.attachment.create.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      id: "att-1",
      ...args.data,
    }),
  );
});

afterEach(() => {
  nowSpy.mockRestore();
});

describe("upload key の同一ミリ秒衝突防止（randomUUID 付与）", () => {
  it("property photo: Date.now() 固定でも 2 回の storage key が異なり、prefix/拡張子/形式を維持", async () => {
    const req = () =>
      multipartReq("http://t/api/properties/p-1/photos", "photo.png", "image/png");
    const res1 = await postPropertyPhoto(req(), paramsP("p-1"));
    const res2 = await postPropertyPhoto(req(), paramsP("p-1"));
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);

    const [k1, k2] = uploadedKeys();
    expect(k1).not.toBe(k2); // 同一 ms でも衝突しない（旧実装なら同一になる）
    const re = new RegExp(
      `^properties/p-1/photos/${FIXED_NOW}-${UUID_RE}\\.png$`,
    );
    expect(k1).toMatch(re); // prefix / entity id / 拡張子 / 形式の維持
    expect(k2).toMatch(re);
  });

  it("building photo: Date.now() 固定でも 2 回の storage key が異なり、prefix/拡張子/形式を維持", async () => {
    const req = () =>
      multipartReq("http://t/api/buildings/b-1/photos", "photo.jpg", "image/jpeg");
    const res1 = await postBuildingPhoto(req(), paramsP("b-1"));
    const res2 = await postBuildingPhoto(req(), paramsP("b-1"));
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);

    const [k1, k2] = uploadedKeys();
    expect(k1).not.toBe(k2);
    const re = new RegExp(`^buildings/b-1/photos/${FIXED_NOW}-${UUID_RE}\\.jpg$`);
    expect(k1).toMatch(re);
    expect(k2).toMatch(re);
  });

  it("property attachment (general): Date.now() 固定でも 2 回の storage key が異なり、attachments subdir/拡張子を維持", async () => {
    const req = () =>
      multipartReq(
        "http://t/api/properties/p-1/attachments",
        "doc.pdf",
        "application/pdf",
      );
    const res1 = await postAttachment(req(), paramsP("p-1"));
    const res2 = await postAttachment(req(), paramsP("p-1"));
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);

    const [k1, k2] = uploadedKeys();
    expect(k1).not.toBe(k2);
    const re = new RegExp(
      `^properties/p-1/attachments/${FIXED_NOW}-${UUID_RE}\\.pdf$`,
    );
    expect(k1).toMatch(re);
    expect(k2).toMatch(re);
  });

  it("property attachment (registry): registry subdir を維持したまま同一 ms 衝突を防止（配信方針は不変）", async () => {
    const req = () =>
      multipartReq(
        "http://t/api/properties/p-1/attachments",
        "touhon.pdf",
        "application/pdf",
        { type: "registry" },
      );
    const res1 = await postAttachment(req(), paramsP("p-1"));
    const res2 = await postAttachment(req(), paramsP("p-1"));
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);

    const [k1, k2] = uploadedKeys();
    expect(k1).not.toBe(k2);
    const re = new RegExp(
      `^properties/p-1/registry/${FIXED_NOW}-${UUID_RE}\\.pdf$`,
    );
    expect(k1).toMatch(re); // registry subdir は従来のまま
    expect(k2).toMatch(re);
  });

  it("拡張子が大文字・複合名でも最終拡張子を維持する（photo.FINAL.PNG → .PNG）", async () => {
    const req = multipartReq(
      "http://t/api/properties/p-1/photos",
      "photo.FINAL.PNG",
      "image/png",
    );
    const res = await postPropertyPhoto(req, paramsP("p-1"));
    expect(res.status).toBe(201);
    const [k1] = uploadedKeys();
    expect(k1).toMatch(
      new RegExp(`^properties/p-1/photos/${FIXED_NOW}-${UUID_RE}\\.PNG$`),
    );
  });
});
