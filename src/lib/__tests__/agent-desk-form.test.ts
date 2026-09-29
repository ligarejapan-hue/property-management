import { describe, it, expect } from "vitest";
import {
  EMPTY_DESK_FORM, deskFormReducer, nextDeskGuideStep, validateDeskForm, materialEmailWarning,
  buildCreateBody, jstInputsToIso, isoToJstInputs, formatJst, type DeskFormState, type DeskFormAction,
} from "@/lib/agent-inquiry/desk-form";

const agent = {
  id: "a1", companyName: "○○不動産", branchName: null, phone: "03-1", matchedBy: "mobile" as const,
  lastContact: { name: "田中", mobile: "090-1234-5678", email: "t@x.jp" },
};
const property = {
  id: "p1", name: "サンライズ中野", roomNo: "305", town: "東京都中野区中野2丁目", propertyType: "apartment_unit", adPermissions: {},
};
const run = (...actions: DeskFormAction[]) => actions.reduce((s, a) => deskFormReducer(s, a), EMPTY_DESK_FORM);

describe("フォームの状態", () => {
  it("携帯で当たった業者を選ぶと問い合わせ者を前回の値で埋める", () => {
    const s = run({ type: "agentSelected", agent });
    expect(s.agent?.id).toBe("a1");
    expect([s.contactName, s.contactMobile, s.contactEmail]).toEqual(["田中", "090-1234-5678", "t@x.jp"]);
    expect(s.agentQuery).toBe("○○不動産");
  });
  it("選んだ後に検索欄を打ち直したら選択を外す(表示と中身の食い違いを防ぐ)", () => {
    const s = run({ type: "agentSelected", agent }, { type: "agentQuery", value: "△△" });
    expect(s.agent).toBeNull();
    const p = run({ type: "propertySelected", property }, { type: "propertyQuery", value: "別" });
    expect(p.property).toBeNull();
  });
  it("用件を内見以外にすると内見の入力を消す", () => {
    const s = run(
      { type: "kind", value: "viewing" },
      { type: "viewing", field: "viewingType", value: "guided" },
      { type: "kind", value: "ad_permission" },
    );
    expect(s.viewingType).toBeNull();
  });
  it("reset で空に戻る(入口は電話)", () => {
    expect(run({ type: "channel", value: "fax" }, { type: "reset" })).toEqual(EMPTY_DESK_FORM);
    expect(EMPTY_DESK_FORM.channel).toBe("phone");
  });
});

describe("次に押す所", () => {
  it.each<[string, DeskFormState, string]>([
    ["最初は業者", EMPTY_DESK_FORM, "agent"],
    ["業者の次は物件", run({ type: "agentSelected", agent }), "property"],
    ["物件の次は用件", run({ type: "agentSelected", agent }, { type: "propertySelected", property }), "kind"],
    ["内見なら案内/下見", run({ type: "agentSelected", agent }, { type: "propertySelected", property }, { type: "kind", value: "viewing" }), "viewingType"],
    ["揃ったら保存", run({ type: "agentSelected", agent }, { type: "propertySelected", property }, { type: "kind", value: "ad_permission" }), "save"],
  ])("%s", (_l, s, want) => expect(nextDeskGuideStep(s)).toBe(want));
});

describe("検証と送る形", () => {
  it("業者・物件・用件は必須・内見なら案内/下見も必須", () => {
    expect(Object.keys(validateDeskForm(EMPTY_DESK_FORM)).sort()).toEqual(["agent", "kind", "property"]);
    const s = run({ type: "agentSelected", agent }, { type: "propertySelected", property }, { type: "kind", value: "viewing" });
    expect(validateDeskForm(s)).toEqual({ viewingType: "案内か下見かを選んでください" });
  });
  it("資料請求でメールが空なら黄色の知らせ(保存は止めない)", () => {
    const s = run(
      { type: "agentSelected", agent: { ...agent, lastContact: null } },
      { type: "propertySelected", property },
      { type: "kind", value: "material_request" },
    );
    expect(materialEmailWarning(s)).toBe("資料の送り先のメールが空です");
    expect(validateDeskForm(s)).toEqual({});
  });
  it("送る形: 内見は日時つき(JST→UTC)・空欄は送らない", () => {
    const s = run(
      { type: "agentSelected", agent }, { type: "propertySelected", property }, { type: "kind", value: "viewing" },
      { type: "viewing", field: "viewingType", value: "guided" }, { type: "viewing", field: "date", value: "2026-10-02" },
      { type: "viewing", field: "time", value: "14:00" }, { type: "note", value: "  " },
    );
    expect(buildCreateBody(s)).toEqual({
      propertyId: "p1", agentId: "a1", kind: "viewing", channel: "phone",
      contactName: "田中", contactMobile: "090-1234-5678", contactEmail: "t@x.jp", note: null,
      viewing: { viewingType: "guided", scheduledAt: "2026-10-02T05:00:00.000Z", attendantId: null },
    });
  });
  it("広告の許可は viewing を付けない", () => {
    const s = run({ type: "agentSelected", agent }, { type: "propertySelected", property }, { type: "kind", value: "ad_permission" });
    expect(buildCreateBody(s).viewing).toBeUndefined();
  });
});

describe("日時(JST)", () => {
  it("日付と時刻が揃ったときだけ UTC にする(片方だけ=日程調整中)", () => {
    expect(jstInputsToIso("2026-10-02", "14:00")).toBe("2026-10-02T05:00:00.000Z");
    expect(jstInputsToIso("2026-10-02", "")).toBeNull();
    expect(jstInputsToIso("", "14:00")).toBeNull();
    expect(jstInputsToIso("2026-13-40", "14:00")).toBeNull();
  });
  it("戻す・表示する", () => {
    expect(isoToJstInputs("2026-10-02T05:00:00.000Z")).toEqual({ date: "2026-10-02", time: "14:00" });
    expect(isoToJstInputs(null)).toEqual({ date: "", time: "" });
    expect(formatJst("2026-10-01T15:30:00.000Z")).toBe("10/2(金) 0:30");
    expect(formatJst(null)).toBe("日程調整中");
  });
});

import { hitsForQuery } from "@/lib/agent-inquiry/desk-form";

describe("検索結果は今の検索語のものだけ出す(@codex #459 R1)", () => {
  it("前の検索語の結果は出さない(打ち直し中に古い候補を選べない)", () => {
    expect(hitsForQuery({ query: "新宿", hits: [1, 2], failed: false }, "新宿")).toEqual({ hits: [1, 2], failed: false });
    expect(hitsForQuery({ query: "新宿", hits: [1, 2], failed: false }, "新宿区")).toBeNull();
    expect(hitsForQuery(null, "新宿")).toBeNull();
  });
  it("失敗は「見つからない」と区別する", () => {
    expect(hitsForQuery({ query: "新宿", hits: [], failed: true }, "新宿")).toEqual({ hits: [], failed: true });
  });
});

describe("業者を替えたら前の業者から自動で入れた問い合わせ者を消す(@codex #459 R2)", () => {
  const agentB = { id: "b1", companyName: "△△住宅", branchName: null, phone: "03-2", matchedBy: "text" as const, lastContact: null };
  it("自動で入れた問い合わせ者は、前回の無い業者に替えたら消す", () => {
    const s = run({ type: "agentSelected", agent }, { type: "agentQuery", value: "△△" }, { type: "agentSelected", agent: agentB });
    expect([s.contactName, s.contactMobile, s.contactEmail]).toEqual(["", "", ""]);
  });
  it("自分で打った問い合わせ者は業者を替えても残す", () => {
    const s = run(
      { type: "agentSelected", agent },
      { type: "contact", field: "contactName", value: "田中(直した)" },
      { type: "agentQuery", value: "△△" },
      { type: "agentSelected", agent: agentB },
    );
    expect(s.contactName).toBe("田中(直した)");
  });
  it("業者を選ぶ前に打った問い合わせ者は、前回の無い業者を選んでも残す", () => {
    const s = run({ type: "contact", field: "contactName", value: "佐藤" }, { type: "agentSelected", agent: agentB });
    expect(s.contactName).toBe("佐藤");
  });
});

describe("自動で入れた値は欄ごとに見る(@codex #459 R3)", () => {
  const agentB = { id: "b1", companyName: "△△住宅", branchName: null, phone: "03-2", matchedBy: "text" as const, lastContact: null };
  it("1つの欄だけ直したら、直していない欄(自動のまま)だけ消す", () => {
    const s = run(
      { type: "agentSelected", agent },
      { type: "contact", field: "contactName", value: "田中(直した)" },
      { type: "agentQuery", value: "△△" },
      { type: "agentSelected", agent: agentB },
    );
    expect([s.contactName, s.contactMobile, s.contactEmail]).toEqual(["田中(直した)", "", ""]);
  });
  it("携帯の欄を抜けただけ(同じ値に整えただけ)なら自動のまま扱う", () => {
    const s = run(
      { type: "agentSelected", agent },
      { type: "contact", field: "contactMobile", value: "090-1234-5678" },
      { type: "agentQuery", value: "△△" },
      { type: "agentSelected", agent: agentB },
    );
    expect([s.contactName, s.contactMobile, s.contactEmail]).toEqual(["", "", ""]);
  });
});

import { draftOf, draftStale, editDraft } from "@/lib/agent-inquiry/desk-form";

describe("下書きは書き始めたときの値を覚え、その間に他の人が変えたら黙って上書きしない(@codex #459 R6)", () => {
  it("書き始めたときの値(base)を覚える・2回目以降の入力では base を変えない", () => {
    const d1 = editDraft(null, "打ち1", "サーバA");
    expect(d1).toEqual({ value: "打ち1", base: "サーバA" });
    expect(editDraft(d1, "打ち2", "サーバB")).toEqual({ value: "打ち2", base: "サーバA" });
    expect(draftOf(d1, "サーバA")).toBe("打ち1");
    expect(draftOf(null, "サーバA")).toBe("サーバA");
  });
  it("書き始めた後に最新の値が変わっていたら「食い違い」", () => {
    expect(draftStale({ value: "打ち", base: "サーバA" }, "サーバA")).toBe(false);
    expect(draftStale({ value: "打ち", base: "サーバA" }, "サーバB")).toBe(true);
    expect(draftStale(null, "サーバB")).toBe(false);
    // 自分の保存で最新の値が下書きと同じになった=食い違いではない
    expect(draftStale({ value: "打ち", base: "サーバA" }, "打ち")).toBe(false);
  });
});

describe("自分の保存が通った後の下書きは最新の値を基準にし直す(@codex #459 R7)", () => {
  it("下書きの値=最新の値になっていたら、次の入力の基準は最新の値", () => {
    const saved = { value: "B", base: "A" }; // A から B に書き換えて保存が通った
    expect(editDraft(saved, "C", "B")).toEqual({ value: "C", base: "B" });
    expect(draftStale(editDraft(saved, "C", "B"), "B")).toBe(false);
  });
});

import { isAmbiguousSaveError } from "@/lib/agent-inquiry/desk-form";

describe("サーバが前後の空白を落として保存しても食い違い扱いにしない(@codex #459 R14 2件目)", () => {
  it("下書きと最新の値の違いが前後の空白だけなら、自分の保存が通ったものとして基準にし直す", () => {
    const saved = { value: "打ち ", base: "A" };
    expect(editDraft(saved, "打ち2", "打ち")).toEqual({ value: "打ち2", base: "打ち" });
    expect(draftStale(saved, "打ち")).toBe(false);
  });
});

describe("保存できたか分からない失敗(@codex #459 R15)", () => {
  it("通信が切れた(状態コード無し)・中継の時間切れ(5xx)は「分からない」", () => {
    expect(isAmbiguousSaveError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isAmbiguousSaveError(Object.assign(new Error("x"), { status: 504 }))).toBe(true);
    expect(isAmbiguousSaveError(Object.assign(new Error("x"), { status: 502 }))).toBe(true);
  });
  it("はっきり断られた(4xx)は「保存されていない」", () => {
    expect(isAmbiguousSaveError(Object.assign(new Error("x"), { status: 409 }))).toBe(false);
    expect(isAmbiguousSaveError(Object.assign(new Error("x"), { status: 422 }))).toBe(false);
  });
});

import { splitNewAgentPhone } from "@/lib/agent-inquiry/desk-form";

describe("検索に打った携帯は業者の代表電話に入れない(@codex #459 R19)", () => {
  it("070/080/090 は問い合わせ者の携帯へ回し、代表電話は空", () => {
    expect(splitNewAgentPhone("090-1234-5678")).toEqual({ agentPhone: "", callerMobile: "090-1234-5678" });
    expect(splitNewAgentPhone("０８０１２３４５６７８")).toEqual({ agentPhone: "", callerMobile: "０８０１２３４５６７８" });
    expect(splitNewAgentPhone(" 07012345678 ")).toEqual({ agentPhone: "", callerMobile: "07012345678" });
  });
  it("固定電話は代表電話へ", () => {
    expect(splitNewAgentPhone("03-1234-5678")).toEqual({ agentPhone: "03-1234-5678", callerMobile: null });
  });
  it("電話番号らしくない検索語はどちらにも入れない", () => {
    expect(splitNewAgentPhone("中野不動産")).toEqual({ agentPhone: "", callerMobile: null });
    expect(splitNewAgentPhone("")).toEqual({ agentPhone: "", callerMobile: null });
  });
});
