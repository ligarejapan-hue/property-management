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
// 画面すっきり化 第3回(2026-10-16): 実行は usePropertyAction へ切り出し、ActionBar は結果を受け取って描くだけ。
const idleAction = { loading: null, message: null, error: null, run: async () => {} };
const base: {
  dmStatus: string;
  investigationConfirmedAt: string | null;
  assignedToMe: boolean;
  hasOwners: boolean;
  action: typeof idleAction;
} = {
  dmStatus: "send",
  investigationConfirmedAt: null,
  assignedToMe: false,
  hasOwners: true,
  action: idleAction,
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
  it("担当は動詞表記", () => {
    expect(render()).toContain("自分を担当にする");
  });

  it("⚠状態と紛れないよう、DM以外の操作は選択の印を持たない", () => {
    const html = render();
    // aria-pressed を持つのは DM の3つだけ。
    const total = html.split("aria-pressed=").length - 1;
    expect(total).toBe(3);
  });
});

describe("画面すっきり化 第3回(発注者決定 2026-10-16)", () => {
  it("すでに自分が担当なら「自分を担当にする」を出さない", () => {
    expect(render({ assignedToMe: true })).not.toContain("自分を担当にする");
    expect(render({ assignedToMe: false })).toContain("自分を担当にする");
  });

  it("調査情報の未確認の帯と「確認した」は出さない(自動取得のため・2026-11-14 発注者)", () => {
    const html = render({});
    expect(html).not.toContain("調査情報が未確認です");
    expect(html).not.toContain("確認した");
    expect(html).not.toContain('aria-label="調査を確認する"');
    // DMの切替は残る。
    expect(html).toContain("送付可");
  });

  it("「登記取得済にする」は ActionBar に出さない(「その他 ▾」へ移した)", () => {
    expect(render()).not.toContain("登記取得済にする");
  });

  it("どこから押しても結果の文言は ActionBar の下に出る", () => {
    const html = render({ action: { ...idleAction, message: "登記取得済みに設定しました" } as never });
    expect(html).toContain("登記取得済みに設定しました");
    const err = render({ action: { ...idleAction, error: "失敗しました" } as never });
    expect(err).toContain("失敗しました");
  });
});

describe("所有者が入っていない物件は「送付可」を押せない(2026-11-14 発注者)", () => {
  it("所有者がいなければ送付可が押せず、理由を出す", () => {
    const html = render({ dmStatus: "hold", hasOwners: false });
    expect(html).toContain("所有者が入っていないので送付可にできません。所有者が入ると自動で仕分けます。");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="所有者が入っていない物件は送付可にできません"/);
  });
  it("所有者がいれば押せて、理由も出ない", () => {
    const html = render({ dmStatus: "hold", hasOwners: true });
    expect(html).not.toContain("所有者が入っていないので");
    expect(html).not.toContain('title="所有者が入っていない物件は送付可にできません"');
  });
});
