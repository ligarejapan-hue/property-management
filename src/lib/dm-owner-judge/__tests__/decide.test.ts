import { describe, it, expect } from "vitest";
import { decideDmByOwners, ownerlessDmStep, type OwnerSignals } from "../decide";

const clean: OwnerSignals = {
  agentNameOwnerIds: [],
  otherSendOwnerIds: [],
  otherNoSendOwnerIds: [],
  terminalOwnerIds: [],
  terminalOnProperty: false,
};

describe("decideDmByOwners(所有者が入ったときの DM判断の仕分け・2026-11-14 発注者)", () => {
  it("どれにも当たらなければ送付可", () => {
    expect(decideDmByOwners(clean)).toEqual({ dmStatus: "send", reasons: [] });
  });

  it("業者と同じ名前の所有者がいれば送付不可", () => {
    expect(decideDmByOwners({ ...clean, agentNameOwnerIds: ["o1"] })).toEqual({
      dmStatus: "no_send",
      reasons: ["agent_name"],
    });
  });

  it("同じ所有者がほかの物件で送付可なら送付不可(二重に送らない)", () => {
    expect(decideDmByOwners({ ...clean, otherSendOwnerIds: ["o1"] }).dmStatus).toBe("no_send");
  });

  it("同じ所有者がほかの物件で送付不可なら送付不可", () => {
    expect(decideDmByOwners({ ...clean, otherNoSendOwnerIds: ["o1"] }).reasons).toEqual(["other_no_send"]);
  });

  it("DM を断った・宛先不明の記録があれば送付不可(所有者でも物件でも)", () => {
    expect(decideDmByOwners({ ...clean, terminalOwnerIds: ["o1"] }).reasons).toEqual(["terminal"]);
    expect(decideDmByOwners({ ...clean, terminalOnProperty: true }).reasons).toEqual(["terminal"]);
  });

  it("いくつも当たれば理由を全部並べる(決まった順)", () => {
    expect(
      decideDmByOwners({
        agentNameOwnerIds: ["o1"],
        otherSendOwnerIds: ["o2"],
        otherNoSendOwnerIds: ["o2"],
        terminalOwnerIds: ["o3"],
        terminalOnProperty: false,
      }).reasons,
    ).toEqual(["agent_name", "other_send", "other_no_send", "terminal"]);
  });
});

describe("ownerlessDmStep(所有者が入っていない物件)", () => {
  it("送付可なら未判断に戻して所有者待ちの印を立てる", () => {
    expect(ownerlessDmStep({ dmStatus: "send", dmOwnerPending: false })).toEqual({ dmStatus: "hold", dmOwnerPending: true });
    expect(ownerlessDmStep({ dmStatus: "send", dmOwnerPending: true })).toEqual({ dmStatus: "hold", dmOwnerPending: true });
  });
  it("未判断で印が無ければ印だけ立てる", () => {
    expect(ownerlessDmStep({ dmStatus: "hold", dmOwnerPending: false })).toEqual({ dmOwnerPending: true });
  });
  it("未判断で印があれば何もしない", () => {
    expect(ownerlessDmStep({ dmStatus: "hold", dmOwnerPending: true })).toBeNull();
  });
  it("人が送付不可にした物件は触らない(印が立っていれば下ろすだけ)", () => {
    expect(ownerlessDmStep({ dmStatus: "no_send", dmOwnerPending: false })).toBeNull();
    expect(ownerlessDmStep({ dmStatus: "no_send", dmOwnerPending: true })).toEqual({ dmOwnerPending: false });
  });
});
