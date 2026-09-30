/**
 * 通知 段階1 の配線を source で固定する(env=node・jsdom を使わない方針のため)。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(__dirname, "../../../", p), "utf-8");

describe("ログアウトの経路", () => {
  it("アプリのログアウトはすべて通知の後片付けを通す(next-auth の signOut を直接呼ばない)", () => {
    for (const p of [
      "components/layout/dashboard-layout.tsx",
      "components/auth/idle-session-guard.tsx",
      "app/(dashboard)/admin/change-password/page.tsx",
    ]) {
      const src = read(p);
      expect(src, p).not.toMatch(/\bsignOut\(\s*\{/);
      expect(src, p).toContain("signOutWithNotificationCleanup");
    }
  });
});

describe("自動ログオフの予告ダイアログ", () => {
  it("ダイアログの中の操作(ボタンへのマウス移動・タブ移動を含む)は活動(延長)に数えない", () => {
    const dialog = read("components/auth/idle-logout-dialog.tsx");
    expect(dialog).toMatch(/className=\{IDLE_WARNING_DIALOG_CLASS\}/);
    const guard = read("components/auth/idle-session-guard.tsx");
    expect(guard).toMatch(
      /const markActivity = \(e\?: Event\) => \{[\s\S]{0,500}closest\(`\.\$\{IDLE_WARNING_DIALOG_CLASS\}`\)\) return;/,
    );
    // 延長は「続ける」・Esc の明示の操作だけ(onContinue が活動の処理を直接呼ぶ)。
    expect(guard).toMatch(/onContinue=\{\(\) => activityHandlerRef\.current\(\)\}/);
    expect(dialog).toMatch(/onClose=\{onContinue\}/);
  });
});

describe("編集権限の知らせ", () => {
  it("戻った直後の合図で外れたと分かった場合も、戻ったときの知らせを出す", () => {
    const src = read("components/notifications/edit-lock-notices.tsx");
    expect(src).toContain("returnedAtRef.current = Date.now()");
    expect(src).toMatch(/justReturned[\s\S]*toast\(/);
  });

  it("物件・所有者の編集画面とも、保存前の入力の有無を渡す", () => {
    expect(read("components/properties/property-edit-form.tsx")).toContain("hasUnsavedInput={hasUnsavedInput}");
    expect(read("app/(dashboard)/properties/[id]/page.tsx")).toContain("hasUnsavedInput={hasUnsavedOwnerInput}");
  });
});

describe("共用 PC で前の人のまま開いていたタブ", () => {
  it("後片付けの合図(Service Worker の知らせ・storage)を受けたら、ベル・OS の通知・ポップアップのどれも出さない", () => {
    const src = read("components/notifications/notice-provider.tsx");
    expect(src).toMatch(/pm-switched"\) markSwitched\(\)/);
    expect(src).toMatch(/e\.key === NOTICE_SWITCH_KEY\) markSwitched\(\)/);
    expect(src).toMatch(/const notify = useCallback\(\(input: NotifyInput\) => \{[\s\S]{0,200}if \(switchedRef\.current\) return;/);
    expect(src).toMatch(/const toast = useCallback\(\(input: ToastInput\) => \{\s*if \(switchedRef\.current\) return;/);
  });

  it("後片付け(clearNoticeStorage)がほかのタブへの合図を書く", () => {
    const src = read("lib/notifications/notice-store.ts");
    expect(src).toMatch(/removeItem\(NOTICE_STORAGE_KEY\);\s*window\.localStorage\.setItem\(NOTICE_SWITCH_KEY/);
  });
});

describe("予告が出たあとで別の画面へ移ったとき", () => {
  it("自動ログオフの予告: 別の画面へ移ったときにもベル・OS の通知に1回出す", () => {
    const src = read("components/auth/idle-session-guard.tsx");
    expect(src).toMatch(/const onVisibility = \(\) => \{\s*if \(document\.visibilityState === "hidden"\) notifyBackgroundWarning\(\);/);
    expect(src).toMatch(/const notifyBackgroundWarning = \(\) => \{\s*if \(warnedRef\.current \|\| !warnActiveRef\.current\) return;\s*if \(document\.visibilityState !== "hidden"\) return;/);
  });

  it("編集権限の予告: 帯が出ている間に別の画面へ移ったらベル・OS の通知に出す", () => {
    const src = read("components/notifications/edit-lock-notices.tsx");
    expect(src).toMatch(/snap\.kind === "mine" && snap\.warnIdle && !warnNotifiedRef\.current/);
  });
});

describe("後片付けと書き込みが重なったとき", () => {
  it("書き込む直前に後片付けの合図を読み直し、変わっていれば書かない", () => {
    const src = read("components/notifications/notice-provider.tsx");
    expect(src).toMatch(/switchMarkRef\.current = readSwitchMark\(\);/);
    expect(src).toMatch(/if \(readSwitchMark\(\) !== switchMarkRef\.current\) \{[\s\S]{0,80}return;\s*\}\s*if \(input\.bell !== false\)/);
  });
});

describe("後片付けと書き込みの間に割り込まれたとき(@codex #462 P1)", () => {
  it("お知らせに書いたときの合図を付け、読む側は今の合図と違うものを出さない", () => {
    const provider = read("components/notifications/notice-provider.tsx");
    expect(provider).toMatch(/mark: switchMarkRef\.current/);
    // 前の人のタブからは既読化でも書き換えない。
    expect(provider).toMatch(/const markAllRead = useCallback\(\(\) => \{\s*[^\n]*\n\s*if \(switchedRef\.current \|\| readSwitchMark\(\) !== switchMarkRef\.current\) return;/);
    const store = read("lib/notifications/notice-store.ts");
    expect(store).toMatch(/noticesForMark\(memoryFallback, mark\)/);
    expect(store).toMatch(/const kept = noticesForMark\(source, mark\);/);
    expect(store).toMatch(/e\.key === NOTICE_SWITCH_KEY\) onChange\(\)/);
  });
});

describe("予告を取り下げたとき(@codex #462)", () => {
  it("自動ログオフ: 延長されたら出していた OS の通知を閉じる", () => {
    const src = read("components/auth/idle-session-guard.tsx");
    // ほかのタブが出した通知も閉じるため、予告中なら(このタブで出していなくても)閉じる。
    expect(src).toMatch(/const withdrawWarning = \(sharedWarn = false\) => \{\s*if \(sharedWarn \|\| warnedRef\.current \|\| warnActiveRef\.current\) withdrawRef\.current\(IDLE_WARN_TAG\);/);
    // 操作による延長では、共有の最終操作から見て予告の範囲だったら(このタブの判定が
    // 追いついていなくても)閉じる。ほかのタブの操作による取り下げでも通す。
    expect(src).toMatch(/withdrawWarning\(idlePhase\(now - prevLastActivity\) === "warn"\);/);
    expect(src.match(/withdrawWarning\(\);/g)?.length).toBe(1);
  });

  it("編集権限: 予告が終わったら出していた OS の通知を閉じる", () => {
    const src = read("components/notifications/edit-lock-notices.tsx");
    expect(src).toMatch(/withdraw\(`edit-lock:warn:\$\{resourceType\}:\$\{resourceId\}`\)/);
  });

  it("Service Worker は同じ順番待ちで、その印の通知だけを閉じる", () => {
    const sw = readFileSync(resolve(__dirname, "../../../../public/sw.js"), "utf-8");
    expect(sw).toMatch(/data\.type === "close"[\s\S]{0,200}enqueue\(/);
    expect(sw).toMatch(/getNotifications\(\{ tag: data\.tag \}\)[\s\S]{0,80}if \(isOurs\(n\) && n\.data\.gen === state\.gen\) n\.close\(\);/);
  });

  it("前の人のまま開いていたタブからは閉じない(タブ側と Service Worker 側の両方で世代を確かめる)", () => {
    const provider = read("components/notifications/notice-provider.tsx");
    expect(provider).toMatch(
      /const withdraw = useCallback\(\(tag: string\) => \{[\s\S]{0,200}if \(switchedRef\.current \|\| readSwitchMark\(\) !== switchMarkRef\.current\) return;\s*const gen = genRef\.current;\s*if \(gen === null\) return;\s*void closeOsNotification\(tag, gen\);/,
    );
    const sw = readFileSync(resolve(__dirname, "../../../../public/sw.js"), "utf-8");
    expect(sw).toMatch(/data\.type === "close"[\s\S]{0,600}if \(data\.gen !== state\.gen\) \{\s*reply\(\{ ok: false, stale: true \}\);/);
  });
});
