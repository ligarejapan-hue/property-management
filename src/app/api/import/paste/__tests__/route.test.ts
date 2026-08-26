/**
 * 貼り付け取込 API の契約テスト。
 * vitest は env=node のため、route を直接 import して NextRequest を渡す。
 * 認証・Prisma は vi.mock で差し替える。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let mockSession: { id: string; role?: string } = { id: "user-1" };
// ⚠ granted: true が無いと hasPermission (src/lib/permissions.ts) は
//   常に false を返す(= 常に403)。リポジトリ内の他テストの慣例に合わせる。
//
// ⚠owner_name / owner_address の**表示レベル**もここに含める。この route は
//   所有者検索の入口なので、owners と同じく「マスクされている項目では検索しない」
//   規則に従う(全体レビュー Critical 2)。表示レベルは
//   getOwnerDisplayConfig(実物を使う・preloadedPermissions 経由でDBを引かない)
//   がこの配列から解決する。
const FULL_PERMS = [
  { resource: "import", action: "write", granted: true },
  { resource: "property", action: "write", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner_name", action: "full", granted: true },
  { resource: "owner_address", action: "full", granted: true },
];
let mockPerms: unknown = FULL_PERMS;
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
// PDF 経路の検証用。isPdfBuffer/isLikelyScannedPdf は実物を使い、
// 抽出結果(pdfText)だけ差し替える(判定そのものを偽装しないため)。
// ⚠isLikelyScannedPdf(50文字未満は「読めていない」)を通る長さにしておく。
let pdfText = "■物件所在地： 東京都A区B1-2-3（地番552-2）\n■物件種別： 一般住宅\n■建物構造： 木造スレート葺\n■間取り： 2LDK";
vi.mock("@/lib/pdf-extract", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pdf-extract")>("@/lib/pdf-extract");
  return { ...actual, extractTextFromPdf: vi.fn(async () => pdfText) };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    property: { findMany: (...a: unknown[]) => mockFindMany(...a) },
    owner: { findMany: (...a: unknown[]) => mockOwnerFindMany(...a) },
  },
}));

import { POST } from "../route";
import { NextRequest } from "next/server";

const NL = "\n";

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
  mockSession = { id: "user-1" };
  mockPerms = FULL_PERMS;
  mockFindMany.mockReset();
  mockFindMany.mockResolvedValue([]);
  mockOwnerFindMany.mockReset();
  mockOwnerFindMany.mockResolvedValue([]);
  pdfText = "■物件所在地： 東京都A区B1-2-3（地番552-2）\n■物件種別： 一般住宅\n■建物構造： 木造スレート葺\n■間取り： 2LDK";
});

/** %PDF- マジックバイトを持つ最小限の PDF を multipart で送る。 */
async function pdfReq(size = 100): Promise<NextRequest> {
  const head = Buffer.from("%PDF-1.4" + NL);
  const body = Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x20)]);
  const fd = new FormData();
  fd.append("file", new File([body], "shokai.pdf", { type: "application/pdf" }));
  const blob = await new Response(fd).blob();
  return new NextRequest("http://localhost/api/import/paste", {
    method: "POST",
    body: blob,
    headers: { "content-length": String(blob.size) },
  });
}

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

  it("★import:write が無ければ403(取込系routeの共通ゲート・全体レビュー I-1)", async () => {
    mockPerms = FULL_PERMS.filter((p) => p.resource !== "import");
    const res = await POST(jsonReq({ text: "■物件所在地： 東京都A区B1-2-3" }));
    expect(res.status).toBe(403);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("★property:write が無ければ403(import:write だけでは通さない)", async () => {
    mockPerms = FULL_PERMS.filter((p) => p.resource !== "property");
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

  it("★DBの氏名が全角英字「ＡＢＣ商事」、貼り付けが半角英字「ABC商事」でも見つかる", async () => {
    // 本番実測(2026-08-26): is_archived=false 1,312件中、氏名の先頭が全角英数
    // 5件・全角カナ24件(半角は0件)。正規化後の1文字だけで前方一致すると、
    // NFKCが全角→半角へ寄せるLatin文字では、DB(全角のまま)の生値と食い違って
    // 取りこぼす(JS側の正規化一致フィルタに到達する前に脱落する)。
    mockOwnerFindMany.mockResolvedValue([
      { id: "w1", name: "ＡＢＣ商事", currentAddress: null, address: null },
    ]);
    const res = await POST(
      jsonReq({ text: "■物件所在地： 東京都A区B1-2-3\n■お名前： ABC商事" }),
    );
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([
      { id: "w1", name: "ＡＢＣ商事", matchKind: "name_only" },
    ]);
  });

  it("★逆方向=DBの氏名が半角英字「ABC商事」、貼り付けが全角英字「ＡＢＣ商事」でも見つかる", async () => {
    mockOwnerFindMany.mockResolvedValue([
      { id: "w2", name: "ABC商事", currentAddress: null, address: null },
    ]);
    const res = await POST(
      jsonReq({ text: "■物件所在地： 東京都A区B1-2-3\n■お名前： ＡＢＣ商事" }),
    );
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([
      { id: "w2", name: "ABC商事", matchKind: "name_only" },
    ]);
  });

  it("★全角カナで始まる名前(本番に24件)でも見つかる。貼り付けが半角カナでも同様", async () => {
    mockOwnerFindMany.mockResolvedValue([
      { id: "w3", name: "タナカ商店", currentAddress: null, address: null }, // 全角カナ開始
    ]);
    const res = await POST(
      // 半角カナ("ﾀﾅｶ")で貼り付けても NFKC 正規化(全角カナへ寄る)と、
      // 前方一致の候補集合(全角/半角の両方)を通じて見つかる。
      jsonReq({ text: "■物件所在地： 東京都A区B1-2-3\n■お名前： ﾀﾅｶ商店" }),
    );
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([
      { id: "w3", name: "タナカ商店", matchKind: "name_only" },
    ]);
  });

  it("★幅違いの候補を広げても別人(全角/半角違いなだけの他社)は拾わない", async () => {
    // 過剰一致になっていないことの確認: 先頭の幅は一致するが氏名全体は
    // 別物("ＡＢＣ商事" と "ＡＢＣ工業")の場合、JS側の normalizeName
    // 完全一致で正しく除外されること。
    mockOwnerFindMany.mockResolvedValue([
      { id: "w4", name: "ＡＢＣ工業", currentAddress: null, address: null },
    ]);
    const res = await POST(
      jsonReq({ text: "■物件所在地： 東京都A区B1-2-3\n■お名前： ABC商事" }),
    );
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([]);
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

// ===========================================================================
// 全体レビュー Critical 2: この route は所有者検索の入口であり、物件も返す。
//   owners / owners/search / properties/suggest と同じ規則へ揃える。
// ===========================================================================

describe("所有者候補は owners と同じ規則で守る（検索オラクル封じ）", () => {
  const nameAndAddress =
    "■物件所在地： 東京都A区B1-2-3\n■お名前： 山田太郎\n■現住所： 東京都渋谷区X1-1-1";

  it("★owner:read が無ければ空で返し、所有者を**引きに行かない**", async () => {
    mockPerms = FULL_PERMS.filter((p) => p.resource !== "owner");
    mockOwnerFindMany.mockResolvedValue([
      { id: "o-secret", name: "山田太郎", currentAddress: "東京都渋谷区X1-1-1", address: null },
    ]);
    const res = await POST(jsonReq({ text: nameAndAddress }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([]);
    // 「引かない」ことまで固定する(引いてから捨てるのでは、DB負荷も
    //  タイミング差による観測も残る)。
    expect(mockOwnerFindMany).not.toHaveBeenCalled();
  });

  it("★条件は氏名と住所のAND: 住所は見られても氏名がマスクなら検索させない（項目ごとのORに直すとオラクルが再び開く）", async () => {
    mockPerms = [
      ...FULL_PERMS.filter((p) => p.resource !== "owner_name"),
      { resource: "owner_name", action: "masked", granted: true },
    ];
    const res = await POST(jsonReq({ text: nameAndAddress }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([]);
    expect(mockOwnerFindMany).not.toHaveBeenCalled();
  });

  it("★条件は氏名と住所のAND: 氏名は見られても住所がpartialなら検索させない（既定の field_staff がこれ・3入口の項目ごとORへ揃えてはいけない）", async () => {
    // prisma/seed.ts の field_staff は owner_phone: masked / owner_address: partial。
    // この人に「山田太郎 / 登記上の住所と一致」を返すと、市までしか見せていない
    // 住所の一致を確定させてしまう(= 検索オラクル)。
    mockPerms = [
      { resource: "import", action: "write", granted: true },
      { resource: "property", action: "write", granted: true },
      { resource: "owner", action: "read", granted: true },
      { resource: "owner_name", action: "full", granted: true },
      { resource: "owner_address", action: "partial", granted: true },
    ];
    mockOwnerFindMany.mockResolvedValue([
      { id: "o-secret", name: "山田太郎", currentAddress: null, address: "東京都渋谷区X1-1-1" },
    ]);
    const res = await POST(jsonReq({ text: nameAndAddress }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([]);
    expect(mockOwnerFindMany).not.toHaveBeenCalled();
  });

  it("★AND を OR に緩めると通ってしまう組み合わせが、実際に閉じている（住所partial×氏名full で候補ゼロ）", async () => {
    // ⚠この route は「氏名で前方一致 → 住所で一致の種類(連絡先/登記上)を出し分ける」
    //   ため、氏名だけ・住所だけの可否で判断してはいけない。owners は項目ごとに
    //   OR で検索対象を組むが、**この経路は氏名と住所を組み合わせて答えを返す**ので
    //   AND にしている。「3入口に揃える」つもりで OR へ直すと、住所が partial の
    //   人に「登記上の住所と一致」が返り、市までしか見せていない住所の一致を
    //   確定させられる(＝指摘 Critical 2 の再現)。
    mockPerms = [
      { resource: "import", action: "write", granted: true },
      { resource: "property", action: "write", granted: true },
      { resource: "owner", action: "read", granted: true },
      { resource: "owner_name", action: "full", granted: true },
      { resource: "owner_address", action: "partial", granted: true },
    ];
    mockOwnerFindMany.mockResolvedValue([
      { id: "o-oracle", name: "山田太郎", currentAddress: null, address: "東京都渋谷区X1-1-1" },
    ]);
    const res = await POST(jsonReq({ text: nameAndAddress }));
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("registry_address");
  });

  it("氏名も住所も見られる人には従来どおり候補を返す（過剰に閉じていない）", async () => {
    mockOwnerFindMany.mockResolvedValue([
      { id: "o-ok", name: "山田太郎", currentAddress: "東京都渋谷区X1-1-1", address: null },
    ]);
    const res = await POST(jsonReq({ text: nameAndAddress }));
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([
      { id: "o-ok", name: "山田太郎", matchKind: "current_address" },
    ]);
  });
});

describe("物件はレコード単位のスコープで絞る（field_staff は担当分だけ）", () => {
  /** 担当分(mine)と担当外(theirs)を1件ずつ返す。 */
  function twoProperties(externalLinkKeyOwner: "mine" | "theirs") {
    mockFindMany.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
      const mine = {
        id: "p-mine",
        address: "東京都A区B1-2-3",
        lotNumber: "1-1",
        externalLinkKey: externalLinkKeyOwner === "mine" ? "SA-1" : null,
        createdBy: "user-1",
        assignedTo: null,
      };
      const theirs = {
        id: "p-theirs",
        address: "東京都A区B1-2-3",
        lotNumber: "1-1",
        externalLinkKey: externalLinkKeyOwner === "theirs" ? "SA-1" : null,
        createdBy: "someone-else",
        assignedTo: "someone-else",
      };
      if (args?.where?.externalLinkKey) {
        return [mine, theirs].filter((p) => p.externalLinkKey === "SA-1");
      }
      return [mine, theirs];
    });
  }

  it("★field_staff の similar には担当外の物件（住所・id）が出ない", async () => {
    mockSession = { id: "user-1", role: "field_staff" };
    twoProperties("mine");
    const res = await POST(
      jsonReq({ text: "■物件所在地： 東京都A区B1-2-3（地番1-1）" }),
    );
    const body = await res.json();
    expect(body.similar.map((x: { id: string }) => x.id)).toEqual(["p-mine"]);
    expect(body.duplicates.similarPropertyIds).toEqual(["p-mine"]);
    expect(JSON.stringify(body.similar)).not.toContain("p-theirs");
  });

  it("担当外でない役割（office_staff 等）には両方出る（絞りすぎていない）", async () => {
    mockSession = { id: "user-1", role: "office_staff" };
    twoProperties("mine");
    const res = await POST(
      jsonReq({ text: "■物件所在地： 東京都A区B1-2-3（地番1-1）" }),
    );
    const body = await res.json();
    expect(body.similar.map((x: { id: string }) => x.id).sort()).toEqual(["p-mine", "p-theirs"]);
  });

  it("★担当外の物件が登録済みでも blocked は残るが、id は渡さない", async () => {
    mockSession = { id: "user-1", role: "field_staff" };
    twoProperties("theirs");
    const res = await POST(
      jsonReq({ text: "■査定ナンバー： SA-1\n■物件所在地： 東京都A区B1-2-3（地番1-1）" }),
    );
    const body = await res.json();
    // 「もう登録されている」ことは必ず伝える(伝えないと二重登録が起きる)。
    expect(body.duplicates.blocked).toBe(true);
    // 開けない物件の id は渡さない(押しても403になるリンクを見せない)。
    expect(body.duplicates.blockedByPropertyId).toBeNull();
  });

  it("担当分の物件が登録済みなら blocked と id の両方を返す", async () => {
    mockSession = { id: "user-1", role: "field_staff" };
    twoProperties("mine");
    const res = await POST(
      jsonReq({ text: "■査定ナンバー： SA-1\n■物件所在地： 東京都A区B1-2-3（地番1-1）" }),
    );
    const body = await res.json();
    expect(body.duplicates.blocked).toBe(true);
    expect(body.duplicates.blockedByPropertyId).toBe("p-mine");
  });

  it("★レスポンスに createdBy / assignedTo を載せない（判定にだけ使う）", async () => {
    mockSession = { id: "user-1", role: "office_staff" };
    twoProperties("mine");
    const res = await POST(
      jsonReq({ text: "■物件所在地： 東京都A区B1-2-3（地番1-1）" }),
    );
    const dumped = JSON.stringify(await res.json());
    expect(dumped).not.toContain("createdBy");
    expect(dumped).not.toContain("assignedTo");
    expect(dumped).not.toContain("someone-else");
  });
});

describe("PDF 経路（全体レビュー I-2 / I-5 / m-2 / m-6）", () => {
  it("★PDF から取り出した本文を返す（確認画面の左側で突き合わせられるように）", async () => {
    pdfText = "■物件所在地： 東京都A区B1-2-3（地番552-2）\n■物件種別： 一般住宅\n■建物構造： 木造スレート葺\n■間取り： 2LDK" + NL + "■お名前： 山田太郎";
    const res = await POST(await pdfReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.extractedText).toBe(pdfText);
    expect(body.draft.property.address.value).toBe("東京都A区B1-2-3");
  });

  it("★貼り付け経路では本文を返さない（画面が原文を持っているので往復させない）", async () => {
    const res = await POST(jsonReq({ text: "■物件所在地： 東京都A区B1-2-3" }));
    const body = await res.json();
    expect(body.extractedText).toBeNull();
  });

  it("★PDF の上限は確定側(MAX_FILE_SIZE)と同じで、案内文言もその数字を出す", async () => {
    const { MAX_FILE_SIZE } = await import("@/lib/storage");
    const res = await POST(await pdfReq(MAX_FILE_SIZE + 1));
    expect(res.status).toBe(400);
    const body = await res.json();
    // 「10MBまで」と案内して 8MB で弾く食い違いを作らない。
    expect(body.error.message).toContain(String(MAX_FILE_SIZE / 1024 / 1024));
    expect(body.error.message).not.toContain("10MB");
  });

  it("★文字が数文字しか取れないPDF(スキャン画像)は、空でなくても断る", async () => {
    // isLikelyScannedPdf は50文字未満を「読めていない」とみなす。
    // trim()==="" 判定では、雑音を数文字吐くスキャンPDFが素通りしていた。
    pdfText = "  ・  ";
    const res = await POST(await pdfReq());
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("文字が入っていません");
  });

  it("★長すぎるPDFの断り文言は「貼り付けた文章」と言わない", async () => {
    pdfText = "あ".repeat(200_001);
    const res = await POST(await pdfReq());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("PDF");
    expect(body.error.message).not.toContain("貼り付けた文章");
  });

  it("貼り付け経路の長すぎる断り文言は従来どおり「貼り付けた文章」", async () => {
    const res = await POST(jsonReq({ text: "あ".repeat(200_001) }));
    expect((await res.json()).error.message).toContain("貼り付けた文章");
  });
});

describe("氏名の先頭1文字（全体レビュー m-1）", () => {
  it("★サロゲートペアで始まる姓「𠮷田」でも前方一致の種にできる（半分に割らない）", async () => {
    mockOwnerFindMany.mockResolvedValue([
      { id: "sp1", name: "𠮷田太郎", currentAddress: null, address: null },
    ]);
    const res = await POST(
      jsonReq({ text: "■物件所在地： 東京都A区B1-2-3" + NL + "■お名前： 𠮷田太郎" }),
    );
    expect(res.status).toBe(200);
    const args = mockOwnerFindMany.mock.calls[0][0] as {
      where?: { OR?: { name?: { startsWith?: string } }[] };
    };
    const prefixes = (args.where?.OR ?? []).map((o) => o.name?.startsWith);
    // slice(0,1) だと壊れた片割れ(長さ1)しか渡らない。
    expect(prefixes).toContain("𠮷");
    expect(prefixes.every((x) => x !== undefined && Array.from(x).length === 1)).toBe(true);
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([
      { id: "sp1", name: "𠮷田太郎", matchKind: "name_only" },
    ]);
  });
});

// ===========================================================================
// @codex PR#414 P2: 住所の重複候補を「生値の contains」で引いていた
//   本番実測(2026-08-26・properties の is_archived=false 669件):
//     全角英数を含む 665件(99.4%) / 全角ハイフン類 659件 / 空白を含む 0件
//   本番の住所はほぼ全件が全角。貼り付け元(Webフォーム)は半角。生値では
//   ほぼ1件も候補にならず、住所による重複警告が実質的に機能していなかった。
// ===========================================================================

describe("住所の重複候補は全角/半角の違いを越えて見つかる", () => {
  /**
   * DB に住所1件だけがある状態を再現する。
   * ⚠**where を実際に適用する**。素通しで返すモックだと、生値の contains に
   *   戻しても「候補に入った」ことになり(=本番では1件も返らないのに)緑のまま
   *   通ってしまう。ここは「どう引いたか」で結果が変わることが本題なので、
   *   contains / startsWith を**生の格納値に対して**評価する。
   */
  function dbAddress(address: string) {
    const row = {
      id: "p-existing",
      address,
      lotNumber: null,
      externalLinkKey: null,
      createdBy: "user-1",
      assignedTo: null,
    };
    mockFindMany.mockImplementation(
      async (args: { where?: { externalLinkKey?: string; address?: { contains?: string; startsWith?: string } } }) => {
        if (args?.where?.externalLinkKey) return [];
        const cond = args?.where?.address;
        if (!cond) return [];
        if (typeof cond.startsWith === "string") {
          return address.startsWith(cond.startsWith) ? [row] : [];
        }
        if (typeof cond.contains === "string") {
          return address.includes(cond.contains) ? [row] : [];
        }
        return [];
      },
    );
  }

  it("★本番の実態=DBが全角「東京都Ａ区Ｂ１－２－３」、貼り付けが半角「東京都A区B1-2-3」で候補に入る", async () => {
    dbAddress("東京都Ａ区Ｂ１－２－３");
    const res = await POST(jsonReq({ text: "■物件所在地： 東京都A区B1-2-3" }));
    const body = await res.json();
    expect(body.similar.map((x: { id: string }) => x.id)).toEqual(["p-existing"]);
    expect(body.duplicates.similarPropertyIds).toEqual(["p-existing"]);
  });

  it("★逆方向=DBが半角、貼り付けが全角でも候補に入る", async () => {
    dbAddress("東京都A区B1-2-3");
    const res = await POST(jsonReq({ text: "■物件所在地： 東京都Ａ区Ｂ１－２－３" }));
    const body = await res.json();
    expect(body.similar.map((x: { id: string }) => x.id)).toEqual(["p-existing"]);
  });

  it("★別の住所は候補に入らない（広げすぎていない）", async () => {
    dbAddress("東京都Ａ区Ｂ９－９－９");
    const res = await POST(jsonReq({ text: "■物件所在地： 東京都A区B1-2-3" }));
    const body = await res.json();
    expect(body.similar).toEqual([]);
    expect(body.duplicates.blocked).toBe(false);
  });

  it("★DBへの問い合わせは生値の contains ではなく、幅の別が無いCJK前方一致で行う", async () => {
    // 「どう引いたか」まで固定する。contains に戻すと、本番データ(ほぼ全角)では
    // 1件も返らなくなるが、モックは何を渡されても返すので結果だけでは気づけない。
    await POST(jsonReq({ text: "■物件所在地： 東京都世田谷区等々力2丁目15番12号" }));
    const addressCall = mockFindMany.mock.calls
      .map((c) => c[0] as { where?: { address?: Record<string, unknown>; isArchived?: boolean }; take?: number })
      .find((a) => a?.where?.address !== undefined);
    expect(addressCall).toBeDefined();
    expect(addressCall!.where!.address).toEqual({ startsWith: "東京都世田谷区等々力" });
    expect(addressCall!.where!.address).not.toHaveProperty("contains");
    // 取得上限とアーカイブ除外は維持する。
    expect(addressCall!.where!.isArchived).toBe(false);
    expect(addressCall!.take).toBe(300);
  });
});

// ===========================================================================
// 外部キー(査定ナンバー)の表記ゆれ（@codex PR#414 の報告 → 発注者判断 2026-08-26）
//   本番実測: 外部キーを持つ物件は 669件中 0件。今日は踏めないが、この列に
//   今後書くのはほぼこの機能であり、**助言ロックの鍵が比較に使う鍵と一致して
//   いなければロックは何も守らない**ため、入口で1回だけ正規化して揃える。
// ===========================================================================

describe("外部キーは全角/半角の別を越えて突き合わせる", () => {
  /**
   * DB に外部キー付きの物件が1件だけある状態。
   * ⚠**where を実際に適用する**(素通しのモックだと、正規化を戻しても
   *   「見つかった」ことになり緑のまま通る＝バグを直ったと証明してしまう)。
   */
  function dbExternalKey(stored: string) {
    const row = {
      id: "p-key",
      address: "東京都A区B1-2-3",
      lotNumber: null,
      externalLinkKey: stored,
      createdBy: "user-1",
      assignedTo: null,
    };
    mockFindMany.mockImplementation(
      async (args: { where?: { externalLinkKey?: { in?: string[] }; address?: { startsWith?: string; contains?: string } } }) => {
        if (args?.where?.externalLinkKey) {
          return (args.where.externalLinkKey.in ?? []).includes(stored) ? [row] : [];
        }
        const cond = args?.where?.address;
        if (cond && typeof cond.startsWith === "string") {
          return row.address.startsWith(cond.startsWith) ? [row] : [];
        }
        return [];
      },
    );
  }

  it("★貼り付けが全角「ＳＡ２６０８－１２３４５６７」でも、半角で保存された既存物件が見つかりブロックされる", async () => {
    dbExternalKey("SA2608-1234567");
    const res = await POST(
      jsonReq({ text: "■査定ナンバー： ＳＡ２６０８－１２３４５６７" + NL + "■物件所在地： 東京都A区B1-2-3" }),
    );
    const body = await res.json();
    expect(body.duplicates.blocked).toBe(true);
    expect(body.duplicates.blockedByPropertyId).toBe("p-key");
  });

  it("★逆方向=貼り付けが半角、既存データの保存が全角でも見つかりブロックされる", async () => {
    // 今回の方針(保存も正規化後に揃える)ではこの組み合わせは新たに生まれないが、
    // CSV 取込などで既に全角が入っている行を取りこぼさないことを見る。
    // ⚠この向きでは外部キーの完全一致クエリは当たらない。住所の候補として
    //   取れた行を judgeDuplicates が normalizeForCompare で突き合わせて
    //   ブロックする経路で拾う(=正規化した比較が実際に効いている)。
    dbExternalKey("ＳＡ２６０８－１２３４５６７");
    const res = await POST(
      jsonReq({ text: "■査定ナンバー： SA2608-1234567" + NL + "■物件所在地： 東京都A区B1-2-3" }),
    );
    const body = await res.json();
    expect(body.duplicates.blocked).toBe(true);
    expect(body.duplicates.blockedByPropertyId).toBe("p-key");
  });

  it("★CSV取込が全角で入れた既存行は、住所が違っていても外部キーだけで見つかりブロックされる", async () => {
    // @codex PR#414 2巡目 P2: CSV取込(src/app/api/import/csv/route.ts)は
    // externalLinkKey を**生値のまま**保存する。全角で入った行は、正規化後(半角)の
    // 完全一致だけでは見つからない。住所も違う＝住所の候補にも入らないので、
    // 外部キーのクエリが全角形も見ていなければ、この二重登録は素通りする。
    const row = {
      id: "p-key-fw",
      address: "大阪府C区D9-9-9",
      lotNumber: null,
      externalLinkKey: "ＳＡ２６０８－１２３４５６７",
      createdBy: "user-1",
      assignedTo: null,
    };
    mockFindMany.mockImplementation(
      async (args: { where?: { externalLinkKey?: { in?: string[] }; address?: { startsWith?: string } } }) => {
        if (args?.where?.externalLinkKey) {
          return (args.where.externalLinkKey.in ?? []).includes(row.externalLinkKey) ? [row] : [];
        }
        const cond = args?.where?.address;
        if (cond && typeof cond.startsWith === "string") {
          return row.address.startsWith(cond.startsWith) ? [row] : [];
        }
        return [];
      },
    );
    const res = await POST(
      jsonReq({ text: "■査定ナンバー： SA2608-1234567" + NL + "■物件所在地： 東京都A区B1-2-3" }),
    );
    const body = await res.json();
    expect(body.duplicates.blocked).toBe(true);
    expect(body.duplicates.blockedByPropertyId).toBe("p-key-fw");
  });

  it("★下書きが返す外部キーは正規化済み（画面がそのまま commit へ渡すため）", async () => {
    const res = await POST(
      jsonReq({ text: "■査定ナンバー： ＳＡ２６０８－１２３４５６７" + NL + "■物件所在地： 東京都A区B1-2-3" }),
    );
    const body = await res.json();
    expect(body.draft.externalLinkKey).toBe("SA2608-1234567");
  });

  it("★DBへの問い合わせにも正規化後の値を使う（生値で引かない）", async () => {
    await POST(
      jsonReq({ text: "■査定ナンバー： ＳＡ２６０８－１２３４５６７" + NL + "■物件所在地： 東京都A区B1-2-3" }),
    );
    const keyCall = mockFindMany.mock.calls
      .map((c) => c[0] as { where?: { externalLinkKey?: { in?: string[] } } })
      .find((a) => a?.where?.externalLinkKey !== undefined);
    // 正規化後(半角)を必ず含み、CSV取込が生値で入れた全角形も併せて見る。
    expect(keyCall?.where?.externalLinkKey?.in).toEqual([
      "SA2608-1234567",
      "ＳＡ２６０８－１２３４５６７",
    ]);
  });
});

describe("下書きAPIの multipart も formData() の前に大きさを見る（P1②）", () => {
  it("★Content-Length が上限超過なら413で、PDFの解析にも到達しない", async () => {
    const { MAX_FILE_SIZE } = await import("@/lib/storage");
    const fd = new FormData();
    fd.append("file", new File([Buffer.from("%PDF-1.4")], "x.pdf", { type: "application/pdf" }));
    const blob = await new Response(fd).blob();
    const tooBig = new NextRequest("http://localhost/api/import/paste", {
      method: "POST",
      body: blob,
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(MAX_FILE_SIZE + 2 * 1024 * 1024),
      },
    });
    const res = await POST(tooBig);
    expect(res.status).toBe(413);
  });

  it("★Content-Length が無い multipart は411", async () => {
    const fd = new FormData();
    fd.append("file", new File([Buffer.from("%PDF-1.4")], "x.pdf", { type: "application/pdf" }));
    const blob = await new Response(fd).blob();
    const noLen = new NextRequest("http://localhost/api/import/paste", {
      method: "POST",
      body: blob,
      headers: { "content-type": "multipart/form-data; boundary=x" },
    });
    const res = await POST(noLen);
    expect(res.status).toBe(411);
  });

  it("通常の大きさのPDFは従来どおり通る", async () => {
    const res = await POST(await pdfReq());
    expect(res.status).toBe(200);
  });
});
