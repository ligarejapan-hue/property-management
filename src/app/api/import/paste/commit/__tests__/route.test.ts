import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSession = { id: "user-1" };
// ⚠granted: true が無いと hasPermission は全件 false を返す(このリポジトリの
//   テスト作法のハマりどころ)。brief の見本にこのキーが抜けていたので補った。
// ⚠所有者の**項目ごと**の書き込み権限も要る(owners/route.ts と同じ規則)。
//   hasExplicitWritePerm は action が "full" か "edit" のときだけ true。
const FULL_PERMS = [
  { resource: "import", action: "write", granted: true },
  { resource: "property", action: "write", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_name", action: "full", granted: true },
  { resource: "owner_name_kana", action: "full", granted: true },
  { resource: "owner_phone", action: "full", granted: true },
  { resource: "owner_email", action: "full", granted: true },
  { resource: "owner_address", action: "full", granted: true },
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
/** DB に保存されている外部キーの文字列(null = 渡された値に関わらず一致とみなす)。 */
let storedExternalKey: string | null = null;
/** 既存所有者が紐付け可能か(false = アーカイブ済み/削除済み)。 */
let ownerLinkable = true;
/** owner.updateMany に渡された引数。 */
const ownerUpdateManyArgs: unknown[] = [];
/** storage.upload に**要求した** key / アダプタが実際に**保存した** key / delete に渡された key。 */
const requestedKeys: string[] = [];
const storedKeys: string[] = [];
const deletedKeys: string[] = [];
/** アダプタが要求と違う key へ保存する状況の再現(null = 要求どおり)。 */
let storedKeyOverride: string | null = null;

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
      // ⚠upload に渡された key を控える。孤児 PDF の削除が「アップロードした
      //   その key」で呼ばれたかを確かめるため(固定文字列の assert では、
      //   別の key を消していても緑になる)。
      // ⚠**要求した key と、実際に保存された key を分けて返す**。本番の server
      //   アダプタは最終的な保存先を返すため、要求 key で消しに行くと存在しない
      //   パスを消して実物は孤児のまま残る。requestedKeys / storedKeys を
      //   別々に記録し、削除が**返ってきた方**で呼ばれることを見る。
      upload: vi.fn(async (_buf: unknown, opts: { key: string }) => {
        requestedKeys.push(opts.key);
        const stored = storedKeyOverride ?? opts.key;
        storedKeys.push(stored);
        return {
          url: "https://storage.local/properties/x/paste-import/x.pdf",
          key: stored,
        };
      }),
      delete: vi.fn(async (key: string) => { deletedKeys.push(key); }),
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
      // ⚠**where を実際に適用する**。素通しで「あり」を返すモックだと、
      //   検索する値がロックの鍵や保存値とずれても緑のまま通ってしまう。
      //   storedExternalKey が入っているときは、渡された値と一致したときだけ返す。
      findFirst: vi.fn(async (args: { where?: { externalLinkKey?: { in?: string[] } } }) => {
        callOrder.push("property.findFirst");
        findFirstArgs.push(args);
        if (existingByExternalKey === null) return null;
        if (storedExternalKey !== null) {
          // ⚠**where を実際に適用する**。検索が探した候補の中に、DB に保存されて
          //   いる表記が含まれているときだけ返す。
          const wanted = args?.where?.externalLinkKey?.in ?? [];
          if (!wanted.includes(storedExternalKey)) return null;
        }
        return { id: existingByExternalKey };
      }),
    },
    owner: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        (created.owner ??= []).push(data);
        return { id: "new-owner", ...(data as object) };
      }),
      findFirst: vi.fn(async () => null),
      // 既存所有者への紐付け前の「アーカイブ済みでないこと」の再確認＋行ロック。
      // ownerLinkable=false にすると count:0(=アーカイブ済み/削除済み)を再現できる。
      updateMany: vi.fn(async (args: { where?: { id?: string; isArchived?: boolean } }) => {
        callOrder.push("owner.updateMany");
        ownerUpdateManyArgs.push(args);
        return { count: ownerLinkable ? 1 : 0 };
      }),
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
  storedExternalKey = null;
  ownerLinkable = true;
  ownerUpdateManyArgs.length = 0;
  requestedKeys.length = 0;
  storedKeys.length = 0;
  deletedKeys.length = 0;
  storedKeyOverride = null;
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
      where: { externalLinkKey: { in: ["SA2608-1234567", "ＳＡ２６０８－１２３４５６７"] }, isArchived: false },
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
  storedExternalKey = null;
  ownerLinkable = true;
  ownerUpdateManyArgs.length = 0;
  requestedKeys.length = 0;
  storedKeys.length = 0;
  deletedKeys.length = 0;
  storedKeyOverride = null;
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
  // ⚠専有面積は**区分マンション専用の欄**。種別が合わないと保存側で null に
  //   落ちる(10巡目 ①)ので、値そのものを見るテストでは種別を区分にする。
  const area = (v: string) => ({
    ...baseBody,
    property: { ...baseBody.property, propertyType: "apartment_unit", exclusiveArea: v },
  });

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
      // 現況も区分専用の欄なので、値を見るときは種別を区分にする。
      property: { ...baseBody.property, propertyType: "apartment_unit", occupancyStatus: "occupied" },
    }));
    expect(res.status).toBe(200);
    expect(created.property?.[0]).toMatchObject({ occupancyStatus: "occupied" });
  });
});

// ===========================================================================
// @codex PR#414 の指摘
// ===========================================================================

describe("所有者の項目ごとの書き込み権限（P1-1）", () => {
  const ownerWith = (over: Record<string, string | null>) => ({
    ...baseBody,
    owner: {
      name: "山田太郎", nameKana: null, phone: null, email: null, currentAddress: null,
      ...over,
    },
  });

  it("★owner:write はあっても owner_phone が書けなければ、電話入りは403", async () => {
    // 通常の所有者作成(POST /api/owners)は項目ごとに権限を見ている。ここが
    // 素通しだと「この担当者には電話を触らせない」設定の迂回路になる。
    mockPerms = FULL_PERMS.filter((p) => p.resource !== "owner_phone");
    const res = await POST(req(ownerWith({ phone: "09000000000" })));
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toContain("電話番号");
    // 断るのはトランザクションより前＝物件も所有者も作らない。
    expect(created.property).toBeUndefined();
    expect(created.owner).toBeUndefined();
  });

  it("★同じ利用者でも、電話を空にすれば通る（書かない項目では止めない）", async () => {
    mockPerms = FULL_PERMS.filter((p) => p.resource !== "owner_phone");
    const res = await POST(req(ownerWith({ phone: "" })));
    expect(res.status).toBe(200);
    expect(created.owner?.[0]).toMatchObject({ name: "山田太郎", phone: null });
  });

  it("★現住所は owner_address の権限で見る（登記上住所と同じ機微度）", async () => {
    mockPerms = FULL_PERMS.filter((p) => p.resource !== "owner_address");
    const res = await POST(req(ownerWith({ currentAddress: "東京都A区B1-2-3" })));
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toContain("現住所");
  });

  it("★メールアドレスも owner_email の権限で見る", async () => {
    mockPerms = FULL_PERMS.filter((p) => p.resource !== "owner_email");
    const res = await POST(req(ownerWith({ email: "a@example.jp" })));
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toContain("メールアドレス");
  });

  it("★氏名そのものも owner_name の権限で見る", async () => {
    mockPerms = FULL_PERMS.filter((p) => p.resource !== "owner_name");
    const res = await POST(req(ownerWith({})));
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toContain("氏名");
  });

  it("★read レベルでは書けない（hasExplicitWritePerm は full/edit だけを通す）", async () => {
    mockPerms = [
      ...FULL_PERMS.filter((p) => p.resource !== "owner_phone"),
      { resource: "owner_phone", action: "read", granted: true },
    ];
    const res = await POST(req(ownerWith({ phone: "09000000000" })));
    expect(res.status).toBe(403);
  });

  it("既存所有者への紐付けだけなら、項目ごとの権限は要らない（何も書かないため）", async () => {
    mockPerms = FULL_PERMS.filter((p) => p.resource !== "owner_phone");
    const res = await POST(req({ ...baseBody, linkExistingOwnerId: "existing-owner-1" }));
    expect(res.status).toBe(200);
  });
});

describe("既存の所有者への紐付けはアーカイブ済みを弾く（P1-2）", () => {
  const linkBody = { ...baseBody, linkExistingOwnerId: "existing-owner-1" };

  it("★アーカイブ済みの所有者を指定したら409で、物件も作らない", async () => {
    ownerLinkable = false;
    const res = await POST(req(linkBody));
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain("この所有者は使用できません");
    // トランザクションごと巻き戻る＝物件も紐付けも残らない。
    expect(created.property).toBeUndefined();
    expect(created.propertyOwner).toBeUndefined();
  });

  it("★確認は isArchived: false つきの updateMany（存在確認だけで済ませない＝行ロックを兼ねる）", async () => {
    await POST(req(linkBody));
    expect(ownerUpdateManyArgs[0]).toMatchObject({
      where: { id: "existing-owner-1", isArchived: false },
    });
  });

  it("★ロックの順序は Owner → 物件（親→子の既存規約を崩さない）", async () => {
    // 添付ありの経路で、owner.updateMany が lockPropertyRow より先であること。
    await POST(await multipartReq(linkBody, pdfFile("shokai.pdf")));
    const ownerIdx = callOrder.indexOf("owner.updateMany");
    const propIdx = callOrder.indexOf("lockPropertyRow");
    expect(ownerIdx).toBeGreaterThanOrEqual(0);
    expect(propIdx).toBeGreaterThan(ownerIdx);
    // 物件の作成よりも前に確かめる（作ってから気づくのでは無駄が出る）。
    expect(callOrder.indexOf("property.create")).toBeGreaterThan(ownerIdx);
  });

  it("★新規に所有者を作るときは owner.updateMany を呼ばない（過剰な確認を足していない）", async () => {
    const res = await POST(req({
      ...baseBody,
      owner: { name: "山田太郎", nameKana: null, phone: null, email: null, currentAddress: null },
    }));
    expect(res.status).toBe(200);
    expect(callOrder).not.toContain("owner.updateMany");
  });

  it("アーカイブされていない所有者には従来どおり紐付けられる", async () => {
    const res = await POST(req(linkBody));
    expect(res.status).toBe(200);
    expect(created.propertyOwner?.[0]).toMatchObject({ ownerId: "existing-owner-1" });
  });
});

describe("外部キーは入口で1回だけ正規化し、保存・検索・ロックで同じ値を使う", () => {
  // ⚠いちばん重要なのはロック: 助言ロックの鍵が比較に使う鍵と一致していなければ、
  //   鍵がずれた瞬間に直列化が外れ、二重登録のガードが静かに無効になる。
  const FULL = "ＳＡ２６０８－１２３４５６７";
  const HALF = "SA2608-1234567";

  it("★全角で送られても、半角で保存された既存物件が見つかり409になる", async () => {
    existingByExternalKey = "prop-existing-1";
    storedExternalKey = HALF; // DB は半角で保存されている
    const res = await POST(req({ ...baseBody, externalLinkKey: FULL }));
    expect(res.status).toBe(409);
    expect(created.property).toBeUndefined();
  });

  it("★逆に半角で送られても、正規化後の値で引くので取りこぼさない", async () => {
    existingByExternalKey = "prop-existing-1";
    storedExternalKey = HALF;
    const res = await POST(req({ ...baseBody, externalLinkKey: HALF }));
    expect(res.status).toBe(409);
  });

  it("★保存する値そのものが正規化後の形（保存した値 == 検索する値 になる）", async () => {
    const res = await POST(req({ ...baseBody, externalLinkKey: FULL }));
    expect(res.status).toBe(200);
    expect(created.property?.[0]).toMatchObject({ externalLinkKey: HALF });
  });

  it("★助言ロックの鍵は、比較に使った値と同じ（鍵がずれたらロックは何も守らない）", async () => {
    await POST(req({ ...baseBody, externalLinkKey: FULL }));
    expect(advisoryLockValues[0]).toEqual([HALF]);
    // 3か所すべてが同じ文字列であることを一続きで確かめる。
    expect(findFirstArgs[0]).toMatchObject({
      where: { externalLinkKey: { in: [HALF, FULL] }, isArchived: false },
    });
    expect(created.property?.[0]).toMatchObject({ externalLinkKey: HALF });
  });

  it("★前後の空白も落とす（空白だけなら「無い」と同じに畳む）", async () => {
    const res = await POST(req({ ...baseBody, externalLinkKey: "  " }));
    expect(res.status).toBe(200);
    expect(callOrder).not.toContain("advisoryLock");
    expect(created.property?.[0]).toMatchObject({ externalLinkKey: null });
  });
});

// ===========================================================================
// @codex PR#414 2巡目
// ===========================================================================

describe("トランザクションが失敗したら、先に保存したPDFを消す（P1①）", () => {
  it("★409のとき、アップロード済みの key で storage.delete が呼ばれる", async () => {
    // ⚠孤児 PDF は Attachment 行を持たないため自動お掃除の対象外＝**消えないまま
    //   溜まり続ける**。中身は所有者の個人情報なので、容量ではなく個人情報の問題。
    existingByExternalKey = "prop-existing-1";
    const res = await POST(
      await multipartReq({ ...baseBody, externalLinkKey: "SA2608-1234567" }, pdfFile("shokai.pdf")),
    );
    expect(res.status).toBe(409);
    expect(storedKeys).toHaveLength(1);
    // 「消した」だけでなく「**保存されたその key を**消した」ことを見る。
    expect(deletedKeys).toEqual([storedKeys[0]]);
  });

  it("★アーカイブ済み所有者による409でも消す（409の経路が1つだけではない）", async () => {
    ownerLinkable = false;
    const res = await POST(
      await multipartReq({ ...baseBody, linkExistingOwnerId: "existing-owner-1" }, pdfFile()),
    );
    expect(res.status).toBe(409);
    expect(deletedKeys).toEqual([storedKeys[0]]);
  });

  it("★成功したときは消さない（消しすぎていない）", async () => {
    const res = await POST(await multipartReq(baseBody, pdfFile()));
    expect(res.status).toBe(200);
    expect(storedKeys).toHaveLength(1);
    expect(deletedKeys).toEqual([]);
  });

  it("★PDFが無いときは storage.delete を呼ばない", async () => {
    existingByExternalKey = "prop-existing-1";
    const res = await POST(req({ ...baseBody, externalLinkKey: "SA2608-1234567" }));
    expect(res.status).toBe(409);
    expect(deletedKeys).toEqual([]);
  });
});

describe("multipart は formData() の前に大きさを見る（P1②）", () => {
  it("★Content-Length が上限超過なら413で、formData() に到達しない", async () => {
    const { MAX_FILE_SIZE } = await import("@/lib/storage");
    // 本文を実際に作らず、ヘッダだけ巨大にする(=ガードが**先に**効いていなければ
    // formData() がヘッダどおりの本文を待って別のエラーになる)。
    const fd = new FormData();
    fd.append("data", JSON.stringify(baseBody));
    const blob = await new Response(fd).blob();
    const reqTooBig = new NextRequest("http://localhost/api/import/paste/commit", {
      method: "POST",
      body: blob,
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(MAX_FILE_SIZE + 2 * 1024 * 1024),
      },
    });
    const res = await POST(reqTooBig);
    expect(res.status).toBe(413);
    expect(created.property).toBeUndefined();
    expect(storedKeys).toEqual([]);
  });

  it("★Content-Length が無い multipart は411", async () => {
    const fd = new FormData();
    fd.append("data", JSON.stringify(baseBody));
    const blob = await new Response(fd).blob();
    const noLen = new NextRequest("http://localhost/api/import/paste/commit", {
      method: "POST",
      body: blob,
      headers: { "content-type": "multipart/form-data; boundary=x" },
    });
    const res = await POST(noLen);
    expect(res.status).toBe(411);
  });

  it("通常の大きさの multipart は従来どおり通る", async () => {
    const res = await POST(await multipartReq(baseBody, pdfFile()));
    expect(res.status).toBe(200);
  });
});

describe("物件名は種別に合うときだけ保存する（P2④）", () => {
  const withBuilding = (propertyType: string, buildingName: string | null) => ({
    ...baseBody,
    property: { ...baseBody.property, propertyType, buildingName },
  });

  it("★種別を土地に直したのに建物名が残っていたら、保存される値は null", async () => {
    // 画面はその種別で建物名の欄を出さない＝**見えず直せないデータ**が残り、
    // CSV出力やDM差込で初めて表に出る。判定は UI・通常の作成/更新と同じ純関数。
    const res = await POST(req(withBuilding("land", "グリーンコート")));
    expect(res.status).toBe(200);
    expect(created.property?.[0]).toMatchObject({ buildingName: null });
  });

  it("★戸建でも null になる", async () => {
    await POST(req(withBuilding("house", "グリーンコート")));
    expect(created.property?.[0]).toMatchObject({ buildingName: null });
  });

  it("区分マンションなら保存される（落としすぎていない）", async () => {
    await POST(req(withBuilding("apartment_unit", " グリーンコート ")));
    expect(created.property?.[0]).toMatchObject({ buildingName: "グリーンコート" });
  });

  it("一棟アパート・一棟マンションでも保存される", async () => {
    await POST(req(withBuilding("apartment_block", "サンハイツ")));
    expect(created.property?.[0]).toMatchObject({ buildingName: "サンハイツ" });
  });

  it("★長すぎる物件名は400で断る（黙って切り詰めない）", async () => {
    const res = await POST(req(withBuilding("apartment_unit", "あ".repeat(101))));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("物件名");
    expect(created.property).toBeUndefined();
  });

  it("100文字ちょうど（前後に空白あり）は通る＝整えてから測っている", async () => {
    const res = await POST(req(withBuilding("apartment_unit", "  " + "あ".repeat(100) + "  ")));
    expect(res.status).toBe(200);
    expect(created.property?.[0]).toMatchObject({ buildingName: "あ".repeat(100) });
  });
});

describe("メールアドレスの形式を通常の所有者作成と同じ規則で見る（3巡目 P2）", () => {
  const ownerEmail = (email: string | null) => ({
    ...baseBody,
    owner: { name: "山田太郎", nameKana: null, phone: null, email, currentAddress: null },
  });

  it("★壊れたメールアドレスは400で、物件も所有者も作られない", async () => {
    // createOwnerSchema が弾く値は、この経路でも同じように弾く。
    // ここが無検証だと「通常のAPIでは作れない所有者」がこの画面からだけ作れる。
    const res = await POST(req(ownerEmail("abc@")));
    expect(res.status).toBe(400);
    expect(created.property).toBeUndefined();
    expect(created.owner).toBeUndefined();
  });

  it("★文言は通常の所有者作成と同じ（片方だけ直る食い違いを作らない）", async () => {
    const { createOwnerSchema } = await import("@/lib/validators");
    const expected = createOwnerSchema.shape.email.safeParse("abc@");
    expect(expected.success).toBe(false);
    const res = await POST(req(ownerEmail("abc@")));
    const body = await res.json();
    expect(body.error.message).toBe(
      expected.success ? "" : expected.error.issues[0].message,
    );
  });

  it("★@が無い/空白だけ等、いくつかの壊れ方をまとめて弾く", async () => {
    for (const bad of ["yamada", "yamada@@example.jp", "@example.jp", "a b@example.jp"]) {
      const res = await POST(req(ownerEmail(bad)));
      expect(res.status, `${bad} が通ってしまった`).toBe(400);
    }
  });

  it("空なら通る（未入力は誤りではない・必須にしない）", async () => {
    const res = await POST(req(ownerEmail("")));
    expect(res.status).toBe(200);
    expect(created.owner?.[0]).toMatchObject({ email: null });
  });

  it("null でも通る", async () => {
    const res = await POST(req(ownerEmail(null)));
    expect(res.status).toBe(200);
    expect(created.owner?.[0]).toMatchObject({ email: null });
  });

  it("正しいメールアドレスは従来どおり保存される（弾きすぎていない）", async () => {
    const res = await POST(req(ownerEmail("yamada@example.jp")));
    expect(res.status).toBe(200);
    expect(created.owner?.[0]).toMatchObject({ email: "yamada@example.jp" });
  });
});

// ===========================================================================
// @codex PR#414 4巡目
// ===========================================================================

describe("削除は「アダプタが実際に保存した key」で行う（4巡目 ①）", () => {
  it("★アップロードが要求と違う key を返したとき、**返ってきた方**で削除する", async () => {
    // 本番の server アダプタは最終的な保存先を返す。要求 key で消しに行くと
    // 存在しないパスを消し、**実物のPDFは孤児のまま残る**。
    storedKeyOverride = "properties/actual/where-it-really-went.pdf";
    existingByExternalKey = "prop-existing-1";
    const res = await POST(
      await multipartReq({ ...baseBody, externalLinkKey: "SA2608-1234567" }, pdfFile()),
    );
    expect(res.status).toBe(409);
    expect(requestedKeys).toHaveLength(1);
    expect(storedKeys).toEqual(["properties/actual/where-it-really-went.pdf"]);
    // 返ってきた key を消していること。
    expect(deletedKeys).toEqual(["properties/actual/where-it-really-went.pdf"]);
    // 要求した key は消していないこと（両者は実際に別物）。
    expect(requestedKeys[0]).not.toBe(storedKeys[0]);
    expect(deletedKeys).not.toContain(requestedKeys[0]);
  });
});

describe("監査ログが管理画面で「物件」として拾え、中身も伏せ字にならない（4巡目 ⑤⑥）", () => {
  it("★targetTable は複数形 properties（本番の audit_logs に合わせる）", async () => {
    await POST(req(baseBody));
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({ targetTable: "properties" });
  });

  it("★route が実際に書いた detail が、管理画面の安全化を通っても伏せ字にならない", async () => {
    // ⚠2段そろって初めて監査になる: ①route が detail に書く
    //   ②audit-log-detail-safety の allowlist に載っている。
    //   ①だけだと記録はされるのに監査画面では [REDACTED] になり、
    //   所有者・紐付け・添付が作られたのかが管理者に一切分からない。
    const { sanitizeAuditDetail, REDACTED } = await import("@/lib/audit-log-detail-safety");
    await POST(await multipartReq({
      ...baseBody,
      owner: { name: "山田太郎", nameKana: null, phone: null, email: null, currentAddress: null },
      externalLinkKey: "SA2608-1234567",
    }, pdfFile()));

    const call = auditCalls[0] as { action: string; detail: Record<string, unknown> };
    // 記録した4つの真偽値が、まず route 側で正しい値になっている。
    expect(call.detail).toEqual({
      ownerCreated: true,
      ownerLinked: true,
      attachmentCreated: true,
      hasExternalKey: true,
    });
    // その**同じ detail** を管理画面と同じ関数に通しても、1つも伏せ字にならない。
    const shown = sanitizeAuditDetail(call.action, call.detail) as Record<string, unknown>;
    expect(shown).toEqual(call.detail);
    expect(Object.values(shown)).not.toContain(REDACTED);
  });
});

describe("JSON body の上限はこの口の実態に合わせる（5巡目 ①）", () => {
  it("★共有の既定(64MB)ではなく、この口専用の小さい上限で弾く", async () => {
    const big = new NextRequest("http://localhost/api/import/paste/commit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // 3MB: 共有の既定(64MB)なら通ってしまうが、この口の上限(2MB)は超える。
        "content-length": String(3 * 1024 * 1024),
      },
      body: JSON.stringify(baseBody),
    });
    const res = await POST(big);
    expect(res.status).toBe(413);
    expect(created.property).toBeUndefined();
  });

  it("★下書き側より厳しい（口ごとに分けている）", async () => {
    // 下書き側の上限(4MB)は超えないが commit 側の上限(2MB)は超える大きさ。
    const mid = new NextRequest("http://localhost/api/import/paste/commit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(3 * 1024 * 1024),
      },
      body: JSON.stringify(baseBody),
    });
    expect((await POST(mid)).status).toBe(413);
  });

  it("正規の大きさは従来どおり通る", async () => {
    expect((await POST(req(baseBody))).status).toBe(200);
  });
});

describe("区分マンション専用の欄は種別に合うときだけ保存する（10巡目）", () => {
  const unitFields = {
    roomNo: "303",
    exclusiveArea: "70.55",
    layoutType: "2LDK",
    occupancyStatus: "occupied",
  };
  const withType = (propertyType: string) => ({
    ...baseBody,
    property: { ...baseBody.property, propertyType, ...unitFields },
  });

  it("★種別が land なら、部屋番号も専有面積も間取りも現況も null で保存される", async () => {
    // 物件詳細は区分のときしかこれらを描かず、通常の編集画面(updatePropertySchema)にも
    // 無い＝**見えず直せないデータ**になる。
    const res = await POST(req(withType("land")));
    expect(res.status).toBe(200);
    expect(created.property?.[0]).toMatchObject({
      roomNo: null,
      exclusiveArea: null,
      layoutType: null,
      occupancyStatus: null,
    });
  });

  it("★戸建・一棟マンション・一棟アパートでも同じ", async () => {
    for (const t of ["house", "apartment_building", "apartment_block"]) {
      for (const k of Object.keys(created)) delete created[k];
      const res = await POST(req(withType(t)));
      expect(res.status, t).toBe(200);
      expect(created.property?.[0], t).toMatchObject({
        roomNo: null,
        exclusiveArea: null,
        layoutType: null,
        occupancyStatus: null,
      });
    }
  });

  it("★種別が apartment_unit なら、4つともそのまま保存される（落としすぎていない）", async () => {
    const res = await POST(req(withType("apartment_unit")));
    expect(res.status).toBe(200);
    expect(created.property?.[0]).toMatchObject(unitFields);
  });

  it("★旧値 unit でもそのまま保存される（既存データの取り込みで消えない）", async () => {
    const res = await POST(req(withType("unit")));
    expect(res.status).toBe(200);
    expect(created.property?.[0]).toMatchObject(unitFields);
  });

  it("★物件名(buildingName)の扱いは変わっていない（既存の正規化と共存する）", async () => {
    await POST(req({
      ...baseBody,
      property: { ...baseBody.property, propertyType: "apartment_unit", buildingName: "グリーンコート", ...unitFields },
    }));
    expect(created.property?.[0]).toMatchObject({ buildingName: "グリーンコート", roomNo: "303" });
  });

  it("★判定は1か所(normalizeUnitOnlyFields)を通る。保存経路が素通しで書いていない", async () => {
    // ⚠次に区分専用の欄が増えたときも自動的に守られる形であることを固定する。
    //   UNIT_ONLY_PROPERTY_FIELDS に載っている欄を、保存経路が
    //   normalizeUnitOnlyFields の外で data に書いていたら名指しで落ちる。
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const { UNIT_ONLY_PROPERTY_FIELDS } = await import("@/lib/property-building-name");

    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../route.ts"),
      "utf8",
    );
    const callAt = src.indexOf("normalizeUnitOnlyFields(propertyType, {");
    expect(callAt, "normalizeUnitOnlyFields の呼び出しが無い").toBeGreaterThanOrEqual(0);
    const callBlock = src.slice(callAt, src.indexOf("});", callAt));

    // data: { ... } に直接書かれている欄を洗う。
    const dataAt = src.indexOf("tx.property.create({");
    const dataBlock = src.slice(dataAt, src.indexOf("        });", dataAt));

    const offenders: string[] = [];
    for (const f of UNIT_ONLY_PROPERTY_FIELDS) {
      // ⚠正規表現の**エスケープに頼らない**。テンプレート文字列の中で
      //   バックスラッシュが1つ落ちると `\s` が `s` になり、
      //   「何にも当たらないのに緑」の空振りになる(実際に一度踏んだ)。
      //   行を分けて素直に見る。
      const writtenDirectly = dataBlock
        .split("\n")
        .map((line) => line.trim())
        .some((line) => line.startsWith(`${f}:`) || line === `${f},`);
      const throughHelper = callBlock.includes(`${f}:`) || callBlock.includes(`${f},`);
      if (writtenDirectly && !throughHelper) {
        offenders.push(`${f} が normalizeUnitOnlyFields を通らずに保存されている`);
      }
    }
    expect(offenders, offenders.join(" / ")).toEqual([]);
    // 少なくとも今回の4欄はヘルパー経由になっていること（走査が空当たりでない裏取り）。
    for (const f of ["roomNo", "exclusiveArea", "layoutType", "occupancyStatus"]) {
      expect(callBlock, f).toContain(f);
    }
    // 展開はヘルパーの結果で行っていること。
    expect(dataBlock).toContain("...unitOnly,");
  });
});
