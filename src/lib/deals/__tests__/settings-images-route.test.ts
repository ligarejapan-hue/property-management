import { describe, it, expect, vi, beforeEach } from "vitest";
import { crc32, deflateSync } from "node:zlib";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/storage", () => {
  const files = new Map<string, Buffer>();
  const store = {
    upload: vi.fn(async (b: Buffer, o: { key: string }) => { files.set(o.key, b); return { url: `/uploads/${o.key}`, key: o.key }; }),
    delete: vi.fn(async (k: string) => { files.delete(k); }),
    read: vi.fn(async (k: string) => (files.has(k) ? { body: files.get(k)!, contentType: "x", size: files.get(k)!.length } : null)),
  };
  return { __files: files, __store: store, getStorage: () => store };
});
vi.mock("@/lib/prisma", () => ({
  default: { dealSettings: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() } },
}));

import prismaMock from "@/lib/prisma";
import * as storageMod from "@/lib/storage";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET, POST, DELETE } from "../../../app/api/admin/deal-settings/images/[kind]/route";
import { loadDealBranding } from "../branding-store";
import { dealImageKey, dealImageMimeFromKey, isDealSettingsStorageKey, imageDataUri } from "../branding";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { dealSettings: { findUnique: Fn; create: Fn; updateMany: Fn } };
const files = (storageMod as unknown as { __files: Map<string, Buffer> }).__files;
const store = (storageMod as unknown as { __store: { upload: Fn; delete: Fn; read: Fn } }).__store;
const ADMIN = [{ resource: "user_management", action: "write", granted: true }];
const ctx = (kind = "logo") => ({ params: Promise.resolve({ kind }) });
const at = new Date("2026-10-24T00:00:00Z");
const settingsRow = (v: number, extra: Record<string, unknown> = {}) => ({
  representativeTitle: null, representativeName: null, bankAccount: {}, propertyKinds: [], texts: {}, logoKey: null, sealKey: null,
  version: v, updatedAt: at, ...extra,
});

/** 試験用の小さな PNG(幅 w・高さ h)。pad を渡すと、その大きさの付帯の chunk を足す(形としては正しいまま大きくする)。 */
function png(w: number, h: number, pad = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), ...(pad ? [chunk("tEXt", Buffer.alloc(pad, 0x41))] : []), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
function upload(body: Buffer | string, opts: { type?: string; version?: string | null; kind?: string } = {}) {
  const fd = new FormData();
  fd.append("file", new File([typeof body === "string" ? body : new Uint8Array(body)], "社長の印.png", { type: opts.type ?? "image/png" }));
  if (opts.version !== null) fd.append("version", opts.version ?? "3");
  return POST(new Request("http://x/api/admin/deal-settings/images/logo", { method: "POST", body: fd }), ctx(opts.kind));
}
const del = (version: string | null, kind = "logo") =>
  DELETE(new Request(`http://x/api/admin/deal-settings/images/${kind}${version === null ? "" : `?version=${version}`}`, { method: "DELETE" }), ctx(kind));

beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
  (getApiSession as Fn).mockResolvedValue({ id: "u-admin", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue(ADMIN);
  pm.dealSettings.findUnique.mockResolvedValue(settingsRow(3));
  pm.dealSettings.updateMany.mockResolvedValue({ count: 1 });
  pm.dealSettings.create.mockResolvedValue({});
});

describe("ロゴ・角印の鍵と埋め込み", () => {
  it("鍵は deal-settings/ の下・形式は拡張子から", () => {
    expect(dealImageKey("seal", "abc", "image/jpeg")).toBe("deal-settings/seal-abc.jpg");
    expect(dealImageMimeFromKey("deal-settings/logo-a.png")).toBe("image/png");
    expect(dealImageMimeFromKey("deal-settings/logo-a.JPG")).toBe("image/jpeg");
    expect(dealImageMimeFromKey("deal-settings/logo-a.svg")).toBeNull();
    for (const k of ["deal-settings/logo-a.png", "/deal-settings/x", "./Deal-Settings/x"]) expect(isDealSettingsStorageKey(k)).toBe(true);
    expect(isDealSettingsStorageKey("properties/deal-settings/x")).toBe(false);
    expect(imageDataUri("image/png", Buffer.from("ab"))).toBe("data:image/png;base64,YWI=");
  });
});

describe("画像を上げる", () => {
  it("管理者でなければ 403(見る・上げる・消す)", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "deal", action: "write", granted: true }]);
    expect((await GET(new Request("http://x"), ctx())).status).toBe(403);
    expect((await upload(png(10, 10))).status).toBe(403);
    expect((await del("3")).status).toBe(403);
    expect(store.upload).not.toHaveBeenCalled();
  });
  it("知らない種類は 404", async () => {
    expect((await upload(png(10, 10), { kind: "stamp" })).status).toBe(404);
    expect((await GET(new Request("http://x"), ctx("stamp"))).status).toBe(404);
  });
  it("PNG を受け取り、deal-settings/ に置いて鍵を書く・監査にファイル名は残さない", async () => {
    const res = await upload(png(120, 40));
    expect(res.status).toBe(200);
    const key = store.upload.mock.calls[0][1].key as string;
    expect(key).toMatch(/^deal-settings\/logo-[0-9a-f-]{36}\.png$/);
    expect(store.upload.mock.calls[0][1].fileName).toBe("logo.png");
    expect(pm.dealSettings.updateMany).toHaveBeenCalledWith({
      where: { id: "singleton", version: 3 },
      data: { logoKey: key, updatedById: "u-admin", version: { increment: 1 } },
    });
    const body = await res.json();
    expect(body.settings).toMatchObject({ hasLogo: true, version: 4 });
    expect(JSON.stringify(body)).not.toContain("deal-settings/");
    const audit = (writeAuditLog as Fn).mock.calls[0][0];
    expect(audit).toMatchObject({ action: "deal_settings_image_update", targetTable: "deal_settings", detail: { kind: "logo", op: "set", width: 120, height: 40 } });
    expect(JSON.stringify(audit)).not.toContain("社長");
  });
  it("前の画像は、差し替えが済んでから消す", async () => {
    files.set("deal-settings/logo-old.png", png(1, 1));
    pm.dealSettings.findUnique.mockResolvedValue(settingsRow(3, { logoKey: "deal-settings/logo-old.png" }));
    expect((await upload(png(10, 10))).status).toBe(200);
    expect(files.has("deal-settings/logo-old.png")).toBe(false);
    expect([...files.keys()]).toHaveLength(1);
  });
  it("初めての保存(版 0)は行を作る・同時なら 409 で置いた画像を消す", async () => {
    pm.dealSettings.findUnique.mockResolvedValue(null);
    expect((await upload(png(10, 10), { version: "0" })).status).toBe(200);
    expect(pm.dealSettings.create).toHaveBeenCalledWith({ data: { id: "singleton", logoKey: expect.stringMatching(/^deal-settings\//), updatedById: "u-admin" } });
    files.clear();
    pm.dealSettings.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    expect((await upload(png(10, 10), { version: "0" })).status).toBe(409);
    expect(files.size).toBe(0);
  });
  it("版が古ければ 409 で何も置かない・書き込みで負けても置いた画像を消し、前の画像は残す", async () => {
    const OLD = "deal-settings/logo-old.png";
    files.set(OLD, png(1, 1));
    pm.dealSettings.findUnique.mockResolvedValue(settingsRow(3, { logoKey: OLD }));
    expect((await upload(png(10, 10), { version: "2" })).status).toBe(409);
    expect(store.upload).not.toHaveBeenCalled();
    pm.dealSettings.updateMany.mockResolvedValue({ count: 0 });
    expect((await upload(png(10, 10), { version: "3" })).status).toBe(409);
    expect([...files.keys()]).toEqual([OLD]);
    pm.dealSettings.updateMany.mockRejectedValue(new Error("db down"));
    expect((await upload(png(10, 10), { version: "3" })).status).toBe(500);
    expect([...files.keys()]).toEqual([OLD]);
  });
  it("@codex: 返す版はこの書き込みで決まった版(直後にほかの人が保存しても、その版を返さない)", async () => {
    // 1回目=書く前の行・2回目以降=直後にほかの管理者が文字の設定を保存した行(版 9)
    pm.dealSettings.findUnique.mockResolvedValueOnce(settingsRow(3)).mockResolvedValue(settingsRow(9, { logoKey: "deal-settings/logo-x.png" }));
    expect((await (await upload(png(10, 10))).json()).settings).toMatchObject({ version: 4, hasLogo: true });
    pm.dealSettings.findUnique.mockResolvedValueOnce(null).mockResolvedValue(settingsRow(9));
    expect((await (await upload(png(10, 10), { version: "0" })).json()).settings).toMatchObject({ version: 1, hasLogo: true });
    files.set("deal-settings/seal-a.png", png(5, 5));
    pm.dealSettings.findUnique.mockResolvedValueOnce(settingsRow(3, { sealKey: "deal-settings/seal-a.png" })).mockResolvedValue(settingsRow(9, { sealKey: "x" }));
    expect((await (await del("3", "seal")).json()).settings).toMatchObject({ version: 4, hasSeal: false });
  });
  it("前の画像を消すのは、鍵を書き換えたあと", async () => {
    files.set("deal-settings/logo-old.png", png(1, 1));
    pm.dealSettings.findUnique.mockResolvedValue(settingsRow(3, { logoKey: "deal-settings/logo-old.png" }));
    expect((await upload(png(10, 10))).status).toBe(200);
    expect(store.delete).toHaveBeenCalledWith("deal-settings/logo-old.png");
    expect(store.delete.mock.invocationCallOrder[0]).toBeGreaterThan(pm.dealSettings.updateMany.mock.invocationCallOrder[0]);
  });
  it("形式・中身・大きさ・版が合わなければ 422", async () => {
    expect((await upload(png(10, 10), { type: "image/svg+xml" })).status).toBe(422);
    expect((await upload("<svg onload=alert(1)>", { type: "image/png" })).status).toBe(422);
    expect((await upload(png(2001, 10))).status).toBe(422);
    // 形としては正しい PNG でも 1MB を超えれば受け取らない
    const big = png(10, 10, 1024 * 1024);
    expect(big.length).toBeGreaterThan(1024 * 1024);
    expect((await upload(big)).status).toBe(422);
    expect((await upload(png(10, 10), { version: null })).status).toBe(422);
    expect((await upload(png(10, 10), { version: "x" })).status).toBe(422);
    expect(store.upload).not.toHaveBeenCalled();
  });
  it("見本: 登録した画像を no-store で返す・無ければ 404", async () => {
    expect((await GET(new Request("http://x"), ctx())).status).toBe(404);
    files.set("deal-settings/seal-a.png", png(5, 5));
    pm.dealSettings.findUnique.mockResolvedValue(settingsRow(3, { sealKey: "deal-settings/seal-a.png" }));
    const res = await GET(new Request("http://x"), ctx("seal"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    files.clear();
    expect((await GET(new Request("http://x"), ctx("seal"))).status).toBe(404);
  });
});

describe("画像を消す", () => {
  it("鍵を空にしてからファイルを消す・監査を残す", async () => {
    files.set("deal-settings/seal-a.png", png(5, 5));
    pm.dealSettings.findUnique.mockResolvedValue(settingsRow(3, { sealKey: "deal-settings/seal-a.png" }));
    const res = await del("3", "seal");
    expect(res.status).toBe(200);
    expect(pm.dealSettings.updateMany).toHaveBeenCalledWith({
      where: { id: "singleton", version: 3 }, data: { sealKey: null, updatedById: "u-admin", version: { increment: 1 } },
    });
    expect(files.size).toBe(0);
    expect(store.delete.mock.invocationCallOrder[0]).toBeGreaterThan(pm.dealSettings.updateMany.mock.invocationCallOrder[0]);
    expect((writeAuditLog as Fn).mock.calls[0][0]).toMatchObject({ action: "deal_settings_image_update", detail: { kind: "seal", op: "clear" } });
  });
  it("版が古い・負けたら 409 でファイルは残す・版が無ければ 422", async () => {
    files.set("deal-settings/logo-a.png", png(5, 5));
    pm.dealSettings.findUnique.mockResolvedValue(settingsRow(3, { logoKey: "deal-settings/logo-a.png" }));
    expect((await del("2")).status).toBe(409);
    pm.dealSettings.updateMany.mockResolvedValue({ count: 0 });
    expect((await del("3")).status).toBe(409);
    expect(files.size).toBe(1);
    expect((await del(null)).status).toBe(422);
  });
  it("登録が無ければ何もしない", async () => {
    expect((await del("3")).status).toBe(200);
    expect(pm.dealSettings.updateMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("書類に使うロゴ", () => {
  it("登録した画像を data: の URL で返す・無い/読めないときは null", async () => {
    pm.dealSettings.findUnique.mockResolvedValue(settingsRow(3));
    expect(await loadDealBranding()).toEqual({ logo: null });
    pm.dealSettings.findUnique.mockResolvedValue(settingsRow(3, { logoKey: "deal-settings/logo-a.png" }));
    expect(await loadDealBranding()).toEqual({ logo: null });
    files.set("deal-settings/logo-a.png", Buffer.from("ab"));
    expect(await loadDealBranding()).toEqual({ logo: "data:image/png;base64,YWI=" });
    store.read.mockRejectedValueOnce(new Error("io"));
    expect(await loadDealBranding()).toEqual({ logo: null });
  });
});
