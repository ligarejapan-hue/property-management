import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
const auditMock = vi.fn();
vi.mock("@/lib/audit", () => ({ writeAuditLog: (...a: unknown[]) => auditMock(...a) }));

import { applyBuildingLink, writeBuildingLinkAudit, finalBuildingFields } from "@/lib/building-link/apply";
import { AUTO_CHOICE } from "@/lib/building-link/resolve";
import { buildingNameKey } from "@/lib/building-identity";
import { createFakeBuildingTx, type FakeDb } from "./fake-building-tx";

const ADDR = "東京都大田区南雪谷１丁目１６４－２－４５";
// 比べる形は Task 1 の実装から取る(長音「ー」も「-」へ寄せるので、手書きの文字列にしない)。
const KEY = buildingNameKey("パークハウス第一");
let db: FakeDb;
beforeEach(() => {
  db = { buildings: [], properties: [{ id: "p1", buildingId: null, buildingName: "パークハウス第１" }], executed: [] };
  auditMock.mockReset();
});
const input = (over: Partial<Parameters<typeof applyBuildingLink>[1]> = {}) => ({
  propertyId: "p1",
  propertyType: "apartment_unit",
  buildingName: "パークハウス第１",
  address: ADDR,
  buildingNumber: "１６４－２－４５",
  choice: AUTO_CHOICE,
  currentBuildingId: null,
  userId: "u1",
  ...over,
});

describe("applyBuildingLink", () => {
  it("候補が無ければ棟を作り、住所は部屋の部分を除き、key を入れてつなぐ", async () => {
    const out = await applyBuildingLink(createFakeBuildingTx(db), input());
    expect(out.action).toBe("created");
    expect(db.buildings).toHaveLength(1);
    expect(db.buildings[0]).toMatchObject({
      name: "パークハウス第１",
      address: "東京都大田区南雪谷１丁目１６４－２",
      nameKey: KEY,
      areaKey: "東京都大田区南雪谷1丁目",
      createdBy: "u1",
    });
    expect(db.properties[0].buildingId).toBe(db.buildings[0].id);
  });

  it("同じ町丁目の表記違いの棟があればつなぎ、物件名を棟の表記にそろえる", async () => {
    db.buildings.push({ id: "b1", name: "パークハウス第一", address: "x", nameKey: KEY, areaKey: "東京都大田区南雪谷1丁目", createdAt: new Date("2026-01-01"), createdBy: "u0" });
    const out = await applyBuildingLink(createFakeBuildingTx(db), input());
    expect(out).toMatchObject({ action: "linked", building: { id: "b1", name: "パークハウス第一" }, renamedFrom: "パークハウス第１" });
    expect(db.properties[0]).toMatchObject({ buildingId: "b1", buildingName: "パークハウス第一" });
  });

  it("key が null の古い棟も、その場で計算して見つけ、key を埋める(SKIP LOCKED)", async () => {
    db.buildings.push({ id: "old", name: "パークハウス第一", address: "東京都大田区南雪谷1丁目164-2", nameKey: null, areaKey: null, createdAt: new Date("2025-01-01"), createdBy: "u0" });
    const out = await applyBuildingLink(createFakeBuildingTx(db), input());
    expect(out).toMatchObject({ action: "linked", building: { id: "old" } });
    expect(db.executed.some((sql) => /FOR UPDATE SKIP LOCKED/.test(sql))).toBe(true);
    expect(db.buildings[0]).toMatchObject({ nameKey: KEY, areaKey: "東京都大田区南雪谷1丁目" });
  });

  it("順番待ちのロックを $executeRaw で取る", async () => {
    await applyBuildingLink(createFakeBuildingTx(db), input());
    expect(db.executed.some((sql) => /pg_advisory_xact_lock\(hashtext\(.*\)::bigint\)/.test(sql))).toBe(true);
  });

  it("物件名を空にしたら棟から外す", async () => {
    db.properties[0] = { id: "p1", buildingId: "b1", buildingName: null };
    const out = await applyBuildingLink(createFakeBuildingTx(db), input({ buildingName: null, currentBuildingId: "b1" }));
    expect(out).toMatchObject({ action: "unlinked", previousBuildingId: "b1" });
    expect(db.properties[0].buildingId).toBeNull();
  });

  it("棟につながっていない土地は何もしない(DB を触らない)", async () => {
    const tx = createFakeBuildingTx(db);
    const out = await applyBuildingLink(tx, input({ propertyType: "land", buildingName: null }));
    expect(out.action).toBe("none");
    expect(db.executed).toHaveLength(0);
  });

  it("選んだ棟が消えていたら 409", async () => {
    await expect(
      applyBuildingLink(createFakeBuildingTx(db), input({ choice: { kind: "existing", buildingId: "gone" } })),
    ).rejects.toMatchObject({ status: 409, code: "BUILDING_NOT_FOUND" });
  });

  it("同じ棟のまま・名前も同じなら kept で物件を更新しない", async () => {
    db.buildings.push({ id: "b1", name: "パークハウス第１", address: "x", nameKey: KEY, areaKey: "東京都大田区南雪谷1丁目", createdAt: new Date(), createdBy: "u0" });
    db.properties[0] = { id: "p1", buildingId: "b1", buildingName: "パークハウス第１" };
    const tx = createFakeBuildingTx(db);
    const out = await applyBuildingLink(tx, input({ currentBuildingId: "b1" }));
    expect(out).toMatchObject({ action: "kept", renamedFrom: null });
    expect(tx.property.update).not.toHaveBeenCalled();
  });
});

describe("writeBuildingLinkAudit", () => {
  it("作ったときは棟の作成とつないだことの2本。住所を入れない", async () => {
    await writeBuildingLinkAudit("u1", "p1", {
      action: "created", building: { id: "b1", name: "n" }, previousBuildingId: null, renamedFrom: null, warnings: [],
    });
    expect(auditMock.mock.calls.map((c) => (c[0] as { action: string }).action)).toEqual([
      "building.auto_create",
      "property.building_link",
    ]);
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain("南雪谷");
  });
  it("取込から作ったときは棟の作成に取込の id を入れる(取り消しで消す目印。id だけ・住所なし)", async () => {
    await writeBuildingLinkAudit(
      "u1", "p1",
      { action: "created", building: { id: "b1", name: "n" }, previousBuildingId: null, renamedFrom: null, warnings: [] },
      { importJobId: "job-9" },
    );
    expect(auditMock.mock.calls[0][0]).toMatchObject({
      action: "building.auto_create", targetId: "b1", detail: { propertyId: "p1", importJobId: "job-9" },
    });
    expect(Object.keys((auditMock.mock.calls[0][0] as { detail: object }).detail).sort()).toEqual(["importJobId", "propertyId"]);
  });
  it("取込でないときは importJobId を入れない", async () => {
    await writeBuildingLinkAudit("u1", "p1", {
      action: "created", building: { id: "b1", name: "n" }, previousBuildingId: null, renamedFrom: null, warnings: [],
    });
    expect((auditMock.mock.calls[0][0] as { detail: object }).detail).toEqual({ propertyId: "p1" });
  });
  it("前の棟があれば relink", async () => {
    await writeBuildingLinkAudit("u1", "p1", {
      action: "linked", building: { id: "b2", name: "n" }, previousBuildingId: "b1", renamedFrom: null, warnings: [],
    });
    expect(auditMock.mock.calls[0][0]).toMatchObject({ action: "property.building_relink" });
  });
  it("none と kept は書かない", async () => {
    await writeBuildingLinkAudit("u1", "p1", { action: "none", building: null, previousBuildingId: null, renamedFrom: null, warnings: [] });
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("finalBuildingFields", () => {
  it("つないだら棟の名前、外したら保存した名前と null、none は buildingId を変えない", () => {
    expect(finalBuildingFields({ action: "linked", building: { id: "b", name: "正" }, previousBuildingId: null, renamedFrom: "入", warnings: [] }, "入"))
      .toEqual({ buildingId: "b", buildingName: "正" });
    expect(finalBuildingFields({ action: "unlinked", building: null, previousBuildingId: "b", renamedFrom: null, warnings: [] }, null))
      .toEqual({ buildingId: null, buildingName: null });
    expect(finalBuildingFields({ action: "none", building: null, previousBuildingId: null, renamedFrom: null, warnings: [] }, "x"))
      .toEqual({ buildingId: undefined, buildingName: "x" });
  });
});
