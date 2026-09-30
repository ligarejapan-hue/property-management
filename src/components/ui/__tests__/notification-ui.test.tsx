/**
 * 通知 段階1 の見た目(承認済み HTML イメージ)の固定。env=node のため renderToStaticMarkup で検証する。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastStack } from "../toast-stack";
import { BellButton, NotificationPanel, type NotificationPanelItem } from "../notification-panel";

const noop = () => {};

describe("ToastStack", () => {
  it("0件なら何も出さない", () => {
    expect(renderToStaticMarkup(createElement(ToastStack, { toasts: [], onDismiss: noop }))).toBe("");
  });

  it("右下(PC)・下に全幅(スマホ)、色帯・閉じるボタン・motion-reduce を持つ", () => {
    const out = renderToStaticMarkup(
      createElement(ToastStack, {
        toasts: [{ id: "1", tone: "red", icon: "unlock", title: "編集権限が外れました", body: "理由" }],
        onDismiss: noop,
      }),
    );
    expect(out).toContain("sm:right-4");
    expect(out).toContain("inset-x-3");
    expect(out).toContain("border-l-red-600");
    expect(out).toContain('aria-label="閉じる"');
    expect(out).toContain("motion-reduce:animate-none");
    expect(out).toContain("dark:bg-gray-900");
    expect(out).toContain("編集権限が外れました");
  });
});

describe("BellButton", () => {
  it("件数の丸は赤で、0件なら出さない", () => {
    const one = renderToStaticMarkup(createElement(BellButton, { unreadCount: 2, open: false, onClick: noop }));
    expect(one).toContain("bg-red-600");
    expect(one).toContain(">2<");
    const zero = renderToStaticMarkup(createElement(BellButton, { unreadCount: 0, open: false, onClick: noop }));
    expect(zero).not.toContain("bg-red-600");
  });

  it("10件以上は 9+", () => {
    expect(renderToStaticMarkup(createElement(BellButton, { unreadCount: 12, open: false, onClick: noop }))).toContain("9+");
  });
});

describe("NotificationPanel", () => {
  const item: NotificationPanelItem = {
    id: "a",
    icon: "unlock",
    tone: "red",
    message: "編集権限が外れました",
    meta: "物件の編集 ・ 14:32",
    unread: true,
  };
  const panel = (permission: "unsupported" | "default" | "granted" | "denied", items = [item]) =>
    renderToStaticMarkup(
      createElement(NotificationPanel, {
        items,
        permission,
        deviceLabel: "この PC",
        onMarkAllRead: noop,
        onItemClick: noop,
        onRequestPermission: noop,
      }),
    );

  it("未確認は薄い indigo の背景と点、すべて確認済みにするリンク", () => {
    const out = panel("default");
    expect(out).toContain("bg-indigo-50/70");
    expect(out).toContain('aria-label="未確認"');
    expect(out).toContain("すべて確認済みにする");
  });

  it("0件のとき", () => {
    expect(panel("default", [])).toContain("新しいお知らせはありません");
  });

  it("許可の4状態の文言", () => {
    expect(panel("default")).toContain("通知を許可する");
    expect(panel("granted")).toContain("この PCに通知します");
    expect(panel("denied")).toContain("通知がブロックされています");
    expect(panel("unsupported")).toContain("iPhone はホーム画面に追加すると使えます。");
  });
});
