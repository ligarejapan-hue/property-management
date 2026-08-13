import { describe, it, expect, afterEach } from "vitest";
import {
  DEFAULT_RESEND_COOLDOWN_DAYS,
  buildResendCandidateWhere,
  decideResendCandidacy,
  getResendCooldownDays,
  resendCutoff,
  type ResendCandidacyInput,
} from "../candidacy";

// 設計 §4。sentAt は @db.Date(JST暦日を UTC 真夜中で保持)なので、テストも同じ表現で書く。
// JST 2026-08-13 から 90 日戻すと 2026-05-15(手計算で固定する=実装の式を書き写さない)。
const CUTOFF_DAY = "2026-05-15T00:00:00.000Z";

function log(day: string, reactionStatus = "no_response") {
  return { sentAt: new Date(`${day}T00:00:00.000Z`), reactionStatus };
}

function input(over: Partial<ResendCandidacyInput> = {}): ResendCandidacyInput {
  return {
    dmStatus: "send",
    logs: [log("2026-01-10")],
    ownerHasTerminalReaction: false,
    ...over,
  };
}

describe("resendCutoff", () => {
  it("JST の今日の暦日から cooldownDays 戻した UTC 真夜中を返す", () => {
    // 2026-08-13T00:30Z = JST 2026-08-13 09:30
    expect(
      resendCutoff(new Date("2026-08-13T00:30:00.000Z"), 90).toISOString(),
    ).toBe(CUTOFF_DAY);
  });

  it("JST の深夜(UTC では前日)でも JST 暦日で導出する", () => {
    // 2026-08-12T16:30Z = JST 2026-08-13 01:30 → 上と同じ cutoff でなければならない
    expect(
      resendCutoff(new Date("2026-08-12T16:30:00.000Z"), 90).toISOString(),
    ).toBe(CUTOFF_DAY);
  });
});

describe("getResendCooldownDays", () => {
  afterEach(() => {
    delete process.env.DM_RESEND_COOLDOWN_DAYS;
  });

  it("未設定なら既定 90 日", () => {
    delete process.env.DM_RESEND_COOLDOWN_DAYS;
    expect(getResendCooldownDays()).toBe(90);
    expect(DEFAULT_RESEND_COOLDOWN_DAYS).toBe(90);
  });

  it("env で上書きできる", () => {
    process.env.DM_RESEND_COOLDOWN_DAYS = "30";
    expect(getResendCooldownDays()).toBe(30);
  });

  it("数値でない/0以下の env は無視して既定に戻す", () => {
    process.env.DM_RESEND_COOLDOWN_DAYS = "abc";
    expect(getResendCooldownDays()).toBe(90);
    process.env.DM_RESEND_COOLDOWN_DAYS = "0";
    expect(getResendCooldownDays()).toBe(90);
    process.env.DM_RESEND_COOLDOWN_DAYS = "-5";
    expect(getResendCooldownDays()).toBe(90);
  });
});

describe("decideResendCandidacy", () => {
  const now = new Date("2026-08-13T00:30:00.000Z");
  const opts = { cooldownDays: 90 };

  it("送付済み・反響なし・90日超なら候補", () => {
    expect(decideResendCandidacy(input(), now, opts)).toEqual({
      eligible: true,
      reason: null,
    });
  });

  it("ちょうど 90 日前(cutoff 当日)の送付は候補に入る", () => {
    expect(
      decideResendCandidacy(input({ logs: [log("2026-05-15")] }), now, opts)
        .eligible,
    ).toBe(true);
  });

  it("89 日前(cutoff の翌日)の送付は候補に入らない", () => {
    expect(
      decideResendCandidacy(input({ logs: [log("2026-05-16")] }), now, opts),
    ).toEqual({ eligible: false, reason: "within_cooldown" });
  });

  it("古い送付が複数あっても、1件でも期間内なら候補に入らない", () => {
    expect(
      decideResendCandidacy(
        input({ logs: [log("2026-01-10"), log("2026-08-01")] }),
        now,
        opts,
      ).reason,
    ).toBe("within_cooldown");
  });

  it("dmStatus が send 以外なら候補に入らない", () => {
    expect(decideResendCandidacy(input({ dmStatus: "hold" }), now, opts)).toEqual(
      { eligible: false, reason: "dm_status_not_send" },
    );
  });

  it("送付記録が1件も無ければ候補に入らない", () => {
    expect(decideResendCandidacy(input({ logs: [] }), now, opts)).toEqual({
      eligible: false,
      reason: "never_sent",
    });
  });

  it("拒否・宛先不明・連絡ありの反響が付いた記録があれば候補に入らない", () => {
    for (const status of ["refused", "undeliverable", "replied"]) {
      expect(
        decideResendCandidacy(
          input({ logs: [log("2026-01-10", status)] }),
          now,
          opts,
        ),
      ).toEqual({ eligible: false, reason: "terminal_reaction" });
    }
  });

  it("所有者が他物件で拒否・宛先不明なら候補に入らない", () => {
    expect(
      decideResendCandidacy(input({ ownerHasTerminalReaction: true }), now, opts),
    ).toEqual({ eligible: false, reason: "owner_terminal_reaction" });
  });

  it("options 未指定なら env/既定の cooldown を使う", () => {
    expect(
      decideResendCandidacy(input({ logs: [log("2026-05-16")] }), now).eligible,
    ).toBe(false);
  });
});

describe("buildResendCandidateWhere", () => {
  const fragments = buildResendCandidateWhere(
    new Date("2026-08-13T00:30:00.000Z"),
    90,
  ) as Array<Record<string, any>>;

  // §4 の5条件が where にすべて現れることを構造で固定する(1つ落ちたら落ちる)。
  it("§4-1 dmStatus=send を強制する", () => {
    expect(fragments).toContainEqual({ dmStatus: "send" });
  });

  it("§4-2 送付記録が1件以上あることを要求する", () => {
    expect(fragments).toContainEqual({ dmLogs: { some: {} } });
  });

  it("§4-3 cutoff より新しい送付記録が無いことを要求する", () => {
    expect(fragments).toContainEqual({
      dmLogs: { none: { sentAt: { gt: new Date(CUTOFF_DAY) } } },
    });
  });

  it("§4-4 物件の記録に terminal/replied の反響が無いことを要求する", () => {
    const f = fragments.find(
      (x) => x.dmLogs?.none?.reactionStatus?.in !== undefined,
    );
    expect(f).toBeDefined();
    expect([...f!.dmLogs.none.reactionStatus.in].sort()).toEqual([
      "refused",
      "replied",
      "undeliverable",
    ]);
  });

  it("§4-5 所有者の他物件も含めた拒否/宛先不明を、代表と共有者連関の両経路で見る", () => {
    const f = fragments.find((x) => x.propertyOwners?.none !== undefined);
    expect(f).toBeDefined();
    const or = f!.propertyOwners.none.owner.OR;
    expect(or).toHaveLength(2);
    // ⚠`.sort()` は破壊的。where 断片の配列をその場で並べ替えないよう必ずコピーしてから。
    expect([...or[0].dmLogs.some.reactionStatus.in].sort()).toEqual([
      "refused",
      "undeliverable",
    ]);
    expect([...or[1].dmLogOwners.some.log.reactionStatus.in].sort()).toEqual([
      "refused",
      "undeliverable",
    ]);
  });

  it("5条件ちょうど(条件の増減に気づける)", () => {
    expect(fragments).toHaveLength(5);
  });
});
