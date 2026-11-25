import { z } from "zod";
import { text } from "./schema-parts";

/**
 * 集合ポストの解除番号の確認欄(2026-11-26 発注者)。取引の `checklist_state.mailbox` に持つ(列は前からある・migration なし)。
 * 鍵受領書に解除番号と解除方法を載せる。解除番号は変更履歴・監査には値を残さない(項目名だけ)。
 */
export const MAILBOX_STATUSES = { unknown: "未確認", none: "なし", present: "あり" } as const;
export type MailboxStatus = keyof typeof MAILBOX_STATUSES;
export const MAILBOX_LIMITS = { code: 30, method: 200 } as const;

export const mailboxSchema = z.object({
  status: z.enum(["unknown", "none", "present"]),
  /** 解除番号(例 1234・右3左5 など)。 */
  code: text(MAILBOX_LIMITS.code),
  /** 解除方法(ダイヤルの回し方・開け方)。 */
  method: text(MAILBOX_LIMITS.method),
  /** 現地で開くことを確かめた。 */
  checked: z.boolean(),
}).strict();
export type Mailbox = z.output<typeof mailboxSchema>;
export const DEFAULT_MAILBOX: Mailbox = { status: "unknown", code: null, method: null, checked: false };

/** `checklist_state` の JSON → 集合ポスト(壊れていれば初めの値)。 */
export function readMailbox(checklistState: unknown): Mailbox {
  const src = checklistState && typeof checklistState === "object" && !Array.isArray(checklistState)
    ? (checklistState as Record<string, unknown>).mailbox : undefined;
  const r = mailboxSchema.safeParse(src);
  return r.success ? r.data : DEFAULT_MAILBOX;
}

/** `checklist_state` の mailbox の鍵だけを差し替える(ほかの鍵は残す)。 */
export function withMailbox(checklistState: unknown, mailbox: Mailbox): Record<string, unknown> {
  const base = checklistState && typeof checklistState === "object" && !Array.isArray(checklistState)
    ? (checklistState as Record<string, unknown>) : {};
  return { ...base, mailbox };
}
