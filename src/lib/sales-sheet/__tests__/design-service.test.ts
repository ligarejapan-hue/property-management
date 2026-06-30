import { describe, it, expect, vi, type Mock } from "vitest";
import { sampleDocument } from "../__fixtures__/sample-document";

// NOTE: We do NOT mock @/lib/prisma globally here.
// design-service accepts an optional `db` parameter for dependency injection.
// We pass minimal fake DB objects directly to each function under test.

import {
  createDesign,
  getDesign,
  listDesigns,
  updateDesign,
  deleteDesign,
  type SaveDesignInput,
} from "../design-service";
import type { PrismaClient } from "@/generated/prisma";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake db implementing only salesSheetDesign methods we call. */
function makeDb(overrides?: Partial<{
  create: Mock;
  findUnique: Mock;
  findMany: Mock;
  update: Mock;
  updateMany: Mock;
  delete: Mock;
  deleteMany: Mock;
}>) {
  return {
    salesSheetDesign: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      ...overrides,
    },
  } as unknown as PrismaClient;
}

const NOW = new Date("2026-06-28T00:00:00.000Z");

const storedDesign = {
  id: "sheet1",
  propertyId: "prop1",
  title: "テスト販売図面",
  document: sampleDocument,
  templateId: null,
  thumbnailUrl: null,
  createdBy: "user1",
  updatedBy: "user1",
  createdAt: NOW,
  updatedAt: NOW,
};

const validInput: SaveDesignInput = {
  propertyId: "prop1",
  title: "テスト販売図面",
  document: sampleDocument,
  userId: "user1",
};

const invalidDocument = { bad: "data" };

// ---------------------------------------------------------------------------
// createDesign
// ---------------------------------------------------------------------------

describe("createDesign", () => {
  it("有効な document を検証して保存し、作成結果を返す", async () => {
    const db = makeDb({ create: vi.fn().mockResolvedValue(storedDesign) });
    const result = await createDesign(validInput, db);
    expect(result).toEqual(storedDesign);
    expect(db.salesSheetDesign.create).toHaveBeenCalledOnce();
    const createCall = (db.salesSheetDesign.create as Mock).mock.calls[0][0];
    expect(createCall.data.propertyId).toBe("prop1");
    expect(createCall.data.createdBy).toBe("user1");
    expect(createCall.data.updatedBy).toBe("user1");
  });

  it("title が省略された場合はデフォルトタイトルを使う", async () => {
    const db = makeDb({ create: vi.fn().mockResolvedValue({ ...storedDesign, title: "無題の販売図面" }) });
    await createDesign({ ...validInput, title: undefined }, db);
    const data = (db.salesSheetDesign.create as Mock).mock.calls[0][0].data;
    expect(data.title).toBe("無題の販売図面");
  });

  it("空文字の title はデフォルトタイトルになる", async () => {
    const db = makeDb({ create: vi.fn().mockResolvedValue({ ...storedDesign, title: "無題の販売図面" }) });
    await createDesign({ ...validInput, title: "  " }, db);
    const data = (db.salesSheetDesign.create as Mock).mock.calls[0][0].data;
    expect(data.title).toBe("無題の販売図面");
  });

  it("不正な document は ZodError を throw し、DB は呼ばれない", async () => {
    const db = makeDb({ create: vi.fn() });
    await expect(createDesign({ ...validInput, document: invalidDocument }, db)).rejects.toThrow();
    expect(db.salesSheetDesign.create).not.toHaveBeenCalled();
  });

  it("大きすぎる data: 埋め込み画像は拒否し、DB は呼ばれない（保存はリンク参照のみ・data:化は出力時）", async () => {
    const db = makeDb({ create: vi.fn() });
    const bigDataDoc = {
      ...sampleDocument,
      elements: sampleDocument.elements.map((el) =>
        el.id === "photo1" ? { ...el, src: "data:image/png;base64," + "A".repeat(9000) } : el,
      ),
    };
    await expect(createDesign({ ...validInput, document: bigDataDoc }, db)).rejects.toThrow();
    expect(db.salesSheetDesign.create).not.toHaveBeenCalled();
  });

  it("文書全体が大きすぎる場合は拒否し、DB は呼ばれない（DB 肥大化防止）", async () => {
    const db = makeDb({ create: vi.fn() });
    const hugeDoc = {
      ...sampleDocument,
      elements: sampleDocument.elements.map((el) =>
        el.id === "title" && el.type === "text" ? { ...el, content: "あ".repeat(600000) } : el,
      ),
    };
    await expect(createDesign({ ...validInput, document: hugeDoc }, db)).rejects.toThrow();
    expect(db.salesSheetDesign.create).not.toHaveBeenCalled();
  });

  it("qr.dataUrl が大きすぎる場合も拒否（image だけでなく qr も上限対象）", async () => {
    const db = makeDb({ create: vi.fn() });
    const qrDoc = {
      ...sampleDocument,
      elements: [
        ...sampleDocument.elements,
        { id: "qr1", type: "qr", x: 0, y: 0, w: 20, h: 20, z: 5, dataUrl: "data:image/png;base64," + "A".repeat(9000) },
      ],
    };
    await expect(createDesign({ ...validInput, document: qrDoc }, db)).rejects.toThrow();
    expect(db.salesSheetDesign.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getDesign
// ---------------------------------------------------------------------------

describe("getDesign", () => {
  it("正しい propertyId で自物件の design を返す", async () => {
    const db = makeDb({ findUnique: vi.fn().mockResolvedValue(storedDesign) });
    const result = await getDesign("prop1", "sheet1", db);
    expect(result).toEqual(storedDesign);
  });

  it("他物件の design は null を返す（propertyId スコープ）", async () => {
    // DB に存在するが propertyId が異なる
    const db = makeDb({ findUnique: vi.fn().mockResolvedValue({ ...storedDesign, propertyId: "OTHER_PROP" }) });
    const result = await getDesign("prop1", "sheet1", db);
    expect(result).toBeNull();
  });

  it("design が存在しない場合は null を返す", async () => {
    const db = makeDb({ findUnique: vi.fn().mockResolvedValue(null) });
    const result = await getDesign("prop1", "no-such-sheet", db);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listDesigns
// ---------------------------------------------------------------------------

describe("listDesigns", () => {
  it("指定 propertyId の design 一覧を返す", async () => {
    const summaries = [
      { id: "s1", title: "図面A", updatedAt: NOW, createdAt: NOW, thumbnailUrl: null },
      { id: "s2", title: "図面B", updatedAt: NOW, createdAt: NOW, thumbnailUrl: null },
    ];
    const db = makeDb({ findMany: vi.fn().mockResolvedValue(summaries) });
    const result = await listDesigns("prop1", db);
    expect(result).toEqual(summaries);
    const call = (db.salesSheetDesign.findMany as Mock).mock.calls[0][0];
    expect(call.where).toEqual({ propertyId: "prop1" });
    expect(call.orderBy).toEqual({ updatedAt: "desc" });
  });
});

// ---------------------------------------------------------------------------
// updateDesign
// ---------------------------------------------------------------------------

describe("updateDesign", () => {
  it("updatedAt が一致する場合は更新成功を返す", async () => {
    const updated = { ...storedDesign, title: "新タイトル", updatedBy: "user2" };
    const db = makeDb({
      // findUnique is called twice: once inside getDesign, once for post-write re-read
      findUnique: vi.fn()
        .mockResolvedValueOnce(storedDesign) // getDesign
        .mockResolvedValueOnce(updated),     // post-write re-read
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    });
    const result = await updateDesign(
      "prop1", "sheet1",
      { title: "新タイトル", expectedUpdatedAt: NOW },
      "user2",
      db,
    );
    expect(result).toEqual({ ok: true, design: updated });
    expect(db.salesSheetDesign.updateMany).toHaveBeenCalledOnce();
  });

  it("updatedAt が不一致の場合は conflict を返す（楽観ロック）", async () => {
    // updateMany returns count=0 because the stale timestamp doesn't match the DB row
    const db = makeDb({
      findUnique: vi.fn().mockResolvedValue(storedDesign),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    });
    const staleDate = new Date("2026-01-01T00:00:00.000Z");
    const result = await updateDesign(
      "prop1", "sheet1",
      { title: "新タイトル", expectedUpdatedAt: staleDate },
      "user1",
      db,
    );
    expect(result).toEqual({ ok: false, reason: "conflict" });
    // conflict is now driven by the atomic updateMany result, not a pre-read compare
    expect(db.salesSheetDesign.updateMany).toHaveBeenCalledOnce();
  });

  it("同時書き込み競合: updateMany が count:0 を返す場合 conflict を返す（アトミックガード）", async () => {
    // Scenario: timestamps match at read-time, but a concurrent writer commits between
    // our read and our write. The DB-side WHERE on updatedAt catches the race.
    const db = makeDb({
      findUnique: vi.fn().mockResolvedValue(storedDesign), // read succeeds (timestamps match)
      updateMany: vi.fn().mockResolvedValue({ count: 0 }), // concurrent writer already wrote
    });
    const result = await updateDesign(
      "prop1", "sheet1",
      { title: "新タイトル", expectedUpdatedAt: NOW },
      "user2",
      db,
    );
    expect(result).toEqual({ ok: false, reason: "conflict" });
    // Assert the write predicate included updatedAt — that is the atomic guard
    const whereArg = (db.salesSheetDesign.updateMany as Mock).mock.calls[0][0].where;
    expect(whereArg).toMatchObject({ id: "sheet1", propertyId: "prop1", updatedAt: NOW });
    // No post-write re-read on conflict
    expect(db.salesSheetDesign.findUnique).toHaveBeenCalledTimes(1); // only the getDesign read
  });

  it("design が存在しない場合は not_found を返す", async () => {
    const db = makeDb({ findUnique: vi.fn().mockResolvedValue(null) });
    const result = await updateDesign(
      "prop1", "sheet1",
      { expectedUpdatedAt: NOW },
      "user1",
      db,
    );
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(db.salesSheetDesign.updateMany).not.toHaveBeenCalled();
  });

  it("他物件の design 更新は not_found を返す", async () => {
    const db = makeDb({ findUnique: vi.fn().mockResolvedValue({ ...storedDesign, propertyId: "OTHER_PROP" }) });
    const result = await updateDesign(
      "prop1", "sheet1",
      { expectedUpdatedAt: NOW },
      "user1",
      db,
    );
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(db.salesSheetDesign.updateMany).not.toHaveBeenCalled();
  });

  it("patch に不正な document が含まれる場合は ZodError を throw する", async () => {
    const db = makeDb({
      findUnique: vi.fn().mockResolvedValue(storedDesign),
      updateMany: vi.fn(),
    });
    await expect(
      updateDesign("prop1", "sheet1", { document: invalidDocument, expectedUpdatedAt: NOW }, "user1", db),
    ).rejects.toThrow();
    // parseSalesSheetDocument throws before the write — DB is untouched
    expect(db.salesSheetDesign.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deleteDesign
// ---------------------------------------------------------------------------

describe("deleteDesign", () => {
  it("存在する自物件の design を削除して true を返す（scope は deleteMany の WHERE で保証）", async () => {
    const db = makeDb({ deleteMany: vi.fn().mockResolvedValue({ count: 1 }) });
    const result = await deleteDesign("prop1", "sheet1", db);
    expect(result).toBe(true);
    const where = (db.salesSheetDesign.deleteMany as Mock).mock.calls[0][0].where;
    expect(where).toEqual({ id: "sheet1", propertyId: "prop1" });
  });

  it("他物件 / 存在しない design は count=0 → false（並行二重削除でも例外を投げない）", async () => {
    const db = makeDb({ deleteMany: vi.fn().mockResolvedValue({ count: 0 }) });
    const result = await deleteDesign("prop1", "sheet1", db);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// geometry 制限（保存境界の DoS ガード: page は A4 のみ・element は合理的範囲）
// ---------------------------------------------------------------------------

describe("保存境界の geometry 制限", () => {
  const a4Portrait = { width: 210, height: 297, orientation: "portrait" as const };
  const hugePage = { width: 100000, height: 100000, orientation: "landscape" as const };

  it("A4 portrait ページは保存できる", async () => {
    const db = makeDb({ create: vi.fn().mockResolvedValue(storedDesign) });
    const doc = { ...sampleDocument, page: a4Portrait };
    await expect(createDesign({ ...validInput, document: doc }, db)).resolves.toBeDefined();
    expect(db.salesSheetDesign.create).toHaveBeenCalledOnce();
  });

  it("A4 landscape の通常 document は保存できる（既存図面を壊さない）", async () => {
    const db = makeDb({ create: vi.fn().mockResolvedValue(storedDesign) });
    await expect(createDesign(validInput, db)).resolves.toBeDefined(); // sampleDocument は A4_LANDSCAPE
  });

  it("巨大ページは create で 422（DB 未呼出）", async () => {
    const db = makeDb({ create: vi.fn() });
    const doc = { ...sampleDocument, page: hugePage };
    await expect(createDesign({ ...validInput, document: doc }, db)).rejects.toThrow();
    expect(db.salesSheetDesign.create).not.toHaveBeenCalled();
  });

  it("巨大な要素サイズ（w/h）は create で 422（DB 未呼出）", async () => {
    const db = makeDb({ create: vi.fn() });
    const doc = {
      ...sampleDocument,
      elements: sampleDocument.elements.map((el) =>
        el.id === "title" ? { ...el, w: 1_000_000_000 } : el,
      ),
    };
    await expect(createDesign({ ...validInput, document: doc }, db)).rejects.toThrow();
    expect(db.salesSheetDesign.create).not.toHaveBeenCalled();
  });

  it("極端にページ外へ飛ぶ位置（x/y）は create で 422（DB 未呼出）", async () => {
    const db = makeDb({ create: vi.fn() });
    const doc = {
      ...sampleDocument,
      elements: sampleDocument.elements.map((el) =>
        el.id === "title" ? { ...el, x: 1_000_000_000 } : el,
      ),
    };
    await expect(createDesign({ ...validInput, document: doc }, db)).rejects.toThrow();
    expect(db.salesSheetDesign.create).not.toHaveBeenCalled();
  });

  it("巨大ページは update でも 422（DB 未呼出）", async () => {
    const db = makeDb({
      findUnique: vi.fn().mockResolvedValue(storedDesign),
      updateMany: vi.fn(),
    });
    const doc = { ...sampleDocument, page: hugePage };
    await expect(
      updateDesign("prop1", "sheet1", { document: doc, expectedUpdatedAt: NOW }, "user1", db),
    ).rejects.toThrow();
    expect(db.salesSheetDesign.updateMany).not.toHaveBeenCalled();
  });

  it("負の z を持つ要素は create で 422（API 直叩き対策・DB 未呼出）", async () => {
    // エディタの reducer は負 z を作らないが、POST/PUT 直叩きで z:-1 が来得る。
    // 負 z は export(render-html)で背景裏に隠れるため保存境界で弾く。
    const db = makeDb({ create: vi.fn() });
    const doc = {
      ...sampleDocument,
      elements: sampleDocument.elements.map((el) =>
        el.id === "title" ? { ...el, z: -1 } : el,
      ),
    };
    await expect(createDesign({ ...validInput, document: doc }, db)).rejects.toThrow();
    expect(db.salesSheetDesign.create).not.toHaveBeenCalled();
  });
});
