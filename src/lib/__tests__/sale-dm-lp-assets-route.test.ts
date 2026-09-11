import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(), getOwnerDisplayConfig: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => { const t = await r.text(); return t ? JSON.parse(t) : {}; }),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
const { storageStub } = vi.hoisted(() => ({ storageStub: { upload: vi.fn(), delete: vi.fn(), getUrl: vi.fn(), read: vi.fn(), keyFromUrl: vi.fn() } }));
vi.mock("@/lib/storage", () => {
  const MAX = 8 * 1024 * 1024;
  return {
    getStorage: () => storageStub,
    MAX_FILE_SIZE: MAX,
    ALLOWED_PHOTO_MIMES: new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]),
    validateFile: (size: number, mime: string, allowed: Set<string>) => (size > MAX ? "大きすぎます" : !allowed.has(mime) ? `許可されていないファイル形式です: ${mime}` : null),
  };
});
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmLpAsset: { findMany: vi.fn(async () => []), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    dmLpVariantMedia: { count: vi.fn(async () => 0) },
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction = vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { GET, POST } from "../../app/api/properties/sale-dm/lp-assets/route";
import { DELETE } from "../../app/api/properties/sale-dm/lp-assets/[assetId]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmLpAsset: { findMany: Fn; findUnique: Fn; create: Fn; update: Fn };
  dmLpVariantMedia: { count: Fn };
  $queryRaw: Fn;
};
const READS = ["property", "csv_export", "csv_export_personal", "owner"];

// 合成 JPEG(実画像なし): SOI + APP0(JFIF) + [APP1(EXIF)] + COM(コメント) + SOF0(width×height) + SOS + EOI。
// APP0 / COM は「EXIF ではないが公開配信の画像に残ってはいけない」付随情報の代表。
const COM_TEXT = "撮影者 山田太郎";
function jpegBytes(width: number, height: number, withExif = false): Buffer {
  // SOF0: 長さ(2) + precision(1) + 高さ(2) + 幅(2) + 成分数(1) + 成分ごとに3byte。
  // ⚠許可リスト strip は残す segment の中身の長さまで検査するので、成分数と長さを合わせる。
  const sof = Buffer.alloc(13); sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(11, 2); sof[4] = 8; sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7); sof[9] = 1; sof[10] = 1; sof[11] = 0x11; sof[12] = 0;
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const comPayload = Buffer.from(COM_TEXT, "utf8");
  const com = Buffer.concat([Buffer.from([0xff, 0xfe]), (() => { const l = Buffer.alloc(2); l.writeUInt16BE(comPayload.length + 2, 0); return l; })(), comPayload]);
  const exifPayload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from("II*\0\x08\0\0\0\0\0", "latin1")]);
  const app1 = withExif ? Buffer.concat([Buffer.from([0xff, 0xe1]), (() => { const l = Buffer.alloc(2); l.writeUInt16BE(exifPayload.length + 2, 0); return l; })(), exifPayload]) : Buffer.alloc(0);
  // ⚠許可リスト strip は DQT を最低1つ・DHT/DAC を最低1つ・entropy-coded data を
  // 1byte 以上必須にした(@codex P2=実データの無い画像を弾く)。この合成 JPEG も満たす。
  const dqtPayload = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 0x10)]); // Pq/Tq=0 の 8bit 量子化表(64byte)
  const dqt = Buffer.concat([Buffer.from([0xff, 0xdb]), (() => { const l = Buffer.alloc(2); l.writeUInt16BE(dqtPayload.length + 2, 0); return l; })(), dqtPayload]);
  const dhtCounts = Buffer.alloc(16); dhtCounts[0] = 1; // 符号長1が1個
  const dhtPayload = Buffer.concat([Buffer.from([0x00]), dhtCounts, Buffer.from([0x0a])]); // 値1個
  const dht = Buffer.concat([Buffer.from([0xff, 0xc4]), (() => { const l = Buffer.alloc(2); l.writeUInt16BE(dhtPayload.length + 2, 0); return l; })(), dhtPayload]);
  // SOS: 長さ(2) + Ns(1) + 成分ごとに2byte + Ss/Se/AhAl(3)
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  const entropy = Buffer.from([0x12, 0x34]); // entropy-coded data(実データ)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, com, dqt, dht, sof, sos, entropy, Buffer.from([0xff, 0xd9])]);
}
function multipart(bytes: Buffer, mime: string, name = "a.jpg", label?: string): Request {
  const fd = new FormData();
  fd.append("file", new File([bytes as unknown as BlobPart], name, { type: mime }));
  if (label !== undefined) fd.append("label", label);
  return new Request("http://x/api/properties/sale-dm/lp-assets", { method: "POST", body: fd });
}
const perms = (admin: boolean) => [
  ...READS.map((r) => ({ resource: r, action: "read", granted: true })),
  { resource: "property", action: "write", granted: true },
  ...(admin ? [{ resource: "user_management", action: "write", granted: true }] : []),
];

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue(perms(true));
  (getOwnerDisplayConfig as Fn).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  storageStub.upload.mockResolvedValue({ url: "/uploads/lp-assets/x.jpg", key: "lp-assets/x.jpg" });
  pm.dmLpAsset.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "a1", createdAt: new Date(), deletedAt: null, ...data }));
  pm.dmLpAsset.findUnique.mockResolvedValue({ id: "a1", publicId: "p".repeat(32), storageKey: "lp-assets/x.jpg", deletedAt: null });
  pm.dmLpVariantMedia.count.mockResolvedValue(0);
});

describe("POST lp-assets(アップロード)", () => {
  it("JPEG を EXIF を除いて保存し、publicId(32hex)と寸法を返す。/uploads の URL は返さない", async () => {
    const res = await POST(multipart(jpegBytes(1600, 900, true), "image/jpeg", "会社の外観.jpg", "外観") as never);
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.asset.publicId).toMatch(/^[0-9a-f]{32}$/);
    expect(j.asset).toMatchObject({ width: 1600, height: 900, mime: "image/jpeg", label: "外観" });
    expect(JSON.stringify(j)).not.toContain("/uploads/");
    expect(JSON.stringify(j)).not.toContain("storageKey");
    const uploaded: Buffer = storageStub.upload.mock.calls[0][0];
    expect(uploaded.includes(Buffer.from("Exif\0\0", "latin1"))).toBe(false);
    // EXIF だけでなく、デコードに要らない segment は1つも残らない(許可リストで組み立て直す)。
    const sosAt = uploaded.indexOf(Buffer.from([0xff, 0xda]));
    expect(sosAt).toBeGreaterThan(0);
    const head = uploaded.subarray(0, sosAt);
    for (let m = 0xe0; m <= 0xef; m += 1) expect(head.includes(Buffer.from([0xff, m]))).toBe(false); // APPn
    expect(head.includes(Buffer.from([0xff, 0xfe]))).toBe(false); // COM
    expect(uploaded.includes(Buffer.from(COM_TEXT, "utf8"))).toBe(false);
    expect(uploaded.includes(Buffer.from("JFIF", "latin1"))).toBe(false);
    expect(storageStub.upload.mock.calls[0][1].key).toMatch(/^lp-assets\/[0-9a-f-]{36}\.jpg$/);
    expect(writeAuditLog.mock.calls[0][0].action).toBe("sale_dm_lp_asset_upload");
    expect(JSON.stringify(writeAuditLog.mock.calls[0][0].detail)).not.toContain("外観");
  });
  it("長辺が1600を超えると 422(画面側で縮小して送る前提)", async () => {
    const res = await POST(multipart(jpegBytes(2000, 1000), "image/jpeg") as never);
    expect(res.status).toBe(422);
    expect(storageStub.upload).not.toHaveBeenCalled();
  });
  it("HEIC は 422(JPEG に変換してから送る)・multipart 以外も 422", async () => {
    expect((await POST(multipart(jpegBytes(10, 10), "image/heic", "a.heic") as never)).status).toBe(422);
    expect((await POST(new Request("http://x", { method: "POST", body: "{}" }) as never)).status).toBe(422);
  });
  it("壊れた画像(寸法が読めない)は 422 で保存しない", async () => {
    const res = await POST(multipart(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg") as never);
    expect(res.status).toBe(422);
    expect(storageStub.upload).not.toHaveBeenCalled();
  });
  it("DB 保存に失敗したら保存した実ファイルを消す", async () => {
    pm.dmLpAsset.create.mockRejectedValue(new Error("db down"));
    const res = await POST(multipart(jpegBytes(100, 100), "image/jpeg") as never);
    expect(res.status).toBe(500);
    expect(storageStub.delete).toHaveBeenCalledWith("lp-assets/x.jpg");
  });
  it("書き込み権限が無ければ 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue(READS.map((r) => ({ resource: r, action: "read", granted: true })));
    expect((await POST(multipart(jpegBytes(10, 10), "image/jpeg") as never)).status).toBe(403);
  });
});

describe("GET lp-assets(一覧)", () => {
  it("削除済みを除き新しい順、referenced を付ける、storageKey は返さない", async () => {
    pm.dmLpAsset.findMany.mockResolvedValue([
      { id: "a1", publicId: "p1", mime: "image/jpeg", width: 1, height: 1, bytes: 10, label: null, createdAt: new Date(), storageKey: "k", _count: { media: 2 } },
    ]);
    const res = await GET(new Request("http://x") as never);
    const j = await res.json();
    expect(pm.dmLpAsset.findMany.mock.calls[0][0].where).toEqual({ deletedAt: null });
    expect(j.assets[0]).toMatchObject({ id: "a1", referenced: true });
    expect(JSON.stringify(j)).not.toContain("storageKey");
  });
});

describe("DELETE lp-assets/[assetId]", () => {
  const ctx = { params: Promise.resolve({ assetId: "a1" }) };
  it("管理者のみ(user_management:write)。参照中は 409 REFERENCED", async () => {
    (getUserPermissions as Fn).mockResolvedValue(perms(false));
    expect((await DELETE(new Request("http://x", { method: "DELETE" }) as never, ctx)).status).toBe(403);
    (getUserPermissions as Fn).mockResolvedValue(perms(true));
    pm.dmLpVariantMedia.count.mockResolvedValue(1);
    const r = await DELETE(new Request("http://x", { method: "DELETE" }) as never, ctx);
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("REFERENCED");
    // 参照ありで 409 のときは論理削除まで進まない(削除/添付の競合を閉じるロックの後に判定している証拠)。
    expect(pm.dmLpAsset.update).not.toHaveBeenCalled();
  });
  it("対象行を FOR UPDATE でロックしてから参照件数を数える(削除/添付の競合を閉じる)", async () => {
    pm.dmLpAsset.update.mockResolvedValue({ id: "a1" });
    const r = await DELETE(new Request("http://x", { method: "DELETE" }) as never, ctx);
    expect(r.status).toBe(200);
    expect(pm.$queryRaw).toHaveBeenCalledTimes(1);
    expect(String(pm.$queryRaw.mock.calls[0][0])).toContain("dm_lp_assets");
    expect(String(pm.$queryRaw.mock.calls[0][0])).toContain("FOR UPDATE");
    const lockOrder = pm.$queryRaw.mock.invocationCallOrder[0];
    const countOrder = pm.dmLpVariantMedia.count.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(countOrder);
  });
  it("参照が無ければ論理削除し、実ファイルは best-effort で消す", async () => {
    pm.dmLpAsset.update.mockResolvedValue({ id: "a1" });
    storageStub.delete.mockRejectedValue(new Error("nfs"));
    const r = await DELETE(new Request("http://x", { method: "DELETE" }) as never, ctx);
    expect(r.status).toBe(200);
    expect(pm.dmLpAsset.update.mock.calls[0][0].data.deletedAt).toBeInstanceOf(Date);
    expect(writeAuditLog.mock.calls[0][0].action).toBe("sale_dm_lp_asset_delete");
  });
});
