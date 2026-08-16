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

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 実時刻 → JST 暦日 "YYYY-MM-DD"(深夜0-9時は UTC 前日でも当日扱い=R37)。 */
export function jstCalendarDay(at: Date): string {
  return new Date(at.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
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
/**
 * この行の「拒否」は守られているか(**退避=shadow も含む**・@codex #385 R2 P1)。
 *
 * 旧優先規則(2026-08-17以前)では同期 undeliverable が手動 refused を上書きし、
 * 元の拒否は manualReactionShadow に退避されていた。見えている reactionStatus だけで
 * 認可すると、この既存データの拒否を非管理者が編集・削除で消せてしまう。
 * DB の書き換え(正規化スクリプト)は別承認が要るため、**判定側を広げる**方式で守る。
 * 認可(PATCH/DELETE)・deletable 計算・UI施錠は必ずこの関数を使う(条件を散らさない)。
 */
export function isRefusalProtected(fields: {
  reactionStatus: string | null;
  manualReactionShadow: unknown;
}): boolean {
  if (fields.reactionStatus === "refused") return true;
  return parseShadow(fields.manualReactionShadow)?.status === "refused";
}

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
  // 同期undeliverable は原則ここを素通り(≧手動terminal)だが、**手動の「拒否」だけは
  // 上書きしない**(発注者指示 2026-08-17)。拒否は「変更・取消は管理者のみ」の縛りの
  // 根拠で、同期が undeliverable へ差し替えると reactionStatus が refused でなくなり、
  // **縛りが自動処理経由で外れる**(提出前レビュー Important)。除外の効果はどちらも
  // terminal で同じなので、拒否を保持しても宛先が復活することはない。物件側の
  // 宛先不明フラグは返戻ドラフト(deliveryStatus)の実数から別途立つ=そちらも失わない。
  if (
    sync.kind === "undeliverable" &&
    isManual &&
    current.reactionStatus === "refused"
  ) {
    return current;
  }
  if (
    sync.kind === "replied" &&
    isManual &&
    current.reactionStatus !== "no_response"
  ) {
    return current;
  }

  // 宛先不明→連絡ありへの訂正(@codex #366 R1 P2): 同期値が shadow(=undeliverable が
  // 上書きしていた手動値)を抱えているとき、弱い replied をそのまま被せると手動値が
  // shadow に隠れたまま生き返らない(次の手動保存で退避ごと消える)。先に手動値を
  // 復元してから優先規則を適用し直す(手動の実反響は同期replied に勝つ)。
  if (sync.kind === "replied" && current.reactionSource === "sale_dm_sync") {
    const shadow = parseShadow(current.manualReactionShadow);
    if (shadow) {
      const restored: ReactionFields = {
        reactionStatus: shadow.status,
        reactedAt: shadow.reactedAt ? new Date(shadow.reactedAt) : null,
        reactionNote: shadow.note,
        reactionSource: "manual",
        manualReactionShadow: null,
      };
      return applySyncReaction(restored, sync);
    }
  }

  const next: ReactionFields = {
    reactionStatus: sync.kind,
    reactedAt: sync.at,
    reactionNote: null,
    reactionSource: "sale_dm_sync",
    // 手動値を上書きするときのみ全量退避。同期→同期では既存の退避を温存。
    manualReactionShadow: isManual
      ? toShadow(current)
      : (current.manualReactionShadow ?? null),
  };
  // 同値の同期を再適用しても同一参照を返す(冪等)。呼び出し側はこれで書込・ロックを省略する。
  if (
    current.reactionStatus === next.reactionStatus &&
    sameInstant(current.reactedAt, next.reactedAt) &&
    current.reactionNote === next.reactionNote &&
    current.reactionSource === next.reactionSource &&
    current.manualReactionShadow === next.manualReactionShadow
  ) {
    return current;
  }
  return next;
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
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
