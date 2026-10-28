import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeDealCalc } from "../../calc/deal-calc";
import { DEFAULT_COSTS, DEFAULT_TERMS, EMPTY_BROKER, EMPTY_SNAPSHOT } from "../../schemas";
import { DEFAULT_PROPERTY_KINDS } from "../../constants";
import { INITIAL_RATE_TABLES, type RateTableRow } from "../../rate-tables";
import { DEFAULT_FUNDING_INPUTS } from "../../funding-schema";
import { DEFAULT_BUSINESS_INPUTS } from "../../business-schema";
import { resolveDealSettings } from "../../settings";
import type { DealPartyView, DealView } from "../../view";
import type { CompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import type { BusinessDocContext } from "../business/common";
import { contractGuideOptionsSchema } from "../business/contract-guide";
import { BUSINESS_DOCS, businessDocOf } from "../registry";
import { dealDocumentTitle } from "../issue";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const party = (p: Partial<DealPartyView> & Pick<DealPartyView, "id" | "role" | "name">): DealPartyView => ({
  partyType: "individual", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1, ...p,
});
const SELLER = party({ id: "p-seller", role: "seller", name: "架空 一郎<i>", address: "架空県架空市1-1" });
const BUYER = party({ id: "p-buyer", role: "buyer", name: "架空 花子", address: "架空県架空市4-4" });
const deal: DealView = {
  id: "d", dealNo: "2026-0021", name: "試験", businessType: "resale", tradeSide: null, status: "contracted",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "building", hasOc: false,
  contractAt: "2026-04-30T15:00:00.000Z", contractPlace: null, settlementAt: "2026-06-30T01:00:00.000Z", settlementPlace: "架空銀行 架空支店",
  price: 50_000_000, buildingTax: null, deposit: 2_000_000, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験ハイツ<b>", address: "架空県架空市2-2" },
  counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 }, costs: DEFAULT_COSTS,
  settlementTerms: DEFAULT_TERMS, leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [SELLER, BUYER],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "架空県知事(1)第00000号", tel: "03-0000-0000", fax: "", email: "", hp: "", address: "架空県架空市3-3" };
const SEAL = "data:image/png;base64,c2VhbA==";
const ctx = (d: DealView = deal): BusinessDocContext => ({
  deal: d, calc: computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-28"),
  settings: resolveDealSettings(null), company, rateRows, today: "2026-10-28", logo: null, seal: SEAL,
  staff: { sales: "架空 営業", ops: null },
});
const doc = (key: string) => businessDocOf(key)!;
const G = "contract_guide";

describe("契約のご案内", () => {
  it("「契約・媒介の書類」の先頭に出て、どの取引でも出せる・前回の入力を引き継ぐ", () => {
    expect(BUSINESS_DOCS[0].key).toBe(G);
    expect(doc(G).label).toBe("契約のご案内");
    expect(doc(G).group).toBe("contract");
    expect(doc(G).remember).toBe(true);
    expect(doc(G).applies(ctx())).toBe(true);
    expect(dealDocumentTitle(G, "default")).toBe("契約のご案内");
  });

  it("宛先の初期値: 買主側の仲介なら買主、それ以外は売主。選べる宛先に名前が付く", () => {
    expect(doc(G).defaults(ctx()).values.addressee).toBe("seller");
    expect(doc(G).defaults(ctx({ ...deal, businessType: "brokerage", tradeSide: "buyer" })).values.addressee).toBe("buyer");
    expect(doc(G).defaults(ctx()).choices?.addressee).toEqual([
      { value: "seller", label: "売主様(架空 一郎<i>)" }, { value: "buyer", label: "買主様(架空 花子)" },
    ]);
    expect(doc(G).defaults(ctx({ ...deal, parties: [] })).choices?.addressee[1]).toEqual({ value: "buyer", label: "買主様(未入力)" });
  });

  it("お持ちいただくものの初期値は、書類確認書(契約時)の「持参するもの」", () => {
    expect(doc(G).defaults(ctx()).values.belongings).toBe(["手付金", "収入印紙", "印鑑(認印または実印)", "本人確認書類"].join("\n"));
    expect(doc(G).defaults(ctx()).values.notes).toBeNull();
  });

  it("空欄の確認: 契約日時・契約場所・宛先の当事者", () => {
    expect(doc(G).missing(ctx())).toEqual(["契約場所"]);
    expect(doc(G).missing(ctx({ ...deal, contractAt: null, contractPlace: "架空会議室", parties: [BUYER] }))).toEqual(["契約日時", "売主"]);
    expect(doc(G).blocking(ctx({ ...deal, parties: [] }))).toEqual([]);
  });

  it("空欄の確認は、選んだ宛先(前回の入力・画面で選び直した宛先)の当事者で見る(@codex)", () => {
    const onlySeller = ctx({ ...deal, contractPlace: "架空会議室", parties: [SELLER] });
    expect(doc(G).missing(onlySeller)).toEqual([]);
    expect(doc(G).missing(onlySeller, { addressee: "buyer" })).toEqual(["買主"]);
    expect(doc(G).missing(onlySeller, { addressee: "壊れた" })).toEqual([]);
    // 画面で選び直したときのため、当事者のいない宛先を渡す
    expect(doc(G).defaults(onlySeller).choices?.addresseeMissing).toEqual([{ value: "buyer", label: "買主" }]);
    expect(doc(G).defaults(ctx()).choices?.addresseeMissing).toEqual([]);
  });

  it("組み立て: 宛先・日時・手付金・持ち物・この後の流れ・会社と担当(エスケープする)", () => {
    const out = doc(G).build(ctx(), { addressee: "seller", belongings: "実印\n印鑑証明書", notes: null });
    expect(out.html).toContain("不動産売買契約のご案内");
    expect(out.html).toContain("架空 一郎&lt;i&gt; 様");
    expect(out.html).toContain("試験ハイツ&lt;b&gt;");
    expect(out.html).toContain("2,000,000円");
    expect(out.html).toContain("<li>実印</li>");
    expect(out.html).toContain("<li>印鑑証明書</li>");
    expect(out.html).toContain("2026年5月1日");
    expect(out.html).toContain("2026年6月30日");
    expect(out.html).toContain("架空不動産株式会社");
    expect(out.html).toContain("担当 架空 営業");
    expect(out.html).not.toContain("ご連絡事項");
    expect(out.html).not.toContain(SEAL);
    expect(out.rows).toContainEqual({ label: "宛先", value: "架空 一郎<i>" });
    expect(out.rows).toContainEqual({ label: "手付金", value: 2_000_000 });
    const withNotes = doc(G).build(ctx(), { addressee: "buyer", belongings: null, notes: "駐車場はありません" });
    expect(withNotes.html).toContain("架空 花子 様");
    expect(withNotes.html).toContain("ご連絡事項");
    expect(withNotes.html).toContain("駐車場はありません");
  });

  it("宛先の当事者・日付・手付金が無くても落ちない(名前と日付は空けて出す)", () => {
    const out = doc(G).build(ctx({ ...deal, parties: [], contractAt: null, settlementAt: null, deposit: null }), { addressee: "buyer", belongings: null, notes: null });
    expect(out.html).toContain('<div class="customer"> 様</div>');
    expect(out.html).toContain("決まりしだいご案内します");
    expect(out.rows).toContainEqual({ label: "宛先", value: null });
  });

  it("宛先は売主・買主だけ", () => {
    expect(contractGuideOptionsSchema.safeParse({ addressee: "agent", belongings: null, notes: null }).success).toBe(false);
    expect(contractGuideOptionsSchema.safeParse({ addressee: "seller", belongings: "x".repeat(501), notes: null }).success).toBe(false);
  });
});

const C = "completion_confirmation";
const brokerDeal: DealView = {
  ...deal, businessType: "brokerage", tradeSide: "both",
  costs: { ...DEFAULT_COSTS, scrivener: { name: "架空司法書士事務所", address: null, tel: null, staff: "架空 書士" } },
};

describe("取引完了確認書", () => {
  it("決済の書類の、精算金領収書のすぐ後ろに出る・前回の入力を引き継ぐ", () => {
    const keys = BUSINESS_DOCS.map((d) => d.key);
    expect(keys.indexOf(C)).toBe(keys.indexOf("settlement_receipt") + 1);
    expect(doc(C).label).toBe("取引完了確認書");
    expect(doc(C).group).toBe("settlement");
    expect(doc(C).remember).toBe(true);
    expect(doc(C).applies(ctx())).toBe(true);
    expect(dealDocumentTitle(C, "default")).toBe("取引完了確認書");
  });

  it("引き渡した書類の初期値は、書類確認書(決済時)の「受け取るもの」(物件種別で出し分け)", () => {
    expect(doc(C).defaults(ctx()).values.handover).toBe(
      ["鍵", "登記識別情報(権利証)・登記に必要な書類", "残代金・精算金の領収書", "境界確認書・測量図"].join("\n"),
    );
    expect(doc(C).defaults(ctx({ ...deal, propertyKind: "unit" })).values.handover).toBe(
      ["鍵", "登記識別情報(権利証)・登記に必要な書類", "残代金・精算金の領収書", "管理規約・使用細則"].join("\n"),
    );
  });

  it("空欄の確認: 契約日・売主・買主", () => {
    expect(doc(C).missing(ctx())).toEqual([]);
    expect(doc(C).missing(ctx({ ...deal, contractAt: null, parties: [] }))).toEqual(["契約日", "売主", "買主"]);
    expect(doc(C).blocking(ctx({ ...deal, parties: [] }))).toEqual([]);
  });

  it("組み立て: 本文・当事者の署名欄・物件・引き渡した書類(□)・司法書士・仲介業者", () => {
    const out = doc(C).build(ctx(brokerDeal), { handover: "鍵\n登記識別情報" });
    expect(out.html).toContain("取引完了確認書");
    expect(out.html).toContain("2026年5月1日付で締結した下記不動産の売買契約");
    expect(out.html).toContain("残代金の授受、物件の引渡し及び所有権移転登記の申請手続きが本日完了したことを確認します");
    expect(out.html).toContain("架空 一郎&lt;i&gt;");
    expect(out.html).toContain("架空県架空市1-1");
    expect(out.html).toContain("架空 花子");
    expect(out.html).toContain("2026年6月30日");
    expect(out.html).toContain("試験ハイツ&lt;b&gt;");
    expect(out.html).toContain("□ 鍵");
    expect(out.html).toContain("□ 登記識別情報");
    expect(out.html).toContain("架空司法書士事務所");
    expect(out.html).toContain("仲介業者");
    expect(out.html).toContain("架空不動産株式会社");
    expect(out.html).not.toContain(SEAL);
    expect(out.rows).toContainEqual({ label: "売主", value: "架空 一郎<i>" });
    expect(out.rows).toContainEqual({ label: "引き渡した書類など", value: "鍵\n登記識別情報" });
    // 登録した住所・氏名とは別に、手書きの署名の空欄を当事者ごとに出す(@codex)
    expect(out.html.match(/<td class="sign-blank">署名<\/td>/g)?.length).toBe(2);
    expect(doc(C).build(ctx({ ...deal, parties: [] }), { handover: null }).html.match(/<td class="sign-blank">署名<\/td>/g)?.length).toBe(2);
    // 仲介でない取引(買取再販)には仲介業者の欄を出さない
    expect(doc(C).build(ctx(), { handover: null }).html).not.toContain("仲介業者");
  });

  it("当事者・日付・引き渡した書類が無くても落ちない(空けて出す)", () => {
    const out = doc(C).build(ctx({ ...deal, parties: [], contractAt: null, settlementAt: null }), { handover: null });
    expect(out.html).toContain("年　　月　　日付で締結した");
    expect(out.html).not.toContain("□ ");
    expect(out.rows).toContainEqual({ label: "売主", value: null });
  });
});

describe("第2段階の書類の文面", () => {
  it("前の会社の名前・リースバックの語を使わない", () => {
    for (const f of ["contract-guide.ts", "completion.ts"]) {
      const src = readFileSync(join(process.cwd(), "src/lib/deals/documents/business", f), "utf8");
      for (const w of ["インテリックス", "リースバック", "LB"]) expect(src, `${f} に ${w}`).not.toContain(w);
    }
  });
});
