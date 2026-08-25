/**
 * 貼り付け取込 API の契約テスト。
 * vitest は env=node のため、route を直接 import して NextRequest を渡す。
 * 認証・Prisma は vi.mock で差し替える。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSession = { id: "user-1" };
// ⚠ granted: true が無いと hasPermission (src/lib/permissions.ts) は
//   常に false を返す(= 常に403)。リポジトリ内の他テストの慣例に合わせる。
let mockPerms: unknown = [{ resource: "property", action: "write", granted: true }];
const mockFindMany = vi.fn();
const mockOwnerFindMany = vi.fn();

// ⚠api-helpers を vi.importActual すると実物の "@/lib/auth" まで読み込まれ、
//   next-auth 内部の拡張子なし "next/server" import が node の ESM 解決に失敗する
//   (corporate-number-mock-permissions.test.ts と同じ回避: @/lib/auth 自体も
//   mock してこの経路に入らせない)。
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

// リポジトリ内の route テスト全てが NextRequest をこの形で mock している
// (例: owner-archive-route.test.ts)ので同じ形にする。
vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
    }
  }
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});

vi.mock("@/lib/api-helpers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-helpers")>("@/lib/api-helpers");
  return {
    ...actual,
    getApiSession: vi.fn(async () => mockSession),
    getUserPermissions: vi.fn(async () => mockPerms),
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    property: { findMany: (...a: unknown[]) => mockFindMany(...a) },
    owner: { findMany: (...a: unknown[]) => mockOwnerFindMany(...a) },
  },
}));

import { POST } from "../route";
import { NextRequest } from "next/server";

const jsonReq = (body: unknown) => {
  const s = JSON.stringify(body);
  // ⚠assertImportJsonBodySize(@/lib/import-body-size) は content-length ヘッダを
  //   要求する(欠落は411)。実ブラウザの fetch は JSON body に自動で付けるが、
  //   NextRequest を直接組み立てるテストでは自分で付けないと本文の
  //   ガード(request.json() の前に呼ぶ)を通れない。
  return new NextRequest("http://localhost/api/import/paste", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(s)),
    },
    body: s,
  });
};

beforeEach(() => {
  mockPerms = [{ resource: "property", action: "write", granted: true }];
  mockFindMany.mockReset();
  mockFindMany.mockResolvedValue([]);
  mockOwnerFindMany.mockReset();
  mockOwnerFindMany.mockResolvedValue([]);
});

describe("POST /api/import/paste", () => {
  it("貼り付けたテキストから下書きを返す", async () => {
    const res = await POST(jsonReq({ text: "■物件所在地： 東京都A区B1-2-3（地番552-2）" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft.property.address.value).toBe("東京都A区B1-2-3");
    expect(body.draft.property.lotNumber.value).toBe("552-2");
  });

  it("★権限が無ければ403", async () => {
    mockPerms = [];
    const res = await POST(jsonReq({ text: "■物件所在地： 東京都A区B1-2-3" }));
    expect(res.status).toBe(403);
  });

  it("★文字数の上限を超えたら400（無言で切り詰めない）", async () => {
    const res = await POST(jsonReq({ text: "あ".repeat(200_001) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    // ⚠実際の handleApiError(@/lib/api-helpers) は { error: { message, code } } を返す
    //   (registry-preflight-route.test.ts 等、既存の全 route テストと同じ形)。
    expect(body.error.message).toContain("長すぎ");
  });

  it("text が空なら400", async () => {
    const res = await POST(jsonReq({ text: "   " }));
    expect(res.status).toBe(400);
  });

  it("★同じ外部キーの物件があれば blocked で返す", async () => {
    mockFindMany.mockResolvedValue([
      { id: "p1", address: "別", lotNumber: null, externalLinkKey: "SA-1" },
    ]);
    const res = await POST(
      jsonReq({ text: "■査定ナンバー： SA-1\n■物件所在地： 東京都A区B1-2-3" }),
    );
    const body = await res.json();
    expect(body.duplicates.blocked).toBe(true);
    expect(body.duplicates.blockedByPropertyId).toBe("p1");
  });

  it("★住所一致の候補が take(50) を埋めていても、外部キー一致は別クエリなので必ず候補に入り blocked になる", async () => {
    // 外部キー一致クエリと住所前方一致クエリを where の形で区別する。
    // 同じ建物に多数戸(50件超)が既に登録されている状況を再現し、ブロックすべき
    // 唯一の外部キー一致行(p-key)が住所一致の50件の中には**含まれない**ようにする。
    mockFindMany.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
      if (args?.where?.externalLinkKey) {
        return [{ id: "p-key", address: "別の建物", lotNumber: null, externalLinkKey: "SA-1" }];
      }
      return Array.from({ length: 50 }, (_, i) => ({
        id: `p-addr-${i}`,
        address: "東京都A区B1-2-3",
        lotNumber: null,
        externalLinkKey: null,
      }));
    });
    const res = await POST(
      jsonReq({ text: "■査定ナンバー： SA-1\n■物件所在地： 東京都A区B1-2-3" }),
    );
    const body = await res.json();
    expect(body.duplicates.blocked).toBe(true);
    expect(body.duplicates.blockedByPropertyId).toBe("p-key");
  });

  it("★所有者の氏名が無ければ所有者候補を引きに行かない", async () => {
    const res = await POST(jsonReq({ text: "■物件所在地： 東京都A区B1-2-3" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([]);
    expect(mockOwnerFindMany).not.toHaveBeenCalled();
  });

  it("★氏名も現住所(Owner.currentAddress)も一致する既存所有者は current_address で返る", async () => {
    mockOwnerFindMany.mockResolvedValue([
      { id: "o1", name: "山田太郎", currentAddress: "東京都渋谷区X1-1-1", address: null },
    ]);
    const res = await POST(
      jsonReq({
        text: "■物件所在地： 東京都A区B1-2-3\n■お名前： 山田太郎\n■現住所： 東京都渋谷区X1-1-1",
      }),
    );
    const body = await res.json();
    expect(mockOwnerFindMany).toHaveBeenCalledTimes(1);
    expect(body.ownerCandidates).toEqual([
      { id: "o1", name: "山田太郎", matchKind: "current_address" },
    ]);
  });

  it("★本番の実態=currentAddressがnullでaddress(登記上住所)に貼り付けの現住所と同じ値が入っている場合、registry_addressで返る", async () => {
    // 本番実測(2026-08-26): is_archived=false 1,312件中、currentAddress は0件・
    // address(登記上住所)は1,309件。ほぼ全員がこの形なので、ここが通らないと
    // この機能は本番でほぼ発火しない。
    mockOwnerFindMany.mockResolvedValue([
      { id: "o1b", name: "山田太郎", currentAddress: null, address: "東京都渋谷区X1-1-1" },
    ]);
    const res = await POST(
      jsonReq({
        text: "■物件所在地： 東京都A区B1-2-3\n■お名前： 山田太郎\n■現住所： 東京都渋谷区X1-1-1",
      }),
    );
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([
      { id: "o1b", name: "山田太郎", matchKind: "registry_address" },
    ]);
  });

  it("★同じ候補に現住所も登記上住所も一致する場合、current_addressが優先される", async () => {
    mockOwnerFindMany.mockResolvedValue([
      {
        id: "o1c",
        name: "山田太郎",
        currentAddress: "東京都渋谷区X1-1-1",
        address: "東京都渋谷区X1-1-1",
      },
    ]);
    const res = await POST(
      jsonReq({
        text: "■物件所在地： 東京都A区B1-2-3\n■お名前： 山田太郎\n■現住所： 東京都渋谷区X1-1-1",
      }),
    );
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([
      { id: "o1c", name: "山田太郎", matchKind: "current_address" },
    ]);
  });

  it("★氏名だけ一致する既存所有者は name_only で返る（現住所も登記上住所も違う/無い）", async () => {
    mockOwnerFindMany.mockResolvedValue([
      { id: "o2", name: "山田太郎", currentAddress: "大阪府大阪市Y2-2-2", address: null },
    ]);
    const res = await POST(
      jsonReq({
        text: "■物件所在地： 東京都A区B1-2-3\n■お名前： 山田太郎\n■現住所： 東京都渋谷区X1-1-1",
      }),
    );
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([
      { id: "o2", name: "山田太郎", matchKind: "name_only" },
    ]);
  });

  it("★本番の実態=DBの氏名が空白なし「佐藤花子」、貼り付けが全角空白入り「佐藤　花子」でも見つかる", async () => {
    // 本番実測(2026-08-26): is_archived=false 1,312件中、氏名に空白が入っているのは
    // 全角1件・半角3件だけでほぼ全員「空白なし」。一方 貼り付け元(HOME4U査定依頼)は
    // 「佐藤　花子」のように全角空白入りが典型 → where の完全一致だと0件になっていた。
    mockOwnerFindMany.mockResolvedValue([
      { id: "s1", name: "佐藤花子", currentAddress: null, address: null },
    ]);
    const res = await POST(
      jsonReq({ text: "■物件所在地： 東京都A区B1-2-3\n■お名前： 佐藤　花子" }),
    );
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([
      { id: "s1", name: "佐藤花子", matchKind: "name_only" },
    ]);
  });

  it("★逆方向=DBの氏名が全角空白入り「佐藤　花子」、貼り付けが空白なし「佐藤花子」でも見つかる", async () => {
    mockOwnerFindMany.mockResolvedValue([
      { id: "s2", name: "佐藤　花子", currentAddress: null, address: null },
    ]);
    const res = await POST(
      jsonReq({ text: "■物件所在地： 東京都A区B1-2-3\n■お名前： 佐藤花子" }),
    );
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([
      { id: "s2", name: "佐藤　花子", matchKind: "name_only" },
    ]);
  });

  it("★全角空白と半角空白の違いだけでも見つかる", async () => {
    mockOwnerFindMany.mockResolvedValue([
      { id: "s3", name: "佐藤 花子", currentAddress: null, address: null }, // 半角
    ]);
    const res = await POST(
      jsonReq({ text: "■物件所在地： 東京都A区B1-2-3\n■お名前： 佐藤　花子" }), // 全角
    );
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([
      { id: "s3", name: "佐藤 花子", matchKind: "name_only" },
    ]);
  });

  it("★別人(佐藤太郎)は正規化しすぎて拾わない", async () => {
    // 前方一致の絞り込みは姓の先頭1文字だけなので「佐藤」姓の別人も DB から
    // 返ってきうるが、JS 側の normalizeName 完全一致で除外されることを確かめる。
    mockOwnerFindMany.mockResolvedValue([
      { id: "s4", name: "佐藤太郎", currentAddress: null, address: null },
    ]);
    const res = await POST(
      jsonReq({ text: "■物件所在地： 東京都A区B1-2-3\n■お名前： 佐藤　花子" }),
    );
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([]);
  });

  it("★所有者候補のDB取得件数上限(take)を固定する(上限が消えても気づけるように)", async () => {
    const res = await POST(
      jsonReq({ text: "■物件所在地： 東京都A区B1-2-3\n■お名前： 佐藤　花子" }),
    );
    expect(res.status).toBe(200);
    expect(mockOwnerFindMany).toHaveBeenCalledTimes(1);
    const args = mockOwnerFindMany.mock.calls[0][0] as { take?: number };
    // ⚠姓の先頭1文字で前方一致するため、多い姓(佐藤等)は何十件も返りうる。
    //   正規化一致で最終的に絞り込む前提で厚めに取っている値そのものを固定する。
    expect(args.take).toBe(200);
  });

  it("★一致の種類が異なる候補が同一レスポンスに混在しても、各候補が自分の種類を保つ", async () => {
    mockOwnerFindMany.mockResolvedValue([
      { id: "t-cur", name: "田中一郎", currentAddress: "東京都新宿区Z9-9-9", address: null },
      { id: "t-reg", name: "田中一郎", currentAddress: null, address: "東京都新宿区Z9-9-9" },
      {
        id: "t-name",
        name: "田中一郎",
        currentAddress: "大阪府大阪市Y2-2-2",
        address: "福岡県福岡市W3-3-3",
      },
    ]);
    const res = await POST(
      jsonReq({
        text: "■物件所在地： 東京都A区B1-2-3\n■お名前： 田中一郎\n■現住所： 東京都新宿区Z9-9-9",
      }),
    );
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([
      { id: "t-cur", name: "田中一郎", matchKind: "current_address" },
      { id: "t-reg", name: "田中一郎", matchKind: "registry_address" },
      { id: "t-name", name: "田中一郎", matchKind: "name_only" },
    ]);
  });

  it("★所有者検索は isArchived: false を指定する(除外はサーバー側クエリで行う)", async () => {
    const res = await POST(
      jsonReq({ text: "■物件所在地： 東京都A区B1-2-3\n■お名前： 山田太郎" }),
    );
    expect(res.status).toBe(200);
    expect(mockOwnerFindMany).toHaveBeenCalledTimes(1);
    const args = mockOwnerFindMany.mock.calls[0][0] as { where?: { isArchived?: boolean } };
    expect(args.where?.isArchived).toBe(false);
  });

  it("★所有者候補のレスポンスに電話番号・メールアドレス・住所を含めない", async () => {
    mockOwnerFindMany.mockResolvedValue([
      {
        id: "o3",
        name: "山田太郎",
        currentAddress: "東京都渋谷区X1-1-1",
        phone: "09099999999",
        email: "yamada@example.com",
        address: "登記上の住所テキスト",
      },
    ]);
    const res = await POST(
      jsonReq({
        text: "■物件所在地： 東京都A区B1-2-3\n■お名前： 山田太郎\n■現住所： 東京都渋谷区X1-1-1",
      }),
    );
    const body = await res.json();
    // ⚠body.draft.owner.currentAddress には貼った現住所がそのまま入る(既存の仕様=
    //   確認画面用の下書きが原文の構造化値を持つのは正しい)。ここで確かめたいのは
    //   「所有者候補(ownerCandidates)」側にDBの電話・メール・登記住所が絶対に
    //   漏れていないことなので、対象を ownerCandidates に絞って確認する。
    const rawCandidates = JSON.stringify(body.ownerCandidates);
    expect(rawCandidates).not.toContain("09099999999");
    expect(rawCandidates).not.toContain("yamada@example.com");
    expect(rawCandidates).not.toContain("登記上の住所テキスト");
    // candidate.currentAddress の値そのもの(現住所)も候補には含めない。
    expect(rawCandidates).not.toContain("渋谷区X1-1-1");
    expect(body.ownerCandidates).toEqual([
      { id: "o3", name: "山田太郎", matchKind: "current_address" },
    ]);
  });

  it("★下書きに貼った原文をそのまま含めない（PII を返しっぱなしにしない）", async () => {
    const res = await POST(
      jsonReq({ text: "■物件所在地： 東京都A区B1-2-3\n■電話番号： 09012345678\n■お名前： 山田太郎" }),
    );
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("rawText");
    // 所有者の欄には入るが、原文そのものは返さない
    expect(body.draft.owner.phone.value).toBe("09012345678");
  });
});
