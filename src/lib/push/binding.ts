/**
 * 端末の登録の「結び付け」をどうするか(設計書 §7.5 の 2)。**純関数だけ**。
 *
 * - 同じ endpoint が別の利用者に結び付いていたら、今の利用者に付け替える。付け替えでは
 *   device_scope を shared(画面を閉じて65分)に戻す=前の人が選んだ「自分専用(30日)」を引き継がない
 *   (P1: 次の人の通知がブラウザを閉じたあとも届き続けるため)。personal は今の利用者が自分で選んだときだけ。
 * - 同じ利用者でも、期限切れ・無効化からの再有効化は新しい結び付けとして扱う(binding_id・bound_at を
 *   作り直す)。止まっていた間の出来事を、その端末に送らないため。
 * - 中継サービスが「もう無い」と返した登録(revoked_reason = gone)は同じ endpoint で有効に戻さない
 *   (送るたびに失敗するため)。画面は購読を作り直して新しい endpoint で登録し直す。
 */

export type DeviceScope = "shared" | "personal";
export const DEVICE_SCOPES: readonly DeviceScope[] = ["shared", "personal"];

/** shared = 自動ログオフと同じ65分。personal = 最後のログインから30日。 */
export const SHARED_TTL_MS = 65 * 60 * 1000;
export const PERSONAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ExistingSubscription {
  userId: string;
  deviceScope: string;
  bindingId: string;
  boundAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

export type BindingDecision =
  | { kind: "gone" }
  | {
      kind: "create" | "rebind" | "keep";
      bindingId: string;
      boundAt: Date;
      deviceScope: DeviceScope;
      expiresAt: Date;
      /** 前の結び付けの送り待ちを取り消す(4b で送信記録の表ができたら使う)。 */
      cancelPrevious: boolean;
    };

export function expiryFor(scope: DeviceScope, now: Date): Date {
  return new Date(now.getTime() + (scope === "personal" ? PERSONAL_TTL_MS : SHARED_TTL_MS));
}

export function isActiveSubscription(s: Pick<ExistingSubscription, "revokedAt" | "expiresAt">, now: Date): boolean {
  return s.revokedAt === null && s.expiresAt.getTime() > now.getTime();
}

export function decideBinding(args: {
  existing: ExistingSubscription | null;
  userId: string;
  /** 今の利用者がこの登録の操作で選んだ範囲。ログイン後の自動の付け替えでは渡さない。 */
  requestedScope?: DeviceScope;
  now: Date;
  newBindingId: string;
}): BindingDecision {
  const { existing, userId, requestedScope, now, newBindingId } = args;
  if (!existing) {
    const scope = requestedScope ?? "shared";
    return { kind: "create", bindingId: newBindingId, boundAt: now, deviceScope: scope, expiresAt: expiryFor(scope, now), cancelPrevious: false };
  }
  if (existing.revokedReason === "gone") return { kind: "gone" };
  const sameUser = existing.userId === userId;
  if (sameUser && isActiveSubscription(existing, now)) {
    const current: DeviceScope = existing.deviceScope === "personal" ? "personal" : "shared";
    const scope = requestedScope ?? current;
    return { kind: "keep", bindingId: existing.bindingId, boundAt: existing.boundAt, deviceScope: scope, expiresAt: expiryFor(scope, now), cancelPrevious: false };
  }
  // 別の利用者 → shared に戻す(本人がこの操作で personal を選んだときだけ personal)。
  // 同じ利用者の再有効化 → 前の範囲のまま(本人が選び直していればそちら)。
  const scope: DeviceScope = requestedScope ?? (sameUser && existing.deviceScope === "personal" ? "personal" : "shared");
  return { kind: "rebind", bindingId: newBindingId, boundAt: now, deviceScope: scope, expiresAt: expiryFor(scope, now), cancelPrevious: true };
}
