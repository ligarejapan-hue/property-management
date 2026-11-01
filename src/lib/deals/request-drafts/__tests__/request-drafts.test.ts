import { describe, expect, it } from "vitest";
import {
  DEFAULT_REQUEST_TEMPLATES, REQUEST_FIELDS, REQUEST_LIMITS, requestTemplatesSaveSchema, renderRequestDraft, resolveRequestTemplates, templatesForItem, unknownFieldsOf,
  type RequestFieldValues, type RequestTemplate,
} from "../templates";
import { DEFAULT_SCHEDULE_TEMPLATE } from "../../schedule";
import { buildRequestFieldValues, recipientOptions, type RequestFieldInput } from "../values";
import { EMPTY_BANK_ACCOUNT, EMPTY_BROKER, EMPTY_SNAPSHOT } from "../../schemas";
import type { DealPartyView, DealView } from "../../view";
import type { Lease } from "../../schemas";

const tpl = (o: Partial<RequestTemplate> = {}): RequestTemplate => ({ id: "t1", label: "依頼", recipient: "other", scheduleItemKey: "s_x", body: "本文", ...o });

describe("初めのひな形", () => {
  it("そのまま保存できる", () => {
    expect(requestTemplatesSaveSchema.safeParse(DEFAULT_REQUEST_TEMPLATES).success).toBe(true);
  });
  it("6つの相手と用件が、初めの段取りの項目に結びついている", () => {
    const byItem = (key: string) => DEFAULT_REQUEST_TEMPLATES.filter((t) => t.scheduleItemKey === key).map((t) => t.recipient);
    expect(byItem("c_scrivener")).toEqual(["scrivener"]);
    expect(byItem("c_mortgage")).toEqual(["bank"]);
    expect(byItem("s_management_report")).toEqual(["management"]);
    expect(byItem("s_seller_docs")).toEqual(["seller"]);
    expect(byItem("s_broker_check")).toEqual(["broker"]);
    expect(byItem("s_tenant_notice")).toEqual(["tenant"]);
    for (const t of DEFAULT_REQUEST_TEMPLATES) expect(DEFAULT_SCHEDULE_TEMPLATE.some((s) => s.id === t.scheduleItemKey), t.id).toBe(true);
  });
  it("抵当権者や謄本の中身は差し込まない", () => {
    const bank = DEFAULT_REQUEST_TEMPLATES.find((t) => t.recipient === "bank")!;
    expect(bank.body).not.toContain("抵当権者");
    expect(REQUEST_FIELDS.join()).not.toMatch(/抵当権者|金融機関/);
  });
});

describe("ひな形と段取りの項目の結びつき", () => {
  it("鍵が同じものだけ返す。並びは保存の順", () => {
    const list = [tpl({ id: "a", scheduleItemKey: "k1" }), tpl({ id: "b", scheduleItemKey: "k2" }), tpl({ id: "c", scheduleItemKey: "k1" })];
    expect(templatesForItem(list, "k1").map((t) => t.id)).toEqual(["a", "c"]);
  });
  it("手入力の項目(鍵が無い)には結びつかない。結びつき無しのひな形も拾わない", () => {
    const list = [tpl({ id: "a", scheduleItemKey: null })];
    expect(templatesForItem(list, null)).toEqual([]);
    expect(templatesForItem(list, "k1")).toEqual([]);
  });
  it("段取りのひな形から消した項目でも、作成済みの取引の鍵が同じなら結びつく", () => {
    expect(templatesForItem([tpl({ scheduleItemKey: "removed" })], "removed")).toHaveLength(1);
  });
});

describe("ひな形の保存と読み出し", () => {
  it("保存が無い・空・壊れているときは初めのひな形", () => {
    expect(resolveRequestTemplates([])).toEqual(DEFAULT_REQUEST_TEMPLATES);
    expect(resolveRequestTemplates(undefined)).toEqual(DEFAULT_REQUEST_TEMPLATES);
    expect(resolveRequestTemplates([{ id: "x" }])).toEqual(DEFAULT_REQUEST_TEMPLATES);
  });
  it("保存したものを返す", () => {
    const mine = [tpl({ body: "{{物件名}}" })];
    expect(resolveRequestTemplates(mine)).toEqual(mine);
  });
  it("読み出しは知らない差し込み欄で落とさない(残りのひな形まで初めに戻さない)", () => {
    const mine = [tpl({ body: "{{昔の欄}}" })];
    expect(resolveRequestTemplates(mine)).toEqual(mine);
  });
  it("保存は知らない差し込み欄を断る(欄の名前を伝える)", () => {
    const r = requestTemplatesSaveSchema.safeParse([tpl({ body: "{{売主様}} {{物件名}}" })]);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toContain("{{売主様}}");
  });
  it("空の名前・空の本文・重なった鍵・長すぎる本文を断る", () => {
    expect(requestTemplatesSaveSchema.safeParse([tpl({ label: " " })]).success).toBe(false);
    expect(requestTemplatesSaveSchema.safeParse([tpl({ body: " " })]).success).toBe(false);
    expect(requestTemplatesSaveSchema.safeParse([tpl(), tpl()]).success).toBe(false);
    expect(requestTemplatesSaveSchema.safeParse([tpl({ body: "あ".repeat(REQUEST_LIMITS.body + 1) })]).success).toBe(false);
    expect(requestTemplatesSaveSchema.safeParse([]).success).toBe(false);
  });
  it("知らない欄を拾う", () => {
    expect(unknownFieldsOf("{{物件名}} {{ない}} {{ 物件名 }} {{ない}}")).toEqual(["ない"]);
  });
});

describe("差し込み", () => {
  const values: RequestFieldValues = { 物件名: { value: "試験マンション 101" }, 決済場所: { blank: "missing" }, 売主名: { blank: "permission" }, 提出用リンク: { blank: "no_link" } };
  it("値を差し込む。前後の空白を許す", () => {
    expect(renderRequestDraft("物件:{{物件名}} / {{ 物件名 }}", values)).toEqual({ text: "物件:試験マンション 101 / 試験マンション 101", blanks: [] });
  });
  it("欠けている値は空にして、一覧で知らせる", () => {
    expect(renderRequestDraft("場所:{{決済場所}}です", values)).toEqual({ text: "場所:です", blanks: [{ field: "決済場所", reason: "missing" }] });
  });
  it("権限がない欄は空にして、理由を分けて知らせる", () => {
    expect(renderRequestDraft("{{売主名}} 様", values)).toEqual({ text: " 様", blanks: [{ field: "売主名", reason: "permission" }] });
  });
  it("値の入っていない欄(渡されていない)も空", () => {
    expect(renderRequestDraft("{{買主名}}", values).blanks).toEqual([{ field: "買主名", reason: "missing" }]);
  });
  it("知らない欄は空にして、それと分かる理由を付ける", () => {
    expect(renderRequestDraft("a{{昔の欄}}b", values)).toEqual({ text: "ab", blanks: [{ field: "昔の欄", reason: "unknown" }] });
  });
  it("同じ欄は一度だけ知らせる", () => {
    expect(renderRequestDraft("{{決済場所}}{{決済場所}}", values).blanks).toHaveLength(1);
  });
  it("差し込んだ値の中の {{ }} は展開しない", () => {
    expect(renderRequestDraft("{{物件名}}", { 物件名: { value: "{{売主名}}" }, 売主名: { value: "試験 太郎" } }).text).toBe("{{売主名}}");
  });
  it("閉じていない {{ はそのまま", () => {
    expect(renderRequestDraft("a{{物件名", values).text).toBe("a{{物件名");
  });
  it("欄が空になって空行が続くときだけ詰める", () => {
    expect(renderRequestDraft("上\n\n{{提出用リンク}}\n\n下", values).text).toBe("上\n\n下");
    expect(renderRequestDraft("上\n\n\n下", values).text).toBe("上\n\n\n下");
  });
});

const party = (o: Partial<DealPartyView> = {}): DealPartyView => ({
  id: "p1", role: "seller", partyType: "individual", name: "試験 太郎", representative: null, address: "東京都品川区1-1", phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1, ...o,
});
const lease = (o: Partial<Lease> = {}): Lease => ({
  room: "101", tenant: "賃借 花子", contractType: "ordinary", period: null, rent: 1, commonFee: 0, parking: 0, other: 0, deposit: 0, arrears: false, arrearsAmount: 0, manager: "管理株式会社", ...o,
});
const deal = (o: Partial<DealView> = {}): DealView => ({
  dealNo: "2026-0001", price: 30_000_000, settlementAt: "2026-12-16T01:30:00.000Z", settlementPlace: "試験銀行 本店", contractAt: "2026-11-01T15:00:00.000Z",
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験マンション", roomNo: "101", address: "東京都港区1-1", lotNumber: "1番1" },
  counterpartyBroker: { ...EMPTY_BROKER, company: "相手不動産", staff: "相手 一郎" },
  costs: { scrivener: { name: "試験司法書士", address: null, tel: null, staff: "登記 二郎" }, registrationFee: null, cancellationFee: null, surveyFee: null, others: [], lowCostSpecial: false },
  parties: [party(), party({ id: "b1", role: "buyer", name: "買主 三郎", address: "東京都目黒区2-2" })], leases: [], propertyId: "prop", ...o,
} as DealView);
const input = (o: Partial<RequestFieldInput> = {}): RequestFieldInput => ({
  deal: deal(),
  settlement: { ready: true, totalSellerToBuyer: 1000, totalBuyerToSeller: 2000, paymentAtSettlement: 27_000_000 },
  company: { nameJa: "試験不動産株式会社", tel: "03-0000-0000", address: "東京都千代田区1-1" },
  bankAccount: { ...EMPTY_BANK_ACCOUNT, bankName: "試験銀行", branchName: "本店", accountNumber: "1234567" },
  access: { name: true, address: true, canManage: true, canOpenProperty: true },
  assigneeName: "担当 太郎",
  buildingManagementCompany: "棟の管理会社",
  documents: ["実印", "印鑑証明書"],
  recipient: null,
  docLink: null,
  ...o,
});
const val = (v: RequestFieldValues, k: keyof RequestFieldValues) => v[k];

describe("差し込み欄の値", () => {
  it("取引の値を読みやすい形で入れる", () => {
    const v = buildRequestFieldValues(input());
    expect(val(v, "物件名")).toEqual({ value: "試験マンション 101" });
    expect(val(v, "所在")).toEqual({ value: "東京都港区1-1" });
    expect(val(v, "地番")).toEqual({ value: "1番1" });
    expect(val(v, "決済日時")).toEqual({ value: "2026年12月16日 10:30" });
    expect(val(v, "決済日")).toEqual({ value: "2026年12月16日" });
    expect(val(v, "契約日時")).toEqual({ value: "2026年11月2日" });
    expect(val(v, "決済場所")).toEqual({ value: "試験銀行 本店" });
    expect(val(v, "売買価格")).toEqual({ value: "30,000,000円" });
    expect(val(v, "決済時のお支払額")).toEqual({ value: "27,000,000円" });
    expect(val(v, "会社名")).toEqual({ value: "試験不動産株式会社" });
    expect(val(v, "担当者名")).toEqual({ value: "担当 太郎" });
    expect(val(v, "司法書士名")).toEqual({ value: "試験司法書士" });
    expect(val(v, "相手業者担当者")).toEqual({ value: "相手 一郎" });
    expect(val(v, "必要書類")).toEqual({ value: "・実印\n・印鑑証明書" });
  });
  it("欠けている値は「未入力」", () => {
    const v = buildRequestFieldValues(input({
      deal: deal({ settlementAt: null, settlementPlace: null, price: null, propertySnapshot: EMPTY_SNAPSHOT }), assigneeName: null, documents: [],
      settlement: { ready: false, totalSellerToBuyer: 0, totalBuyerToSeller: 0, paymentAtSettlement: null },
    }));
    for (const k of ["決済日時", "決済場所", "売買価格", "物件名", "所在", "担当者名", "必要書類", "売主から買主への精算額", "決済時のお支払額"] as const) {
      expect(val(v, k), k).toEqual({ blank: "missing" });
    }
  });
  it("精算額は計算できるようになるまで出さない(0円と未入力を取り違えない)", () => {
    expect(val(buildRequestFieldValues(input({ settlement: { ready: false, totalSellerToBuyer: 0, totalBuyerToSeller: 0, paymentAtSettlement: null } })), "買主から売主への精算額")).toEqual({ blank: "missing" });
    expect(val(buildRequestFieldValues(input({ settlement: { ready: true, totalSellerToBuyer: 0, totalBuyerToSeller: 0, paymentAtSettlement: 0 } })), "買主から売主への精算額")).toEqual({ value: "0円" });
  });

  describe("氏名・住所の権限", () => {
    it("権限があれば差し込む", () => {
      const v = buildRequestFieldValues(input());
      expect(val(v, "売主名")).toEqual({ value: "試験 太郎" });
      expect(val(v, "買主名")).toEqual({ value: "買主 三郎" });
      expect(val(v, "売主住所")).toEqual({ value: "東京都品川区1-1" });
    });
    it("氏名の権限がなければ空。住所は住所の権限で別に決める", () => {
      const v = buildRequestFieldValues(input({ access: { name: false, address: true, canManage: true, canOpenProperty: true } }));
      expect(val(v, "売主名")).toEqual({ blank: "permission" });
      expect(val(v, "買主名")).toEqual({ blank: "permission" });
      expect(val(v, "売主住所")).toEqual({ value: "東京都品川区1-1" });
    });
    it("住所の権限がなければ、値の有無にかかわらず権限なしと出す", () => {
      const access = { name: true, address: false, canManage: true, canOpenProperty: true };
      expect(val(buildRequestFieldValues(input({ access })), "売主住所")).toEqual({ blank: "permission" });
      const noAddress = deal({ parties: [party({ address: null })] });
      expect(val(buildRequestFieldValues(input({ access, deal: noAddress })), "売主住所")).toEqual({ blank: "permission" });
    });
    it("権限がなくても、どこにも名前や住所を残さない", () => {
      const v = buildRequestFieldValues(input({ access: { name: false, address: false, canManage: false, canOpenProperty: false } }));
      const dump = JSON.stringify(v);
      for (const s of ["試験 太郎", "買主 三郎", "品川区"]) expect(dump).not.toContain(s);
    });
    it("自社の名前は権限に関係なく入れる(個人の情報ではない)", () => {
      const self = deal({ parties: [party({ id: "b1", role: "buyer", name: "試験不動産株式会社", isSelf: true })] });
      const v = buildRequestFieldValues(input({ deal: self, access: { name: false, address: false, canManage: true, canOpenProperty: true } }));
      expect(val(v, "買主名")).toEqual({ value: "試験不動産株式会社" });
    });
    it("当事者がいなければ未入力(権限で隠すものが無い)", () => {
      const v = buildRequestFieldValues(input({ deal: deal({ parties: [] }), access: { name: false, address: false, canManage: true, canOpenProperty: true } }));
      expect(val(v, "売主名")).toEqual({ blank: "missing" });
    });
    it("売主が2人なら、宛先を選ばない文面には並べて入れる", () => {
      const two = deal({ parties: [party(), party({ id: "p2", name: "試験 次郎" })] });
      expect(val(buildRequestFieldValues(input({ deal: two })), "売主名")).toEqual({ value: "試験 太郎・試験 次郎" });
    });
    it("宛先を選べば、その人だけを入れる", () => {
      const two = deal({ parties: [party(), party({ id: "p2", name: "試験 次郎", address: "東京都大田区3-3" })] });
      const v = buildRequestFieldValues(input({ deal: two, recipient: { kind: "seller", party: two.parties[1] } }));
      expect(val(v, "売主名")).toEqual({ value: "試験 次郎" });
      expect(val(v, "売主住所")).toEqual({ value: "東京都大田区3-3" });
    });
    it("賃借人名は氏名の権限に従う。部屋番号は権限に関係なく入れる", () => {
      const d = deal({ leases: [lease()] });
      const recipient = { kind: "tenant" as const, lease: d.leases[0] };
      expect(val(buildRequestFieldValues(input({ deal: d, recipient })), "賃借人名")).toEqual({ value: "賃借 花子" });
      const v = buildRequestFieldValues(input({ deal: d, recipient, access: { name: false, address: false, canManage: true, canOpenProperty: true } }));
      expect(val(v, "賃借人名")).toEqual({ blank: "permission" });
      expect(val(v, "部屋番号")).toEqual({ value: "101" });
    });
  });

  describe("管理会社名", () => {
    it("物件を見られる人には棟の管理会社", () => {
      expect(val(buildRequestFieldValues(input()), "管理会社名")).toEqual({ value: "棟の管理会社" });
    });
    it("棟に無ければ賃貸借の管理会社欄(重なりは1つ)", () => {
      const d = deal({ leases: [lease(), lease({ room: "102" }), lease({ room: "103", manager: "別管理" })] });
      expect(val(buildRequestFieldValues(input({ deal: d, buildingManagementCompany: null })), "管理会社名")).toEqual({ value: "管理株式会社・別管理" });
    });
    it("物件を見られない人には棟の値を出さない", () => {
      const access = { name: true, address: true, canManage: true, canOpenProperty: false };
      expect(val(buildRequestFieldValues(input({ access })), "管理会社名")).toEqual({ blank: "permission" });
    });
    it("どこにも無ければ未入力", () => {
      expect(val(buildRequestFieldValues(input({ buildingManagementCompany: null })), "管理会社名")).toEqual({ blank: "missing" });
    });
  });

  describe("編集の権限が要る欄", () => {
    const seller = () => ({ kind: "seller" as const, party: party() });
    const link = { url: "https://public.example/submit/abc", expiresOn: "2026-12-01" };
    it("提出用リンクがあれば差し込む", () => {
      const v = buildRequestFieldValues(input({ recipient: seller(), docLink: link }));
      expect(val(v, "提出用リンク")).toEqual({ value: link.url });
      expect(val(v, "リンクの期限")).toEqual({ value: "2026年12月1日" });
      const guide = val(v, "提出用リンクのご案内") as { value: string };
      expect(guide.value).toContain(link.url);
      expect(guide.value).toContain("2026年12月1日");
    });
    it("リンクが無ければ空にして「未発行」", () => {
      const v = buildRequestFieldValues(input({ recipient: seller(), docLink: null }));
      expect(val(v, "提出用リンク")).toEqual({ blank: "no_link" });
      expect(val(v, "提出用リンクのご案内")).toEqual({ blank: "no_link" });
    });
    it("編集できない人にはリンクを渡さない", () => {
      const v = buildRequestFieldValues(input({ recipient: seller(), docLink: link, access: { name: true, address: true, canManage: false, canOpenProperty: true } }));
      expect(val(v, "提出用リンク")).toEqual({ blank: "permission" });
      expect(JSON.stringify(v)).not.toContain(link.url);
    });
    it("売主の宛先を選んでいないときはリンクを入れない(別の人のリンクを送らない)", () => {
      expect(val(buildRequestFieldValues(input({ recipient: null, docLink: link })), "提出用リンク")).toEqual({ blank: "no_link" });
    });
    it("賃料振込先は買主が自社のときだけ自社の口座", () => {
      expect(val(buildRequestFieldValues(input()), "賃料振込先")).toEqual({ blank: "missing" });
      const self = deal({ parties: [party({ id: "b1", role: "buyer", isSelf: true })] });
      const v = val(buildRequestFieldValues(input({ deal: self })), "賃料振込先") as { value: string };
      expect(v.value).toContain("試験銀行");
      expect(val(buildRequestFieldValues(input({ deal: self, access: { name: true, address: true, canManage: false, canOpenProperty: true } })), "賃料振込先")).toEqual({ blank: "permission" });
    });
  });
});

describe("宛先の選択肢", () => {
  const two = deal({ parties: [party(), party({ id: "p2", name: "試験 次郎" }), party({ id: "s", name: "自社", isSelf: true }), party({ id: "b1", role: "buyer" })], leases: [lease(), lease({ room: null, tenant: "賃借 次郎" }), lease({ room: "103", tenant: null })] });
  it("売主は自社を除いて選べる", () => {
    expect(recipientOptions("seller", two, true).map((r) => r.id)).toEqual(["p1", "p2"]);
    expect(recipientOptions("seller", two, true)[0].label).toContain("試験 太郎");
  });
  it("氏名の権限がなければ選択肢にも名前を出さない", () => {
    const opts = recipientOptions("seller", two, false);
    expect(opts.map((r) => r.label)).toEqual(["売主 1", "売主 2"]);
    expect(JSON.stringify(recipientOptions("tenant", two, false))).not.toContain("賃借");
  });
  it("賃借人は入居中の行だけ・行の番号で選ぶ", () => {
    const opts = recipientOptions("tenant", two, true);
    expect(opts.map((r) => r.id)).toEqual(["0", "1"]);
    expect(opts[0].label).toContain("101");
  });
  it("ほかの相手には選択肢を出さない", () => {
    expect(recipientOptions("scrivener", two, true)).toEqual([]);
    expect(recipientOptions("other", two, true)).toEqual([]);
  });
});
