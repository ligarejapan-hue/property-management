/** 貼り付けて物件化の控え(設計書 §2 S1)。 */
import { z } from "zod/v4";
import type { PasteDraft } from "@/lib/paste-import/types";
import type { BuildingChoice } from "@/lib/building-link/resolve";
// ⚠型だけ読む(部品の本体は読まない)。
import type {
  OwnerCandidateSummary,
  OwnerMatchKind,
  OwnerMode,
  OwnerValues,
  PasteDuplicatesResult,
  PropertyValues,
  SimilarPropertySummary,
} from "@/components/import/paste-import-review";
import { buildingChoiceSchema } from "./building-choice";

/** 読み取り後の確認画面の状態(サーバーの応答と人が直した値)。 */
export interface PasteReviewDraft {
  draft: PasteDraft;
  duplicates: PasteDuplicatesResult | null;
  similar: SimilarPropertySummary[];
  ownerCandidates: OwnerCandidateSummary[];
  ownerCandidatesTruncated: boolean;
  extractedText: string | null;
  propertyValues: PropertyValues;
  ownerValues: OwnerValues;
  note: string;
  externalLinkKey: string;
  ownerMode: OwnerMode;
  linkedOwner: { id: string; matchKindAtSelection: OwnerMatchKind } | null;
  buildingChoice: BuildingChoice;
}

/**
 * rev = 控えの形の版。PasteDraft など中身の型を変えたら上げる(古い控えを捨てるため)。
 * pdfFileName = 確認画面を PDF から作ったときのファイル名(登録で添付するので選び直しが要る)。
 */
export interface PasteScreenDraft {
  rev: 1;
  rawText: string;
  pdfFileName: string | null;
  review: PasteReviewDraft | null;
}

const MATCH_KINDS = ["current_address", "registry_address", "name_only"] as const;

// ⚠サーバーの応答の部分は、画面が実際に使う欄だけを確かめる(形を写しきると型の変更のたびに
//   ずれる)。足りない控えは捨てる=最初からやり直しになるだけで、画面は壊れない。
const reviewSchema = z.object({
  draft: z.looseObject({
    noteFromUnmapped: z.string(),
    unreadable: z.array(z.unknown()),
    property: z.looseObject({}),
  }),
  duplicates: z.looseObject({ blocked: z.boolean() }).nullable(),
  similar: z.array(z.looseObject({ id: z.string() })),
  ownerCandidates: z.array(z.looseObject({ id: z.string(), matchKind: z.enum(MATCH_KINDS) })),
  ownerCandidatesTruncated: z.boolean(),
  extractedText: z.string().nullable(),
  propertyValues: z.record(z.string(), z.string()),
  ownerValues: z.object({
    name: z.string(),
    nameKana: z.string(),
    phone: z.string(),
    email: z.string(),
    currentAddress: z.string(),
  }),
  note: z.string(),
  externalLinkKey: z.string(),
  ownerMode: z.enum(["link", "new", "none"]),
  linkedOwner: z.object({ id: z.string(), matchKindAtSelection: z.enum(MATCH_KINDS) }).nullable(),
  buildingChoice: buildingChoiceSchema,
});

const schema = z.object({
  rev: z.literal(1),
  rawText: z.string(),
  pdfFileName: z.string().nullable(),
  review: reviewSchema.nullable(),
});

export function parsePasteDraft(d: unknown): PasteScreenDraft | null {
  const r = schema.safeParse(d);
  // 検査を通った控えは、この画面が書いたものと同じ形(書き手はこの画面だけ)。
  return r.success ? (r.data as unknown as PasteScreenDraft) : null;
}

export function isPasteDraftEmpty(d: PasteScreenDraft): boolean {
  return d.rawText.trim() === "" && d.review === null;
}

/** 大きすぎて控えを止めた後に、送信中の印だけを残す中身(空)。 */
export function compactPasteDraftForPending(): PasteScreenDraft {
  return { rev: 1, rawText: "", pdfFileName: null, review: null };
}

/** PDF から作った確認画面を戻したとき、選び直すまで登録を止める理由(無ければ null)。 */
export function pdfReselectReason(d: { hasReview: boolean; pdfFileName: string | null; hasPdfFile: boolean }): string | null {
  if (!d.hasReview || d.pdfFileName == null || d.hasPdfFile) return null;
  return `PDF「${d.pdfFileName}」を選び直してください`;
}
