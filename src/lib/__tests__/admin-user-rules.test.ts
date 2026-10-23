import { describe, it, expect } from "vitest";
import { apiErrorMessage, checkUserUpdateGuard } from "../admin-user-rules";

describe("apiErrorMessage(失敗の理由を画面に出す)", () => {
  it("{ error: { message } } の形を読む(handleApiError の形)", () => {
    expect(apiErrorMessage({ error: { message: "最後の管理者です", code: "LAST_ADMIN" } }, "失敗")).toBe("最後の管理者です");
  });
  it("古い { message } の形も読む", () => {
    expect(apiErrorMessage({ message: "古い形" }, "失敗")).toBe("古い形");
  });
  it.each([null, undefined, {}, { error: {} }, { error: { message: "" } }, "文字", 42])("読めないときは既定の文言: %s", (b) => {
    expect(apiErrorMessage(b, "失敗しました")).toBe("失敗しました");
  });
});

describe("checkUserUpdateGuard(ユーザーの編集・無効化の守り)", () => {
  const admin = { role: "admin", isActive: true };
  const office = { role: "office_staff", isActive: true };

  it("自分の役割は変えられない(自分を締め出さない)", () => {
    expect(checkUserUpdateGuard({ isSelf: true, existing: admin, next: { role: "office_staff" }, otherActiveAdmins: 3 })?.code).toBe("SELF_ROLE");
  });
  it("自分の役割を同じ値で送るのは通す(編集の小窓は役割も送る)", () => {
    expect(checkUserUpdateGuard({ isSelf: true, existing: admin, next: { role: "admin" }, otherActiveAdmins: 0 })).toBeNull();
  });
  it("自分は無効化できない", () => {
    expect(checkUserUpdateGuard({ isSelf: true, existing: admin, next: { isActive: false }, otherActiveAdmins: 3 })?.code).toBe("SELF_DEACTIVATE");
  });
  it("最後の管理者を管理者以外にできない", () => {
    expect(checkUserUpdateGuard({ isSelf: false, existing: admin, next: { role: "field_staff" }, otherActiveAdmins: 0 })?.code).toBe("LAST_ADMIN");
  });
  it("最後の管理者を無効化できない", () => {
    expect(checkUserUpdateGuard({ isSelf: false, existing: admin, next: { isActive: false }, otherActiveAdmins: 0 })?.code).toBe("LAST_ADMIN");
  });
  it("ほかに有効な管理者がいれば、管理者を外す・無効化するのは通す", () => {
    expect(checkUserUpdateGuard({ isSelf: false, existing: admin, next: { role: "office_staff" }, otherActiveAdmins: 1 })).toBeNull();
    expect(checkUserUpdateGuard({ isSelf: false, existing: admin, next: { isActive: false }, otherActiveAdmins: 1 })).toBeNull();
  });
  it("無効の管理者を動かすのは数に関係なく通す(有効な管理者を減らさない)", () => {
    expect(checkUserUpdateGuard({ isSelf: false, existing: { role: "admin", isActive: false }, next: { role: "office_staff" }, otherActiveAdmins: 0 })).toBeNull();
  });
  it("管理者以外の役割の変更・無効化は通す", () => {
    expect(checkUserUpdateGuard({ isSelf: false, existing: office, next: { role: "admin" }, otherActiveAdmins: 0 })).toBeNull();
    expect(checkUserUpdateGuard({ isSelf: false, existing: office, next: { isActive: false }, otherActiveAdmins: 0 })).toBeNull();
  });
  it("名前やメールだけの変更は通す", () => {
    expect(checkUserUpdateGuard({ isSelf: true, existing: admin, next: {}, otherActiveAdmins: 0 })).toBeNull();
  });
});
