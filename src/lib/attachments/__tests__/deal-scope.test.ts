import { describe, expect, it } from "vitest";
import {
  dealScopeOf,
  dealScopeOptions,
  estimatedAssignments,
  filterByScope,
  parseScopeInput,
  quietUploadDealOf,
  splitDealsOf,
  type ScopeDeal,
} from "../deal-scope";

const purchase: ScopeDeal = { id: "dp", dealNo: "2026-0012", status: "settled", side: "purchase", settlementAt: "2026-05-30T01:00:00.000Z", createdAt: "2026-03-01T00:00:00.000Z" };
const sale: ScopeDeal = { id: "ds", dealNo: "2026-0031", status: "considering", side: "sale", settlementAt: null, createdAt: "2026-08-01T00:00:00.000Z" };
const att = (o: Partial<Parameters<typeof dealScopeOf>[0]> = {}) => ({
  id: "a1", type: "general", docStage: "contract", dealId: null, dealCommon: false, createdAt: "2026-04-15T03:00:00.000Z", ...o,
});

describe("仕入・売却に分ける取引", () => {
  it("仕入/売却の分かる取引だけ・中止は外す・新しい順のまま", () => {
    const cancelled = { ...sale, id: "dx", status: "cancelled" };
    const unknown = { ...sale, id: "du", side: null };
    expect(splitDealsOf([sale, cancelled, unknown, purchase]).map((d) => d.id)).toEqual(["ds", "dp"]);
  });
});

describe("添付の取引(確定・推定)", () => {
  const deals = [sale, purchase];
  it("決めた取引・共通はそのまま(確定)", () => {
    expect(dealScopeOf(att({ dealId: "ds" }), deals)).toEqual({ scope: "ds", estimated: false });
    expect(dealScopeOf(att({ dealCommon: true }), deals)).toEqual({ scope: "common", estimated: false });
  });
  it("仕入の決済日(日本時間)までに入れたものは仕入・後は売却と推定", () => {
    expect(dealScopeOf(att(), deals)).toEqual({ scope: "dp", estimated: true });
    // 決済日の日本時間の夜(UTC では同じ日の 14:00)も仕入
    expect(dealScopeOf(att({ createdAt: "2026-05-30T14:00:00.000Z" }), deals)).toEqual({ scope: "dp", estimated: true });
    // 翌日(日本時間 5/31 0:00 = UTC 5/30 15:00)からは売却
    expect(dealScopeOf(att({ createdAt: "2026-05-30T15:00:00.000Z" }), deals)).toEqual({ scope: "ds", estimated: true });
  });
  it("謄本・調査資料は共通と推定(発注者決定)", () => {
    expect(dealScopeOf(att({ type: "registry", docStage: null }), deals)).toEqual({ scope: "common", estimated: true });
    expect(dealScopeOf(att({ docStage: "pre_contract" }), deals)).toEqual({ scope: "common", estimated: true });
  });
  it("仕入の決済日が無いときは、売却の取引を作った日を境に", () => {
    const p = { ...purchase, settlementAt: null };
    expect(dealScopeOf(att({ createdAt: "2026-07-31T00:00:00.000Z" }), [sale, p])).toEqual({ scope: "dp", estimated: true });
    expect(dealScopeOf(att({ createdAt: "2026-08-02T00:00:00.000Z" }), [sale, p])).toEqual({ scope: "ds", estimated: true });
  });
  it("取引が片方だけならそちら・どちらも無ければ推定しない", () => {
    expect(dealScopeOf(att({ createdAt: "2026-09-01T00:00:00.000Z" }), [purchase])).toEqual({ scope: "dp", estimated: true });
    expect(dealScopeOf(att(), [sale])).toEqual({ scope: "ds", estimated: true });
    expect(dealScopeOf(att(), [])).toEqual({ scope: null, estimated: false });
  });
  it("決めた取引が今の一覧に無い(中止など)ときもその取引のまま", () => {
    expect(dealScopeOf(att({ dealId: "gone" }), deals)).toEqual({ scope: "gone", estimated: false });
  });
});

describe("推定どおりに確定する分", () => {
  it("推定がある未区分だけ・確定済みと推定できないものは入れない", () => {
    const items = [att({ id: "a1" }), att({ id: "a2", dealId: "ds" }), att({ id: "a3", type: "registry" })];
    expect(estimatedAssignments(items, [sale, purchase])).toEqual([
      { attachmentId: "a1", scope: "dp" },
      { attachmentId: "a3", scope: "common" },
    ]);
    expect(estimatedAssignments(items, [])).toEqual([]);
  });
});

describe("絞り込み", () => {
  it("取引ごと・共通・未区分(推定も含めて確定していないもの)", () => {
    const items = [att({ id: "a1" }), att({ id: "a2", dealId: "ds" }), att({ id: "a3", dealCommon: true })];
    const deals = [sale, purchase];
    expect(filterByScope(items, deals, "all").map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    expect(filterByScope(items, deals, "ds").map((a) => a.id)).toEqual(["a2"]);
    expect(filterByScope(items, deals, "common").map((a) => a.id)).toEqual(["a3"]);
    expect(filterByScope(items, deals, "unset").map((a) => a.id)).toEqual(["a1"]);
    // 取引で絞るときは推定も入れる(未区分のまま見落とさない)
    expect(filterByScope(items, deals, "dp").map((a) => a.id)).toEqual(["a1"]);
  });
});

describe("選択肢と入力", () => {
  it("取引の選択肢は「仕入 2026-0012」の形+共通", () => {
    expect(dealScopeOptions([sale, purchase])).toEqual([
      { value: "ds", label: "売却 2026-0031" },
      { value: "dp", label: "仕入 2026-0012" },
      { value: "common", label: "共通" },
    ]);
  });
  it("送られた値: common・uuid・null(未区分に戻す)だけ", () => {
    expect(parseScopeInput("common")).toEqual({ dealId: null, dealCommon: true });
    expect(parseScopeInput(null)).toEqual({ dealId: null, dealCommon: false });
    expect(parseScopeInput("6F9619FF-8B86-D011-B42D-00C04FC964FF")).toEqual({ dealId: "6f9619ff-8b86-d011-b42d-00c04fc964ff", dealCommon: false });
    expect(parseScopeInput("xyz")).toBeUndefined();
  });
});

describe("仲介の取引も分ける(2026-11-24 発注者 案a)", () => {
  // 購入時の仲介(買主側・6/10 決済)→ 売却時の仲介(売主側)。物件の API と同じ新しい順で渡す。
  const buy: ScopeDeal = { id: "bb", dealNo: "2026-0007", status: "settled", side: null, businessType: "brokerage", tradeSide: "buyer", settlementAt: "2026-06-10T01:00:00.000Z", createdAt: "2026-04-01T00:00:00.000Z" };
  const sell: ScopeDeal = { id: "bs", dealNo: "2026-0012", status: "considering", side: null, businessType: "brokerage", tradeSide: "seller", settlementAt: null, createdAt: "2026-09-01T00:00:00.000Z" };
  const deals = [sell, buy];

  it("中止でない仲介の取引が2件以上なら分ける・1件だけなら分けない(今までどおり)", () => {
    expect(splitDealsOf(deals).map((d) => d.id)).toEqual(["bs", "bb"]);
    expect(splitDealsOf([buy])).toEqual([]);
    // 中止した取引は数えない・分ける対象にしない
    expect(splitDealsOf([{ ...sell, status: "cancelled" }, buy])).toEqual([]);
    const third = { ...sell, id: "bc", status: "cancelled" };
    expect(splitDealsOf([third, sell, buy]).map((d) => d.id)).toEqual(["bs", "bb"]);
  });
  it("買取再販だけの物件は今までどおり(1件でも分ける・仕入/売却の分からない取引は外す)", () => {
    expect(splitDealsOf([purchase]).map((d) => d.id)).toEqual(["dp"]);
    expect(splitDealsOf([{ ...sale, side: null, businessType: "resale" }, purchase]).map((d) => d.id)).toEqual(["dp"]);
  });
  it("買取再販と仲介が両方ある物件は、仲介の取引も分ける(どこにも出ない書類をなくす)", () => {
    expect(splitDealsOf([sell, purchase]).map((d) => d.id)).toEqual(["bs", "dp"]);
    // 仲介の取引の印が付いた書類が、その取引の絞り込みに出る(11-21 の自動で入れた書類など)
    expect(filterByScope([att({ dealId: "bs" })], [sell, purchase], "bs").map((a) => a.id)).toEqual(["a1"]);
  });
  it("買取再販の仕入・売却+仲介の3件: 作った順の決まりで推定する", () => {
    // 作った順: 購入仲介 1/10(2/20 決済)→ 仕入 3/1(5/30 決済)→ 売却 8/1
    const early = { ...buy, settlementAt: "2026-02-20T00:00:00.000Z", createdAt: "2026-01-10T00:00:00.000Z" };
    const mixed = [sale, purchase, early];
    expect(dealScopeOf(att({ createdAt: "2026-02-01T00:00:00.000Z" }), mixed).scope).toBe("bb");
    expect(dealScopeOf(att({ createdAt: "2026-04-15T03:00:00.000Z" }), mixed).scope).toBe("dp");
    expect(dealScopeOf(att({ createdAt: "2026-06-01T00:00:00.000Z" }), mixed).scope).toBe("ds");
  });
  it("名前: 購入仲介・売却仲介・両手仲介・態様が未入力なら仲介", () => {
    const both = { ...sell, id: "bw", dealNo: "2026-0020", tradeSide: "both" };
    const none = { ...sell, id: "bn", dealNo: "2026-0021", tradeSide: null };
    expect(dealScopeOptions([sell, buy, both, none])).toEqual([
      { value: "bs", label: "売却仲介 2026-0012" },
      { value: "bb", label: "購入仲介 2026-0007" },
      { value: "bw", label: "両手仲介 2026-0020" },
      { value: "bn", label: "仲介 2026-0021" },
      { value: "common", label: "共通" },
    ]);
  });
  it("推定: 作った順に並べ、前の取引の決済日(日本時間)までは前の取引・後は次の取引", () => {
    expect(dealScopeOf(att({ createdAt: "2026-05-01T00:00:00.000Z" }), deals)).toEqual({ scope: "bb", estimated: true });
    expect(dealScopeOf(att({ createdAt: "2026-06-10T14:00:00.000Z" }), deals)).toEqual({ scope: "bb", estimated: true });
    expect(dealScopeOf(att({ createdAt: "2026-06-10T15:00:00.000Z" }), deals)).toEqual({ scope: "bs", estimated: true });
    // 謄本・調査資料は共通と推定(買取再販と同じ)
    expect(dealScopeOf(att({ type: "registry", docStage: null }), deals)).toEqual({ scope: "common", estimated: true });
  });
  it("推定: 前の取引に決済日が無ければ、次の取引を作った日を境に", () => {
    const b = { ...buy, settlementAt: null };
    expect(dealScopeOf(att({ createdAt: "2026-08-31T00:00:00.000Z" }), [sell, b])).toEqual({ scope: "bb", estimated: true });
    expect(dealScopeOf(att({ createdAt: "2026-09-02T00:00:00.000Z" }), [sell, b])).toEqual({ scope: "bs", estimated: true });
  });
  it("推定: 取引が3件以上でも同じ決まり(最後の取引の後はいちばん新しい取引)", () => {
    const sell2 = { ...sell, settlementAt: "2026-10-01T00:00:00.000Z" };
    const next: ScopeDeal = { ...buy, id: "bn", dealNo: "2026-0030", status: "considering", tradeSide: "buyer", settlementAt: null, createdAt: "2026-11-01T00:00:00.000Z" };
    const three = [next, sell2, buy];
    expect(dealScopeOf(att({ createdAt: "2026-05-01T00:00:00.000Z" }), three).scope).toBe("bb");
    expect(dealScopeOf(att({ createdAt: "2026-07-01T00:00:00.000Z" }), three).scope).toBe("bs");
    expect(dealScopeOf(att({ createdAt: "2026-12-01T00:00:00.000Z" }), three).scope).toBe("bn");
  });
  it("推定どおりに確定・未区分の絞り込みも仲介の取引で動く", () => {
    const items = [att({ id: "a1" }), att({ id: "a2", createdAt: "2026-10-01T00:00:00.000Z" }), att({ id: "a3", dealId: "bs" })];
    expect(estimatedAssignments(items, deals)).toEqual([
      { attachmentId: "a1", scope: "bb" },
      { attachmentId: "a2", scope: "bs" },
    ]);
    expect(filterByScope(items, deals, "bs").map((a) => a.id)).toEqual(["a2", "a3"]);
    expect(filterByScope(items, deals, "unset").map((a) => a.id)).toEqual(["a1", "a2"]);
  });
  it("仲介の取引が1件だけ(分けない)物件の取引の画面からは、画面に出さずにその取引を付ける(案ア)", () => {
    expect(quietUploadDealOf([buy], "bb")).toBe("bb");
    // 分ける物件では付けない(画面で決めた取引を使う)・中止の取引・買取再販・取引の画面でないときも付けない
    expect(quietUploadDealOf(deals, "bb")).toBeNull();
    expect(quietUploadDealOf([{ ...buy, status: "cancelled" }], "bb")).toBeNull();
    expect(quietUploadDealOf([{ ...sale, side: null, businessType: "resale" }], "ds")).toBeNull();
    expect(quietUploadDealOf([buy], null)).toBeNull();
    expect(quietUploadDealOf(null, "bb")).toBeNull();
    expect(quietUploadDealOf([buy], "other")).toBeNull();
  });
});
