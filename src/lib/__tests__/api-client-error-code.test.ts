/**
 * `codeFromErrorBody`(task5 review round1 Important #4)の単体検証。
 *
 * ⚠この関数は `toApiError`(api-client.ts 内部)と、鍵を持たない画面が自前で
 *   エラーを組み立てる入口(`property-edit-form.tsx` の保存 catch)の両方が通す、
 *   封筒からコードを取り出す唯一の場所。ここを固定しておけば、将来 `error.code` の
 *   形が変わってもここ1箇所を直すだけで済む(でなければ、複製した各画面が
 *   `apiErrorCode` に黙って `null` を渡し続け、鍵の状態が二度と切り替わらなくなる)。
 */
import { describe, it, expect } from "vitest";
import { codeFromErrorBody } from "../api-client";

describe("codeFromErrorBody", () => {
  it("error.code が文字列ならそのまま返す", () => {
    expect(codeFromErrorBody({ error: { code: "EDIT_LOCKED" } })).toBe("EDIT_LOCKED");
  });

  it("error が無ければ null", () => {
    expect(codeFromErrorBody({})).toBeNull();
  });

  it("body が null(非JSON応答)なら null", () => {
    expect(codeFromErrorBody(null)).toBeNull();
  });

  it("body が undefined なら null", () => {
    expect(codeFromErrorBody(undefined)).toBeNull();
  });

  it("error.code が文字列でなければ null(数値・null等を紛れ込ませない)", () => {
    expect(codeFromErrorBody({ error: { code: 500 } })).toBeNull();
    expect(codeFromErrorBody({ error: { code: null } })).toBeNull();
  });
});
