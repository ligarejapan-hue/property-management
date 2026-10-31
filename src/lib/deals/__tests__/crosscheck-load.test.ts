import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ default: { attachment: { findMany: vi.fn() } } }));
vi.mock("@/lib/storage", () => {
  const files = new Map<string, Buffer>();
  return {
    __files: files,
    getStorage: () => ({
      keyFromUrl: (u: string | null) => (u ? u.replace(/^\/uploads\//, "") : null),
      read: async (k: string) => (files.has(k) ? { body: files.get(k)! } : null),
    }),
  };
});
vi.mock("@/lib/pdf-extract", () => ({ extractTextFromPdf: vi.fn(async (b: Buffer) => b.toString("utf8")) }));
vi.mock("@/lib/registry-strike", async (orig) => ({
  ...(await orig<typeof import("@/lib/registry-strike")>()),
  summarizeRegistryRights: vi.fn(),
}));
const { parseRegistryText } = vi.hoisted(() => ({ parseRegistryText: vi.fn() }));
vi.mock("@/lib/pdf-registry-parser", () => ({ parseRegistryText }));

import prismaMock from "@/lib/prisma";
import * as storageMod from "@/lib/storage";
import { summarizeRegistryRights } from "@/lib/registry-strike";
import { loadCrosscheckRegistry } from "../crosscheck-load";

type Fn = ReturnType<typeof vi.fn>;
const findMany = (prismaMock as never as { attachment: { findMany: Fn } }).attachment.findMany;
const files = (storageMod as unknown as { __files: Map<string, Buffer> }).__files;
const FULL = "権 利 部 （ 甲 区 ） 権利部(乙区)";
const OWNER_TABLE = [
  "所有者事項", "┏━━━━━━━━━━┓", "┃ 所 有 者 ┃", "┠─────┬────┨", "┃ 住 所 │ 氏 名 ┃", "┠─────┼────┨",
  "┃架空県架空市1番1号 │架空太郎 ┃", "┗━━━━━┷━━━━┛", "", "-- 1 of 1 --",
].join("\n");
const SUMMARY = {
  hasKouku: true, ownersConfirmed: true, activeRights: [{ rank: "1" }, { rank: "2" }], cautions: [], notes: [],
  currentOwners: [{ name: "架空太郎", address: "架空県", share: "2分の1" }],
};
const att = (id: string, certType: string | null, at: string) => ({
  fileUrl: `/uploads/${id}.pdf`, registryCertificateType: certType, createdAt: new Date(at),
});
const opts = { kindBase: "unit" as const, includeOwners: true };

beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
  (summarizeRegistryRights as Fn).mockResolvedValue(SUMMARY);
  parseRegistryText.mockReturnValue({ unitFloorArea: "60.25", landAreaRegistry: null, buildingFloorArea: null, owners: [] });
});

describe("照合に使う謄本の値を集める", () => {
  it("謄本が無ければ none", async () => {
    findMany.mockResolvedValue([]);
    expect(await loadCrosscheckRegistry("p", opts)).toEqual({ status: "none" });
  });
  it("全部事項から面積・担保・所有者を読む", async () => {
    files.set("a.pdf", Buffer.from(FULL));
    findMany.mockResolvedValue([att("a", "all", "2026-10-01T00:00:00Z")]);
    const r = await loadCrosscheckRegistry("p", opts);
    expect(r).toMatchObject({
      status: "ok",
      areas: { unit: "60.25", attachmentCreatedAt: "2026-10-01T00:00:00.000Z" },
      rights: { activeRights: 2, readable: true },
      owners: { list: [{ name: "架空太郎", share: "2分の1" }], confirmed: true },
    });
  });
  it("所有者事項だけなら面積・担保は無く、所有者の表を読む", async () => {
    files.set("b.pdf", Buffer.from(OWNER_TABLE));
    findMany.mockResolvedValue([att("b", "owner", "2026-10-02T00:00:00Z")]);
    const r = await loadCrosscheckRegistry("p", opts);
    expect(r).toMatchObject({ status: "ok", areas: null, rights: null, owners: { confirmed: true, attachmentCreatedAt: "2026-10-02T00:00:00.000Z" } });
    if (r.status === "ok") expect(r.owners?.list[0].name).toBe("架空太郎");
  });
  it("所有者は新しい謄本から・担保と面積は全部事項から", async () => {
    files.set("b.pdf", Buffer.from(OWNER_TABLE));
    files.set("a.pdf", Buffer.from(FULL));
    findMany.mockResolvedValue([att("b", "owner", "2026-10-02T00:00:00Z"), att("a", "all", "2026-09-01T00:00:00Z")]);
    const r = await loadCrosscheckRegistry("p", opts);
    if (r.status !== "ok") throw new Error("not ok");
    expect(r.owners?.attachmentCreatedAt).toBe("2026-10-02T00:00:00.000Z");
    expect(r.rights?.attachmentCreatedAt).toBe("2026-09-01T00:00:00.000Z");
  });
  it("所有者の表が読めない所有者事項は confirmed=false(古い謄本の名義で比べない)", async () => {
    files.set("b.pdf", Buffer.from("文字だけ"));
    files.set("a.pdf", Buffer.from(FULL));
    findMany.mockResolvedValue([att("b", "owner", "2026-10-02T00:00:00Z"), att("a", "all", "2026-09-01T00:00:00Z")]);
    const r = await loadCrosscheckRegistry("p", opts);
    if (r.status !== "ok") throw new Error("not ok");
    expect(r.owners).toMatchObject({ confirmed: false, list: [] });
  });
  it("全部事項と分かっている添付が読めない=担保は確認できない", async () => {
    findMany.mockResolvedValue([att("a", "all", "2026-10-01T00:00:00Z")]);
    const r = await loadCrosscheckRegistry("p", opts);
    expect(r).toMatchObject({ status: "ok", rights: { readable: false }, owners: { confirmed: false } });
  });
  it("種別が空で読めない添付だけ=unreadable", async () => {
    findMany.mockResolvedValue([att("a", null, "2026-10-01T00:00:00Z")]);
    expect(await loadCrosscheckRegistry("p", opts)).toEqual({ status: "unreadable" });
  });
  it("権限が無い人のときは氏名を持たない", async () => {
    files.set("a.pdf", Buffer.from(FULL));
    findMany.mockResolvedValue([att("a", "all", "2026-10-01T00:00:00Z")]);
    const r = await loadCrosscheckRegistry("p", { kindBase: "unit", includeOwners: false });
    expect(JSON.stringify(r)).not.toContain("架空太郎");
  });
  it("戸建: 土地と建物が別の謄本なら両方読み、古いほうの日付を返す", async () => {
    files.set("n.pdf", Buffer.from(FULL));
    files.set("o.pdf", Buffer.from(FULL));
    parseRegistryText
      .mockReturnValueOnce({ landAreaRegistry: null, buildingFloorArea: "91.05" })
      .mockReturnValueOnce({ landAreaRegistry: "120.50", buildingFloorArea: null });
    findMany.mockResolvedValue([att("n", "all", "2026-10-02T00:00:00Z"), att("o", "all", "2026-09-01T00:00:00Z")]);
    const r = await loadCrosscheckRegistry("p", { kindBase: "house", includeOwners: false });
    expect(r).toMatchObject({ areas: { land: "120.50", building: "91.05", attachmentCreatedAt: "2026-09-01T00:00:00.000Z" } });
  });
});
