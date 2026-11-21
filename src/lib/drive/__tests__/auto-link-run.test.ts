/**
 * 自動の紐づけの本番の流れ(runAutoLink)。DB とドライブは偽物。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findMany: vi.fn() },
    propertyDriveFolder: { findMany: vi.fn(), create: vi.fn() },
    auditLog: { findMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { runAutoLink } from "../auto-link";

const db = prisma as unknown as {
  property: { findMany: Mock };
  propertyDriveFolder: { findMany: Mock; create: Mock };
  auditLog: { findMany: Mock };
};

function client(
  folders: { id: string; name: string; ownedByMe?: boolean }[],
  trashed = new Set<string>(),
  truncated = false,
) {
  const owned = (f: { ownedByMe?: boolean }) => f.ownedByMe !== false;
  return {
    listAllFolders: vi.fn(async () => ({ folders: folders.map((f) => ({ id: f.id, name: f.name, parents: ["x"], ownedByMe: owned(f) })), truncated })),
    getFolder: vi.fn(async (id: string) => {
      const f = folders.find((x) => x.id === id);
      return f ? { id, name: f.name, parents: ["x"], trashed: trashed.has(id), webViewLink: `https://drive/${id}`, ownedByMe: owned(f) } : null;
    }),
    folderPath: vi.fn(async (id: string) => `〇案件 › ${folders.find((x) => x.id === id)?.name}`),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.property.findMany.mockResolvedValue([
    { id: "p1", buildingName: "西荻リリエンハイム", roomNo: "407", address: "a" },
    { id: "p2", buildingName: "ハマイハイライズ", roomNo: "305", address: "b" },
  ]);
  db.propertyDriveFolder.findMany.mockResolvedValue([]);
  db.auditLog.findMany.mockResolvedValue([]);
  db.propertyDriveFolder.create.mockImplementation(async ({ data }: { data: { propertyId: string } }) => ({ id: `link-${data.propertyId}` }));
});

describe("runAutoLink", () => {
  it("合うフォルダを linked_by_id=null(自動の印)で紐づけ、監査には物件の id だけ", async () => {
    const r = await runAutoLink(client([{ id: "f1", name: "西荻リリエンハイム　407号室" }]));
    expect(r).toEqual({ linked: 1, planned: 1, truncated: false });
    expect(db.propertyDriveFolder.create).toHaveBeenCalledWith({
      data: {
        propertyId: "p1",
        folderId: "f1",
        folderName: "西荻リリエンハイム　407号室",
        folderPath: "〇案件 › 西荻リリエンハイム　407号室",
        webViewLink: "https://drive/f1",
        linkedById: null,
      },
      select: { id: true },
    });
    expect(writeAuditLog).toHaveBeenCalledWith({
      userId: null,
      action: "drive_folder_auto_link",
      targetTable: "property_drive_folders",
      targetId: "link-p1",
      detail: { propertyId: "p1" },
    });
  });

  it("紐づけを外したことのある物件は自動にしない(監査の記録から)", async () => {
    db.auditLog.findMany.mockResolvedValue([{ detail: { propertyId: "p1" } }]);
    const r = await runAutoLink(client([{ id: "f1", name: "西荻リリエンハイム 407" }]));
    expect(r.linked).toBe(0);
    expect(db.auditLog.findMany).toHaveBeenCalledWith({ where: { action: "drive_folder_unlink" }, select: { detail: true } });
    expect(db.propertyDriveFolder.create).not.toHaveBeenCalled();
  });

  it("ゴミ箱に入ったフォルダは飛ばす", async () => {
    const r = await runAutoLink(client([{ id: "f1", name: "西荻リリエンハイム 407" }], new Set(["f1"])));
    expect(r.linked).toBe(0);
    expect(db.propertyDriveFolder.create).not.toHaveBeenCalled();
  });

  it("その間に人が紐づけた(一意の鍵の重なり)ものは飛ばして続ける", async () => {
    db.propertyDriveFolder.create
      .mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }))
      .mockImplementationOnce(async () => ({ id: "link-p2" }));
    const r = await runAutoLink(client([{ id: "f1", name: "西荻リリエンハイム 407" }, { id: "f2", name: "ハマイハイライズ 305" }]));
    expect(r.linked).toBe(1);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });

  it("ほかの失敗は投げ直す", async () => {
    db.propertyDriveFolder.create.mockRejectedValueOnce(new Error("db down"));
    await expect(runAutoLink(client([{ id: "f1", name: "西荻リリエンハイム 407" }]))).rejects.toThrow("db down");
  });

  it("★持ち主が別のアカウントのフォルダ(共有されただけ)は自動にしない・同じ名前の自分のフォルダがあればそちら", async () => {
    const r1 = await runAutoLink(client([{ id: "f1", name: "西荻リリエンハイム 407", ownedByMe: false }]));
    expect(r1.linked).toBe(0);
    expect(db.propertyDriveFolder.create).not.toHaveBeenCalled();
    const r2 = await runAutoLink(client([{ id: "f1", name: "西荻リリエンハイム 407", ownedByMe: false }, { id: "f2", name: "西荻リリエンハイム 407号室" }]));
    expect(r2.linked).toBe(1);
    expect(db.propertyDriveFolder.create.mock.calls[0][0].data.folderId).toBe("f2");
  });

  it("★フォルダを全部読み切れなかった回は紐づけない(「合うフォルダが1つだけ」を確かめられない)", async () => {
    const r = await runAutoLink(client([{ id: "f1", name: "西荻リリエンハイム 407" }], new Set(), true));
    expect(r).toEqual({ linked: 0, planned: 0, truncated: true });
    expect(db.propertyDriveFolder.create).not.toHaveBeenCalled();
  });
});
