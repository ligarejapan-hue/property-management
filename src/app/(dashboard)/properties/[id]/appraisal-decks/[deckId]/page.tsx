import { redirect } from "next/navigation";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { canUseAppraisalDecks } from "@/lib/appraisal-deck/access";
import { canAccessPropertyRecord } from "@/lib/property-access";
import prisma from "@/lib/prisma";
import { AppraisalDeckReview } from "@/components/appraisal-deck/AppraisalDeckReview";

/**
 * 「査定のご報告」の下書きの確認画面(2026-11-10)。
 * ⚠ここでも権限を確かめる(数字は API が返す。API 側でも同じ確認をしている)。
 */
export default async function AppraisalDeckReviewPage({ params }: { params: Promise<{ id: string; deckId: string }> }) {
  const { id, deckId } = await params;
  let session: Awaited<ReturnType<typeof getApiSession>>;
  try {
    session = await getApiSession();
  } catch {
    redirect("/login");
  }
  const permissions = await getUserPermissions(session.id);
  if (!canUseAppraisalDecks(permissions, "read")) redirect(`/properties/${id}`);
  const property = await prisma.property.findUnique({
    where: { id },
    select: { id: true, createdBy: true, assignedTo: true, isArchived: true },
  });
  if (!property || !canAccessPropertyRecord(session, property)) redirect(`/properties/${id}`);
  const canWrite = canUseAppraisalDecks(permissions, "write");
  return <AppraisalDeckReview propertyId={id} deckId={deckId} canWrite={canWrite} />;
}
