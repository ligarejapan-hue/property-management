import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("@/lib/api-client", () => ({ executePropertyAction: vi.fn() }));

import ActionBar from "@/components/properties/action-bar";

/**
 * 「この物件で行える操作」の表示。
 *
 * ⚠なぜ直すか(2026-08-21 発注者から報告): 「DM送付不可」と書かれたボタンを見て
 *   **その物件が送付不可だと読んでしまった**。実際は送付可で、警告(登記未取得なのに送付可)は
 *   正しかった。原因は **ボタンの文言が状態と同じ**うえ、**今の状態がその場に出ていない**こと。
 *   さらに旧実装は「今の状態のボタンだけ隠す」ため、**2つ並んでいること自体が状態のサイン**という
 *   極めて読み取りにくい作りだった。
 * ⚠同種の混乱は過去にも報告があり(B-10 UI総点検)、そのときは見出しを足しただけで、足りなかった。
 * ⇒ DMは**3状態の切替**にして現在値を選択として示し、他の操作は**動詞**にする。
 */
const base: {
  propertyId: string;
  registryStatus: string;
  dmStatus: string;
  investigationConfirmedAt: string | null;
  onActionComplete: () => void;
} = {
  propertyId: "p1",
  registryStatus: "unconfirmed",
  dmStatus: "send",
  investigationConfirmedAt: null,
  onActionComplete: () => {},
};

const render = (over: Partial<typeof base> = {}) =>
  renderToStaticMarkup(createElement(ActionBar, { ...base, ...over }));

describe("DMの判断は3状態の切替で示す", () => {
  it("3つの状態が常に並ぶ(状態によってボタンが消えない)", () => {
    for (const dmStatus of ["send", "no_send", "hold"]) {
      const html = render({ dmStatus });
      expect(html).toContain("送付可");
      expect(html).toContain("送付不可");
      expect(html).toContain("未判断");
    }
  });

  it("いまの状態が『選択されている』ものとして示される", () => {
    // aria-pressed=true はちょうど1つ（＝現在値）。
    const html = render({ dmStatus: "send" });
    const pressed = html.split('aria-pressed="true"').length - 1;
    expect(pressed).toBe(1);
  });

  // 選択中のボタンの中身だけを取り出す（位置の引き算で判定しない＝脆いピンにしない）。
  const pressedLabel = (html: string): string | null => {
    const at = html.indexOf('aria-pressed="true"');
    if (at < 0) return null;
    const end = html.indexOf("</button>", at);
    return html.slice(at, end);
  };

  it("どの状態でも、選ばれているのは今の状態そのもの(取り違えない)", () => {
    expect(pressedLabel(render({ dmStatus: "send" }))).toContain("送付可");
    expect(pressedLabel(render({ dmStatus: "no_send" }))).toContain("送付不可");
    expect(pressedLabel(render({ dmStatus: "hold" }))).toContain("未判断");
    // 「送付可」と「送付不可」を取り違えていないこと（部分一致の事故を潰す）。
    expect(pressedLabel(render({ dmStatus: "send" }))).not.toContain("送付不可");
  });

  it("知らない値のときはどれも選択しない(勝手に決めない)", () => {
    const html = render({ dmStatus: "unknown_value" });
    expect(html).not.toContain('aria-pressed="true"');
  });
});

describe("状態を変える操作は動詞で書く", () => {
  it("調査・登記・担当は動詞表記", () => {
    const html = render();
    expect(html).toContain("調査を確認する");
    expect(html).toContain("登記取得済にする");
    expect(html).toContain("自分を担当にする");
  });

  it("⚠状態と紛れないよう、DM以外の操作は選択の印を持たない", () => {
    const html = render();
    // aria-pressed を持つのは DM の3つだけ。
    const total = html.split("aria-pressed=").length - 1;
    expect(total).toBe(3);
  });

  it("済んでいる操作は出さない(従来どおり)", () => {
    const done = render({
      registryStatus: "obtained",
      investigationConfirmedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(done).not.toContain("調査を確認する");
    expect(done).not.toContain("登記取得済にする");
    // DMの切替と担当は残る。
    expect(done).toContain("送付可");
    expect(done).toContain("自分を担当にする");
  });
});
