/**
 * 再送候補の判定(設計 2026-08-08-dm-sending-management-design.md §4)。
 *
 * 判定規則の**単一定義元**。一覧の where(buildResendCandidateWhere)と、
 * DL時の再評価・表示(decideResendCandidacy)を**同じファイルで対に維持する**
 * (同じ判定を2か所に書くとずれる=既知の失敗型)。
 * DB を触らない純関数のみ。クエリ発行とロック規約は呼び出し側 route の責務。
 *
 * 非対称の原則(@codex R4 P2): 誤って候補から**外れる**のは許容、
 * 誤って候補に**入る**のは不可。迷ったら除外側へ倒す。
 */
import { TERMINAL_REACTIONS, jstCalendarDay } from "@/lib/dm-reaction/core";

/** 再送候補に出るまでの間隔(日)。発注者決定=90日(設計§0)。上限(cap)は作らない。 */
export const DEFAULT_RESEND_COOLDOWN_DAYS = 90;

/**
 * cooldown 日数。env `DM_RESEND_COOLDOWN_DAYS` があればそれ(正の数のみ)、
 * 無ければ既定 90。業務値の変更にリリースを要らなくするための上書き口(設計§4)。
 * ⚠ブラウザ側では process.env が無いため既定値になる=画面に日数を出さない
 * (出すと env を変えたときに文言だけ取り残される)。
 */
export function getResendCooldownDays(): number {
  const raw = process.env.DM_RESEND_COOLDOWN_DAYS;
  const parsed = raw ? Number(raw) : undefined;
  return parsed !== undefined && Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_RESEND_COOLDOWN_DAYS;
}

/**
 * 「これより新しい送付があれば候補に入らない」境界。
 * ⚠`PropertyDmLog.sentAt` は `@db.Date`(JST暦日を UTC 真夜中で保持)なので、
 * cutoff も **JST の今日の暦日**から日数を戻した UTC 真夜中に揃える。
 * 素の instant 演算だと JST 0〜9時の判定が1日ずれる(@codex R38 P2)。
 * 比較は `sentAt > cutoff`(cutoff 当日ちょうどは「経過した」扱い=候補に入る)。
 */
export function resendCutoff(now: Date, cooldownDays: number): Date {
  const base = Date.parse(`${jstCalendarDay(now)}T00:00:00.000Z`);
  return new Date(base - cooldownDays * 86_400_000);
}

/** Prisma の `in` に渡す配列形(集合の出所は dm-reaction/core.ts に一本化)。 */
export const TERMINAL_REACTION_VALUES: readonly string[] = [
  ...TERMINAL_REACTIONS,
];

/**
 * 物件自身の記録で候補から外す反響。
 * terminal(拒否・宛先不明)に加えて **replied(連絡あり)** も外す
 * =連絡が来ている相手は人が個別対応する(設計§4「replied を除外する理由」)。
 */
export const SELF_EXCLUDING_REACTION_VALUES: readonly string[] = [
  ...TERMINAL_REACTION_VALUES,
  "replied",
];

export type ResendIneligibleReason =
  | "dm_status_not_send"
  | "never_sent"
  | "within_cooldown"
  | "terminal_reaction"
  | "owner_terminal_reaction";

export interface ResendCandidacyLog {
  sentAt: Date;
  reactionStatus: string;
}

export interface ResendCandidacyInput {
  dmStatus: string;
  /** その物件の送付記録(PropertyDmLog)。 */
  logs: ResendCandidacyLog[];
  /**
   * その物件の所有者の誰かに、**他物件も含めて** 拒否/宛先不明があるか(設計§4-5)。
   * 呼び出し側が §4-5 と同じクエリで計算して渡す(@codex R9 P2)。
   */
  ownerHasTerminalReaction: boolean;
}

export interface ResendCandidacyResult {
  eligible: boolean;
  reason: ResendIneligibleReason | null;
}

/** 設計§4 の5条件をこの順で見る(理由の粒度は表示・ログ用)。 */
export function decideResendCandidacy(
  input: ResendCandidacyInput,
  now: Date,
  options: { cooldownDays?: number } = {},
): ResendCandidacyResult {
  const cooldownDays = options.cooldownDays ?? getResendCooldownDays();
  const cutoff = resendCutoff(now, cooldownDays);

  if (input.dmStatus !== "send") {
    return { eligible: false, reason: "dm_status_not_send" };
  }
  if (input.logs.length === 0) {
    return { eligible: false, reason: "never_sent" };
  }
  if (input.logs.some((l) => l.sentAt.getTime() > cutoff.getTime())) {
    return { eligible: false, reason: "within_cooldown" };
  }
  if (
    input.logs.some((l) =>
      SELF_EXCLUDING_REACTION_VALUES.includes(l.reactionStatus),
    )
  ) {
    return { eligible: false, reason: "terminal_reaction" };
  }
  if (input.ownerHasTerminalReaction) {
    return { eligible: false, reason: "owner_terminal_reaction" };
  }
  return { eligible: true, reason: null };
}

/**
 * 一覧 where 用の Prisma 断片(AND で足す)。上の decideResendCandidacy と**同じ5条件**。
 * ⚠§4-5 は代表(`Owner.dmLogs`)と共有者連関(`Owner.dmLogOwners`)の**両経路**を見る。
 * 片方だけだと、共有者としてだけ拒否された相手の別物件が候補に残る。
 * ⚠isArchived で絞らない=archive 済み所有者に拒否が残っていても除外側に倒す(非対称の原則)。
 */
export function buildResendCandidateWhere(
  now: Date,
  cooldownDays: number,
): unknown[] {
  const cutoff = resendCutoff(now, cooldownDays);
  const terminalIn = { in: [...TERMINAL_REACTION_VALUES] };
  return [
    { dmStatus: "send" },
    { dmLogs: { some: {} } },
    { dmLogs: { none: { sentAt: { gt: cutoff } } } },
    {
      dmLogs: {
        none: { reactionStatus: { in: [...SELF_EXCLUDING_REACTION_VALUES] } },
      },
    },
    {
      propertyOwners: {
        none: {
          owner: {
            OR: [
              { dmLogs: { some: { reactionStatus: terminalIn } } },
              { dmLogOwners: { some: { log: { reactionStatus: terminalIn } } } },
            ],
          },
        },
      },
    },
  ];
}
