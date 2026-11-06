/**
 * 登記状況の自動の「取得済」(2026-11-06 発注者)。
 *   - 上げてよいのは「未取得」からだけ(取得中=謄本の取得の鍵・取得済=何もしない)
 *   - 変更履歴に「自動」で残す・物件の版は上げない
 *   - 失敗しても呼び出し側(添付)を止めない
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { db } = vi.hoisted(() => ({ db: {} as Record<string, unknown> }));
vi.mock("@/lib/prisma", () => ({ default: db }));
// 本物はセッション周りまで読み込む(node では解決できない)。ロックは $queryRaw を1回呼ぶだけの形で写す。
vi.mock("@/lib/property-record-guard", () => ({
  lockPropertyRow: vi.fn(async (tx: { $queryRaw: () => Promise<unknown> }) => { await tx.$queryRaw(); }),
}));

import {
  autoMarkRegistryObtained,
  autoMarkRegistryObtainedBestEffort,
  canAutoMarkRegistryObtained,
  logRegistryObtainedByFetch,
} from "@/lib/registry-status-auto";

function fakeTx(status: string | null, updated = 1) {
  return {
    property: {
      findUnique: vi.fn(async () => (status === null ? null : { registryStatus: status })),
      updateMany: vi.fn(async () => ({ count: updated })),
    },
    changeLog: { create: vi.fn(async () => ({})) },
  };
}

describe("canAutoMarkRegistryObtained", () => {
  it("未取得からだけ上げる", () => {
    expect(canAutoMarkRegistryObtained("unconfirmed")).toBe(true);
    // ⚠取得中は謄本の取得の鍵を兼ねる=外すと二重課金の隙ができる
    expect(canAutoMarkRegistryObtained("scheduled")).toBe(false);
    expect(canAutoMarkRegistryObtained("obtained")).toBe(false);
  });
});

describe("autoMarkRegistryObtained", () => {
  it("★未取得→取得済にして、変更履歴に自動で残す(版は上げない)", async () => {
    const tx = fakeTx("unconfirmed");
    expect(await autoMarkRegistryObtained(tx, { propertyId: "p-1", changedBy: "u-1" })).toBe(true);
    expect(tx.property.updateMany).toHaveBeenCalledWith({
      where: { id: "p-1", registryStatus: "unconfirmed" },
      data: { registryStatus: "obtained" },
    });
    expect(tx.changeLog.create).toHaveBeenCalledWith({
      data: {
        targetTable: "properties", targetId: "p-1", fieldName: "registryStatus",
        oldValue: "unconfirmed", newValue: "obtained", source: "auto", changedBy: "u-1",
      },
    });
  });

  it("★取得済なら何もしない(下げない・履歴も残さない)", async () => {
    const tx = fakeTx("obtained");
    expect(await autoMarkRegistryObtained(tx, { propertyId: "p-1", changedBy: "u-1" })).toBe(false);
    expect(tx.property.updateMany).not.toHaveBeenCalled();
    expect(tx.changeLog.create).not.toHaveBeenCalled();
  });

  it("★取得中(取得の鍵)は変えない", async () => {
    const tx = fakeTx("scheduled");
    expect(await autoMarkRegistryObtained(tx, { propertyId: "p-1", changedBy: "u-1" })).toBe(false);
    expect(tx.property.updateMany).not.toHaveBeenCalled();
  });

  it("間に人が変えていたら(条件付きの更新が0件)履歴を残さない", async () => {
    const tx = fakeTx("unconfirmed", 0);
    expect(await autoMarkRegistryObtained(tx, { propertyId: "p-1", changedBy: "u-1" })).toBe(false);
    expect(tx.changeLog.create).not.toHaveBeenCalled();
  });

  it("物件が無ければ何もしない", async () => {
    const tx = fakeTx(null);
    expect(await autoMarkRegistryObtained(tx, { propertyId: "p-1", changedBy: "u-1" })).toBe(false);
  });
});

describe("autoMarkRegistryObtainedBestEffort", () => {
  beforeEach(() => {
    for (const k of Object.keys(db)) delete db[k];
  });

  it("物件の行をロックしてから上げる", async () => {
    const tx = { ...fakeTx("unconfirmed"), $queryRaw: vi.fn(async () => [{ id: "p-1" }]) };
    db.$transaction = vi.fn(async (fn: (t: unknown) => unknown) => fn(tx));
    expect(await autoMarkRegistryObtainedBestEffort({ propertyId: "p-1", changedBy: "u-1" })).toBe(true);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.property.findUnique.mock.invocationCallOrder[0]);
  });

  it("失敗しても投げない(添付そのものは成功のまま)", async () => {
    db.$transaction = vi.fn(async () => { throw new Error("db down"); });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(autoMarkRegistryObtainedBestEffort({ propertyId: "p-1", changedBy: "u-1" })).resolves.toBe(false);
    err.mockRestore();
  });
});

describe("logRegistryObtainedByFetch(登記取得の成功)", () => {
  beforeEach(() => {
    for (const k of Object.keys(db)) delete db[k];
    db.changeLog = { create: vi.fn(async () => ({})) };
  });

  it("★取得前が取得済でなければ、履歴に自動で残す(古い値=取得の前の値)", async () => {
    await logRegistryObtainedByFetch({ propertyId: "p-1", previousStatus: "unconfirmed", changedBy: "u-1" });
    expect((db.changeLog as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledWith({
      data: {
        targetTable: "properties", targetId: "p-1", fieldName: "registryStatus",
        oldValue: "unconfirmed", newValue: "obtained", source: "auto", changedBy: "u-1",
      },
    });
  });

  it("取得前から取得済なら残さない", async () => {
    await logRegistryObtainedByFetch({ propertyId: "p-1", previousStatus: "obtained", changedBy: "u-1" });
    expect((db.changeLog as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
  });

  it("書けなくても投げない(課金後の成功を失敗にしない)", async () => {
    (db.changeLog as { create: ReturnType<typeof vi.fn> }).create.mockRejectedValueOnce(new Error("x"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(logRegistryObtainedByFetch({ propertyId: "p-1", previousStatus: "unconfirmed", changedBy: "u-1" })).resolves.toBeUndefined();
    err.mockRestore();
  });
});
