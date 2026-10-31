import { z } from "zod";
import { SCHEDULE_LIMITS } from "./schedule";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  const t = Date.parse(`${v}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}, "日付の形が正しくありません");

/** 手で足す項目。 */
export const scheduleAddSchema = z.object({
  label: z.string().trim().min(1, "作業名を入れてください").max(SCHEDULE_LIMITS.label, `作業名は${SCHEDULE_LIMITS.label}文字までです`),
  dueDate: ymd,
  assigneeId: z.string().uuid().nullable().optional(),
}).strict();

/** 担当・期限の変更、完了と取り消し、対象外。1回に1つ以上。 */
export const scheduleItemUpdateSchema = z.object({
  dueDate: ymd.optional(),
  assigneeId: z.string().uuid().optional(),
  completed: z.boolean().optional(),
  excluded: z.boolean().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, "変更がありません");
export type ScheduleItemUpdate = z.output<typeof scheduleItemUpdateSchema>;

/** 手で変えた内容 → 列の値。手で直した期限と担当は、付け直しで動かさない印を付ける。 */
export function scheduleItemUpdateData(b: ScheduleItemUpdate, now: Date) {
  return {
    ...(b.dueDate !== undefined ? { dueDate: new Date(`${b.dueDate}T00:00:00.000Z`), dueManual: true, preIntroduction: false } : {}),
    ...(b.assigneeId !== undefined ? { assigneeId: b.assigneeId, assigneeManual: true } : {}),
    ...(b.completed !== undefined ? { completedAt: b.completed ? now : null, autoCompleted: false, completionHint: null } : {}),
    ...(b.excluded !== undefined ? { excludedAt: b.excluded ? now : null, excludedManual: b.excluded } : {}),
  };
}
