import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// 物件の変更履歴タブ (総点検 2026-07-27)。
//
// 関連レコードの ChangeLog は「その行の id」で記録される
// (property_owners → PropertyOwner.id / buildings → Building.id)。
// 旧実装は 3 テーブルすべてを propertyId で引いていたため、後 2 つは
// 構造的に常に 0 件で、所有者の続柄変更・主所有者切替・**紐づけ解除**・
// 棟情報の変更が履歴タブに一切出なかった (記録自体は残っている)。

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  getApiSession: vi.fn(),
  getUserPermissions: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) =>
    Response.json(body as object, { status }),
  ),
  handleApiError: vi.fn(
    (e: { status?: number; message?: string; code?: string }) =>
      Response.json(
        { error: { message: e?.message, code: e?.code } },
        { status: e?.status ?? 500 },
      ),
  ),
}));
const permOverride = { owner: true };
vi.mock("@/lib/permissions", () => ({
  hasPermission: (_p: unknown, resource: string) =>
    resource === "owner" ? permOverride.owner : true,
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    propertyOwner: { findMany: vi.fn() },
    property: { findUnique: vi.fn() },
    changeLog: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { GET } from "@/app/api/properties/[id]/change-logs/route";

const PROPERTY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_LINK_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const OWNER_LINK_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const BUILDING_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const req = new Request(
  `http://x/api/properties/${PROPERTY_ID}/change-logs`,
) as never;
const ctx = { params: Promise.resolve({ id: PROPERTY_ID }) };

/** 実行して findMany に渡された where.OR を取り出す。 */
async function runAndGetOr() {
  await GET(req, ctx);
  const arg = (prisma.changeLog.findMany as unknown as Mock).mock.calls[0][0];
  return arg.where.OR as Array<Record<string, unknown>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  permOverride.owner = true;
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  (prisma.changeLog.findMany as unknown as Mock).mockResolvedValue([]);
  (prisma.changeLog.count as unknown as Mock).mockResolvedValue(0);
  (prisma.changeLog.groupBy as unknown as Mock).mockResolvedValue([]);
  (prisma.propertyOwner.findMany as unknown as Mock).mockResolvedValue([]);
  (prisma.property.findUnique as unknown as Mock).mockResolvedValue({
    buildingId: null,
  });
});

describe("GET /api/properties/[id]/change-logs — 関連レコードの実 id で引く", () => {
  it("所有者リンクは PropertyOwner.id で検索する (propertyId ではない)", async () => {
    (prisma.propertyOwner.findMany as unknown as Mock).mockResolvedValue([
      { id: OWNER_LINK_1 },
      { id: OWNER_LINK_2 },
    ]);

    const or = await runAndGetOr();
    const ownerCond = or.find((c) => c.targetTable === "property_owners");
    expect(ownerCond).toBeDefined();
    expect(ownerCond?.targetId).toEqual({ in: [OWNER_LINK_1, OWNER_LINK_2] });
    // 旧実装の「propertyId で引く」= 常に0件 に戻っていないこと
    expect(ownerCond?.targetId).not.toBe(PROPERTY_ID);
  });

  it("棟は Building.id で検索する (propertyId ではない)", async () => {
    (prisma.property.findUnique as unknown as Mock).mockResolvedValue({
      buildingId: BUILDING_ID,
    });

    const or = await runAndGetOr();
    const buildingCond = or.find((c) => c.targetTable === "buildings");
    expect(buildingCond).toBeDefined();
    expect(buildingCond?.targetId).toBe(BUILDING_ID);
  });

  it("物件本体は従来どおり propertyId で引く", async () => {
    const or = await runAndGetOr();
    const propCond = or.find((c) => c.targetTable === "properties");
    expect(propCond?.targetId).toBe(PROPERTY_ID);
  });

  it("所有者リンクが無い / 棟に属さない物件は、その条件を積まない", async () => {
    const or = await runAndGetOr();
    expect(or.map((c) => c.targetTable)).toEqual(["properties"]);
  });

  it("⚠既知の制限: 紐づけ解除されたリンクの履歴は引けない (物理削除のため)", async () => {
    // PropertyOwner はソフトデリート列を持たず物理削除される。ChangeLog は
    // targetTable/targetId しか持たず propertyId を保持しないため、消えた
    // リンク id を物件から逆引きする手段が無い。したがって「解除イベント自体」
    // と「解除前にそのリンクへ行った続柄変更・主所有者切替」は表示できない。
    // 解決には ChangeLog へ propertyId を持たせる等のスキーマ変更が必要
    // (別タスク・要承認)。この仕様を明示的に固定しておき、将来対応したときに
    // このテストが落ちて気づけるようにする。
    (prisma.propertyOwner.findMany as unknown as Mock).mockResolvedValue([]);

    const or = await runAndGetOr();
    // 現存リンクが無い = property_owners 条件は積まれない(= 過去分も出ない)
    expect(or.some((c) => c.targetTable === "property_owners")).toBe(false);
    // 逆引きの材料が無いことの裏取り: 検索に使えるのは現存リンクのみ
    const ownerQuery = (prisma.propertyOwner.findMany as unknown as Mock).mock
      .calls[0][0];
    expect(ownerQuery.where).toEqual({ propertyId: PROPERTY_ID });
  });

  it("フィルタ選択肢 (groupBy) も一覧と同じ対象条件を使う", async () => {
    (prisma.propertyOwner.findMany as unknown as Mock).mockResolvedValue([
      { id: OWNER_LINK_1 },
    ]);
    (prisma.property.findUnique as unknown as Mock).mockResolvedValue({
      buildingId: BUILDING_ID,
    });

    await GET(req, ctx);
    const listOr = (prisma.changeLog.findMany as unknown as Mock).mock
      .calls[0][0].where.OR;
    const groupCalls = (prisma.changeLog.groupBy as unknown as Mock).mock.calls;
    expect(groupCalls.length).toBe(2);
    for (const [arg] of groupCalls) {
      // 片方だけ古い条件だと「履歴には出るのに絞り込みの選択肢に出ない」ズレが出る
      expect(arg.where.OR).toEqual(listOr);
    }
  });
});

describe("field_staff は担当外物件の履歴を読めない (@codex #330 R2)", () => {
  // この route は property:read しか見ておらず、担当外の物件 id を渡せば
  // 変更履歴が読めていた。関連レコード(所有者リンク/棟)まで引くようにした分だけ
  // 読める範囲が広がる(続柄・主所有者切替・棟情報)ため、関連を引く前に弾く。
  beforeEach(() => {
    (getApiSession as Mock).mockResolvedValue({ id: "staff1", role: "field_staff" });
  });

  it("createdBy / assignedTo のどちらでもなければ 403 で、関連レコードを引かない", async () => {
    (prisma.property.findUnique as unknown as Mock).mockResolvedValue({
      id: PROPERTY_ID,
      buildingId: BUILDING_ID,
      createdBy: "someone-else",
      assignedTo: "another",
    });

    const res = await GET(req, ctx);
    expect(res.status).toBe(403);
    // 弾く前に関連を引いてしまうと、担当外の所有者リンク id が DB から出てしまう
    expect(prisma.propertyOwner.findMany).not.toHaveBeenCalled();
    expect(prisma.changeLog.findMany).not.toHaveBeenCalled();
    expect(prisma.changeLog.groupBy).not.toHaveBeenCalled();
  });

  it("自分が作成した物件なら読める", async () => {
    (prisma.property.findUnique as unknown as Mock).mockResolvedValue({
      id: PROPERTY_ID,
      buildingId: null,
      createdBy: "staff1",
      assignedTo: null,
    });
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
  });

  it("自分が担当の物件なら読める", async () => {
    (prisma.property.findUnique as unknown as Mock).mockResolvedValue({
      id: PROPERTY_ID,
      buildingId: null,
      createdBy: "someone-else",
      assignedTo: "staff1",
    });
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
  });

  it("物件が存在しなければ 404 (存在の有無を 403/404 で区別しない設計は他 route と同じ)", async () => {
    (prisma.property.findUnique as unknown as Mock).mockResolvedValue(null);
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
  });
});

describe("owner:read が無ければ所有者リンクの履歴を出さない (@codex #330 R3)", () => {
  // property_owners の ChangeLog は oldValue/newValue に**自由記述の note** を
  // そのまま持つ。物件詳細 route は property:read だけの利用者に所有者を
  // `{ id }` まで削って返しており、履歴からそれを回り込めては意味がない。
  beforeEach(() => {
    permOverride.owner = false;
    (prisma.propertyOwner.findMany as unknown as Mock).mockResolvedValue([
      { id: OWNER_LINK_1 },
    ]);
  });

  it("property_owners の条件を積まない", async () => {
    const or = await runAndGetOr();
    expect(or.some((c) => c.targetTable === "property_owners")).toBe(false);
  });

  it("所有者リンクの id を DB から引くこともしない", async () => {
    await GET(req, ctx);
    expect(prisma.propertyOwner.findMany).not.toHaveBeenCalled();
  });

  it("物件本体・棟の履歴は従来どおり出す", async () => {
    (prisma.property.findUnique as unknown as Mock).mockResolvedValue({
      id: PROPERTY_ID,
      buildingId: BUILDING_ID,
      createdBy: "u1",
      assignedTo: null,
    });
    const or = await runAndGetOr();
    expect(or.map((c) => c.targetTable).sort()).toEqual([
      "buildings",
      "properties",
    ]);
  });
});
