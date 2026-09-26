/**
 * 編集中の鍵の帯(仕様 6.2・6.3・6.4)。
 *
 * ⚠jsdom は使わない方針(`@testing-library/react` は依存に無い・vitest.config.ts は
 *   `environment: "node"`)。見た目・文言は `renderToStaticMarkup` の文字列で固定し、
 *   押したときの動きは部品から切り出した `createForceReleaseHandler`/`createConfirmReleaseHandler`
 *   を node で直接呼ぶ(`src/app/(dashboard)/admin/attachments/__tests__/name-cell.test.tsx` と同じ形)。
 *
 * review round 1(task-4-review.md)の反映:
 * - Important #1: 配線(`createForceReleaseHandler`/`createConfirmReleaseHandler` への
 *   引数)を source assertion で、通知の表示を `initialNotice` を使った render assertion で固定。
 * - Important #2: `createConfirmReleaseHandler` を「component の onConfirm」相当として
 *   `release`(= `createForceReleaseHandler` の戻り値)と組み合わせてテストする。
 * - Important #3: `confirmReleaseMessage` の自分の別画面の文言を固定。
 * - Important #4(round1時点): `activeNotice` を直接テストし、古い行の通知が出ないことを固定。
 * - Minor: `formatSince` の不正値・`held_by_self_other_screen` + admin のボタン表示を追加。
 *
 * review round 2(task-4-review.md「## 再点検」)の反映:
 * - Important(round1の#4の鍵が甘かった続き): `noticeRowKey` に `lockId` を含めたので、
 *   対象・状態が同じでも保持者(=`lockId`)が入れ替わっていれば古い通知を出さないことを
 *   `activeNotice` の直接テストと `EditLockHolderBanner` の render assertion の両方で固定。
 * - コントローラの裁定(round1の判断を反転): 「通知(競合等)が立っているときは、それを
 *   帯として出す」テストは round1 では `not.toContain("鍵を外す")`/`not.toContain("編集中です")`
 *   だったが、**この期待を反転**して「通知が立っていても held な行なら帯とボタンを併記する」
 *   ことを固定する(round1の判断が誤りだったための反転であり、アサーションを弱めた
 *   わけではない)。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EditLockBanner,
  EditLockHolderBanner,
  formatSince,
  createForceReleaseHandler,
  createConfirmReleaseHandler,
  confirmReleaseMessage,
  activeNotice,
  noticeRowKey,
} from "../edit-lock-banner";
// ⚠(横断レビュー I3) 帯の「held かどうか」は、見ている側の4つの無効化を決めている
//   この純関数と**同じ1本**であることを総当たりで突き合わせる。
import { isEditLockHeldByOther } from "@/lib/edit-lock/save-gate";
import { forceReleaseEditLockApi, type EditLockStatusRow } from "@/lib/api-client";

const bannerSrc = readFileSync(
  resolve(process.cwd(), "src/components/edit-lock/edit-lock-banner.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

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

  it("解釈できない値でも NaN:NaN を出さず空文字にする(review Minor #1)", () => {
    expect(formatSince("garbage")).toBe("");
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

  /**
   * 横断レビュー I2。仕様 6.2 が指定した**編集する側**の文言はこれ
   * (「この内容は保存できません」=編集中の人にとって唯一重要な一文)。
   * 修理前は 6.3 の**見ている側**の文言(「🔒 {氏名}さんが編集中です(HH:mm〜)」)を
   * 編集側でも流用しており、仕様にある文言がブランチのどこにも存在しなかった。
   * ⚠この帯に開始時刻は入らない(仕様6.2の一文のまま)。氏名+時刻は保存が423で
   *   断られたときのエラー表示(`showComposedEditLockedMessage`・6.5と同じ組み立て)が持つ。
   */
  it("他の人が編集を始めたときは仕様6.2の文言(保存できない旨)を出す", () => {
    const html = renderToStaticMarkup(
      <EditLockBanner state={{ kind: "taken", holderName: "山田", since: SINCE }} warnIdle={false} />,
    );
    expect(html).toContain("山田さんが編集を始めました。この内容は保存できません");
  });

  it("自分の別画面が始めたときは自分の氏名を出さない専用の文言にする(I2・§11の裁定)", () => {
    const html = renderToStaticMarkup(
      <EditLockBanner
        state={{ kind: "taken", holderName: "自分", since: SINCE, bySelfOtherScreen: true }}
        warnIdle={false}
      />,
    );
    expect(html).toContain("あなたが別の画面で編集を始めました。この内容は保存できません");
    // ⚠自分の氏名を「◯◯さんが」と出してはいけない(D6・§11に3回書かれた規則)。
    expect(html).not.toContain("自分さんが");
  });
});

describe("EditLockHolderBanner(一覧向けの帯+管理者の鍵を外す)", () => {
  /**
   * 横断レビュー I3。この帯が「held かどうか」を自前で書き写していたため、7つ目の
   * held 状態が増えた瞬間に、帯と**見ている側の4つの無効化**(`page.tsx` が
   * `isEditLockHeldByOther` で決めている)が静かに食い違う作りだった。
   * 判定が本当に同じ1本かを、状態を総当たりして帯の有無と突き合わせて固定する。
   */
  it("(I3) 帯を出すかどうかは save-gate の isEditLockHeldByOther と完全に一致する(判定を再実装しない)", () => {
    const states: EditLockStatusRow["state"][] = [
      "free",
      "mine",
      "held_by_other",
      "held_by_self_other_screen",
    ];
    for (const state of states) {
      const target = row({ state });
      const html = renderToStaticMarkup(
        <EditLockHolderBanner row={target} isAdmin={false} onReleased={() => {}} />,
      );
      expect(html !== "", `state=${state}`).toBe(isEditLockHeldByOther(target));
    }
  });

  it("(I3) この部品は判定を自分で書かず save-gate から import する", () => {
    // ⚠描画の一致だけでは、同じ式をここに書き写した実装でも green のままになる。
    //   単一の出どころであること自体を固定する。
    expect(bannerSrc).toMatch(
      /import \{ isEditLockHeldByOther \} from "@\/lib\/edit-lock\/save-gate"/,
    );
    expect(bannerSrc).toContain("const isHeld = isEditLockHeldByOther(row);");
  });

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

  it("自分の別画面でも管理者には「鍵を外す」が出る(review Minor #2)", () => {
    const selfOtherScreen = row({ state: "held_by_self_other_screen", holderName: undefined });
    const withoutAdmin = renderToStaticMarkup(
      <EditLockHolderBanner row={selfOtherScreen} isAdmin={false} onReleased={() => {}} />,
    );
    expect(withoutAdmin).not.toContain("鍵を外す");

    const withAdmin = renderToStaticMarkup(
      <EditLockHolderBanner row={selfOtherScreen} isAdmin onReleased={() => {}} />,
    );
    expect(withAdmin).toContain("鍵を外す");
  });

  it("lockId が無ければ管理者でもボタンを出さない(窓口が返さない=権限が無いのと同じ)", () => {
    const html = renderToStaticMarkup(
      <EditLockHolderBanner row={row({ lockId: undefined })} isAdmin onReleased={() => {}} />,
    );
    expect(html).not.toContain("鍵を外す");
  });

  // ⚠round1では「通知が立っているあいだは帯を隠す」ことを固定していたが、コントローラの
  //   裁定でround1の判断を反転した: 通知は帯を置き換えず、held な行なら常に併記する
  //   (衝突直後に管理者が今の鍵を操作できなくなるのを防ぐため)。このテストは
  //   `not.toContain` → `toContain` に反転しており、アサーションを弱めたわけではない。
  it("通知(競合等)が立っていても、held な行なら帯とボタンを併記する(review round2・round1の判断を反転)", () => {
    const html = renderToStaticMarkup(
      <EditLockHolderBanner
        row={row()}
        isAdmin
        onReleased={() => {}}
        initialNotice="状況が変わりました。表示を更新します"
      />,
    );
    expect(html).toContain("状況が変わりました。表示を更新します");
    // 通知と同じ行(同じ lockId)がまだ held_by_other である限り、帯とボタンは消えない。
    expect(html).toContain("🔒 山田さんが編集中です(05:02〜)");
    expect(html).toContain("鍵を外す");
  });

  it("通知が今と同じ行(lockId含む)に対するものなら出す(省略時は今の row とみなす)", () => {
    const html = renderToStaticMarkup(
      <EditLockHolderBanner
        row={row()}
        isAdmin={false}
        onReleased={() => {}}
        initialNotice="状況が変わりました。表示を更新します"
      />,
    );
    expect(html).toContain("状況が変わりました。表示を更新します");
  });

  it("通知が古い行(別のresourceId)に対するものなら、いま渡された行には出さない(review Important #4)", () => {
    const staleKey = noticeRowKey({
      resourceType: "property",
      resourceId: "old-id",
      state: "held_by_other",
      lockId: "l1",
    });
    const html = renderToStaticMarkup(
      <EditLockHolderBanner
        row={row()}
        isAdmin={false}
        onReleased={() => {}}
        initialNotice="状況が変わりました。表示を更新します"
        initialNoticeRowKey={staleKey}
      />,
    );
    expect(html).not.toContain("状況が変わりました");
    // 古い通知は捨てられ、いまの行の状態(held_by_other)がそのまま出る。
    expect(html).toContain("🔒 山田さんが編集中です(05:02〜)");
  });

  it("対象・状態が同じでも lockId が違えば古い通知を出さない(別の保持者に切り替わった・review round2 Important)", () => {
    const staleKey = noticeRowKey({
      resourceType: "property",
      resourceId: "p1",
      state: "held_by_other",
      lockId: "l1",
    });
    const html = renderToStaticMarkup(
      <EditLockHolderBanner
        row={row({ lockId: "l2", holderName: "佐藤" })}
        isAdmin={false}
        onReleased={() => {}}
        initialNotice="状況が変わりました。表示を更新します"
        initialNoticeRowKey={staleKey}
      />,
    );
    expect(html).not.toContain("状況が変わりました");
    // 新しい保持者(佐藤)の帯がそのまま出る。
    expect(html).toContain("🔒 佐藤さんが編集中です(05:02〜)");
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

describe("createConfirmReleaseHandler(承諾ボタンの後始末・review Important #2・#4前半)", () => {
  beforeEach(() => vi.clearAllMocks());

  // ⚠component の実際の配線(row → createForceReleaseHandler → release →
  //   createConfirmReleaseHandler)をそのまま組み立てて呼ぶ。isolated handler だけでなく
  //   「component の onConfirm 相当」を検査する、というレビュー指摘に応えるため。
  const buildConfirm = (r: EditLockStatusRow, onReleased: () => void, setNotice: (m: string | null) => void) => {
    const setBusy = vi.fn();
    const setConfirmOpen = vi.fn();
    const release = createForceReleaseHandler({ row: r, onReleased, setNotice });
    const confirm = createConfirmReleaseHandler({ release, setBusy, setConfirmOpen, setNotice });
    return { confirm, setBusy, setConfirmOpen };
  };

  it("成功: 開始時に通知を消し、busyを立てて→戻し、ダイアログを閉じる(新規の通知は出さない)", async () => {
    vi.mocked(forceReleaseEditLockApi).mockResolvedValue(undefined);
    const onReleased = vi.fn();
    const setNotice = vi.fn();
    const { confirm, setBusy, setConfirmOpen } = buildConfirm(row(), onReleased, setNotice);

    await confirm();

    expect(setNotice).toHaveBeenCalledTimes(1);
    expect(setNotice).toHaveBeenNthCalledWith(1, null);
    expect(setBusy).toHaveBeenNthCalledWith(1, true);
    expect(setBusy).toHaveBeenLastCalledWith(false);
    expect(setConfirmOpen).toHaveBeenCalledWith(false);
    expect(onReleased).toHaveBeenCalledTimes(1);
  });

  it("EDIT_LOCK_CHANGED(競合): 通知を出し、onReleased も呼び、ダイアログを閉じてbusyを戻す", async () => {
    vi.mocked(forceReleaseEditLockApi).mockRejectedValue(
      Object.assign(new Error("changed"), { code: "EDIT_LOCK_CHANGED", status: 409 }),
    );
    const onReleased = vi.fn();
    const setNotice = vi.fn();
    const { confirm, setBusy, setConfirmOpen } = buildConfirm(row(), onReleased, setNotice);

    await confirm();

    expect(setNotice).toHaveBeenNthCalledWith(1, null);
    expect(setNotice).toHaveBeenNthCalledWith(2, "状況が変わりました。表示を更新します");
    expect(onReleased).toHaveBeenCalledTimes(1);
    expect(setConfirmOpen).toHaveBeenCalledWith(false);
    expect(setBusy).toHaveBeenLastCalledWith(false);
  });

  it("原因不明の失敗: 汎用の失敗通知を出し、onReleased は呼ばず、ダイアログは閉じてbusyも戻す(review Important #2)", async () => {
    vi.mocked(forceReleaseEditLockApi).mockRejectedValue(new Error("network down"));
    const onReleased = vi.fn();
    const setNotice = vi.fn();
    const { confirm, setBusy, setConfirmOpen } = buildConfirm(row(), onReleased, setNotice);

    await confirm();

    expect(setNotice).toHaveBeenNthCalledWith(1, null);
    expect(setNotice).toHaveBeenNthCalledWith(2, "編集を終了できませんでした。もう一度お試しください");
    expect(onReleased).not.toHaveBeenCalled();
    expect(setConfirmOpen).toHaveBeenCalledWith(false);
    expect(setBusy).toHaveBeenLastCalledWith(false);
  });
});

describe("confirmReleaseMessage(確認ダイアログの本文・review Important #3)", () => {
  it("他の人の編集は氏名入りの文言(従来どおり・一字一句固定)", () => {
    expect(confirmReleaseMessage({ state: "held_by_other", holderName: "山田" })).toBe(
      "山田さんの編集を終わらせます。山田さんが今入力している内容は失われ、保存されません。山田さんの画面は、この先5分間は保存できません(5分経つと、この記録はまた誰でも編集を始められる状態に戻ります)。",
    );
  });

  it("自分の別画面は氏名を使わない自然な文言にする(発注者裁定・一字一句固定)", () => {
    expect(confirmReleaseMessage({ state: "held_by_self_other_screen", holderName: undefined })).toBe(
      "あなたの別の画面での編集を終わらせます。その画面で入力している内容は失われ、保存されません。その画面は、この先5分間は保存できません(5分経つと、この記録はまた誰でも編集を始められる状態に戻ります)。",
    );
  });
});

describe("activeNotice(通知の有効性を判定する純関数・review Important #4)", () => {
  const r = row();

  it("通知が無ければ出さない", () => {
    expect(activeNotice(null, null, r)).toBeNull();
  });

  it("通知はあっても対応する行が無ければ出さない", () => {
    expect(activeNotice("状況が変わりました。表示を更新します", null, r)).toBeNull();
  });

  it("行の識別子(対象+ID+状態)が一致すれば出す", () => {
    expect(activeNotice("msg", noticeRowKey(r), r)).toBe("msg");
  });

  it("対象IDが違えば出さない(古い行の通知を引き継がない)", () => {
    expect(activeNotice("msg", noticeRowKey({ ...r, resourceId: "other" }), r)).toBeNull();
  });

  it("状態だけ違っても出さない", () => {
    expect(activeNotice("msg", noticeRowKey({ ...r, state: "free" }), r)).toBeNull();
  });

  it("対象・状態が同じでも lockId が違えば出さない(別の保持者に入れ替わっている・review round2 Important)", () => {
    expect(activeNotice("msg", noticeRowKey({ ...r, lockId: "l2" }), r)).toBeNull();
  });

  it("lockId まで一致すれば出す(取り違えていないこと自体も確認)", () => {
    expect(activeNotice("msg", noticeRowKey({ ...r, lockId: r.lockId }), r)).toBe("msg");
  });
});

describe("EditLockHolderBanner の配線(source assertion・node環境では実描画で確かめられないため)", () => {
  const src = readFileSync(
    resolve(process.cwd(), "src/components/edit-lock/edit-lock-banner.tsx"),
    "utf8",
  );

  it("release は row・onReleased・setNotice をそのまま渡して作る", () => {
    expect(src).toContain("createForceReleaseHandler({ row, onReleased, setNotice })");
  });

  it("承諾ボタンの後始末は release・setBusy・setConfirmOpen・setNotice をそのまま渡して作る", () => {
    expect(src).toContain("createConfirmReleaseHandler({ release, setBusy, setConfirmOpen, setNotice })");
  });

  it("ConfirmDialog の onConfirm には配線した後始末をそのまま渡す(inline の即席処理にしない)", () => {
    expect(src).toContain("onConfirm={confirmRelease}");
  });

  it("確認ダイアログの本文は confirmReleaseMessage(row) をそのまま使う(文言のコピーを二重に持たない)", () => {
    expect(src).toContain("message={confirmReleaseMessage(row)}");
  });
});

describe("解除の確認ダイアログの文言", () => {
  it("氏名入りの確認文を一字一句固定する", async () => {
    const { ConfirmDialog } = await import("@/components/ui/confirm-dialog");
    const message = confirmReleaseMessage({ state: "held_by_other", holderName: "山田" });
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

  it("自分の別画面の確認文を一字一句固定する(review Important #3)", async () => {
    const { ConfirmDialog } = await import("@/components/ui/confirm-dialog");
    const message = confirmReleaseMessage({ state: "held_by_self_other_screen", holderName: undefined });
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
      "あなたの別の画面での編集を終わらせます。その画面で入力している内容は失われ、保存されません。その画面は、この先5分間は保存できません(5分経つと、この記録はまた誰でも編集を始められる状態に戻ります)。",
    );
  });
});
