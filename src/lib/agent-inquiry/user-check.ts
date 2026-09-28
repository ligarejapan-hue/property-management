import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";

/** 担当者・立ち会いに選べるのは有効な利用者だけ(存在しない id で外部キー違反の 500 にしない)。 */
export async function assertActiveUser(userId: string | null | undefined, code: string) {
  if (!userId) return;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } });
  if (!u?.isActive) throw new ApiError(422, "担当者を選び直してください", code);
}
