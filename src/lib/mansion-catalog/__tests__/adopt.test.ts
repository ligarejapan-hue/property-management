import { describe, it, expect, vi } from "vitest";
import { adoptCatalogBuilding, fillEmptyFromCatalog, catalogFillValues, type AdoptTx, type CatalogEntry } from "@/lib/mansion-catalog/adopt";
import { buildingLinkLockKey } from "@/lib/building-link/resolve";

const C: CatalogEntry = {
  id: "c1", name: "プラウド青砥", address: "東京都葛飾区青戸4丁目2番14号", builtYear: 2026, builtMonth: 9,
  totalFloors: 14, basementFloors: null, totalUnits: 155, structureType: "RC（鉄筋コンクリート）",
  managementCompany: "野村不動産パートナーズ", nameKey: "プラウド青砥", areaKey: "東京都葛飾区青戸4丁目",
};
type B = { id: string; name: string; address: string; nameKey: string | null; areaKey: string | null; catalogId: string | null; createdBy: string } & Record<string, unknown>;

function fakeTx(buildings: B[], catalog: CatalogEntry[] = [C], lock?: (k: string) => Promise<void>) {
  let seq = 0;
  const audits: unknown[] = [];
  const changes: unknown[] = [];
  const tx = {
    changeLog: { createMany: vi.fn(async ({ data }: { data: unknown[] }) => { changes.push(...data); return { count: data.length }; }) },
    $executeRaw: vi.fn(async (_s: TemplateStringsArray, ...v: unknown[]) => { if (lock) await lock(String(v[0])); return 0; }),
    mansionCatalog: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => catalog.find((c) => c.id === where.id) ?? null) },
    building: {
      findFirst: vi.fn(async ({ where }: { where: { catalogId: string } }) => buildings.find((b) => b.catalogId === where.catalogId) ?? null),
      findMany: vi.fn(async ({ where }: { where: { areaKey: string; nameKey: string } }) =>
        buildings.filter((b) => b.areaKey === where.areaKey && b.nameKey === where.nameKey)),
      create: vi.fn(async ({ data }: { data: Omit<B, "id"> }) => {
        if (data.catalogId && buildings.some((b) => b.catalogId === data.catalogId)) throw new Error("unique catalog_id");
        const b = { id: `new-${++seq}`, ...data } as B;
        buildings.push(b);
        return { id: b.id, name: b.name };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<B> }) => {
        const b = buildings.find((x) => x.id === where.id)!;
        const { version, ...rest } = data as Partial<B> & { version?: { increment: number } };
        Object.assign(b, rest);
        if (version) b.version = ((b.version as number | undefined) ?? 1) + version.increment;
        return { id: b.id, name: b.name };
      }),
    },
    auditLog: { create: vi.fn(async ({ data }: { data: unknown }) => { audits.push(data); return { id: "a" }; }) },
  };
  return { tx: tx as unknown as AdoptTx, audits, buildings, changes };
}

describe("fillEmptyFromCatalog", () => {
  it("空いている欄だけ。手で入れた値は変えない", () => {
    expect(fillEmptyFromCatalog({ builtYear: 1990, totalFloors: null, totalUnits: undefined }, C)).toEqual({
      builtMonth: 9, totalFloors: 14, totalUnits: 155, structureType: "RC（鉄筋コンクリート）", managementCompany: "野村不動産パートナーズ",
    });
    expect(catalogFillValues(C)).not.toHaveProperty("basementFloors");
  });
});

describe("adoptCatalogBuilding", () => {
  it("名簿の建物が無ければ not_found", async () => {
    const f = fakeTx([], []);
    expect(await adoptCatalogBuilding(f.tx, "c1", "u1")).toEqual({ kind: "not_found" });
  });
  it("同じ鍵の棟が無ければ、名簿の値を入れて作る(catalog_id 付き・監査は id だけ)", async () => {
    const f = fakeTx([]);
    const r = await adoptCatalogBuilding(f.tx, "c1", "u1");
    expect(r).toMatchObject({ kind: "created" });
    expect(f.buildings[0]).toMatchObject({ name: "プラウド青砥", address: C.address, catalogId: "c1", totalFloors: 14, totalUnits: 155, nameKey: C.nameKey, areaKey: C.areaKey, createdBy: "u1" });
    expect(f.audits).toEqual([{ userId: "u1", action: "building.catalog_adopt", targetTable: "buildings", targetId: f.buildings[0].id, detail: { catalogId: "c1", kind: "created" } }]);
  });
  it("ロックの鍵は物件の保存と同じ", async () => {
    const f = fakeTx([]);
    await adoptCatalogBuilding(f.tx, "c1", "u1");
    expect((f.tx.$executeRaw as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1]).toBe(buildingLinkLockKey(C.areaKey, C.nameKey!));
  });
  it("もう棟になっていれば、その棟を返す(何も変えない)", async () => {
    const f = fakeTx([{ id: "b1", name: "プラウド青砥", address: "x", nameKey: "z", areaKey: "z", catalogId: "c1", createdBy: "u0" }]);
    expect(await adoptCatalogBuilding(f.tx, "c1", "u1")).toEqual({ kind: "existing", building: { id: "b1", name: "プラウド青砥" } });
    expect(f.audits).toEqual([]);
  });
  it("同じ鍵の自社の棟が1つなら、つないで空いている欄だけ埋める", async () => {
    const f = fakeTx([{ id: "b1", name: "プラウド青砥", address: "x", nameKey: C.nameKey, areaKey: C.areaKey, catalogId: null, createdBy: "u0", builtYear: 2025, totalFloors: null }]);
    expect(await adoptCatalogBuilding(f.tx, "c1", "u1")).toMatchObject({ kind: "linked", building: { id: "b1" } });
    expect(f.buildings[0]).toMatchObject({ catalogId: "c1", builtYear: 2025, totalFloors: 14 });
  });
  it("★つないで埋めたら版番号を進め(開いたままの編集画面で消されない)、埋めた欄を履歴と監査に残す", async () => {
    const f = fakeTx([{ id: "b1", name: "プラウド青砥", address: "x", nameKey: C.nameKey, areaKey: C.areaKey, catalogId: null, createdBy: "u0", version: 3, builtYear: 2025, totalFloors: null }]);
    await adoptCatalogBuilding(f.tx, "c1", "u1");
    expect(f.buildings[0].version).toBe(4);
    expect(f.changes).toContainEqual(expect.objectContaining({ targetTable: "buildings", targetId: "b1", fieldName: "totalFloors", oldValue: null, newValue: "14", changedBy: "u1" }));
    expect(f.changes).not.toContainEqual(expect.objectContaining({ fieldName: "builtYear" }));
    expect(f.audits[0]).toMatchObject({ detail: { catalogId: "c1", kind: "linked", filled: expect.arrayContaining(["totalFloors", "totalUnits"]) } });
  });
  it("★人のいない後処理(userId なし)でも版番号を進め、監査に埋めた欄を残す(履歴は人が要るので書かない)", async () => {
    const f = fakeTx([{ id: "b1", name: "プラウド青砥", address: "x", nameKey: C.nameKey, areaKey: C.areaKey, catalogId: null, createdBy: "u0", version: 1 }]);
    expect(await adoptCatalogBuilding(f.tx, "c1", null, { create: false })).toMatchObject({ kind: "linked" });
    expect(f.buildings[0].version).toBe(2);
    expect(f.changes).toEqual([]);
    expect(f.audits[0]).toMatchObject({ userId: null, detail: { kind: "linked" } });
  });
  it("★同じ鍵の棟が2つ・または別の名簿の建物につながった棟なら ambiguous(どれにも付けない・作らない)", async () => {
    const two = fakeTx([
      { id: "b1", name: "a", address: "x", nameKey: C.nameKey, areaKey: C.areaKey, catalogId: null, createdBy: "u0" },
      { id: "b2", name: "b", address: "x", nameKey: C.nameKey, areaKey: C.areaKey, catalogId: null, createdBy: "u0" },
    ]);
    expect(await adoptCatalogBuilding(two.tx, "c1", "u1")).toEqual({ kind: "ambiguous" });
    const other = fakeTx([{ id: "b1", name: "a", address: "x", nameKey: C.nameKey, areaKey: C.areaKey, catalogId: "c9", createdBy: "u0" }]);
    expect(await adoptCatalogBuilding(other.tx, "c1", "u1")).toEqual({ kind: "ambiguous" });
    expect(two.buildings).toHaveLength(2);
  });
  it("create:false のときは作らず none", async () => {
    const f = fakeTx([]);
    expect(await adoptCatalogBuilding(f.tx, "c1", null, { create: false })).toEqual({ kind: "none" });
    expect(f.buildings).toHaveLength(0);
  });
  it("★同時に2回呼ばれても棟は1つ(ロックはトランザクションの終わりまで続く=順番に並べて写す)", async () => {
    const buildings: B[] = [];
    const a = fakeTx(buildings);
    const run = serialLock();
    const rs = await Promise.all([run(() => adoptCatalogBuilding(a.tx, "c1", "u1")), run(() => adoptCatalogBuilding(a.tx, "c1", "u2"))]);
    expect(buildings).toHaveLength(1);
    expect(rs.map((r) => r.kind)).toEqual(["created", "existing"]);
  });
});

/** 本物のアドバイザリロックは tx の終わりまで続く。後から来た呼び出しは、前の呼び出しが終わるまで待つ。 */
function serialLock() {
  let tail = Promise.resolve();
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = tail;
    let release!: () => void;
    tail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
