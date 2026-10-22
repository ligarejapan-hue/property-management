/**
 * API のエラー応答から人に見せる文を取り出す(実機確認 2026-10-23)。
 *
 * 背景: 権限テンプレートの作成・削除が失敗したとき `alert(json.error ?? "…")` が
 * `{ error: { message, code } }` のオブジェクトをそのまま出して「[object Object]」になった。
 */
import { describe, it, expect } from "vitest";
import { apiErrorMessage } from "@/lib/api-error-message";

describe("apiErrorMessage", () => {
  it("handleApiError の形 { error: { message, code } } は message を返す", () => {
    expect(apiErrorMessage({ error: { message: "権限がありません", code: "FORBIDDEN" } }, "失敗")).toBe("権限がありません");
  });
  it("古い形 { error: '文' } はその文を返す", () => {
    expect(apiErrorMessage({ error: "テンプレートが見つかりません" }, "失敗")).toBe("テンプレートが見つかりません");
  });
  it("message が無い・空・本体が無いときは既定の文", () => {
    expect(apiErrorMessage({ error: { code: "X" } }, "削除に失敗しました")).toBe("削除に失敗しました");
    expect(apiErrorMessage({ error: { message: "  " } }, "削除に失敗しました")).toBe("削除に失敗しました");
    expect(apiErrorMessage({ error: "" }, "削除に失敗しました")).toBe("削除に失敗しました");
    expect(apiErrorMessage({}, "削除に失敗しました")).toBe("削除に失敗しました");
    expect(apiErrorMessage(null, "削除に失敗しました")).toBe("削除に失敗しました");
    expect(apiErrorMessage("text", "削除に失敗しました")).toBe("削除に失敗しました");
  });
  it("オブジェクトを文字列化した「[object Object]」は決して返さない", () => {
    expect(apiErrorMessage({ error: { nested: { message: "x" } } }, "既定")).toBe("既定");
  });
});
