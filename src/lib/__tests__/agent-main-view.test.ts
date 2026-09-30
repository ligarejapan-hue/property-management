import { describe, it, expect } from "vitest";
import type { AgentDetail } from "@/lib/api-client";
import {
  nextAdValue, formatJstFull, formatJstDate, timelineKindLabel, timelineWhen, agentFieldValue, agentEditError,
  agentEditPatch, homeInquiryChips, windowNameFor, MAIN_WINDOW_NAME, DESK_WINDOW_NAME, AGENT_EDIT_FIELDS,
  editAgentField, agentStaleFields, rebaseAgentEdits, agentAfterSave, type AgentEdits,
} from "@/lib/agent-inquiry/main-view";

/** 最新の値 a を見ながら、欄を打った状態を作る。 */
const typed = (a: AgentDetail, fields: Partial<Record<keyof AgentEdits, string>>): AgentEdits =>
  (Object.entries(fields) as [keyof AgentEdits, string][]).reduce<AgentEdits>((e, [k, v]) => editAgentField(a, e, k, v), {});

const agent: AgentDetail = {
  id: "a1", companyName: "○○不動産", companyKana: null, branchName: "新宿支店", licenseNo: null,
  phone: "03-1234-5678", fax: null, email: "info@example.jp", address: null, note: null, isArchived: false, version: 4,
};

describe("広告の可否の次の値", () => {
  it("○→×→△→未設定→○ と一巡する(設計 §2.3)", () => {
    expect(nextAdValue("ok")).toBe("ng");
    expect(nextAdValue("ng")).toBe("ask");
    expect(nextAdValue("ask")).toBeNull();
    expect(nextAdValue(null)).toBe("ok");
  });
});

describe("日時の表示(JST・年つき)", () => {
  it("UTC の 15:00 は翌日の 0:00(JST)", () => {
    expect(formatJstFull("2026-12-31T15:00:00.000Z")).toBe("2027/1/1(金) 0:00");
    expect(formatJstDate("2026-12-31T15:00:00.000Z")).toBe("2027/1/1");
  });
  it("分は2桁", () => {
    expect(formatJstFull("2026-10-02T05:05:00.000Z")).toBe("2026/10/2(金) 14:05");
  });
});

describe("時系列の1行", () => {
  it("内見は案内/下見、それ以外は用件の名前", () => {
    expect(timelineKindLabel({ kind: "viewing", viewingType: "guided" })).toBe("案内");
    expect(timelineKindLabel({ kind: "viewing", viewingType: "preview" })).toBe("下見");
    expect(timelineKindLabel({ kind: "viewing", viewingType: null })).toBe("内見");
    expect(timelineKindLabel({ kind: "material_request", viewingType: null })).toBe("資料請求");
    expect(timelineKindLabel({ kind: "ad_permission", viewingType: null })).toBe("広告の許可");
  });
  it("日程が決まっていない内見は、受けた日時を添えて日程調整中と出す", () => {
    expect(timelineWhen({ at: "2026-10-02T05:00:00.000Z", unscheduled: true })).toBe("日程調整中(受付 2026/10/2(金) 14:00)");
    expect(timelineWhen({ at: "2026-10-02T05:00:00.000Z", unscheduled: false })).toBe("2026/10/2(金) 14:00");
  });
});

describe("名簿の編集=触った欄だけ送る", () => {
  it("触っていなければ最新の値を出し、送るものは無い", () => {
    expect(agentFieldValue(agent, {}, "branchName")).toBe("新宿支店");
    expect(agentFieldValue(agent, {}, "fax")).toBe("");
    expect(agentEditPatch(agent, {})).toBeNull();
  });
  it("触った欄だけを送る。空にした任意の欄は null", () => {
    expect(agentEditPatch(agent, typed(agent, { branchName: " 渋谷支店 ", email: "" }))).toEqual({ branchName: "渋谷支店", email: null });
  });
  it("触ったが元と同じ(前後の空白だけ違う)なら送らない", () => {
    expect(agentEditPatch(agent, typed(agent, { branchName: "新宿支店 ", fax: "  " }))).toBeNull();
  });
  it("★他の人が別の欄を直した後でも、触っていない欄は送らない(古い値で上書きしない)", () => {
    const edits = typed(agent, { note: "要注意" });
    const newer: AgentDetail = { ...agent, address: "東京都新宿区1-1", version: 5 };
    expect(agentEditPatch(newer, edits)).toEqual({ note: "要注意" });
    expect(agentStaleFields(newer, edits)).toEqual([]);
  });
  it("商号・代表電話を空にしたら保存させない", () => {
    expect(agentEditError(agent, typed(agent, { companyName: "  " }))).toBe("商号と代表電話を入れてください");
    expect(agentEditError(agent, typed(agent, { phone: "" }))).toBe("商号と代表電話を入れてください");
    expect(agentEditError(agent, typed(agent, { note: "x" }))).toBeNull();
  });
  it("打った値を出す。打ち直しても、書き始めたときの値(基準)は最初の1回のまま", () => {
    let e = typed(agent, { phone: "03-1111" });
    e = editAgentField({ ...agent, phone: "03-9999-8888" }, e, "phone", "03-1111-2222");
    expect(agentFieldValue(agent, e, "phone")).toBe("03-1111-2222");
    expect(e.phone).toEqual({ value: "03-1111-2222", base: "03-1234-5678" });
  });
  it("★自分が打っている欄を、他の人が先に変えていたら気付ける(相手の値つき)", () => {
    const edits = typed(agent, { phone: "03-1111-2222", note: "要注意" });
    const newer: AgentDetail = { ...agent, phone: "03-9999-8888", version: 5 };
    expect(agentStaleFields(newer, edits)).toEqual([{ key: "phone", label: "代表電話", current: "03-9999-8888" }]);
  });
  it("相手が空にした欄は「(空)」と出す", () => {
    const edits = typed(agent, { email: "new@example.jp" });
    expect(agentStaleFields({ ...agent, email: null }, edits)).toEqual([{ key: "email", label: "メール", current: "(空)" }]);
  });
  it("自分の保存が通って同じ値になった欄は、食い違いではない", () => {
    const edits = typed(agent, { branchName: "渋谷支店" });
    expect(agentStaleFields({ ...agent, branchName: "渋谷支店", version: 5 }, edits)).toEqual([]);
  });
  it("★相手の値を見せた後は今の値を基準にし直す=もう一度押せば自分の内容で保存できる", () => {
    const edits = typed(agent, { phone: "03-1111-2222" });
    const newer: AgentDetail = { ...agent, phone: "03-9999-8888", version: 5 };
    const rebased = rebaseAgentEdits(newer, edits);
    expect(agentStaleFields(newer, rebased)).toEqual([]);
    expect(agentEditPatch(newer, rebased)).toEqual({ phone: "03-1111-2222" });
    // その後さらに別の人が変えたら、また気付ける。
    expect(agentStaleFields({ ...newer, phone: "03-0000-0000" }, rebased)).toHaveLength(1);
  });
  it("★保存が通ったら、送った値と新しい版番号を手元の表示に写す(読み直しに失敗しても保存前の値を出さない)", () => {
    expect(agentAfterSave(agent, { branchName: "渋谷支店", email: null }, 5)).toEqual({ ...agent, branchName: "渋谷支店", email: null, version: 5 });
    expect(agentAfterSave(agent, { isArchived: true }, 5)).toEqual({ ...agent, isArchived: true, version: 5 });
  });
  it("欄の並びに API の入力項目が全部ある", () => {
    expect(AGENT_EDIT_FIELDS.map((f) => f.key)).toEqual([
      "companyName", "companyKana", "branchName", "phone", "fax", "email", "licenseNo", "address", "note",
    ]);
  });
});

describe("ホームの件数", () => {
  it("未対応があれば目立たせ、0件は静かに出す(消さない=受付の窓の入口でもある)", () => {
    expect(homeInquiryChips({ open: 3, upcomingViewings: 0 })).toEqual([
      { key: "open", label: "未対応の反響", count: 3, tone: "alert" },
      { key: "viewings", label: "今日・明日の内見", count: 0, tone: "quiet" },
    ]);
    expect(homeInquiryChips({ open: 0, upcomingViewings: 2 })[1].tone).toBe("info");
  });
});

describe("窓の名前", () => {
  it("名前が空の窓だけ名乗る(受付の窓として開いた窓をメイン画面と呼ばない)", () => {
    expect(windowNameFor("", MAIN_WINDOW_NAME)).toBe("pm-main");
    expect(windowNameFor("pm-inquiry-desk", MAIN_WINDOW_NAME)).toBeNull();
    expect(windowNameFor("pm-main", MAIN_WINDOW_NAME)).toBeNull();
    expect(windowNameFor("", DESK_WINDOW_NAME)).toBe("pm-inquiry-desk");
  });
});
