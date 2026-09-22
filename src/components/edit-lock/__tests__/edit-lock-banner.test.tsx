/**
 * 編集中の鍵の帯(仕様 6.2・6.3・6.4)。
 *
 * ⚠jsdom は使わない方針(`@testing-library/react` は依存に無い・vitest.config.ts は
 *   `environment: "node"`)。見た目・文言は `renderToStaticMarkup` の文字列で固定し、
 *   押したときの動きは部品から切り出した `createForceReleaseHandler` を node で直接呼ぶ
 *   (`src/app/(dashboard)/admin/attachments/__tests__/name-cell.test.tsx` と同じ形)。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EditLockBanner,
  EditLockHolderBanner,
  formatSince,
  createForceReleaseHandler,
} from "../edit-lock-banner";
import { forceReleaseEditLockApi, type EditLockStatusRow } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({
  forceReleaseEditLockApi: vi.fn(),
  // 実物(src/lib/api-client.ts)と同じ形の最小再現。
  apiErrorCode: (e: unknown) => {
    if (!(e instanceof Error)) return null;
    const code = (e as Error & { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  },
}));

// 2026-09-22 05:02 (現地時間として組み立てる。ISO 化 → 復元で往復するので、
// テストを走らせる環境のタイムゾーンに関わらず "05:02" に戻る)。
const SINCE = new Date(2026, 8, 22, 5, 2).toISOString();

const row = (over: Partial<EditLockStatusRow> = {}): EditLockStatusRow => ({
  resourceType: "property",
  resourceId: "p1",
  state: "held_by_other",
  holderName: "山田",
  since: SINCE,
  lockId: "l1",
  ...over,
});

describe("formatSince", () => {
  it("現地時間の HH:mm(0埋め)にする", () => {
    expect(formatSince(SINCE)).toBe("05:02");
  });

  it("時刻が無いときは空文字", () => {
    expect(formatSince(undefined)).toBe("");
  });
});

describe("EditLockBanner(本人向けの帯)", () => {
  it("鍵を持っている間(予告なし)は帯を出さない", () => {
    const html = renderToStaticMarkup(<EditLockBanner state={{ kind: "mine", lockId: "l1" }} warnIdle={false} />);
    expect(html).toBe("");
  });

  it("閲覧中(未取得)も帯を出さない", () => {
    const html = renderToStaticMarkup(<EditLockBanner state={{ kind: "idle" }} warnIdle={false} />);
    expect(html).toBe("");
  });

  it("55分の予告を出す", () => {
    const html = renderToStaticMarkup(<EditLockBanner state={{ kind: "mine", lockId: "l1" }} warnIdle />);
    expect(html).toContain("操作がないため、あと5分で編集を終了します");
  });

  it("期限切れの文言を出す", () => {
    const html = renderToStaticMarkup(<EditLockBanner state={{ kind: "expired" }} warnIdle={false} />);
    expect(html).toContain("しばらく画面が止まっていたため、編集の鍵が外れました。入力すると自動で取り直します");
  });

  it("管理者に外された文言を出す", () => {
    const html = renderToStaticMarkup(<EditLockBanner state={{ kind: "force_released" }} warnIdle={false} />);
    expect(html).toContain("管理者が編集を終了しました。この内容は保存できません");
  });

  it("削除された文言を出す", () => {
    const html = renderToStaticMarkup(<EditLockBanner state={{ kind: "deleted" }} warnIdle={false} />);
    expect(html).toContain("この記録は削除されたため、編集を続けられません");
  });

  it("他の人が編集中のときは氏名と開始時刻(HH:mm)を出す", () => {
    const html = renderToStaticMarkup(
      <EditLockBanner state={{ kind: "taken", holderName: "山田", since: SINCE }} warnIdle={false} />,
    );
    expect(html).toContain("🔒 山田さんが編集中です(05:02〜)");
  });
});

describe("EditLockHolderBanner(一覧向けの帯+管理者の鍵を外す)", () => {
  it("他の人が編集中の帯を出す", () => {
    const html = renderToStaticMarkup(<EditLockHolderBanner row={row()} isAdmin={false} onReleased={() => {}} />);
    expect(html).toContain("🔒 山田さんが編集中です(05:02〜)");
  });

  it("自分の別画面のときは氏名を出さない専用の文言にする", () => {
    const html = renderToStaticMarkup(
      <EditLockHolderBanner
        row={row({ state: "held_by_self_other_screen", holderName: undefined })}
        isAdmin={false}
        onReleased={() => {}}
      />,
    );
    expect(html).toContain("🔒 あなたが別の画面で編集中です(05:02〜)");
  });

  it("free/mine のときは何も出さない", () => {
    expect(renderToStaticMarkup(<EditLockHolderBanner row={row({ state: "free" })} isAdmin onReleased={() => {}} />)).toBe("");
    expect(renderToStaticMarkup(<EditLockHolderBanner row={row({ state: "mine" })} isAdmin onReleased={() => {}} />)).toBe("");
  });

  it("管理者にだけ「鍵を外す」が出る", () => {
    const withoutAdmin = renderToStaticMarkup(<EditLockHolderBanner row={row()} isAdmin={false} onReleased={() => {}} />);
    expect(withoutAdmin).not.toContain("鍵を外す");

    const withAdmin = renderToStaticMarkup(<EditLockHolderBanner row={row()} isAdmin onReleased={() => {}} />);
    expect(withAdmin).toContain("鍵を外す");
  });

  it("lockId が無ければ管理者でもボタンを出さない(窓口が返さない=権限が無いのと同じ)", () => {
    const html = renderToStaticMarkup(
      <EditLockHolderBanner row={row({ lockId: undefined })} isAdmin onReleased={() => {}} />,
    );
    expect(html).not.toContain("鍵を外す");
  });
});

describe("createForceReleaseHandler(押したときの動き)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("成功したら窓口を正しい引数で叩き、onReleased を呼ぶ", async () => {
    vi.mocked(forceReleaseEditLockApi).mockResolvedValue(undefined);
    const onReleased = vi.fn();
    const setNotice = vi.fn();
    const handler = createForceReleaseHandler({ row: row(), onReleased, setNotice });

    await handler();

    expect(forceReleaseEditLockApi).toHaveBeenCalledWith("property", "p1", "l1");
    expect(onReleased).toHaveBeenCalledTimes(1);
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("EDIT_LOCK_CHANGED で競合したら通知を出し、かつ onReleased も呼ぶ(両方)", async () => {
    vi.mocked(forceReleaseEditLockApi).mockRejectedValue(
      Object.assign(new Error("changed"), { code: "EDIT_LOCK_CHANGED", status: 409 }),
    );
    const onReleased = vi.fn();
    const setNotice = vi.fn();
    const handler = createForceReleaseHandler({ row: row(), onReleased, setNotice });

    await handler();

    expect(setNotice).toHaveBeenCalledWith("状況が変わりました。表示を更新します");
    expect(onReleased).toHaveBeenCalledTimes(1);
  });

  it("EDIT_LOCK_CHANGED 以外の失敗は投げ直す(競合の通知にしない・onReleased も呼ばない)", async () => {
    vi.mocked(forceReleaseEditLockApi).mockRejectedValue(new Error("network down"));
    const onReleased = vi.fn();
    const setNotice = vi.fn();
    const handler = createForceReleaseHandler({ row: row(), onReleased, setNotice });

    await expect(handler()).rejects.toThrow("network down");
    expect(setNotice).not.toHaveBeenCalled();
    expect(onReleased).not.toHaveBeenCalled();
  });

  it("lockId が無ければ何もしない(押せないはずのボタンの保険)", async () => {
    const onReleased = vi.fn();
    const setNotice = vi.fn();
    const handler = createForceReleaseHandler({ row: row({ lockId: undefined }), onReleased, setNotice });

    await handler();

    expect(forceReleaseEditLockApi).not.toHaveBeenCalled();
    expect(onReleased).not.toHaveBeenCalled();
  });
});

describe("解除の確認ダイアログの文言", () => {
  it("氏名入りの確認文を一字一句固定する", async () => {
    const { ConfirmDialog } = await import("@/components/ui/confirm-dialog");
    const holderLabel = "山田";
    const message = `${holderLabel}さんの編集を終わらせます。${holderLabel}さんが今入力している内容は失われ、保存されません。${holderLabel}さんの画面は、この先5分間は保存できません(5分経つと、この記録はまた誰でも編集を始められる状態に戻ります)。`;
    const html = renderToStaticMarkup(
      <ConfirmDialog
        title="編集の鍵を外しますか"
        message={message}
        confirmLabel="編集を終わらせる"
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(html).toContain(
      "山田さんの編集を終わらせます。山田さんが今入力している内容は失われ、保存されません。山田さんの画面は、この先5分間は保存できません(5分経つと、この記録はまた誰でも編集を始められる状態に戻ります)。",
    );
    expect(html).toContain("編集を終わらせる");
  });
});
