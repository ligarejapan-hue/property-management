import { describe, expect, it } from "vitest";
import {
  dealScopeOf,
  dealScopeOptions,
  estimatedAssignments,
  filterByScope,
  parseScopeInput,
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
