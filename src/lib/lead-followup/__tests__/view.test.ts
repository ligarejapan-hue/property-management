import { describe, it, expect } from "vitest";
import { toFollowupView, followupViewsForList, FOLLOWUP_STOP_REASON_LABELS } from "@/lib/lead-followup/view";

const at = (s: string) => new Date(s);

describe("toFollowupView(画面に出す追客の様子)", () => {
  it("行が無い=まだ始まっていない・止められる", () => {
    expect(toFollowupView(null)).toEqual({ state: "none", label: "まだ送っていません", canStop: true, stopped: null, sends: [] });
  });

  it("進行中は止められる・送った記録は古い順・流れの名前と何通目", () => {
    const v = toFollowupView({
      status: "active",
      stopReason: null,
      stoppedAt: null,
      stoppedBy: null,
      sends: [
        { series: "new", position: 2, result: "skipped", at: at("2026-11-20T01:00:00Z") },
        { series: "new", position: 1, result: "sent", at: at("2026-11-17T01:00:00Z") },
      ],
    });
    expect(v.state).toBe("active");
    expect(v.label).toBe("進行中");
    expect(v.canStop).toBe(true);
    expect(v.sends).toEqual([
      { label: "新規の流れ 1通目", result: "送信", at: "2026-11-17T01:00:00.000Z" },
      { label: "新規の流れ 2通目", result: "飛ばした", at: "2026-11-20T01:00:00.000Z" },
    ]);
  });

  it("送っている途中(sending)も進行中として止められる", () => {
    const v = toFollowupView({ status: "sending", stopReason: null, stoppedAt: null, stoppedBy: null, sends: [] });
    expect(v).toMatchObject({ state: "active", canStop: true });
  });

  it("止まった行は理由・止めた人・日時を出し、もう止められない", () => {
    const v = toFollowupView({
      status: "stopped",
      stopReason: "manual",
      stoppedAt: at("2026-11-18T03:00:00Z"),
      stoppedBy: { name: "担当A" },
      sends: [{ series: "hold", position: 1, result: "failed", at: at("2026-11-18T02:00:00Z") }],
    });
    expect(v.state).toBe("stopped");
    expect(v.label).toBe("止まっています(担当が止めた)");
    expect(v.canStop).toBe(false);
    expect(v.stopped).toEqual({ reason: "担当が止めた", at: "2026-11-18T03:00:00.000Z", by: "担当A" });
    expect(v.sends[0]).toEqual({ label: "保留の流れ 1通目", result: "送れなかった", at: "2026-11-18T02:00:00.000Z" });
  });

  it("全部送り終えた行は止められない", () => {
    expect(toFollowupView({ status: "completed", stopReason: null, stoppedAt: null, stoppedBy: null, sends: [] })).toMatchObject({
      state: "completed",
      label: "全部送り終えました",
      canStop: false,
    });
  });

  it("知らない理由・状態でも落ちない(止まった扱い・理由は「その他」)", () => {
    const v = toFollowupView({ status: "weird", stopReason: "zzz", stoppedAt: null, stoppedBy: null, sends: [] });
    expect(v).toMatchObject({ state: "stopped", canStop: false, label: "止まっています(その他)" });
  });

  it("理由の言葉は設計の9種類と、送信の処理で足した2種類(同じアドレス・対象の削除)と、対象を広げたときの2種類(DM 送付不可・所有者の名前)にある", () => {
    expect(Object.keys(FOLLOWUP_STOP_REASON_LABELS).sort()).toEqual(
      ["completed", "case_closed", "disabled", "handled_done", "interrupted", "manual", "no_address", "send_failed", "unsubscribed", "duplicate_address", "target_deleted", "dm_no_send", "owner_excluded"].sort(),
    );
  });
});

describe("followupViewsForList(申込の一覧)", () => {
  const stopped = { status: "stopped", stopReason: "manual", stoppedAt: null, stoppedBy: null, sends: [] };
  const rows = [
    { id: "a", email: "a@example.test", handleStatus: "open", leadFollowup: null },
    { id: "b", email: null, handleStatus: "open", leadFollowup: null },
    { id: "c", email: "c@example.test", handleStatus: "done", leadFollowup: null },
    { id: "d", email: "d@example.test", handleStatus: "done", leadFollowup: stopped },
  ];

  it("メールを見られない人には全部 null", () => {
    expect([...followupViewsForList(rows, false).values()]).toEqual([null, null, null, null]);
  });

  it("行が無く、メールが無い・対応済みの申込は null。行があれば対応済みでも出す", () => {
    const m = followupViewsForList(rows, true);
    expect(m.get("a")?.state).toBe("none");
    expect(m.get("b")).toBeNull();
    expect(m.get("c")).toBeNull();
    expect(m.get("d")?.state).toBe("stopped");
  });
});
