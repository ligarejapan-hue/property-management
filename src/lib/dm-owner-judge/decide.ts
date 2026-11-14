/**
 * DM判断の自動仕分け(2026-11-14 発注者決定)の決め方(純関数)。
 *
 * 所有者が入った物件(所有者待ちの印あり・未判断)を、次のどれかに当たれば送付不可、どれにも当たらなければ送付可にする。
 * 所有者が複数いれば、1人でも当たれば送付不可。
 * - 業者と同じ名前の所有者(DM の作成で外している判定と同じ=dm-batch/agent-name-exclusion)
 * - 同じ所有者がほかの物件で送付可(二重に送らない)
 * - 同じ所有者がほかの物件で送付不可(過去に送付不可にした人)
 * - DM を断った・宛先不明(解除していないもの)の記録がある(DM の作成で外している判定と同じ=dm-batch/terminal-exclusion)
 */

export type DmStatusValue = "send" | "hold" | "no_send";

export interface OwnerSignals {
  agentNameOwnerIds: readonly string[];
  otherSendOwnerIds: readonly string[];
  otherNoSendOwnerIds: readonly string[];
  terminalOwnerIds: readonly string[];
  /** 所有者に結びつかない断り・宛先不明が、この物件に付いている */
  terminalOnProperty: boolean;
}

export type NoSendReason = "agent_name" | "other_send" | "other_no_send" | "terminal";

export const NO_SEND_REASON_LABELS: Record<NoSendReason, string> = {
  agent_name: "業者と同じ名前の所有者",
  other_send: "同じ所有者がほかの物件で送付可",
  other_no_send: "同じ所有者がほかの物件で送付不可",
  terminal: "DMを断った・宛先不明の記録",
};

export function decideDmByOwners(s: OwnerSignals): { dmStatus: "send" | "no_send"; reasons: NoSendReason[] } {
  const reasons: NoSendReason[] = [];
  if (s.agentNameOwnerIds.length > 0) reasons.push("agent_name");
  if (s.otherSendOwnerIds.length > 0) reasons.push("other_send");
  if (s.otherNoSendOwnerIds.length > 0) reasons.push("other_no_send");
  if (s.terminalOwnerIds.length > 0 || s.terminalOnProperty) reasons.push("terminal");
  return { dmStatus: reasons.length > 0 ? "no_send" : "send", reasons };
}

/**
 * 所有者が入っていない物件で、何を書くか(書かないなら null)。
 * - 送付可 → 未判断に戻して印を立てる(所有者が入っていないのに送付可=物件データエラー)
 * - 未判断で印が無い → 印だけ立てる
 * - 送付不可(人が決めた)→ 触らない。印が残っていれば下ろす
 */
export function ownerlessDmStep(cur: {
  dmStatus: DmStatusValue;
  dmOwnerPending: boolean;
}): { dmStatus?: "hold"; dmOwnerPending: boolean } | null {
  if (cur.dmStatus === "send") return { dmStatus: "hold", dmOwnerPending: true };
  if (cur.dmStatus === "hold") return cur.dmOwnerPending ? null : { dmOwnerPending: true };
  return cur.dmOwnerPending ? { dmOwnerPending: false } : null;
}
