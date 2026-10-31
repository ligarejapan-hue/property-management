import { describe, it, expect } from "vitest";
import {
  ACTIVE_MORTGAGE_MESSAGE, CROSSCHECK_NOTICE_IDS, NAME_VARIANTS, NAME_VARIANT_MESSAGE, REGISTRY_STALE_MESSAGE, SELLER_MISMATCH_MESSAGE,
  buildCrosscheck, foldNameVariants, issueWarnings, normalizeArea, normalizeDate, normalizeName, normalizeYen, parseShare,
  type CrosscheckInput, type CrosscheckItemKey, type IssuedDocFacts, type RegistryFacts,
} from "../crosscheck";

const AT = "2026-10-01T03:00:00.000Z";
const NO_REGISTRY: RegistryFacts = { status: "none" };
const registry = (over: Partial<Extract<RegistryFacts, { status: "ok" }>> = {}): RegistryFacts => ({
  status: "ok",
  areas: null,
  rights: null,
  owners: null,
  ...over,
});
const base = (over: Partial<CrosscheckInput> = {}): CrosscheckInput => ({
  kindBase: "unit", price: 30_000_000, settlementDate: "2026-11-30",
  snapshot: { floorArea: 65.5, landArea: null },
  property: { exclusiveArea: "65.50", exclusiveAreaRegistry: "60.25", landArea: null, landAreaMethod: null, totalFloorArea: null },
  registry: NO_REGISTRY, sellerCompare: "allowed", sellers: [], documents: [],
  ...over,
});
const doc = (over: Partial<IssuedDocFacts> = {}): IssuedDocFacts => ({
  documentId: "doc-1", docType: "settlement_statement", variant: "default", version: 1, title: "精算書", issuedAt: AT, ...over,
});
const item = (input: CrosscheckInput, key: CrosscheckItemKey) => {
  const hit = buildCrosscheck(input).items.find((i) => i.key === key);
  if (!hit) throw new Error(`no item ${key}`);
  return hit;
};

describe("表記ゆれをそろえる", () => {
  it("面積: 全角・単位・小数の書き方がそろう", () => {
    for (const v of ["６５．５０㎡", "65.5", "65.50m2", "65.5 平方メートル", "６５：５０", "65・50", "65.5m²", 65.5]) {
      expect(normalizeArea(v)).toBe(6550);
    }
    expect(normalizeArea("1,234.5㎡")).toBe(123450);
  });
  it("面積: 読めないものと坪は null(推測で換算しない)", () => {
    for (const v of ["", "約65", "20坪", "65.505", null, undefined, -1]) expect(normalizeArea(v)).toBeNull();
  });
  it("金額: 全角・カンマ・円", () => {
    for (const v of ["３０，０００，０００円", "30,000,000", "¥30000000", 30_000_000]) expect(normalizeYen(v)).toBe(30_000_000);
    expect(normalizeYen("3000万円")).toBeNull();
  });
  it("日付: 書き方の違いと全角", () => {
    for (const v of ["2026-11-30", "2026/11/30", "２０２６年１１月３０日", "2026-11-30T10:00"]) expect(normalizeDate(v)).toBe("2026-11-30");
    expect(normalizeDate("来月末")).toBeNull();
    expect(normalizeDate("2026-13-40")).toBeNull();
  });
  it("名前: 空白・全角半角・(株) をそろえる", () => {
    expect(normalizeName("架空　太郎")).toBe(normalizeName("架 空 太 郎"));
    expect(normalizeName("㈱架空不動産")).toBe(normalizeName("株式会社架空不動産"));
    expect(normalizeName("(有)架空")).toBe(normalizeName("有限会社架空"));
    expect(normalizeName("ＡＢＣ商事")).toBe(normalizeName("abc商事"));
  });
  it("持分: 2分の1 と全角・スラッシュ。読めなければ null", () => {
    expect(parseShare("2分の1")).toEqual({ num: 1, den: 2 });
    expect(parseShare("持分 ２分の１")).toEqual({ num: 1, den: 2 });
    expect(parseShare("4分の2")).toEqual({ num: 1, den: 2 });
    expect(parseShare("1/3")).toEqual({ num: 1, den: 3 });
    expect(parseShare("半分")).toBeNull();
    expect(parseShare("0分の1")).toBeNull();
    expect(parseShare(null)).toBeNull();
  });
});

describe("面積(区分)", () => {
  it("同じ種類どうしの一致: 登記(謄本と物件)・壁芯(物件と写し)", () => {
    const input = base({ registry: registry({ areas: { unit: "６０．２５", land: null, building: null, attachmentCreatedAt: AT } }) });
    expect(item(input, "area_registered").status).toBe("match");
    expect(item(input, "area_wall").status).toBe("match");
  });
  it("内法と壁芯の差はエラーにしない(種類が違う・件数に数えない)", () => {
    const input = base({ registry: registry({ areas: { unit: "60.25", land: null, building: null, attachmentCreatedAt: AT } }) });
    expect(item(input, "area_kinds").status).toBe("kind_differs");
    expect(buildCrosscheck(input).mismatchCount).toBe(0);
  });
  it("謄本が無く物件の2つの欄を並べるときも、出どころの鍵が重ならない", () => {
    const keys = item(base(), "area_kinds").sources.map((s) => s.key);
    expect(new Set(keys).size).toBe(2);
  });
  it("登記どうしの差は不一致", () => {
    const input = base({ registry: registry({ areas: { unit: "60.26", land: null, building: null, attachmentCreatedAt: AT } }) });
    expect(item(input, "area_registered").status).toBe("mismatch");
    expect(buildCrosscheck(input).mismatchCount).toBe(1);
  });
  it("壁芯どうしの差は不一致", () => {
    expect(item(base({ snapshot: { floorArea: 66, landArea: null } }), "area_wall").status).toBe("mismatch");
  });
  it("謄本が無い=片方が未入力。全部事項が読めても値が決まらない=確認できない", () => {
    expect(item(base(), "area_registered").status).toBe("missing");
    const input = base({
      property: { exclusiveArea: "65.50", exclusiveAreaRegistry: null, landArea: null, landAreaMethod: null, totalFloorArea: null },
      registry: registry({ areas: { unit: null, land: null, building: null, attachmentCreatedAt: AT } }),
    });
    expect(item(input, "area_registered").status).toBe("unverifiable");
  });
  it("物件の無い取引は、物件の欄を出どころにしない", () => {
    const input = base({ property: null, documents: [doc({ docType: "mediation", floorArea: 65.5 })] });
    expect(item(input, "area_wall").status).toBe("match");
    expect(item(input, "area_wall").sources.map((s) => s.key)).not.toContain("property");
  });
});

describe("面積(土地・建物)", () => {
  const houseProp = { exclusiveArea: null, exclusiveAreaRegistry: null, landArea: "120.50", landAreaMethod: "公簿", totalFloorArea: "91.05" };
  it("戸建: 謄本・物件・写しの土地と建物を比べる", () => {
    const input = base({
      kindBase: "house", property: houseProp, snapshot: { floorArea: 91.05, landArea: 120.5 },
      registry: registry({ areas: { unit: null, land: "１２０．５０", building: "91.05", attachmentCreatedAt: AT } }),
    });
    expect(item(input, "area_land").status).toBe("match");
    expect(item(input, "area_floor").status).toBe("match");
    const input2 = { ...input, snapshot: { floorArea: 90, landArea: 120.5 } };
    expect(item(input2, "area_floor").status).toBe("mismatch");
  });
  it("実測の土地は公簿の謄本と種類が違う(不一致にしない)", () => {
    const input = base({
      kindBase: "land", property: { ...houseProp, landArea: "125.00", landAreaMethod: "実測" }, snapshot: { floorArea: null, landArea: 125 },
      registry: registry({ areas: { unit: null, land: "120.50", building: null, attachmentCreatedAt: AT } }),
    });
    expect(item(input, "area_land").status).toBe("match");
    expect(item(input, "area_land_kinds").status).toBe("kind_differs");
    expect(buildCrosscheck(input).mismatchCount).toBe(0);
  });
  it("土地の取引に建物の項目を出さない・区分に土地の項目を出さない", () => {
    const land = buildCrosscheck(base({ kindBase: "land" })).items.map((i) => i.key);
    expect(land).not.toContain("area_floor");
    const unit = buildCrosscheck(base()).items.map((i) => i.key);
    expect(unit).not.toContain("area_land");
  });
  it("種別が決まっていなければ面積の項目を出さない", () => {
    const keys = buildCrosscheck(base({ kindBase: null })).items.map((i) => i.key);
    expect(keys.filter((k) => k.startsWith("area_"))).toEqual([]);
  });
});

describe("売買価格", () => {
  it("書類が無いと片方が未入力", () => {
    expect(item(base(), "price").status).toBe("missing");
  });
  it("発行時の値と一致・不一致(発行後に変わったことが分かる文)", () => {
    expect(item(base({ documents: [doc({ price: 30_000_000 })] }), "price").status).toBe("match");
    const m = item(base({ documents: [doc({ price: 29_000_000 })] }), "price");
    expect(m.status).toBe("mismatch");
    expect(m.message).toBe("発行後に価格が変わっています。再発行が必要か確認してください");
  });
  it("元のデータどうしの食い違いでなくても、価格以外は従来の文", () => {
    expect(item(base({ documents: [doc({ settlementDate: "2026-12-01" })] }), "settlement_date").message).toContain("発行後に値が変わった");
  });
  it("値の無い過去の書類は「確認できない」(不一致にしない)", () => {
    const i = item(base({ documents: [doc()] }), "price");
    expect(i.status).toBe("unverifiable");
    expect(i.legacyDocuments).toBe(1);
  });
  it("価格を使わない書類は出どころにしない", () => {
    const i = item(base({ documents: [doc({ docType: "key_receipt" })] }), "price");
    expect(i.status).toBe("missing");
    expect(i.legacyDocuments).toBe(0);
  });
  it("取引の価格が空で書類に値がある=片方が未入力", () => {
    expect(item(base({ price: null, documents: [doc({ price: 1 })] }), "price").status).toBe("missing");
  });
});

describe("決済日", () => {
  it("日付で比べる(表記ゆれをそろえる)", () => {
    expect(item(base({ documents: [doc({ settlementDate: "２０２６年１１月３０日" })] }), "settlement_date").status).toBe("match");
    expect(item(base({ documents: [doc({ settlementDate: "2026-12-01" })] }), "settlement_date").status).toBe("mismatch");
  });
  it("取引の決済日が空=片方が未入力", () => {
    expect(item(base({ settlementDate: null, documents: [doc({ settlementDate: "2026-11-30" })] }), "settlement_date").status).toBe("missing");
  });
});

describe("売主名", () => {
  const owners = (names: [string, string | null][], over = {}) => registry({
    owners: { list: names.map(([name, share]) => ({ name, share })), confirmed: true, attachmentCreatedAt: AT, ...over },
  });
  const seller = (name: string, shareNum: number | null = null, shareDen: number | null = null) => ({ name, shareNum, shareDen });

  it("一致(空白の違いをそろえる)", () => {
    expect(item(base({ sellers: [seller("架空 太郎")], registry: owners([["架空太郎", null]]) }), "seller").status).toBe("match");
  });
  it("不一致は次にやることが分かる文言", () => {
    const i = item(base({ sellers: [seller("架空花子")], registry: owners([["架空太郎", null]]) }), "seller");
    expect(i.status).toBe("mismatch");
    expect(i.message).toBe(SELLER_MISMATCH_MESSAGE);
    expect(SELLER_MISMATCH_MESSAGE).toBe("登記名義人と売主が一致しません。相続登記・氏名変更登記などが決済までに必要か確認してください");
  });
  it("謄本の所有者名はどこにも出さない(不一致でも一致でも)", () => {
    for (const sellers of [[seller("架空花子")], [seller("登記名義太郎")]]) {
      const json = JSON.stringify(buildCrosscheck(base({ sellers, registry: owners([["登記名義太郎", null]]) })).items.find((i) => i.key === "seller")?.sources.find((s) => s.key === "registry"));
      expect(json).not.toContain("登記名義太郎");
    }
    const all = JSON.stringify(buildCrosscheck(base({ sellers: [seller("架空花子")], registry: owners([["登記名義太郎", null]]) })));
    expect(all).not.toContain("登記名義太郎");
  });
  it("共有: 名前の組み合わせと持分がそろえば一致", () => {
    const reg = owners([["架空太郎", "2分の1"], ["架空花子", "２分の１"]]);
    expect(item(base({ sellers: [seller("架空花子", 2, 4), seller("架空太郎", 1, 2)], registry: reg }), "seller").status).toBe("match");
  });
  it("共有: 持分が違えば不一致(名前の不一致とは別の文)", () => {
    const reg = owners([["架空太郎", "3分の2"], ["架空花子", "3分の1"]]);
    const i = item(base({ sellers: [seller("架空太郎", 1, 2), seller("架空花子", 1, 2)], registry: reg }), "seller");
    expect(i.status).toBe("mismatch");
    expect(i.message).toContain("持分");
    expect(i.message).not.toBe(SELLER_MISMATCH_MESSAGE);
  });
  it("共有: 持分が未入力なら名前だけ確かめて片方が未入力", () => {
    const reg = owners([["架空太郎", "2分の1"], ["架空花子", "2分の1"]]);
    const i = item(base({ sellers: [seller("架空太郎"), seller("架空花子")], registry: reg }), "seller");
    expect(i.status).toBe("missing");
    expect(i.message).toContain("持分");
  });
  it("共有: 人数が足りない=不一致", () => {
    const reg = owners([["架空太郎", "2分の1"], ["架空花子", "2分の1"]]);
    expect(item(base({ sellers: [seller("架空太郎", 1, 2)], registry: reg }), "seller").status).toBe("mismatch");
  });
  it("謄本の持分が読めないときは名前だけで比べる", () => {
    const reg = owners([["架空太郎", null], ["架空花子", null]]);
    const i = item(base({ sellers: [seller("架空太郎", 1, 2), seller("架空花子", 1, 2)], registry: reg }), "seller");
    expect(i.status).toBe("match");
    expect(i.message).toContain("持分");
  });
  it("単独所有: 当事者の持分が 1/1 以外なら不一致", () => {
    expect(item(base({ sellers: [seller("架空太郎", 1, 1)], registry: owners([["架空太郎", null]]) }), "seller").status).toBe("match");
    expect(item(base({ sellers: [seller("架空太郎", 1, 2)], registry: owners([["架空太郎", null]]) }), "seller").status).toBe("mismatch");
  });
  it("権限が無い人には比べない(確認できない・件数に数えない)", () => {
    const input = base({ sellerCompare: "denied", sellers: [seller("架空花子")], registry: owners([["架空太郎", null]]) });
    const i = item(input, "seller");
    expect(i.status).toBe("unverifiable");
    expect(i.message).toContain("権限");
    expect(buildCrosscheck(input).mismatchCount).toBe(0);
  });
  it("売主が未入力・謄本が無い=片方が未入力", () => {
    expect(item(base({ registry: owners([["架空太郎", null]]) }), "seller").status).toBe("missing");
    expect(item(base({ sellers: [seller("架空太郎")] }), "seller").status).toBe("missing");
  });
  it("確認の要る注記がある所有者・読めない謄本=確認できない", () => {
    expect(item(base({ sellers: [seller("架空太郎")], registry: owners([["架空太郎", null]], { confirmed: false }) }), "seller").status).toBe("unverifiable");
    expect(item(base({ sellers: [seller("架空太郎")], registry: { status: "unreadable" } }), "seller").status).toBe("unverifiable");
  });
  it("決済日より後に取り込んだ謄本では比べない(買主名義の可能性)", () => {
    const input = base({
      settlementDate: "2026-09-30", sellers: [seller("架空花子")],
      registry: owners([["買主太郎", null]]),
    });
    const i = item(input, "seller");
    expect(i.status).toBe("unverifiable");
    expect(i.message).toContain("決済");
  });
});

describe("有効な担保", () => {
  const rights = (activeRights: number) => registry({ rights: { activeRights, attachmentCreatedAt: AT, readable: true } });
  const check = (activeRights?: number) => doc({ docType: "checklist_settlement", title: "書類確認書(決済時)", ...(activeRights === undefined ? {} : { activeRights }) });

  it("書類確認書の件数と一致・不一致", () => {
    expect(item(base({ registry: rights(2), documents: [check(2)] }), "mortgage").status).toBe("match");
    expect(item(base({ registry: rights(2), documents: [check(0)] }), "mortgage").status).toBe("mismatch");
    expect(item(base({ registry: rights(0), documents: [check(1)] }), "mortgage").status).toBe("mismatch");
  });
  it("書類確認書が未発行=片方が未入力・過去の書類=確認できない", () => {
    expect(item(base({ registry: rights(1) }), "mortgage").status).toBe("missing");
    expect(item(base({ registry: rights(1), documents: [check()] }), "mortgage").status).toBe("unverifiable");
  });
  it("全部事項が無い=片方が未入力・読めない=確認できない", () => {
    expect(item(base({ documents: [check(1)] }), "mortgage").status).toBe("missing");
    expect(item(base({ registry: registry({ rights: { activeRights: 0, attachmentCreatedAt: AT, readable: false } }) }), "mortgage").status).toBe("unverifiable");
  });
  it("残っていれば注意を識別子つきで出す(件数に数えない)・無ければ出さない", () => {
    const r = buildCrosscheck(base({ registry: rights(2), documents: [check(2)] }));
    const n = r.notices.find((x) => x.id === CROSSCHECK_NOTICE_IDS.activeMortgage);
    expect(CROSSCHECK_NOTICE_IDS.activeMortgage).toBe("crosscheck.activeMortgage");
    expect(n?.message).toBe(ACTIVE_MORTGAGE_MESSAGE);
    expect(ACTIVE_MORTGAGE_MESSAGE).toBe("抹消書類の手配を確認してください");
    expect(n?.count).toBe(2);
    expect(r.mismatchCount).toBe(0);
    expect(buildCrosscheck(base({ registry: rights(0) })).notices.some((x) => x.id === CROSSCHECK_NOTICE_IDS.activeMortgage)).toBe(false);
  });
});

describe("土地のある物件の謄本(土地と建物の両方が要る)", () => {
  const OLD = "2026-09-01T03:00:00.000Z";
  const seller = { name: "架空太郎", shareNum: null, shareDen: null };
  const both = (over: Partial<Extract<RegistryFacts, { status: "ok" }>> = {}) => registry({
    missing: [], uncertain: null,
    certificates: [{ side: "土地", createdAt: AT }, { side: "建物", createdAt: OLD }],
    areas: { unit: null, land: "120.50", building: "91.05", attachmentCreatedAt: OLD },
    rights: { activeRights: 0, readable: true, attachmentCreatedAt: OLD },
    owners: { list: [{ name: "架空太郎", share: null }], confirmed: true, attachmentCreatedAt: OLD },
    ...over,
  });
  const house = (over: Partial<CrosscheckInput> = {}) => base({
    kindBase: "house", snapshot: { floorArea: 91.05, landArea: 120.5 }, sellers: [seller],
    property: { exclusiveArea: null, exclusiveAreaRegistry: null, landArea: "120.50", landAreaMethod: "公簿", totalFloorArea: "91.05" },
    ...over,
  });
  const check = (activeRights: number) => doc({ docType: "checklist_settlement", title: "書類確認書(決済時)", activeRights });

  it("両方そろえば担保も売主も比べて照合OK", () => {
    const input = house({ registry: both(), documents: [check(0)] });
    expect(item(input, "mortgage").status).toBe("match");
    expect(item(input, "seller").status).toBe("match");
    expect(buildCrosscheck(input).summary).toBe("ok");
  });
  it("建物の謄本が無い: 担保と所有者は確認できない・照合OKにしない", () => {
    const input = house({ registry: both({ missing: ["建物"] }), documents: [check(0)] });
    for (const key of ["mortgage", "seller"] as const) {
      expect(item(input, key).status).toBe("unverifiable");
      expect(item(input, key).message).toBe("確認できない(建物の謄本がありません)");
    }
    const r = buildCrosscheck(input);
    expect(r.summary).toBe("incomplete");
    expect(r.mismatchCount).toBe(0);
  });
  it("土地の謄本が無いときも同じ", () => {
    expect(item(house({ registry: both({ missing: ["土地"] }) }), "mortgage").message).toBe("確認できない(土地の謄本がありません)");
  });
  it("謄本が1通も無い: 両方の謄本が無いと出す・照合OKにしない", () => {
    const input = house({ registry: { status: "none" }, documents: [doc({ price: 30_000_000 })] });
    expect(item(input, "mortgage").message).toBe("確認できない(土地・建物の謄本がありません)");
    expect(buildCrosscheck(input).summary).toBe("incomplete");
    // 比べられた項目が無ければ、照合できる項目がありません。
    expect(buildCrosscheck(house({ registry: { status: "none" } })).summary).toBe("none");
  });
  it("土地の取引は土地の謄本だけで足りる", () => {
    const input = house({ kindBase: "land", registry: both() });
    expect(item(input, "seller").status).toBe("match");
    expect(item(house({ kindBase: "land", registry: { status: "none" } }), "mortgage").message).toBe("確認できない(土地の謄本がありません)");
  });
  it("面積の合計を出せないときは謄本を比べない(不一致にせず、照合OKにもしない)", () => {
    const input = house({ registry: both({ uncertain: "unreadable", areas: { unit: null, land: null, building: null, attachmentCreatedAt: OLD } }), documents: [doc({ price: 30_000_000 })] });
    expect(item(input, "area_land").sources.find((s) => s.key === "registry")?.state).toBe("unverifiable");
    expect(item(input, "area_land").status).not.toBe("mismatch");
    const r = buildCrosscheck(input);
    expect(r.mismatchCount).toBe(0);
    expect(r.summary).toBe("incomplete");
  });
  it("読めない・判定できない・多すぎる謄本があれば確認できない", () => {
    for (const [uncertain, text] of [["unreadable", "読めない謄本"], ["unclassified", "判定できない謄本"], ["too_many", "すべてを確認できません"], ["no_full_certificate", "全部事項の謄本が無い"]] as const) {
      const input = house({ registry: both({ uncertain }) });
      expect(item(input, "mortgage").status).toBe("unverifiable");
      expect(item(input, "seller").message).toContain(text);
      expect(buildCrosscheck(input).summary).toBe("incomplete");
    }
  });
  it("謄本を読む権限が無い人にも照合OKと出さない", () => {
    expect(buildCrosscheck(house({ registry: { status: "denied" }, sellerCompare: "denied", documents: [doc({ price: 30_000_000 })] })).summary).toBe("incomplete");
  });
  it("見つかった権利の注意は片方だけでも出す(分かっている分と示す)", () => {
    const r = buildCrosscheck(house({ registry: both({ missing: ["土地"], rights: { activeRights: 1, readable: true, attachmentCreatedAt: AT } }) }));
    const n = r.notices.find((x) => x.id === CROSSCHECK_NOTICE_IDS.activeMortgage);
    expect(n?.count).toBe(1);
    expect(n?.partial).toBe(true);
  });
  it("不一致があれば食い違いを優先する", () => {
    expect(buildCrosscheck(house({ registry: both({ missing: ["土地"] }), price: 1, documents: [doc({ price: 2 })] })).summary).toBe("mismatch");
  });
  it("土地と建物で所有者や持分が違えば、持分は比べず確認できない", () => {
    const input = house({ registry: both({ owners: { list: [{ name: "架空太郎", share: null }], confirmed: true, attachmentCreatedAt: OLD, differsAcross: true } }) });
    const i = item(input, "seller");
    expect(i.status).toBe("unverifiable");
    expect(i.message).toContain("土地と建物");
    expect(buildCrosscheck(input).summary).toBe("incomplete");
  });
  it("名前が足りなければ、土地と建物で違っていても不一致", () => {
    const input = house({ registry: both({ owners: { list: [{ name: "架空太郎", share: null }, { name: "架空花子", share: null }], confirmed: true, attachmentCreatedAt: OLD, differsAcross: true } }) });
    expect(item(input, "seller").status).toBe("mismatch");
  });
  it("どれか1通でも決済日より後なら売主とは比べない", () => {
    const input = house({
      settlementDate: "2026-09-30",
      registry: both({ owners: { list: [{ name: "買主", share: null }], confirmed: true, attachmentCreatedAt: OLD, newestCreatedAt: AT } }),
    });
    expect(item(input, "seller").status).toBe("unverifiable");
  });
  it("謄本の日付は土地と建物を分けて出し、古いほうで注意する", () => {
    const r = buildCrosscheck(house({ settlementDate: "2026-12-15", registry: both() }));
    expect(r.registries).toEqual([
      { date: "2026-09-01", usedFor: ["建物"] },
      { date: "2026-10-01", usedFor: ["土地"] },
    ]);
    expect(r.notices.some((x) => x.id === CROSSCHECK_NOTICE_IDS.registryStale)).toBe(true);
  });
  it("種類が未選択なら必要な謄本を決められない(区分は従来どおり)", () => {
    const input = house({ kindBase: null, registry: both(), documents: [doc({ price: 30_000_000 })] });
    expect(item(input, "mortgage").message).toContain("物件の種類");
    expect(buildCrosscheck(input).summary).toBe("incomplete");
    expect(item(base({ sellers: [seller], registry: both({ certificates: undefined }) }), "seller").status).toBe("match");
  });
});

describe("表記の違い(異体字)", () => {
  const owners = (...names: string[]) => registry({
    owners: { list: names.map((name) => ({ name, share: null })), confirmed: true, attachmentCreatedAt: AT },
  });
  const seller = (name: string, shareNum: number | null = null, shareDen: number | null = null) => ({ name, shareNum, shareDen });

  it("対応表の字はそろえて比べる・表は足せる", () => {
    for (const [a, b] of [["髙橋", "高橋"], ["山﨑", "山崎"], ["齋藤", "斎藤"], ["渡邊", "渡辺"], ["渡邉", "渡辺"]]) {
      expect(foldNameVariants(a)).toBe(foldNameVariants(b));
      expect(normalizeName(a)).not.toBe(normalizeName(b));
    }
    expect(Object.keys(NAME_VARIANTS).length).toBeGreaterThanOrEqual(4);
  });
  it("異体字だけの違い: 不一致にせず、件数に数えず、注意を出す", () => {
    const r = buildCrosscheck(base({ sellers: [seller("高橋一郎")], registry: owners("髙橋一郎") }));
    const i = r.items.find((x) => x.key === "seller");
    expect(i?.status).toBe("notation_differs");
    expect(i?.message).toBe(NAME_VARIANT_MESSAGE);
    expect(NAME_VARIANT_MESSAGE).toBe("登記の表記(異体字)と違います。書類の表記を登記に合わせるか確認してください");
    expect(r.mismatchCount).toBe(0);
    expect(r.notices.find((x) => x.id === CROSSCHECK_NOTICE_IDS.nameVariant)?.message).toBe(NAME_VARIANT_MESSAGE);
    expect(JSON.stringify(r)).not.toContain("髙橋");
  });
  it("完全に同じ字なら一致・別の字なら不一致のまま", () => {
    expect(item(base({ sellers: [seller("髙橋一郎")], registry: owners("髙橋一郎") }), "seller").status).toBe("match");
    expect(item(base({ sellers: [seller("田中一郎")], registry: owners("髙橋一郎") }), "seller").status).toBe("mismatch");
  });
  it("異体字があっても持分の違いは不一致", () => {
    const reg = registry({ owners: { list: [{ name: "髙橋一郎", share: "3分の2" }, { name: "架空花子", share: "3分の1" }], confirmed: true, attachmentCreatedAt: AT } });
    const i = item(base({ sellers: [seller("高橋一郎", 1, 2), seller("架空花子", 1, 2)], registry: reg }), "seller");
    expect(i.status).toBe("mismatch");
    expect(i.message).toContain("持分");
  });
  it("発行の確認には出さない(不一致ではない)", () => {
    const r = buildCrosscheck(base({ sellers: [seller("高橋一郎")], registry: owners("髙橋一郎") }));
    expect(issueWarnings(r, "funding_plan")).toEqual([]);
  });
});

describe("賃貸人変更のお知らせの変更日", () => {
  const notice = (settlementDate: string | null) => doc({ documentId: "n", docType: "landlord_change_notice", title: "賃貸人変更のお知らせ", settlementDate });
  it("決済日と別の日は不一致でなく種類が違う", () => {
    const r = buildCrosscheck(base({ documents: [notice("2026-12-01")] }));
    const i = r.items.find((x) => x.key === "landlord_change_date");
    expect(i?.status).toBe("kind_differs");
    expect(i?.message).toBe("変更日が決済日と違います(意図したものか確認)");
    expect(r.mismatchCount).toBe(0);
    expect(r.items.find((x) => x.key === "settlement_date")?.status).toBe("missing");
    expect(issueWarnings(r, "settlement_statement")).toEqual([]);
  });
  it("同じ日なら決済日の照合に入る(別の項目を出さない)", () => {
    const r = buildCrosscheck(base({ documents: [notice("2026-11-30")] }));
    expect(r.items.find((x) => x.key === "settlement_date")?.status).toBe("match");
    expect(r.items.some((x) => x.key === "landlord_change_date")).toBe(false);
  });
  it("他の書類の決済日の違いは不一致のまま", () => {
    const r = buildCrosscheck(base({ documents: [notice("2026-12-01"), doc({ settlementDate: "2026-12-01" })] }));
    expect(r.items.find((x) => x.key === "settlement_date")?.status).toBe("mismatch");
  });
});

describe("照合に使った謄本の日付", () => {
  const withDate = (attachmentCreatedAt: string, settlementDate: string | null = "2026-11-30") => base({
    settlementDate, registry: registry({ rights: { activeRights: 0, attachmentCreatedAt, readable: true } }),
  });
  const stale = (input: CrosscheckInput) => buildCrosscheck(input).notices.find((x) => x.id === CROSSCHECK_NOTICE_IDS.registryStale);

  it("使った謄本の取り込んだ日と用途を返す", () => {
    const r = buildCrosscheck(base({ registry: registry({
      areas: { unit: "60.25", land: null, building: null, attachmentCreatedAt: AT },
      rights: { activeRights: 0, attachmentCreatedAt: AT, readable: true },
      owners: { list: [{ name: "架空太郎", share: null }], confirmed: true, attachmentCreatedAt: "2026-10-05T03:00:00.000Z" },
    }) }));
    expect(r.registries).toEqual([
      { date: "2026-10-01", usedFor: ["面積", "担保"] },
      { date: "2026-10-05", usedFor: ["売主名"] },
    ]);
  });
  it("決済日の3か月より前なら注意(件数に数えない)", () => {
    const input = withDate("2026-08-29T03:00:00.000Z");
    expect(stale(input)?.message).toBe(REGISTRY_STALE_MESSAGE);
    expect(REGISTRY_STALE_MESSAGE).toBe("謄本が古い可能性があります。決済前に最新の謄本で確認してください");
    expect(buildCrosscheck(input).mismatchCount).toBe(0);
  });
  it("ちょうど3か月前は注意しない", () => {
    expect(stale(withDate("2026-08-30T03:00:00.000Z"))).toBeUndefined();
  });
  it("日本時間の日付で判定する", () => {
    // 8/29 15:30 UTC = 8/30 00:30 JST(ちょうど3か月前)
    expect(stale(withDate("2026-08-29T15:30:00.000Z"))).toBeUndefined();
  });
  it("月末は短い月に寄せる(5/31 の3か月前 = 2/28)", () => {
    expect(stale(withDate("2026-02-28T03:00:00.000Z", "2026-05-31"))).toBeUndefined();
    expect(stale(withDate("2026-02-27T03:00:00.000Z", "2026-05-31"))).toBeDefined();
  });
  it("決済日が無ければ注意しない", () => {
    expect(stale(withDate("2020-01-01T03:00:00.000Z", null))).toBeUndefined();
  });
});

describe("全体の結果", () => {
  it("比べられた項目が無い=none(照合OKにしない)", () => {
    const r = buildCrosscheck(base({ kindBase: null, property: null, snapshot: { floorArea: null, landArea: null } }));
    expect(r.summary).toBe("none");
    expect(r.comparedCount).toBe(0);
  });
  it("一致があり不一致が無い=ok・不一致があれば mismatch と件数", () => {
    expect(buildCrosscheck(base()).summary).toBe("ok");
    const r = buildCrosscheck(base({ snapshot: { floorArea: 1, landArea: null }, documents: [doc({ price: 1 })] }));
    expect(r.summary).toBe("mismatch");
    expect(r.mismatchCount).toBe(2);
  });
});

describe("発行の前の確認", () => {
  it("これから出す書類の古い版だけの食い違いは確認に出さない", () => {
    const r = buildCrosscheck(base({ documents: [doc({ price: 1 })] }));
    expect(issueWarnings(r, "settlement_statement")).toEqual([]);
    expect(issueWarnings(r, "funding_plan").map((i) => i.key)).toEqual(["price"]);
  });
  it("元のデータどうしの食い違いは、どの書類でも確認に出す", () => {
    const r = buildCrosscheck(base({ snapshot: { floorArea: 1, landArea: null } }));
    expect(issueWarnings(r, "settlement_statement").map((i) => i.key)).toEqual(["area_wall"]);
  });
  it("売主名の不一致は確認に出す", () => {
    const r = buildCrosscheck(base({
      sellers: [{ name: "架空花子", shareNum: null, shareDen: null }],
      registry: registry({ owners: { list: [{ name: "架空太郎", share: null }], confirmed: true, attachmentCreatedAt: AT } }),
    }));
    expect(issueWarnings(r, "funding_plan").map((i) => i.key)).toEqual(["seller"]);
  });
  it("書類の値が他の書類とも違えば、出す書類を除いても確認に出す", () => {
    const r = buildCrosscheck(base({ documents: [doc({ price: 1 }), doc({ documentId: "doc-2", docType: "mediation", price: 2 })] }));
    expect(issueWarnings(r, "settlement_statement").map((i) => i.key)).toEqual(["price"]);
  });
});
