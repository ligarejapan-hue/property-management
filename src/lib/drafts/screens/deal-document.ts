/** 取引の書類の発行の小窓の控え(設計 第2段階 §3.2)。値の中身は書類ごとに違うので、形は表であることだけ確かめる(発行のときにサーバーが検査し直す)。 */
import { z } from "zod/v4";
import { draftKey } from "../draft-store";

export interface DealDocumentDraft {
  rev: 1;
  values: Record<string, unknown>;
}

const schema = z.object({ rev: z.literal(1), values: z.record(z.string(), z.unknown()) }).strict();

export function parseDealDocumentDraft(d: unknown): DealDocumentDraft | null {
  const r = schema.safeParse(d);
  return r.success ? (r.data as DealDocumentDraft) : null;
}

export const dealDocumentDraftKey = (dealId: string, docType: string) => draftKey("deal-document", `${dealId}:${docType}`);

/** 初めの値(前回の入力・初期値)から変えていなければ控えない(開いただけで「入力の途中」にしない)。 */
export const sameAsInitial = (initial: Record<string, unknown>) => (d: DealDocumentDraft) => JSON.stringify(d.values) === JSON.stringify(initial);
