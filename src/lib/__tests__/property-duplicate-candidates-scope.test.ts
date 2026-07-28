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
import {
  addressAreaKey,
  normalizeRealEstateNumber,
} from "@/lib/address-normalizer";

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

/** SQL 断片 → 返す行 で $queryRaw を差し替える。 */
function mockRaw(byFragment: Record<string, unknown[]>) {
  (prisma.$queryRaw as unknown as Mock).mockImplementation(
    async (strings: string[]) => {
      const sql = strings.join("?");
      for (const [fragment, rows] of Object.entries(byFragment)) {
        if (sql.includes(fragment)) return rows;
      }
      return [];
    },
  );
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

/** $queryRaw の呼び出しを SQL 断片で選ぶ (地番検索 / 不動産番号検索)。 */
function rawCall(fragment: string) {
  const calls = (prisma.$queryRaw as unknown as Mock).mock.calls;
  return calls.find(([strings]) => (strings as string[]).join("?").includes(fragment));
}
/** 地番検索の呼び出し (SQL 文字列 + パラメータ)。 */
function lotQuery() {
  const call = rawCall("lot_number IS NOT NULL");
  if (!call) return undefined;
  const [strings, ...values] = call;
  return { sql: (strings as string[]).join("?"), values };
}
/** 不動産番号検索の呼び出し。 */
function numberQuery() {
  const call = rawCall("real_estate_number IS NOT NULL");
  if (!call) return undefined;
  const [strings, ...values] = call;
  return { sql: (strings as string[]).join("?"), values };
}

describe("地番一致: 同一エリアに絞ってから正規化比較する", () => {
  it("住所のエリアキーで母集団を絞る (無条件スキャンに戻さない)", async () => {
    await GET(req, ctx);
    const q = lotQuery();
    expect(q).toBeDefined();
    // 同じ「1番1」でも市区町村が違えば重複ではない = 意味の上でも正しい絞り込み
    expect(q!.values).toContain("東京都港区芝公園");
    expect(q!.sql).toMatch(/is_archived = false/);
    expect(q!.values).toContain(ID);
  });

  it("走査上限を 50 件から引き上げる (エリア内なら安全に広く見られる)", async () => {
    await GET(req, ctx);
    expect(lotQuery()!.values).toContain(500);
  });

  it("住所が短すぎて prefix を作れない物件では地番検索を行わない", async () => {
    (prisma.property.findUnique as unknown as Mock).mockResolvedValue(
      baseProperty({ address: "東京" }),
    );
    await GET(req, ctx);
    expect(lotQuery()).toBeUndefined();
  });

  it("正規化が違っても同じ地番なら候補に出る (全角・漢数字)", async () => {
    mockRaw({
      "lot_number IS NOT NULL": [
        {
          id: "dup",
          address: "東京都港区芝公園4-2-9",
          lotNumber: "１番１", // 全角
          realEstateNumber: null,
          propertyType: "land",
          caseStatus: "new_case",
        },
      ],
    });
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
    const q = numberQuery();
    expect(q).toBeDefined();
    const { sql, values } = q!;
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
    expect(numberQuery()).toBeUndefined();
  });

  it("番号が無い物件では問い合わせない", async () => {
    (prisma.property.findUnique as unknown as Mock).mockResolvedValue(
      baseProperty({ realEstateNumber: null }),
    );
    await GET(req, ctx);
    expect(numberQuery()).toBeUndefined();
  });

  it("桁が一致すれば区切り文字が違っても候補に出る", async () => {
    mockRaw({
      "real_estate_number IS NOT NULL": [
        {
          id: "dup2",
          address: "東京都千代田区1-1",
          lotNumber: null,
          realEstateNumber: "1234-5678-9012-3", // 区切りあり
          propertyType: "land",
          caseStatus: "new_case",
        },
      ],
    });
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

describe("エリアキーは表記ゆれに影響されない (@codex #330 R1)", () => {
  it("丁目/ハイフンの違いで同じキーになる", () => {
    // 生の先頭10文字だと "東京都港区芝公園4-" と "東京都港区芝公園4丁" に
    // 分かれ、正規化すれば一致する相手を DB 段階で落としていた。
    expect(addressAreaKey("東京都港区芝公園4-2-8")).toBe("東京都港区芝公園");
    expect(addressAreaKey("東京都港区芝公園4丁目2-8")).toBe("東京都港区芝公園");
    expect(addressAreaKey("東京都港区芝公園四丁目2-8")).toBe("東京都港区芝公園");
    expect(addressAreaKey("東京都港区芝公園４−２−８")).toBe("東京都港区芝公園");
  });

  it("地名の漢数字を番地と誤認しない (@codex #330 R2)", () => {
    // ⚠日本の地名には漢数字が普通に含まれる。「最初の漢数字で切る」と
    // 四日市市 → 空キー、八王子市 → "東京都" になり、どちらも呼び出し側の
    // 最低文字数(4)を割って**地番の重複検出そのものが丸ごとスキップ**される。
    expect(addressAreaKey("三重県四日市市諏訪町1-1")).toBe("三重県四日市市諏訪町");
    expect(addressAreaKey("東京都八王子市横山町1-1")).toBe("東京都八王子市横山町");
    expect(addressAreaKey("新潟県十日町市本町1-1")).toBe("新潟県十日町市本町");
    expect(addressAreaKey("東京都港区六本木6-10-1")).toBe("東京都港区六本木");
  });

  it("漢数字は「丁目」が続くときだけ番地として切る", () => {
    // 丁目 が続けば番地表記 → 手前で切る
    expect(addressAreaKey("東京都新宿区西新宿二丁目8-1")).toBe("東京都新宿区西新宿");
    // 「丁」単独 (八丁堀) は地名 → 切らない
    expect(addressAreaKey("東京都中央区八丁堀2-1")).toBe("東京都中央区八丁堀");
  });

  it("空白は落とす / 数字が無い住所はそのまま", () => {
    expect(addressAreaKey("東京都 港区 芝公園 4-2-8")).toBe("東京都港区芝公園");
    expect(addressAreaKey("東京都港区芝公園")).toBe("東京都港区芝公園");
  });

  it("キーが短すぎる住所では地番検索を行わない (母集団を絞れないため)", async () => {
    (prisma.property.findUnique as unknown as Mock).mockResolvedValue(
      baseProperty({ address: "港区1-2-3" }),
    );
    await GET(req, ctx);
    // areaKey = "港区" (2文字) < 4 → 走らせない
    expect(lotQuery()).toBeUndefined();
  });

  it("表記が違う同一エリアの物件を DB 段階で落とさない", async () => {
    mockRaw({
      "lot_number IS NOT NULL": [
        {
          id: "dup3",
          address: "東京都港区芝公園4丁目2-9", // 丁目表記
          lotNumber: "1番1",
          realEstateNumber: null,
          propertyType: "land",
          caseStatus: "new_case",
        },
      ],
    });
    const res = await GET(req, ctx);
    const json = (await res.json()) as { data: Array<{ id: string }> };
    expect(json.data.some((c) => c.id === "dup3")).toBe(true);
  });
});

describe("エリア絞り込みは空白の有無に左右されない (@codex #330 R4)", () => {
  // addressAreaKey は空白を落とすので、DB 側も落としてから比較しないと
  // 「東京都港区芝公園4-2-8」と「東京都 港区 芝公園 4-2-8」が食い違い、
  // **保存側に空白がある物件だけ**が正規化比較の手前で落ちる。
  it("DB 側でも空白を除去してから包含判定する", async () => {
    await GET(req, ctx);
    const { sql } = lotQuery()!;
    expect(sql).toMatch(/translate\(/);
    // 全角スペース(U+3000) と NBSP(160) は [[:space:]] に入らないので明示が必要
    expect(sql).toContain("chr(12288)");
    expect(sql).toContain("chr(160)");
    // % / _ をワイルドカードにしないため LIKE ではなく position
    expect(sql).toMatch(/position\(/);
    expect(sql).not.toMatch(/LIKE/);
  });

  it("SQL 側の空白除去が JS 側 addressAreaKey と同じ結果になる", () => {
    // 実 DB は使えないので translate の意味を JS で再現して突き合わせる。
    // translate(address, ' ' || chr(9) || chr(10) || chr(13) || chr(160) || chr(12288), '')
    const SQL_STRIPPED_CHARS = [
      " ",
      "\t",
      "\n",
      "\r",
      "\u00a0",
      "\u3000",
    ];
    const sqlLikeStrip = (v: string) =>
      SQL_STRIPPED_CHARS.reduce((acc, ch) => acc.split(ch).join(""), v);
    for (const stored of [
      "東京都 港区 芝公園 4-2-8",
      "東京都　港区　芝公園　4-2-8", // 全角スペース
      "東京都 港区 芝公園 4-2-8", // NBSP
      "東京都港区芝公園4-2-8",
    ]) {
      // 保存側の空白を落とした文字列に、エリアキーが含まれること
      expect(sqlLikeStrip(stored)).toContain(
        addressAreaKey("東京都港区芝公園4-2-8"),
      );
    }
  });

  it("空白入りで保存された同一エリアの物件を落とさない", async () => {
    mockRaw({
      "lot_number IS NOT NULL": [
        {
          id: "dup4",
          address: "東京都 港区 芝公園 4-2-9",
          lotNumber: "1番1",
          realEstateNumber: null,
          propertyType: "land",
          caseStatus: "new_case",
        },
      ],
    });
    const res = await GET(req, ctx);
    const json = (await res.json()) as { data: Array<{ id: string }> };
    expect(json.data.some((c) => c.id === "dup4")).toBe(true);
  });
});

describe("重複候補もレコード単位のスコープに閉じる (@codex #330 R5)", () => {
  // この route は property:read しか見ておらず、field_staff が担当外の物件 id を
  // 指定すると**他物件の住所・地番・不動産番号・種別・案件状況**が返っていた。
  // 検索が実際に効くようにした分だけ返る中身が増えるので、入口と候補の両方を閉じる。

  it("担当外の物件を指定したら 403 で、候補検索を一切走らせない", async () => {
    (getApiSession as Mock).mockResolvedValue({
      id: "staff1",
      role: "field_staff",
    });
    (prisma.property.findUnique as unknown as Mock).mockResolvedValue(
      baseProperty({ createdBy: "someone-else", assignedTo: "another" }),
    );

    const res = await GET(req, ctx);
    expect(res.status).toBe(403);
    expect((prisma.$queryRaw as unknown as Mock).mock.calls.length).toBe(0);
    expect((prisma.property.findMany as unknown as Mock).mock.calls.length).toBe(
      0,
    );
  });

  it("自分の物件なら通り、候補側にも自分の id で絞りをかける", async () => {
    (getApiSession as Mock).mockResolvedValue({
      id: "staff1",
      role: "field_staff",
    });
    (prisma.property.findUnique as unknown as Mock).mockResolvedValue(
      baseProperty({ createdBy: "staff1", assignedTo: null }),
    );

    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const lot = lotQuery()!;
    expect(lot.sql).toMatch(/created_by = /);
    expect(lot.sql).toMatch(/assigned_to = /);
    expect(lot.values).toContain("staff1");
    const num = numberQuery()!;
    expect(num.sql).toMatch(/created_by = /);
    expect(num.values).toContain("staff1");
  });

  it("管理者はスコープ無し (null を渡して制限しない)", async () => {
    await GET(req, ctx);
    const lot = lotQuery()!;
    // null = 制限なし。id と areaKey は渡るが、ユーザー id は渡らない。
    expect(lot.values).toContain(null);
    expect(lot.values).not.toContain("u1");
  });
});

describe("地番の突き合わせは件数で打ち切らない (@codex #330 R5)", () => {
  // 並び順のない LIMIT は「エリア内の適当な N 件」を選ぶだけで、本当の重複が
  // その外にいれば黙って取りこぼす (閾値が 50 → 500 に上がるだけ)。
  it("1ページ埋まったら次のページを読む (id カーソル)", async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => ({
      id: `a${String(i).padStart(4, "0")}`,
      address: "東京都港区芝公園4-2-9",
      lotNumber: "9番9",
      realEstateNumber: null,
      propertyType: "land",
      caseStatus: "new_case",
    }));
    const page2 = [
      {
        id: "b0001",
        address: "東京都港区芝公園4-2-10",
        lotNumber: "1番1", // ← 本命の重複はページ2にいる
        realEstateNumber: null,
        propertyType: "land",
        caseStatus: "new_case",
      },
    ];
    let lotCall = 0;
    (prisma.$queryRaw as unknown as Mock).mockImplementation(
      async (strings: string[]) => {
        const sql = strings.join("?");
        if (!sql.includes("lot_number IS NOT NULL")) return [];
        lotCall += 1;
        return lotCall === 1 ? page1 : page2;
      },
    );

    const res = await GET(req, ctx);
    const json = (await res.json()) as { data: Array<{ id: string }> };
    expect(lotCall).toBe(2);
    // 500件の壁の向こうにいた重複を拾えている
    expect(json.data.some((c) => c.id === "b0001")).toBe(true);
  });

  it("暴走上限に当たったら黙らず scanTruncated を返す", async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      id: `x${String(i).padStart(4, "0")}`,
      address: "東京都港区芝公園4-2-9",
      lotNumber: "9番9",
      realEstateNumber: null,
      propertyType: "land",
      caseStatus: "new_case",
    }));
    (prisma.$queryRaw as unknown as Mock).mockImplementation(
      async (strings: string[]) =>
        strings.join("?").includes("lot_number IS NOT NULL") ? full : [],
    );

    const res = await GET(req, ctx);
    const json = (await res.json()) as { scanTruncated: boolean };
    expect(json.scanTruncated).toBe(true);
  });

  it("読み切れたときは scanTruncated=false", async () => {
    const res = await GET(req, ctx);
    const json = (await res.json()) as { scanTruncated: boolean };
    expect(json.scanTruncated).toBe(false);
  });
});
