import { describe, it, expect } from "vitest";
import {
  NEW_FLOW_ENDED_BY_HOLD,
  classifyInquiry,
  classifyProperty,
  decideFollowup,
  initialNewPosition,
  type DecideRow,
} from "@/lib/lead-followup/decide";
import type { FollowupStepsBySeries } from "@/lib/lead-followup/steps";

const DAY = 86_400_000;
const T0 = new Date("2026-12-01T00:00:00Z");
const at = (days: number, plusMs = 0) => new Date(T0.getTime() + days * DAY + plusMs);
const step = (delayDays: number) => ({ delayDays, subject: `件名${delayDays}`, body: `本文${delayDays}` });
const STEPS: FollowupStepsBySeries = {
  new: [step(0), step(3), step(7), step(30)],
  hold: [step(7), step(30)],
};
const prop = (over: Partial<DecideRow> = {}): DecideRow => ({
  targetType: "property",
  newStartedAt: T0,
  newNextPosition: 1,
  holdStartedAt: null,
  holdNextPosition: 1,
  ...over,
});
const inq = (over: Partial<DecideRow> = {}): DecideRow => prop({ targetType: "inquiry", ...over });

describe("案件の状態の分け方", () => {
  it("一括査定: 未着手・コンタクト中=連絡がついていない/やりとり中・査定中=飛ばす/保留/商談中以降・他社・見送り・除外=終わり", () => {
    expect(classifyProperty("new_case")).toBe("uncontacted");
    expect(classifyProperty("contact_attempting")).toBe("uncontacted");
    expect(classifyProperty("contacting_owner")).toBe("skip");
    expect(classifyProperty("appraisal")).toBe("skip");
    expect(classifyProperty("hold")).toBe("hold");
    for (const s of ["negotiating", "brokerage_obtained", "on_sale", "contract_planned", "contracted", "sold", "other_brokerage", "closed", "lead_exclusion_requested", "lead_excluded", "done"]) {
      expect(classifyProperty(s)).toBe("closed");
    }
  });

  it("今は使わない古い値・知らない値は送らない(飛ばす)", () => {
    for (const s of ["owner_contacted", "site_checked", "confirming_owner", "response_received", "dm_target", "dm_sent", "waiting_registry", "zzz"]) {
      expect(classifyProperty(s)).toBe("skip");
    }
  });

  it("査定申込: 未対応=連絡がついていない/対応中=飛ばす/対応済み=終わり", () => {
    expect(classifyInquiry("open")).toBe("uncontacted");
    expect(classifyInquiry("in_progress")).toBe("skip");
    expect(classifyInquiry("done")).toBe("closed");
    expect(classifyInquiry("zzz")).toBe("skip");
  });
});

describe("新規の流れ", () => {
  it("登録の直後に挨拶(0日)を送る", () => {
    expect(decideFollowup(prop(), "uncontacted", STEPS, at(0, 60_000))).toEqual({ kind: "send", series: "new", position: 1 });
  });

  it("日が来る前は待つ", () => {
    expect(decideFollowup(prop({ newNextPosition: 2 }), "uncontacted", STEPS, at(2.9))).toEqual({ kind: "wait" });
  });

  it("やりとり中・査定中の間に日が来た通は飛ばす", () => {
    expect(decideFollowup(prop({ newNextPosition: 2 }), "skip", STEPS, at(3))).toEqual({ kind: "skip", series: "new", position: 2 });
  });

  it("次の通の日も過ぎていたら、古い通は送らずに飛ばす(まとめて送らない)", () => {
    expect(decideFollowup(prop({ newNextPosition: 2 }), "uncontacted", STEPS, at(8))).toEqual({ kind: "skip", series: "new", position: 2 });
    expect(decideFollowup(prop({ newNextPosition: 3 }), "uncontacted", STEPS, at(8))).toEqual({ kind: "send", series: "new", position: 3 });
  });

  it("全部の通を終えたら終わり", () => {
    expect(decideFollowup(prop({ newNextPosition: 5 }), "uncontacted", STEPS, at(100))).toEqual({ kind: "complete" });
  });

  it("商談中以降などは止める(case_closed)・査定申込の対応済みは handled_done", () => {
    expect(decideFollowup(prop(), "closed", STEPS, at(1))).toEqual({ kind: "stop", reason: "case_closed" });
    expect(decideFollowup(inq(), "closed", STEPS, at(1))).toEqual({ kind: "stop", reason: "handled_done" });
  });

  it("査定申込は挨拶(0日の通)を送らず、3日の通から(受付メールが挨拶を兼ねる)", () => {
    expect(decideFollowup(inq(), "uncontacted", STEPS, at(0, 60_000))).toEqual({ kind: "wait" });
    expect(decideFollowup(inq(), "uncontacted", STEPS, at(3))).toEqual({ kind: "send", series: "new", position: 2 });
  });
});

describe("保留の流れ", () => {
  it("新規の流れの途中で保留になったら、保留の流れへ移る(起点=今)", () => {
    expect(decideFollowup(prop({ newNextPosition: 2 }), "hold", STEPS, at(5))).toEqual({
      kind: "update",
      data: { newNextPosition: NEW_FLOW_ENDED_BY_HOLD, holdStartedAt: at(5) },
    });
  });

  it("保留になった日から数えて送る", () => {
    const row = prop({ newNextPosition: NEW_FLOW_ENDED_BY_HOLD, holdStartedAt: at(5) });
    expect(decideFollowup(row, "hold", STEPS, at(11))).toEqual({ kind: "wait" });
    expect(decideFollowup(row, "hold", STEPS, at(12))).toEqual({ kind: "send", series: "hold", position: 1 });
  });

  it("保留を出たら、起点を外して待つ(新規の流れには戻らない)", () => {
    const row = prop({ newNextPosition: NEW_FLOW_ENDED_BY_HOLD, holdStartedAt: at(5), holdNextPosition: 2 });
    expect(decideFollowup(row, "uncontacted", STEPS, at(20))).toEqual({ kind: "update", data: { holdStartedAt: null } });
    expect(decideFollowup({ ...row, holdStartedAt: null }, "uncontacted", STEPS, at(60))).toEqual({ kind: "wait" });
    expect(decideFollowup({ ...row, holdStartedAt: null }, "skip", STEPS, at(60))).toEqual({ kind: "wait" });
  });

  it("もう一度保留になったら、前の続きの通から、その日を新しい起点にする", () => {
    const row = prop({ newNextPosition: NEW_FLOW_ENDED_BY_HOLD, holdStartedAt: null, holdNextPosition: 2 });
    expect(decideFollowup(row, "hold", STEPS, at(40))).toEqual({ kind: "update", data: { holdStartedAt: at(40) } });
    expect(decideFollowup({ ...row, holdStartedAt: at(40) }, "hold", STEPS, at(70))).toEqual({ kind: "send", series: "hold", position: 2 });
  });

  it("保留の流れを全部終えたら終わり・保留の中でも商談中以降は止める", () => {
    const row = prop({ newNextPosition: NEW_FLOW_ENDED_BY_HOLD, holdStartedAt: at(5), holdNextPosition: 3 });
    expect(decideFollowup(row, "hold", STEPS, at(100))).toEqual({ kind: "complete" });
    expect(decideFollowup(row, "closed", STEPS, at(100))).toEqual({ kind: "stop", reason: "case_closed" });
  });

  it("保留の最後の通を送ったあとに保留を出ても、進行中のまま残さず完了にする", () => {
    const row = prop({ newNextPosition: NEW_FLOW_ENDED_BY_HOLD, holdStartedAt: at(5), holdNextPosition: 3 });
    expect(decideFollowup(row, "skip", STEPS, at(100))).toEqual({ kind: "complete" });
    expect(decideFollowup({ ...row, holdStartedAt: null }, "uncontacted", STEPS, at(100))).toEqual({ kind: "complete" });
  });

  it("新規の流れを終えたあとに保留になっても、保留の流れを始める", () => {
    expect(decideFollowup(prop({ newNextPosition: 5 }), "hold", STEPS, at(100))).toEqual({
      kind: "update",
      data: { newNextPosition: NEW_FLOW_ENDED_BY_HOLD, holdStartedAt: at(100) },
    });
  });
});

describe("今いるお客様の最初に見る通(登録日を起点に、次に日が来る通から・2026-11-19 発注者)", () => {
  const NOW = at(40);
  it("ON にした時刻より後の登録は1通目から", () => {
    expect(initialNewPosition(at(39), at(38), NOW, STEPS)).toBe(1);
  });
  it("前からいるお客様は、日が過ぎた通を数えず、次に日が来る通から(見本の流れ=0・3・7・30日)", () => {
    // 見本の流れ = 0・3・7・30日。40日前の登録は全部過ぎている
    expect(initialNewPosition(at(0), at(39), NOW, STEPS)).toBe(5);
    // 5日前の登録 → 0日・3日は過ぎた → 7日目の通(3通目)から
    expect(initialNewPosition(at(35), at(39), NOW, STEPS)).toBe(3);
    // ちょうど日が来ている通も「過ぎた」に入れる(今日の分を慌てて送らない)
    expect(initialNewPosition(at(37), at(39), NOW, STEPS)).toBe(3);
  });
  it("全部過ぎていれば新規の流れは終わり扱い(保留なら保留の流れへ・そうでなければ完了)", () => {
    const pos = initialNewPosition(at(0), at(39), NOW, STEPS);
    expect(decideFollowup(prop({ newNextPosition: pos }), "uncontacted", STEPS, NOW)).toEqual({ kind: "complete" });
    expect(decideFollowup(prop({ newNextPosition: pos }), "hold", STEPS, NOW)).toMatchObject({ kind: "update" });
  });
});
