import { describe, it, expect } from "vitest";
import {
  LETTER_BODY_MAX_LENGTH,
  letterBodyIssueMessage,
  validateLetterBody,
} from "../body-validation";

describe("validateLetterBody", () => {
  it("ふつうの本文は通る", () => {
    expect(
      validateLetterBody("拝啓 時下ますますご清祥のこととお喜び申し上げます。"),
    ).toBeNull();
  });

  it("空・空白のみ・改行のみは弾く(白紙の手紙が確定・印刷まで通るのを防ぐ)", () => {
    for (const body of ["", " ", "　", "\n", " \n\t 　\n"]) {
      expect(validateLetterBody(body)).toBe("empty");
    }
  });

  it("差込タグの書き方が残っている本文は弾く(プレースホルダのまま郵送されるのを防ぐ)", () => {
    expect(validateLetterBody("{{所有者名}} 様へ")).toBe("unknown_tag");
    expect(validateLetterBody("本文\n{{物件所在}}\n本文")).toBe("unknown_tag");
  });

  it("許可タグは通す(貼り付け保存の検証・PR-D2)", () => {
    expect(
      validateLetterBody("{{物件所在}}の{{物件種別}}について", { allowTags: true }),
    ).toBeNull();
  });

  it("許可タグ以外は allowTags でも弾く", () => {
    expect(validateLetterBody("{{所有者名}}", { allowTags: true })).toBe("unknown_tag");
  });

  it("綴り違いのタグも allowTags で弾く", () => {
    expect(validateLetterBody("{{物件所在 }}", { allowTags: true })).toBe("unknown_tag");
  });

  it("既定(allowTags なし)は従来どおり全部の {{ を弾く", () => {
    expect(validateLetterBody("{{物件所在}}")).toBe("unknown_tag");
  });

  it("閉じ側だけ・片方だけの記号も弾く(@codex #376 R12)", () => {
    // ⚠`{{` だけを見ると、許可タグを取り除いた**残り**に `}` が残っても素通りする。
    //   そのまま刷ると手紙に記号が残る。開き side・閉じ side の両方を見る。
    expect(validateLetterBody("{{物件所在}}} の件", { allowTags: true })).toBe("unknown_tag");
    expect(validateLetterBody("{物件所在}} の件", { allowTags: true })).toBe("unknown_tag");
    expect(validateLetterBody("{物件所在} の件", { allowTags: true })).toBe("unknown_tag");
    expect(validateLetterBody("本文 }} 本文", { allowTags: true })).toBe("unknown_tag");
    // 既定(タグを許さない側)でも同じ。
    expect(validateLetterBody("{物件所在}")).toBe("unknown_tag");
  });

  it("上限を超える本文は弾く", () => {
    expect(validateLetterBody("あ".repeat(LETTER_BODY_MAX_LENGTH))).toBeNull();
    expect(validateLetterBody("あ".repeat(LETTER_BODY_MAX_LENGTH + 1))).toBe(
      "too_long",
    );
  });

  it("検査の順番は 空→長さ→タグ(空文字に長さやタグの理由を出さない)", () => {
    expect(validateLetterBody("   ")).toBe("empty");
  });

  it("理由ごとに日本語の説明が出る(そのまま画面に出せる)", () => {
    for (const issue of ["empty", "unknown_tag", "too_long"] as const) {
      const msg = letterBodyIssueMessage(issue);
      expect(msg.length).toBeGreaterThan(5);
      expect(msg).not.toMatch(/[A-Za-z_]{6,}/); // 内部識別子をそのまま出さない
    }
  });
});
