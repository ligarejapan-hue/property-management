import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentPicker } from "../agent-picker";

const draw = (onCreateNew?: () => void) =>
  renderToStaticMarkup(<AgentPicker query="" selected={null} onQuery={() => {}} onPick={() => {}} onCreateNew={onCreateNew} />);

describe("業者を探す欄の説明", () => {
  it("新しく登録できる画面(受付の窓)では登録の案内", () => {
    expect(draw(() => {})).toContain("新しく登録できます");
  });
  it("登録しない画面(取引)では探し方だけ", () => {
    const html = draw();
    expect(html).toContain("会社名(2文字以上)か電話番号(7桁以上)で探せます");
    expect(html).not.toContain("新しく登録");
  });
});
