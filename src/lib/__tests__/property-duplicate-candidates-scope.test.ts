import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// 重複候補の検出 (総点検 2026-07-27)。
//
// 旧実装は「地番/不動産番号が入っている物件」を**無条件に先頭50件**だけ取り、
// JS で正規化比較していた。DB 側の値フィルタも並び順も無いため、該当データが
// 数千件ある本番では本当の重複が 50 件に入る確率が低く、検出が実質機能して
// いなかった (重複登録に気づけず二重管理・二重DMになる)。

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
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: vi.fn(), findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { GET } from "@/app/api/properties/[id]/candidates/route";
import { normalizeRealEstateNumber } from "@/lib/address-normalizer";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const req = new Request("http://x/y") as never;
const ctx = { params: Promise.resolve({ id: ID }) };

function baseProperty(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    address: "東京都港区芝公園4-2-8",
    lotNumber: "1番1",
    realEstateNumber: "1234567890123",
    propertyType: "land",
    caseStatus: "new_case",
    lat: null,
    lng: null,
    createdBy: "u1",
    assignedTo: null,
    isArchived: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  (prisma.property.findUnique as unknown as Mock).mockResolvedValue(
    baseProperty(),
  );
  (prisma.property.findMany as unknown as Mock).mockResolvedValue([]);
  (prisma.$queryRaw as unknown as Mock).mockResolvedValue([]);
});

/** findMany の呼び出しのうち、地番検索のものを取り出す。 */
function lotQuery() {
  const calls = (prisma.property.findMany as unknown as Mock).mock.calls;
  return calls
    .map(([arg]) => arg)
    .find((arg) => arg?.where?.lotNumber?.not === null);
}

describe("地番一致: 同一エリアに絞ってから正規化比較する", () => {
  it("住所 prefix で母集団を絞る (無条件スキャンに戻さない)", async () => {
    await GET(req, ctx);
    const q = lotQuery();
    expect(q).toBeDefined();
    // 同じ「1番1」でも市区町村が違えば重複ではない = 意味の上でも正しい絞り込み
    expect(q.where.address).toEqual({ contains: "東京都港区芝公園4-" });
    expect(q.where.isArchived).toBe(false);
    expect(q.where.id).toEqual({ not: ID });
  });

  it("走査上限を 50 件から引き上げる (エリア内なら安全に広く見られる)", async () => {
    await GET(req, ctx);
    expect(lotQuery().take).toBe(500);
  });

  it("住所が短すぎて prefix を作れない物件では地番検索を行わない", async () => {
    (prisma.property.findUnique as unknown as Mock).mockResolvedValue(
      baseProperty({ address: "東京" }),
    );
    await GET(req, ctx);
    expect(lotQuery()).toBeUndefined();
  });

  it("正規化が違っても同じ地番なら候補に出る (全角・漢数字)", async () => {
    (prisma.property.findMany as unknown as Mock).mockImplementation(
      async (arg: { where?: { lotNumber?: { not: null } } }) =>
        arg?.where?.lotNumber?.not === null
          ? [
              {
                id: "dup",
                address: "東京都港区芝公園4-2-9",
                lotNumber: "１番１", // 全角
                realEstateNumber: null,
                propertyType: "land",
                caseStatus: "new_case",
              },
            ]
          : [],
    );
    const res = await GET(req, ctx);
    const json = (await res.json()) as {
      data: Array<{ id: string; matchType: string }>;
    };
    expect(json.data.some((c) => c.id === "dup" && c.matchType === "lot_number")).toBe(
      true,
    );
  });
});

describe("不動産番号一致: 全件から桁だけを比較して正確に引く", () => {
  it("DB 側で数字以外を除去して完全一致させる (先頭50件スキャンに戻さない)", async () => {
    await GET(req, ctx);
    // $queryRaw を使う = エリアで絞れない全国一意の番号を正確に引くため
    expect((prisma.$queryRaw as unknown as Mock).mock.calls.length).toBe(1);
    const [strings, ...values] = (prisma.$queryRaw as unknown as Mock).mock
      .calls[0];
    const sql = (strings as string[]).join("?");
    // ⚠PostgreSQL の [0-9] は ASCII のみで全角 (U+FF10-FF19) にマッチしない。
    // JS 側は「全角→半角」してから数字以外を除去するので、SQL でも translate で
    // 全角を半角に直してから除去しないと、全角で登録された行を必ず取りこぼす
    // (validators は全角を許容するだけで変換しないため現実に存在し得る)。
    expect(sql).toMatch(
      /translate\(real_estate_number, '０１２３４５６７８９', '0123456789'\)/,
    );
    expect(sql).toMatch(/regexp_replace\(/);
    expect(sql).toMatch(/'\[\^0-9\]', '', 'g'/);
    expect(sql).toMatch(/is_archived = false/);
    // パラメータ化されている (生値を SQL に埋め込まない)
    expect(values).toContain("1234567890123");
    expect(values).toContain(ID);
  });

  it("番号が空 (数字が1桁も無い) なら問い合わせない", async () => {
    (prisma.property.findUnique as unknown as Mock).mockResolvedValue(
      baseProperty({ realEstateNumber: "----" }),
    );
    await GET(req, ctx);
    expect((prisma.$queryRaw as unknown as Mock).mock.calls.length).toBe(0);
  });

  it("番号が無い物件では問い合わせない", async () => {
    (prisma.property.findUnique as unknown as Mock).mockResolvedValue(
      baseProperty({ realEstateNumber: null }),
    );
    await GET(req, ctx);
    expect((prisma.$queryRaw as unknown as Mock).mock.calls.length).toBe(0);
  });

  it("桁が一致すれば区切り文字が違っても候補に出る", async () => {
    (prisma.$queryRaw as unknown as Mock).mockResolvedValue([
      {
        id: "dup2",
        address: "東京都千代田区1-1",
        lotNumber: null,
        realEstateNumber: "1234-5678-9012-3", // 区切りあり
        propertyType: "land",
        caseStatus: "new_case",
      },
    ]);
    const res = await GET(req, ctx);
    const json = (await res.json()) as {
      data: Array<{ id: string; matchType: string; strength: string }>;
    };
    const hit = json.data.find((c) => c.id === "dup2");
    expect(hit?.matchType).toBe("real_estate_number");
    expect(hit?.strength).toBe("strong");
  });
});

describe("SQL 側の正規化が JS 側 normalizeRealEstateNumber と一致する", () => {
  // 実 DB は使えないので、SQL の意味 (translate → 数字以外除去) を
  // JS で再現し、正規化器と同じ結果になることを確かめる。
  const sqlLikeNormalize = (v: string) =>
    v
      // translate('０..９','0..9')
      .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      // regexp_replace('[^0-9]','','g') ※PostgreSQL の [0-9] は ASCII のみ
      .replace(/[^0-9]/g, "");

  it.each([
    "1234567890123",
    "１２３４５６７８９０１２３", // 全角
    "1234-5678-9012-3",
    "１２３４-５６７８-９０１２-３", // 全角+区切り
    "１2３4５6７8９0１2３", // 全半角混在
    "  1234 5678 9012 3  ",
  ])("%s は JS と SQL で同じ結果になる", (input) => {
    expect(sqlLikeNormalize(input)).toBe(normalizeRealEstateNumber(input));
  });

  it("translate を外すと全角が丸ごと消えて一致しなくなる (退行の再現)", () => {
    const withoutTranslate = (v: string) => v.replace(/[^0-9]/g, "");
    const fullWidth = "１２３４５６７８９０１２３";
    expect(withoutTranslate(fullWidth)).toBe("");
    expect(normalizeRealEstateNumber(fullWidth)).toBe("1234567890123");
  });
});
