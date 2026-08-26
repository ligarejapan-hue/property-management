import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSession = { id: "user-1" };
// ⚠granted: true が無いと hasPermission は全件 false を返す(このリポジトリの
//   テスト作法のハマりどころ)。brief の見本にこのキーが抜けていたので補った。
const FULL_PERMS = [
  { resource: "import", action: "write", granted: true },
  { resource: "property", action: "write", granted: true },
  { resource: "owner", action: "write", granted: true },
];
let mockPerms: unknown = FULL_PERMS;
const created: Record<string, unknown[]> = {};
const auditCalls: unknown[] = [];
/** lockPropertyRow / advisory lock (→$queryRaw) と create の呼び出し順を記録する。 */
const callOrder: string[] = [];
/** $queryRaw / $executeRaw に渡された SQL 断片(結合済み)。 */
const sqlSeen: string[] = [];
/** advisory lock に**実際に渡された値**(第2引数以降)。キーの取り違えを検出する。 */
const advisoryLockValues: unknown[][] = [];
/** property.findFirst に渡された引数。 */
const findFirstArgs: unknown[] = [];
/** 外部キー一致で既に存在する物件の id (null = 未登録)。 */
let existingByExternalKey: string | null = null;

// ⚠api-helpers を vi.importActual すると実物の "@/lib/auth" まで読み込まれ、
//   next-auth 内部の拡張子なし "next/server" import が node の ESM 解決に失敗する
//   (src/app/api/import/paste/__tests__/route.test.ts と同じ回避)。
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

// リポジトリ内の route テスト全てが NextRequest をこの形で mock している。
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
vi.mock("@/lib/audit", () => ({
  writeAuditLog: vi.fn(async (input: unknown) => { auditCalls.push(input); }),
}));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    getStorage: vi.fn(() => ({
      upload: vi.fn(async () => ({
        url: "https://storage.local/properties/x/paste-import/x.pdf",
        key: "properties/x/paste-import/x.pdf",
      })),
      delete: vi.fn(async () => {}),
      getUrl: vi.fn(async () => ""),
      read: vi.fn(async () => null),
      keyFromUrl: vi.fn(() => null),
    })),
  };
});
vi.mock("@/lib/prisma", () => {
  const tx = {
    property: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        callOrder.push("property.create");
        (created.property ??= []).push(data);
        return { id: "new-prop", ...(data as object) };
      }),
      findUnique: vi.fn(async () => ({ id: "new-prop" })),
      // 外部キーによる登録済み判定。existingByExternalKey に id を入れると
      // 「既に登録済み」を再現できる。
      findFirst: vi.fn(async (args: { where?: { externalLinkKey?: string } }) => {
        callOrder.push("property.findFirst");
        findFirstArgs.push(args);
        return existingByExternalKey === null ? null : { id: existingByExternalKey };
      }),
    },
    owner: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        (created.owner ??= []).push(data);
        return { id: "new-owner", ...(data as object) };
      }),
      findFirst: vi.fn(async () => null),
    },
    propertyOwner: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        (created.propertyOwner ??= []).push(data);
        return { id: "po-1" };
      }),
    },
    attachment: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        callOrder.push("attachment.create");
        (created.attachment ??= []).push(data);
        return { id: "att-1", ...(data as object) };
      }),
    },
    // ⚠2種類の生SQLが走る。**呼び分けている API も違う**:
    //     - 親の物件行ロック(lockPropertyRow) … $queryRaw (行を読む)
    //     - advisory lock                     … $executeRaw (行を返さない)
    //   advisory lock を $queryRaw で書くと、driver adapter 構成(PrismaPg)では
    //   pg_advisory_xact_lock の戻り型 void(OID 2278)を変換できず本番で必ず
    //   例外になる。ここで**どちらの API に来たか**まで記録し、$queryRaw 側に
    //   advisory lock が来たら名指しで落とす(下の専用テスト)。
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join(" ") : String(strings);
      sqlSeen.push(sql);
      if (sql.includes("pg_advisory_xact_lock")) {
        // 順序テストが「ロックはあった」と誤って緑にならないよう、別名で積む。
        callOrder.push("advisoryLockViaQueryRaw");
      } else {
        callOrder.push("lockPropertyRow");
      }
      return [{ id: "new-prop" }];
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Array.isArray(strings) ? strings.join(" ") : String(strings);
      sqlSeen.push(sql);
      if (sql.includes("pg_advisory_xact_lock")) {
        callOrder.push("advisoryLock");
        advisoryLockValues.push(values);
      } else {
        callOrder.push("executeRaw:other");
      }
      return 0;
    }),
  };
  return { prisma: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)), ...tx } };
});

import { POST } from "../route";
import { NextRequest } from "next/server";

const req = (body: unknown) => {
  const s = JSON.stringify(body);
  // ⚠assertImportJsonBodySize(@/lib/import-body-size) は content-length ヘッダを
  //   要求する(欠落は411)。実ブラウザの fetch は JSON body に自動で付けるが、
  //   NextRequest を直接組み立てるテストでは自分で付けないと本文の
  //   パース前ガードを通れない(src/app/api/import/paste/__tests__/route.test.ts
  //   の jsonReq と同じ理由・Task 8 レビュー Important 対応)。
  return new NextRequest("http://localhost/api/import/paste/commit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(s)),
    },
    body: s,
  });
};

/** %PDF- マジックバイトを持つ最小限の PDF バイナリ。 */
function pdfFile(name = "shokai.pdf"): File {
  return new File([Buffer.from("%PDF-1.4\n%%EOF")], name, { type: "application/pdf" });
}

/** multipart/form-data で data(JSON文字列) + file(PDF) を送るリクエストを作る。 */
async function multipartReq(body: unknown, file: File | null): Promise<NextRequest> {
  const fd = new FormData();
  fd.append("data", JSON.stringify(body));
  if (file) fd.append("file", file);
  const blob = await new Response(fd).blob();
  return new NextRequest("http://localhost/api/import/paste/commit", {
    method: "POST",
    body: blob,
    headers: { "content-length": String(blob.size) },
  });
}

const baseBody = {
  property: {
    address: "東京都A区B1-2-3",
    lotNumber: "552-2",
    propertyType: "house",
    buildingName: null, roomNo: null, exclusiveArea: null,
    layoutType: null, occupancyStatus: null, note: "建物構造: 木造",
  },
  owner: null,
  externalLinkKey: null,
};

beforeEach(() => {
  // ⚠vi.fn() の呼び出し回数はテスト間で自動リセットされない(vitest.config.ts に
  //   clearMocks 設定なし)。「1つのトランザクションで作る」テストが他テストの
  //   累積呼び出しを拾って失敗するのを防ぐ(実装の実装をREADME通りにモックの実装
  //   自体はここでは消えない=clearAllMocksは呼び出し履歴だけを消す)。
  vi.clearAllMocks();
  mockPerms = FULL_PERMS;
  existingByExternalKey = null;
  for (const k of Object.keys(created)) delete created[k];
  auditCalls.length = 0;
  callOrder.length = 0;
  sqlSeen.length = 0;
  advisoryLockValues.length = 0;
  findFirstArgs.length = 0;
});

describe("POST /api/import/paste/commit", () => {
  it("物件を作って id を返す", async () => {
    const res = await POST(req(baseBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.propertyId).toBe("new-prop");
    expect(created.property?.[0]).toMatchObject({
      address: "東京都A区B1-2-3",
      lotNumber: "552-2",
      propertyType: "house",
      introductionRoute: "web_inquiry",
      caseStatus: "new_case",
      createdBy: "user-1",
    });
  });

  it("★所有者の住所は currentAddress に入れる(登記上住所には入れない)", async () => {
    await POST(req({
      ...baseBody,
      owner: {
        name: "山田太郎", nameKana: "ヤマダタロウ",
        phone: "09000000000", email: "a@example.jp",
        currentAddress: "東京都A区B1-2-3",
      },
    }));
    expect(created.owner?.[0]).toMatchObject({
      name: "山田太郎",
      currentAddress: "東京都A区B1-2-3",
    });
    expect(created.owner?.[0]).not.toHaveProperty("address");
  });

  it("★物件の権限が無ければ403", async () => {
    mockPerms = [];
    const res = await POST(req(baseBody));
    expect(res.status).toBe(403);
  });

  it("★所有者を作るのに owner:write が無ければ403", async () => {
    mockPerms = [{ resource: "property", action: "write", granted: true }];
    const res = await POST(req({ ...baseBody, owner: { name: "山田太郎" } }));
    expect(res.status).toBe(403);
  });

  it("★linkExistingOwnerIdだけでも owner:write が無ければ403(権限迂回路が無いことの固定)", async () => {
    mockPerms = [{ resource: "property", action: "write", granted: true }];
    const res = await POST(req({ ...baseBody, linkExistingOwnerId: "existing-owner-1" }));
    expect(res.status).toBe(403);
  });

  it("★linkExistingOwnerId を送ると owner.create は呼ばれず、propertyOwner.create だけが呼ばれる", async () => {
    const res = await POST(req({ ...baseBody, linkExistingOwnerId: "existing-owner-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ownerId).toBe("existing-owner-1");
    expect(created.owner).toBeUndefined();
    expect(created.propertyOwner?.[0]).toMatchObject({
      propertyId: body.propertyId,
      ownerId: "existing-owner-1",
    });
  });

  it("住所が無ければ400", async () => {
    const res = await POST(req({ ...baseBody, property: { ...baseBody.property, address: "" } }));
    expect(res.status).toBe(400);
  });

  it("★監査ログに氏名・電話・メール・住所を入れない", async () => {
    await POST(req({
      ...baseBody,
      owner: { name: "山田太郎", phone: "09000000000", email: "a@example.jp",
               currentAddress: "東京都A区B1-2-3", nameKana: null },
    }));
    const dumped = JSON.stringify(auditCalls);
    expect(dumped).not.toContain("山田太郎");
    expect(dumped).not.toContain("09000000000");
    expect(dumped).not.toContain("a@example.jp");
    expect(dumped).not.toContain("東京都A区B1-2-3");
    expect(dumped).toContain("new-prop");
  });

  it("★1つのトランザクションで作る", async () => {
    const { prisma } = await import("@/lib/prisma");
    await POST(req(baseBody));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  // ---- Step 4: PDF を投入した場合の添付作成 ----
  describe("PDFを投入した場合", () => {
    it("添付を作り、親の物件行ロックの後に作成する", async () => {
      const res = await POST(await multipartReq(baseBody, pdfFile("shokai.pdf")));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(created.attachment?.[0]).toMatchObject({
        targetType: "property",
        targetId: body.propertyId,
        propertyId: body.propertyId,
        fileName: "shokai.pdf",
        mimeType: "application/pdf",
        uploadedBy: "user-1",
      });
      // 親行ロック(lockPropertyRow → $queryRaw)が attachment.create より先。
      const lockIdx = callOrder.indexOf("lockPropertyRow");
      const createIdx = callOrder.indexOf("attachment.create");
      expect(lockIdx).toBeGreaterThanOrEqual(0);
      expect(createIdx).toBeGreaterThan(lockIdx);
    });

    it("PDFが無ければ添付を作らない", async () => {
      await POST(req(baseBody));
      expect(created.attachment).toBeUndefined();
    });

    it("PDFではないファイルは400", async () => {
      const notPdf = new File([Buffer.from("not a pdf")], "x.txt", { type: "text/plain" });
      const res = await POST(await multipartReq(baseBody, notPdf));
      expect(res.status).toBe(400);
    });

    it("監査ログに添付があっても原文・PII は入らない", async () => {
      await POST(await multipartReq({
        ...baseBody,
        owner: { name: "山田太郎", phone: "09000000000", email: "a@example.jp",
                 currentAddress: "東京都A区B1-2-3", nameKana: null },
      }, pdfFile("shokai.pdf")));
      const dumped = JSON.stringify(auditCalls);
      expect(dumped).not.toContain("山田太郎");
      expect(dumped).not.toContain("shokai.pdf");
    });
  });
});

// ===========================================================================
// 全体レビュー Critical 1 / I-1 / I-3
// ===========================================================================

describe("二重登録は確定側(サーバー)で止める", () => {
  const withKey = { ...baseBody, externalLinkKey: "SA2608-1234567" };

  it("★同じ外部キーの物件が既にあれば409を返し、何も作らない", async () => {
    existingByExternalKey = "prop-existing-1";
    const res = await POST(req(withKey));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain("この案件は登録済みです");
    // 物件・所有者・紐付けのどれも作られていない。
    expect(created.property).toBeUndefined();
    expect(created.owner).toBeUndefined();
    expect(created.propertyOwner).toBeUndefined();
    // 監査ログも書かない(作っていないので)。
    expect(auditCalls).toEqual([]);
  });

  it("★所有者つきでも409のときは所有者を作らない", async () => {
    existingByExternalKey = "prop-existing-1";
    const res = await POST(req({
      ...withKey,
      owner: { name: "山田太郎", nameKana: null, phone: null, email: null, currentAddress: null },
    }));
    expect(res.status).toBe(409);
    expect(created.owner).toBeUndefined();
  });

  it("★advisory lock を、存在確認より**先に**取る(順序を固定する)", async () => {
    // ⚠これが逆だと、READ COMMITTED では待っている間に他トランザクションが
    //   確定させた行が見えず(#402 で実測済み)、素通りして二重登録になる。
    await POST(req(withKey));
    const lockIdx = callOrder.indexOf("advisoryLock");
    const findIdx = callOrder.indexOf("property.findFirst");
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(findIdx).toBeGreaterThan(lockIdx);
    // 実際に advisory lock の SQL を投げていること(名前だけの偽装を防ぐ)。
    expect(sqlSeen.some((q) => q.includes("pg_advisory_xact_lock"))).toBe(true);
  });

  it("★advisory lock は $executeRaw で投げる（$queryRaw だと本番で必ず例外になる）", async () => {
    // driver adapter 構成(src/lib/prisma.ts の PrismaPg)では、$queryRaw は
    // 返却列の型 OID を必ず変換する。pg_advisory_xact_lock の戻り型は
    // void(OID 2278)で変換先が無く UnsupportedNativeDataType を投げる。
    // = 査定ナンバーのある登録(この機能の主経路)が毎回500になり、
    //   二重登録ガードは一度も働かない。
    const { prisma } = await import("@/lib/prisma");
    await POST(req(withKey));
    expect(callOrder).toContain("advisoryLock");
    expect(callOrder).not.toContain("advisoryLockViaQueryRaw");
    const executeSql = (prisma.$executeRaw as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => (Array.isArray(c[0]) ? (c[0] as string[]).join(" ") : ""));
    expect(executeSql.some((q) => q.includes("pg_advisory_xact_lock"))).toBe(true);
    // ::bigint も既存の前例(reception-property/route.ts)に合わせる。
    expect(executeSql.some((q) => q.includes("::bigint"))).toBe(true);
  });

  it("★ロックのキーは、その案件の外部キーそのもの（全件が1本のロックに直列化されない）", async () => {
    // SQL 文字列だけを見ていると、hashtext('paste-import') のような固定値へ
    // 書き換えても緑のまま通ってしまう(＝全ての登録が1本のロックで直列化されても
    // 気づけない)。埋め込まれた**値**まで見る。
    await POST(req({ ...withKey, externalLinkKey: "SA2608-7654321" }));
    expect(advisoryLockValues).toHaveLength(1);
    expect(advisoryLockValues[0]).toEqual(["SA2608-7654321"]);
  });

  it("★存在確認は物件の作成より**先**(作ってから気づくのでは遅い)", async () => {
    await POST(req(withKey));
    const findIdx = callOrder.indexOf("property.findFirst");
    const createIdx = callOrder.indexOf("property.create");
    expect(findIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(findIdx);
  });

  it("★存在確認は isArchived: false の同じ外部キーで引く", async () => {
    await POST(req(withKey));
    expect(findFirstArgs[0]).toMatchObject({
      where: { externalLinkKey: "SA2608-1234567", isArchived: false },
    });
  });

  it("★外部キーが無ければロックも存在確認もせず、これまで通り登録できる", async () => {
    const res = await POST(req(baseBody));
    expect(res.status).toBe(200);
    expect(callOrder).not.toContain("advisoryLock");
    expect(callOrder).not.toContain("property.findFirst");
    expect(created.property?.[0]).toMatchObject({ address: "東京都A区B1-2-3" });
  });

  it("外部キーがあり、まだ登録されていなければ登録できる", async () => {
    existingByExternalKey = null;
    const res = await POST(req(withKey));
    expect(res.status).toBe(200);
    expect(created.property?.[0]).toMatchObject({ externalLinkKey: "SA2608-1234567" });
  });
});

describe("取込系routeの共通ゲート(import:write)", () => {
  it("★import:write が無ければ403(全体レビュー I-1)", async () => {
    mockPerms = FULL_PERMS.filter((p) => p.resource !== "import");
    const res = await POST(req(baseBody));
    expect(res.status).toBe(403);
    expect(created.property).toBeUndefined();
  });
});

describe("入力の検査: 直せる形の400で断る(500に化けさせない・全体レビュー I-3)", () => {
  const area = (v: string) => ({ ...baseBody, property: { ...baseBody.property, exclusiveArea: v } });

  it("★専有面積に単位が付いていたら400で、どの欄かを伝える", async () => {
    const res = await POST(req(area("70㎡")));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("専有面積");
    expect(created.property).toBeUndefined();
  });

  it("★専有面積が「約70」でも400", async () => {
    const res = await POST(req(area("約70")));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("専有面積");
  });

  it("★桁数があふれる値（日付を貼ってしまった等）は400。Decimal(8,2)の汎用500に戻さない", async () => {
    // 列は Decimal(8,2) = 整数部6桁まで。見出しの取り違えで「20250815」が
    // 面積欄に入ると、桁数を見ない正規表現は通し、PostgreSQL 側があふれて
    // I-3 で消したはずの「サーバーエラーが発生しました」に逆戻りする。
    const res = await POST(req(area("20250815")));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("専有面積");
    expect(created.property).toBeUndefined();
  });

  it("★小数は2桁まで(3桁は400)", async () => {
    expect((await POST(req(area("70.123")))).status).toBe(400);
  });

  it("整数6桁・小数2桁ちょうどは通る(境界)", async () => {
    const res = await POST(req(area("999999.99")));
    expect(res.status).toBe(200);
    expect(created.property?.[0]).toMatchObject({ exclusiveArea: "999999.99" });
  });

  it("専有面積が素の数字なら通る(小数も)", async () => {
    expect((await POST(req(area("70")))).status).toBe(200);
    expect(created.property?.[0]).toMatchObject({ exclusiveArea: "70" });
  });

  it("専有面積が空欄なら null で通る(未入力は誤りではない)", async () => {
    const res = await POST(req(area("")));
    expect(res.status).toBe(200);
    expect(created.property?.[0]).toMatchObject({ exclusiveArea: null });
  });

  it("★物件種別が enum に無い値なら400", async () => {
    const res = await POST(req({
      ...baseBody,
      property: { ...baseBody.property, propertyType: "一般住宅" },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("物件種別");
    expect(created.property).toBeUndefined();
  });

  it("★現況が enum に無い値なら400", async () => {
    const res = await POST(req({
      ...baseBody,
      property: { ...baseBody.property, occupancyStatus: "居住中" },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("現況");
    expect(created.property).toBeUndefined();
  });

  it("現況が enum の値なら通る", async () => {
    const res = await POST(req({
      ...baseBody,
      property: { ...baseBody.property, occupancyStatus: "occupied" },
    }));
    expect(res.status).toBe(200);
    expect(created.property?.[0]).toMatchObject({ occupancyStatus: "occupied" });
  });
});
