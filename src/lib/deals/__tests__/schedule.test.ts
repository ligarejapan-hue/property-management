import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULE_TEMPLATE, addYmdDays, applyScheduleEvents, computeDueDate, mortgageStateOf, reconcileSchedule, resolveScheduleTemplate,
  scheduleBadge, scheduleEligible, scheduleGroupOf, scheduleNoticeSlot, scheduleTemplateSchema, shiftOffWeekend, jstMorningSendAt,
  type ReconcileDeal, type ScheduleItemState,
} from "../schedule";
import { buildCrosscheck, CROSSCHECK_NOTICE_IDS, type RegistryFacts } from "../crosscheck";

const TODAY = "2026-11-02"; // 月曜
const deal = (o: Partial<ReconcileDeal> = {}): ReconcileDeal => ({
  businessType: "brokerage", tradeSide: "seller", kindBase: "unit", hasOc: false, status: "contracted",
  contractDate: "2026-11-02", settlementDate: "2026-12-16", // 水曜
  assigneeId: "assignee", salesStaffId: null, opsStaffId: null, createdById: "creator", ...o,
});
const run = (d: ReconcileDeal, o: { items?: ScheduleItemState[]; mortgage?: "yes" | "no" | "unknown"; today?: string; template?: typeof DEFAULT_SCHEDULE_TEMPLATE; issued?: string[]; taxes?: boolean } = {}) =>
  reconcileSchedule({
    template: o.template ?? DEFAULT_SCHEDULE_TEMPLATE, deal: d, mortgage: o.mortgage ?? "no", items: o.items ?? [],
    today: o.today ?? TODAY, issuedDocTypes: o.issued ?? [], taxesEntered: o.taxes ?? false,
  });
const keys = (d: ReconcileDeal, o: Parameters<typeof run>[1] = {}) => run(d, o).creates.map((c) => c.templateKey);
/** 作ったものを、保存済みの項目の形にする。 */
const saved = (d: ReconcileDeal, o: Parameters<typeof run>[1] = {}): ScheduleItemState[] =>
  run(d, o).creates.map((c, i) => ({
    id: `id${i}`, templateKey: c.templateKey, dueDate: c.dueDate, dueManual: false, assigneeId: c.assigneeId, assigneeManual: false,
    completed: c.completed, excluded: false, excludedManual: false, preIntroduction: c.preIntroduction, mortgageUnknown: c.mortgageUnknown, completionHint: c.completionHint,
  }));
const byKey = (items: ScheduleItemState[], k: string) => items.find((i) => i.templateKey === k) as ScheduleItemState;

describe("日付の計算と土日", () => {
  it("土日は基準日より前なら前の金曜、後なら次の月曜に寄せる", () => {
    expect(shiftOffWeekend("2026-11-07", -7)).toBe("2026-11-06"); // 土→金
    expect(shiftOffWeekend("2026-11-08", -7)).toBe("2026-11-06"); // 日→金
    expect(shiftOffWeekend("2026-11-07", 1)).toBe("2026-11-09"); // 土→月
    expect(shiftOffWeekend("2026-11-08", 1)).toBe("2026-11-09"); // 日→月
    expect(shiftOffWeekend("2026-11-09", -1)).toBe("2026-11-09"); // 平日はそのまま
  });
  it("基準日の当日は寄せない(決済が土曜なら、決済の項目は土曜のまま)", () => {
    expect(shiftOffWeekend("2026-11-07", 0)).toBe("2026-11-07");
  });
  it("期限は基準日+日数を土日から寄せたもの", () => {
    const item = DEFAULT_SCHEDULE_TEMPLATE.find((t) => t.id === "s_keys_docs")!; // 決−1
    expect(computeDueDate(item, deal({ settlementDate: "2026-11-09" }))).toBe("2026-11-06"); // 月の前日=日→金
    expect(computeDueDate(item, deal({ settlementDate: null }))).toBeNull();
  });
  it("月またぎ", () => expect(addYmdDays("2026-12-31", 1)).toBe("2027-01-01"));
});

describe("ひな形から段取りを作る", () => {
  const always = ["c_scrivener", "s_tax", "s_statement", "s_final", "s_keys_docs", "s_settle", "s_key_receipt"];
  it("仲介・売主側・区分: 区分と売主側の項目が出て、買取再販とOCの項目は出ない", () => {
    expect(keys(deal()).sort()).toEqual([...always, "s_broker_check", "s_management_report", "s_mgmt_notify", "s_seller_docs"].sort());
  });
  it("仲介・買主側: 売主への案内は出ない", () => {
    expect(keys(deal({ tradeSide: "buyer" }))).not.toContain("s_seller_docs");
    expect(keys(deal({ tradeSide: "buyer" }))).toContain("s_broker_check");
  });
  it("仲介・両手: 売主への案内は出る", () => expect(keys(deal({ tradeSide: "both" }))).toContain("s_seller_docs"));
  it("買取再販: 融資と火災保険が出て、仲介の項目は出ない", () => {
    const k = keys(deal({ businessType: "resale", tradeSide: null }));
    expect(k).toEqual(expect.arrayContaining(["s_loan", "s_insurance"]));
    expect(k).not.toContain("s_broker_check");
    expect(k).not.toContain("s_seller_docs");
  });
  it("戸建: 区分の項目は出ない", () => {
    const k = keys(deal({ kindBase: "house" }));
    expect(k).not.toContain("s_management_report");
    expect(k).not.toContain("s_mgmt_notify");
  });
  it("OCあり: 賃借人への通知が出る", () => {
    expect(keys(deal({ hasOc: true }))).toContain("s_tenant_notice");
    expect(keys(deal())).not.toContain("s_tenant_notice");
  });
  it("担保あり: 抹消の依頼が出る。担保なしは出ない", () => {
    expect(keys(deal(), { mortgage: "yes" })).toContain("c_mortgage");
    expect(keys(deal(), { mortgage: "no" })).not.toContain("c_mortgage");
  });
  it("担保を判定できない: 確認を促す印を付けて出す", () => {
    const c = run(deal(), { mortgage: "unknown" }).creates.find((x) => x.templateKey === "c_mortgage");
    expect(c?.mortgageUnknown).toBe(true);
    expect(run(deal(), { mortgage: "yes" }).creates.find((x) => x.templateKey === "c_mortgage")?.mortgageUnknown).toBe(false);
  });
  it("契約日だけ入っていれば、契約日を基準にした項目だけ作る", () => {
    expect(keys(deal({ settlementDate: null }))).toEqual(["c_scrivener"]);
    expect(keys(deal({ contractDate: null, settlementDate: null }))).toEqual([]);
  });
  it("担当: ひな形の決め方の人。空なら取引の担当、それも空なら作成者", () => {
    const tpl = [{ ...DEFAULT_SCHEDULE_TEMPLATE[0], assigneeRule: "sales" as const }];
    expect(run(deal({ salesStaffId: "sales" }), { template: tpl }).creates[0].assigneeId).toBe("sales");
    expect(run(deal(), { template: tpl }).creates[0].assigneeId).toBe("assignee");
    expect(run(deal({ assigneeId: null }), { template: tpl }).creates[0].assigneeId).toBe("creator");
  });
  it("初期のひな形の担当はすべて取引の担当", () => {
    expect(DEFAULT_SCHEDULE_TEMPLATE.every((t) => t.assigneeRule === "assignee")).toBe(true);
    expect(DEFAULT_SCHEDULE_TEMPLATE).toHaveLength(15);
  });
});

describe("導入前の項目", () => {
  it("作った時点で期限が過ぎている項目は導入前にする。今日の期限は導入前にしない", () => {
    const d = deal({ contractDate: "2026-10-01", settlementDate: "2026-11-09" }); // 決−7=11/2(今日)
    const c = run(d).creates;
    expect(c.find((x) => x.templateKey === "c_scrivener")?.preIntroduction).toBe(true); // 10/2
    expect(c.find((x) => x.templateKey === "s_tax")?.preIntroduction).toBe(true); // 10/26
    expect(c.find((x) => x.templateKey === "s_statement")?.preIntroduction).toBe(false); // 今日
  });
  it("日付を直して期限が先になれば、導入前を外す", () => {
    const d = deal({ contractDate: "2026-10-01", settlementDate: "2026-11-09" });
    const items = saved(d);
    const u = run({ ...d, contractDate: "2026-11-10" }, { items }).updates.find((x) => x.id === byKey(items, "c_scrivener").id);
    expect(u?.data).toMatchObject({ dueDate: "2026-11-11", preIntroduction: false });
  });
  it("作ったあとに日付を早めて過ぎた項目は、本当の期限超過(導入前にしない)", () => {
    const d = deal({ settlementDate: "2026-12-16" });
    const items = saved(d);
    const u = run({ ...d, settlementDate: "2026-11-03" }, { items }).updates.find((x) => x.id === byKey(items, "s_tax").id);
    expect(u?.data.dueDate).toBe("2026-10-20");
    expect(u?.data.preIntroduction).toBeUndefined();
  });
});

describe("どの取引に作るか", () => {
  it("中止は作らない。決済日が過ぎていて項目の無い取引も作らない。決済日が今日以降は作る", () => {
    expect(scheduleEligible(deal({ status: "cancelled" }), false, TODAY)).toBe(false);
    expect(scheduleEligible(deal({ settlementDate: "2026-11-01" }), false, TODAY)).toBe(false);
    expect(scheduleEligible(deal({ settlementDate: TODAY }), false, TODAY)).toBe(true);
    expect(scheduleEligible(deal({ settlementDate: "2026-11-01" }), true, TODAY)).toBe(true);
  });
  it("対象外の取引では何もしない", () => {
    expect(run(deal({ status: "cancelled" }))).toEqual({ creates: [], updates: [] });
  });
});

describe("日付・条件を変えたときの付け直し", () => {
  const d = deal();
  it("日付が変わったら未完了の項目の期限を付け直す", () => {
    const items = saved(d);
    const { updates, creates } = run({ ...d, settlementDate: "2026-12-23" }, { items });
    expect(creates).toEqual([]);
    expect(updates.find((u) => u.id === byKey(items, "s_statement").id)?.data.dueDate).toBe("2026-12-16");
  });
  it("完了済みの項目は動かない", () => {
    const items = saved(d).map((i) => (i.templateKey === "s_statement" ? { ...i, completed: true } : i));
    const { updates } = run({ ...d, settlementDate: "2026-12-23" }, { items });
    expect(updates.find((u) => u.id === byKey(items, "s_statement").id)).toBeUndefined();
  });
  it("手で期限を直した項目は動かない(土日にも寄せない)", () => {
    const items = saved(d).map((i) => (i.templateKey === "s_statement" ? { ...i, dueManual: true, dueDate: "2026-12-05" } : i)); // 土曜
    const { updates } = run({ ...d, settlementDate: "2026-12-23" }, { items });
    expect(updates.find((u) => u.id === byKey(items, "s_statement").id)).toBeUndefined();
  });
  it("手で担当を直した項目は、取引の担当が変わっても動かない", () => {
    const items = saved(d).map((i) => (i.templateKey === "s_statement" ? { ...i, assigneeManual: true, assigneeId: "someone" } : i));
    const { updates } = run({ ...d, assigneeId: "new" }, { items });
    expect(updates.find((u) => u.id === byKey(items, "s_statement").id)).toBeUndefined();
    expect(updates.find((u) => u.id === byKey(items, "s_tax").id)?.data.assigneeId).toBe("new");
  });
  it("手入力の項目は触らない", () => {
    const manual: ScheduleItemState = { id: "m", templateKey: null, dueDate: "2026-11-20", dueManual: true, assigneeId: "a", assigneeManual: true, completed: false, excluded: false, excludedManual: false, preIntroduction: false, mortgageUnknown: false, completionHint: null };
    const { updates } = run({ ...d, settlementDate: "2026-12-23", kindBase: "land" }, { items: [...saved(d), manual] });
    expect(updates.find((u) => u.id === "m")).toBeUndefined();
  });
  it("条件が変わって要らなくなった未完了の項目は対象外になり、消えない", () => {
    const items = saved(d);
    const { updates } = run({ ...d, kindBase: "house" }, { items });
    expect(updates.find((u) => u.id === byKey(items, "s_management_report").id)?.data.excluded).toBe(true);
  });
  it("要らなくなっても完了済みは対象外にしない", () => {
    const items = saved(d).map((i) => (i.templateKey === "s_management_report" ? { ...i, completed: true } : i));
    const { updates } = run({ ...d, kindBase: "house" }, { items });
    expect(updates.find((u) => u.id === byKey(items, "s_management_report").id)).toBeUndefined();
  });
  it("条件が戻れば対象外を外す。手で対象外にしたものは戻さない", () => {
    const items = saved(d).map((i) => (i.templateKey === "s_management_report" ? { ...i, excluded: true } : i.templateKey === "s_mgmt_notify" ? { ...i, excluded: true, excludedManual: true } : i));
    const { updates } = run(d, { items });
    expect(updates.find((u) => u.id === byKey(items, "s_management_report").id)?.data.excluded).toBe(false);
    expect(updates.find((u) => u.id === byKey(items, "s_mgmt_notify").id)).toBeUndefined();
  });
  it("条件が加わったら足す", () => {
    const items = saved(d);
    expect(run({ ...d, hasOc: true }, { items }).creates.map((c) => c.templateKey)).toEqual(["s_tenant_notice"]);
  });
  it("ひな形から消した項目は、作成済みの取引に残す", () => {
    const items = saved(d);
    const { updates } = run(d, { items, template: DEFAULT_SCHEDULE_TEMPLATE.filter((t) => t.id !== "s_tax") });
    expect(updates.find((u) => u.id === byKey(items, "s_tax").id)).toBeUndefined();
  });
  it("基準日が消えたら未完了は対象外にし、戻れば元に戻す", () => {
    const items = saved(d);
    const off = run({ ...d, settlementDate: null }, { items }).updates.find((u) => u.id === byKey(items, "s_tax").id);
    expect(off?.data.excluded).toBe(true);
  });
  it("変わるものが無ければ何も書かない", () => expect(run(d, { items: saved(d) })).toEqual({ creates: [], updates: [] }));
});

describe("担保の項目", () => {
  const d = deal();
  it("担保の注意が消えたら、完了にせず完了候補にする", () => {
    const items = saved(d, { mortgage: "yes" });
    const u = run(d, { items, mortgage: "no" }).updates.find((x) => x.id === byKey(items, "c_mortgage").id);
    expect(u?.data).toEqual({ completionHint: "mortgage_cleared" });
  });
  it("判定できないまま作った項目は、担保なしと分かれば対象外", () => {
    const items = saved(d, { mortgage: "unknown" });
    const u = run(d, { items, mortgage: "no" }).updates.find((x) => x.id === byKey(items, "c_mortgage").id);
    expect(u?.data).toMatchObject({ excluded: true, mortgageUnknown: false });
  });
  it("対象外にしたあとの見直しで、完了候補を付けない", () => {
    const items = saved(d, { mortgage: "unknown" }).map((i) => (i.templateKey === "c_mortgage" ? { ...i, excluded: true, mortgageUnknown: false } : i));
    expect(run(d, { items, mortgage: "no" }).updates.find((x) => x.id === byKey(items, "c_mortgage").id)).toBeUndefined();
  });
  it("担保ありと分かれば、確認の印を外す", () => {
    const items = saved(d, { mortgage: "unknown" });
    const u = run(d, { items, mortgage: "yes" }).updates.find((x) => x.id === byKey(items, "c_mortgage").id);
    expect(u?.data).toEqual({ mortgageUnknown: false });
  });
  it("また担保が出たら完了候補を外す", () => {
    const items = saved(d, { mortgage: "yes" }).map((i) => (i.templateKey === "c_mortgage" ? { ...i, completionHint: "mortgage_cleared" as const } : i));
    const u = run(d, { items, mortgage: "yes" }).updates.find((x) => x.id === byKey(items, "c_mortgage").id);
    expect(u?.data).toEqual({ completionHint: null });
  });
  it("一時的に読めなくなっても(担保あり→判定できない)何も変えず、その後に消えれば完了候補", () => {
    const items = saved(d, { mortgage: "yes" });
    expect(run(d, { items, mortgage: "unknown" }).updates.find((x) => x.id === byKey(items, "c_mortgage").id)).toBeUndefined();
    const u = run(d, { items, mortgage: "no" }).updates.find((x) => x.id === byKey(items, "c_mortgage").id);
    expect(u?.data).toEqual({ completionHint: "mortgage_cleared" });
  });
  it("対象外のあとに判定できなくなれば、確認の印を付けて戻す", () => {
    const items = saved(d, { mortgage: "unknown" }).map((i) => (i.templateKey === "c_mortgage" ? { ...i, excluded: true, mortgageUnknown: false } : i));
    const u = run(d, { items, mortgage: "unknown" }).updates.find((x) => x.id === byKey(items, "c_mortgage").id);
    expect(u?.data).toEqual({ excluded: false, mortgageUnknown: true });
  });
});

describe("自動で完了になる条件", () => {
  const items = saved(deal());
  const ofKey = (k: string, r: ReturnType<typeof applyScheduleEvents>) => r.find((x) => x.id === byKey(items, k).id)?.data;
  it("精算書の発行で「精算書を作成」が完了", () => {
    expect(ofKey("s_statement", applyScheduleEvents(items, { issuedDocType: "settlement_statement" }))).toEqual({ completed: true, auto: true });
  });
  it("書類確認書(決済時)の発行で「売主に決済時の必要書類を案内」が完了。契約時では完了しない", () => {
    expect(ofKey("s_seller_docs", applyScheduleEvents(items, { issuedDocType: "checklist_settlement" }))).toEqual({ completed: true, auto: true });
    expect(applyScheduleEvents(items, { issuedDocType: "checklist_contract" })).toEqual([]);
  });
  it("決済済になると「決済・引渡し」が完了", () => {
    expect(ofKey("s_settle", applyScheduleEvents(items, { settled: true }))).toEqual({ completed: true, auto: true });
  });
  it("税額が入ると「年税額を確認」が完了", () => {
    expect(ofKey("s_tax", applyScheduleEvents(items, { taxesEntered: true }))).toEqual({ completed: true, auto: true });
  });
  it("発行だけでは確かめられない項目は完了候補にする", () => {
    expect(ofKey("s_final", applyScheduleEvents(items, { issuedDocType: "settlement_guide" }))).toEqual({ completionHint: "doc_issued" });
    expect(ofKey("s_final", applyScheduleEvents(items, { issuedDocType: "settlement_guide_seller" }))).toEqual({ completionHint: "doc_issued" });
    expect(ofKey("s_key_receipt", applyScheduleEvents(items, { issuedDocType: "key_receipt" }))).toEqual({ completionHint: "doc_issued" });
  });
  it("完了済み・対象外の項目には何もしない", () => {
    const done = items.map((i) => (i.templateKey === "s_statement" ? { ...i, completed: true } : i));
    expect(applyScheduleEvents(done, { issuedDocType: "settlement_statement" })).toEqual([]);
    const off = items.map((i) => (i.templateKey === "s_statement" ? { ...i, excluded: true } : i));
    expect(applyScheduleEvents(off, { issuedDocType: "settlement_statement" })).toEqual([]);
  });
  it("作るときに、もう発行済みの書類があれば完了で作る。候補も付ける", () => {
    const c = run(deal(), { issued: ["settlement_statement", "key_receipt"], taxes: true }).creates;
    expect(c.find((x) => x.templateKey === "s_statement")?.completed).toBe(true);
    expect(c.find((x) => x.templateKey === "s_tax")?.completed).toBe(true);
    expect(c.find((x) => x.templateKey === "s_key_receipt")?.completionHint).toBe("doc_issued");
    expect(c.find((x) => x.templateKey === "s_settle")?.completed).toBe(false);
  });
  it("決済済の取引で作るなら「決済・引渡し」は完了で作る", () => {
    expect(run(deal({ status: "settled" })).creates.find((x) => x.templateKey === "s_settle")?.completed).toBe(true);
  });
});

describe("通知の対象日", () => {
  const item = (dueDate: string, o: Partial<{ completed: boolean; excluded: boolean; preIntroduction: boolean }> = {}) => ({
    dueDate, completed: false, excluded: false, preIntroduction: false, ...o,
  });
  it("前日・当日・期限超過", () => {
    expect(scheduleNoticeSlot(item("2026-11-03"), TODAY)).toBe("tomorrow");
    expect(scheduleNoticeSlot(item(TODAY), TODAY)).toBe("today");
    expect(scheduleNoticeSlot(item("2026-11-01"), TODAY)).toBe("overdue");
    expect(scheduleNoticeSlot(item("2026-10-01"), TODAY)).toBe("overdue");
  });
  it("2日以上先は対象外", () => expect(scheduleNoticeSlot(item("2026-11-04"), TODAY)).toBeNull());
  it("完了・対象外は対象外", () => {
    expect(scheduleNoticeSlot(item(TODAY, { completed: true }), TODAY)).toBeNull();
    expect(scheduleNoticeSlot(item(TODAY, { excluded: true }), TODAY)).toBeNull();
  });
  it("導入前の項目は期限超過の通知に入れない", () => {
    expect(scheduleNoticeSlot(item("2026-10-01", { preIntroduction: true }), TODAY)).toBeNull();
  });
  it("送る時刻は日本時間の朝9時", () => {
    expect(new Date(jstMorningSendAt(TODAY)).toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });
});

describe("画面の見せ方", () => {
  const view = (dueDate: string, o: Partial<Parameters<typeof scheduleBadge>[0]> = {}) => ({ dueDate, completed: false, excluded: false, preIntroduction: false, ...o });
  it("完了・対象外・導入前・期限超過・今日・明日・あとN日", () => {
    expect(scheduleBadge(view(TODAY, { completed: true }), TODAY)).toEqual({ tone: "done", text: "完了" });
    expect(scheduleBadge(view(TODAY, { excluded: true }), TODAY)).toEqual({ tone: "muted", text: "対象外になりました" });
    expect(scheduleBadge(view("2026-10-01", { preIntroduction: true }), TODAY)).toEqual({ tone: "muted", text: "導入前の項目" });
    expect(scheduleBadge(view("2026-11-01"), TODAY)).toEqual({ tone: "overdue", text: "1日超過" });
    expect(scheduleBadge(view(TODAY), TODAY)).toEqual({ tone: "soon", text: "今日" });
    expect(scheduleBadge(view("2026-11-03"), TODAY)).toEqual({ tone: "soon", text: "明日" });
    expect(scheduleBadge(view("2026-11-07"), TODAY)).toEqual({ tone: "normal", text: "あと5日" });
  });
  it("時期のまとめ", () => {
    const s = "2026-12-16";
    expect(scheduleGroupOf({ base: "contract", dueDate: "2026-11-03" }, s)).toBe("after_contract");
    expect(scheduleGroupOf({ base: "settlement", dueDate: "2026-11-25" }, s)).toBe("weeks3");
    expect(scheduleGroupOf({ base: "settlement", dueDate: "2026-12-02" }, s)).toBe("weeks2");
    expect(scheduleGroupOf({ base: "settlement", dueDate: "2026-12-09" }, s)).toBe("week1");
    expect(scheduleGroupOf({ base: "settlement", dueDate: "2026-12-15" }, s)).toBe("eve");
    expect(scheduleGroupOf({ base: "settlement", dueDate: "2026-12-16" }, s)).toBe("eve");
    expect(scheduleGroupOf({ base: "settlement", dueDate: "2026-12-17" }, s)).toBe("after");
    expect(scheduleGroupOf({ base: null, dueDate: "2026-12-09" }, null)).toBe("after_contract");
  });
});

describe("ひな形の保存", () => {
  it("初期のひな形は保存の形に合う", () => expect(scheduleTemplateSchema.safeParse(DEFAULT_SCHEDULE_TEMPLATE).success).toBe(true));
  it("鍵の重なり・空の作業名・範囲外の日数は断る", () => {
    const a = DEFAULT_SCHEDULE_TEMPLATE[0];
    expect(scheduleTemplateSchema.safeParse([a, a]).success).toBe(false);
    expect(scheduleTemplateSchema.safeParse([{ ...a, label: " " }]).success).toBe(false);
    expect(scheduleTemplateSchema.safeParse([{ ...a, offsetDays: 400 }]).success).toBe(false);
  });
  it("保存が空・壊れていれば初期のひな形", () => {
    expect(resolveScheduleTemplate([])).toEqual(DEFAULT_SCHEDULE_TEMPLATE);
    expect(resolveScheduleTemplate("x")).toEqual(DEFAULT_SCHEDULE_TEMPLATE);
    expect(resolveScheduleTemplate(undefined)).toEqual(DEFAULT_SCHEDULE_TEMPLATE);
  });
});

describe("担保の判定は照合の結果を読むだけ", () => {
  const cc = (registry: RegistryFacts, kindBase: "unit" | "house" | null = "unit") => buildCrosscheck({
    kindBase, price: null, settlementDate: null, snapshot: { floorArea: null, landArea: null }, property: null, registry,
    sellerCompare: "denied", sellers: [], documents: [],
  });
  const ok = (activeRights: number, readable = true, extra: object = {}): RegistryFacts => ({
    status: "ok", areas: null, owners: null, rights: { activeRights, readable, attachmentCreatedAt: "2026-10-01T00:00:00.000Z" }, ...extra,
  });
  it("注意があれば担保あり", () => {
    const r = cc(ok(2));
    expect(r.notices.some((n) => n.id === CROSSCHECK_NOTICE_IDS.activeMortgage)).toBe(true);
    expect(mortgageStateOf(r)).toBe("yes");
  });
  it("謄本を読めて0件なら担保なし", () => expect(mortgageStateOf(cc(ok(0)))).toBe("no"));
  it("謄本が無い・読めない・権利が読めないは判定できない", () => {
    expect(mortgageStateOf(cc({ status: "none" }))).toBe("unknown");
    expect(mortgageStateOf(cc({ status: "unreadable" }))).toBe("unknown");
    expect(mortgageStateOf(cc(ok(0, false)))).toBe("unknown");
  });
  it("戸建で片方の謄本が足りなければ、0件でも判定できない", () => {
    expect(mortgageStateOf(cc(ok(0, true, { missing: ["建物"] }), "house"))).toBe("unknown");
    expect(mortgageStateOf(cc(ok(1, true, { missing: ["建物"] }), "house"))).toBe("yes");
  });
  it("物件の種類が未選択なら判定できない", () => expect(mortgageStateOf(cc(ok(0), null))).toBe("unknown"));
});
