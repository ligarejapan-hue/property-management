/**
 * ユーザー管理の小さな決まり(2026-10-23)。
 *
 * - apiErrorMessage: API の失敗の理由を画面に出す。handleApiError は `{ error: { message } }` を返すが、
 *   ユーザー管理の画面は `data.message` を読んでいて、理由が出ずに「失敗」とだけ出ていた。
 * - checkUserUpdateGuard: 役割・有効/無効の変更で、自分を締め出す・有効な管理者が0人になるのを止める。
 *   (一覧から編集で役割を変えられるようにしたため。削除の LAST_ADMIN と同じ考え方)
 */

export function apiErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const b = body as { error?: unknown; message?: unknown };
    if (b.error && typeof b.error === "object") {
      const m = (b.error as { message?: unknown }).message;
      if (typeof m === "string" && m) return m;
    }
    if (typeof b.message === "string" && b.message) return b.message;
  }
  return fallback;
}

export type UserUpdateGuardError = { status: number; message: string; code: string };

export function checkUserUpdateGuard(input: {
  isSelf: boolean;
  existing: { role: string; isActive: boolean };
  next: { role?: string; isActive?: boolean };
  /** 対象を除いた、有効な管理者の数 */
  otherActiveAdmins: number;
}): UserUpdateGuardError | null {
  const { isSelf, existing, next, otherActiveAdmins } = input;
  const roleChanges = next.role !== undefined && next.role !== existing.role;

  if (isSelf && next.isActive === false) {
    return { status: 400, message: "自分自身を無効化できません", code: "SELF_DEACTIVATE" };
  }
  if (isSelf && roleChanges) {
    return { status: 400, message: "自分自身の役割は変えられません(ほかの管理者に頼んでください)", code: "SELF_ROLE" };
  }

  const removesActiveAdmin =
    existing.role === "admin" &&
    existing.isActive &&
    ((roleChanges && next.role !== "admin") || next.isActive === false);
  if (removesActiveAdmin && otherActiveAdmins === 0) {
    return { status: 400, message: "有効な管理者が1人もいなくなるため、変更できません", code: "LAST_ADMIN" };
  }
  return null;
}
