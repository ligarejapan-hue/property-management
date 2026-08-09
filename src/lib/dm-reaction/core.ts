// DM反響の中核(PR-B・設計 2026-08-08-dm-sending-management-design.md §3)。
// 優先規則: 同期undeliverable ≧ 手動terminal > 手動replied > 同期replied > no_response。
// 手動値を同期が上書きするときのみ manual_reaction_shadow へ全量退避(R44)、
// 同期の訂正(cleared)で復元・消費。手動no_responseは同期をブロックしない(R32/R40)。
// DB を触らない純関数のみ。書き込み側のロック規約(terminal は Owner 先頭 FOR UPDATE=R47)は
// 呼び出し元 route/helper が担う。

export const REACTION_STATUSES = [
  "no_response",
  "replied",
  "refused",
  "undeliverable",
] as const;

export type ReactionStatus = (typeof REACTION_STATUSES)[number];

export const TERMINAL_REACTIONS: ReadonlySet<string> = new Set([
  "refused",
  "undeliverable",
]);

export const REACTION_LABELS: Readonly<Record<ReactionStatus, string>> = {
  no_response: "反応なし",
  replied: "連絡あり",
  refused: "拒否",
  undeliverable: "宛先不明",
};

export function isTerminalReaction(
  status: string | null | undefined,
): boolean {
  return status != null && TERMINAL_REACTIONS.has(status);
}

export interface ReactionFields {
  reactionStatus: string;
  reactedAt: Date | null;
  reactionNote: string | null;
  reactionSource: string | null;
  manualReactionShadow: unknown;
}

// JSONB に保存する退避の形(status/reactedAt(ISO)/note の全量=R44)
interface ReactionShadow {
  status: ReactionStatus;
  reactedAt: string | null;
  note: string | null;
}

function parseShadow(value: unknown): ReactionShadow | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.status !== "string" ||
    !(REACTION_STATUSES as readonly string[]).includes(v.status)
  ) {
    return null;
  }
  if (v.reactedAt != null && typeof v.reactedAt !== "string") return null;
  if (v.note != null && typeof v.note !== "string") return null;
  const reactedAt = typeof v.reactedAt === "string" ? v.reactedAt : null;
  if (reactedAt != null && Number.isNaN(new Date(reactedAt).getTime())) {
    return null;
  }
  return {
    status: v.status as ReactionStatus,
    reactedAt,
    note: typeof v.note === "string" ? v.note : null,
  };
}

function toShadow(current: ReactionFields): ReactionShadow {
  return {
    status: (REACTION_STATUSES as readonly string[]).includes(
      current.reactionStatus,
    )
      ? (current.reactionStatus as ReactionStatus)
      : "no_response",
    reactedAt: current.reactedAt ? current.reactedAt.toISOString() : null,
    note: current.reactionNote,
  };
}

const VIRGIN: Omit<ReactionFields, "manualReactionShadow"> = {
  reactionStatus: "no_response",
  reactedAt: null,
  reactionNote: null,
  reactionSource: null,
};

/** 同期イベント(replied|undeliverable|cleared)を現在値に適用した次状態を返す純関数。
 *  変化がなければ current と同一参照を返す(呼び出し側は書き込みを省略できる)。 */
export function applySyncReaction(
  current: ReactionFields,
  sync: { kind: "replied" | "undeliverable" | "cleared"; at: Date },
): ReactionFields {
  const isManual = current.reactionSource === "manual";

  if (sync.kind === "cleared") {
    // 手動の記録は同期の消失で消えない
    if (isManual) return current;
    if (current.reactionSource !== "sale_dm_sync") return current;
    const shadow = parseShadow(current.manualReactionShadow);
    if (shadow) {
      // 上書きしていた手動値を復元(消費)
      return {
        reactionStatus: shadow.status,
        reactedAt: shadow.reactedAt ? new Date(shadow.reactedAt) : null,
        reactionNote: shadow.note,
        reactionSource: "manual",
        manualReactionShadow: null,
      };
    }
    return { ...VIRGIN, manualReactionShadow: null };
  }

  // 同期replied は手動の実反響(replied/refused/undeliverable)には負ける。
  // 同期undeliverable はここを素通り(≧手動terminal)。
  if (
    sync.kind === "replied" &&
    isManual &&
    current.reactionStatus !== "no_response"
  ) {
    return current;
  }

  return {
    reactionStatus: sync.kind,
    reactedAt: sync.at,
    reactionNote: null,
    reactionSource: "sale_dm_sync",
    // 手動値を上書きするときのみ全量退避。同期→同期では既存の退避を温存。
    manualReactionShadow: isManual
      ? toShadow(current)
      : (current.manualReactionShadow ?? null),
  };
}

/** 手動保存を適用(常に受理・source="manual"・shadowクリア)。 */
export function applyManualReaction(
  current: ReactionFields,
  manual: { status: ReactionStatus; reactedAt: Date | null; note: string | null },
): ReactionFields {
  void current;
  return {
    reactionStatus: manual.status,
    reactedAt: manual.reactedAt,
    reactionNote: manual.note,
    reactionSource: "manual",
    manualReactionShadow: null,
  };
}
