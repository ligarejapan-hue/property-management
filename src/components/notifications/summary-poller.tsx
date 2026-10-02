"use client";

/**
 * 通知 段階2(設計書 §5): 画面を開いている間、件数の窓口を取りに行き、次回対応・新しい査定の申込・
 * 謄本の一括取得の完了を知らせる。何も描かない(知らせは `NoticeProvider` のベル・ポップアップ・OS の通知)。
 *
 * - 見えているタブは60秒ごと、見えないタブは5分ごと。見える状態に戻ったらすぐ取りに行く。
 * - 判断は純関数 `decideSummaryNotices`。見た印とカーソルは `pm:notif-summary:v1:<利用者ID>`。
 * - 共用 PC: 後片付け(ログアウト・ログイン画面)の合図が変わったタブは、書かない・出さない
 *   (段階1と同じ守り)。後片付けは `clearNoticeStorage()` がこの保存値も消す。
 * - 複数のタブ: 判断と保存はベルと同じ Web Locks の中で順に行う(同じ知らせを2つのタブが出さない)。
 * - 取りに行くことは自動ログオフの延長に数えない(利用者の操作ではないため。セッションの延長を呼ばない)。
 */
import { useEffect } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { SUMMARY_STATE_PREFIX, readSummaryRaw, readSwitchMark, withNoticeLock, writeSummaryRaw } from "@/lib/notifications/notice-store";
import {
  decideSummaryNotices,
  parseSummaryState,
  resetCursors,
  summaryQuery,
  type SummaryNotice,
  type SummaryResponse,
  type SummaryState,
} from "@/lib/notifications/summary-state";
import type { ToastIcon, ToastTone } from "@/components/ui/toast-stack";
import { useNotices } from "./notice-provider";

export const SUMMARY_VISIBLE_INTERVAL_MS = 60_000;
export const SUMMARY_HIDDEN_INTERVAL_MS = 5 * 60_000;

export function summaryStateKey(userId: string): string {
  return `${SUMMARY_STATE_PREFIX}v1:${userId}`;
}

function loadState(userId: string): SummaryState {
  return parseSummaryState(readSummaryRaw(summaryStateKey(userId)), Date.now());
}

/** 保存できない環境では、この画面の間だけの控えに持つ(`notice-store.ts` の writeSummaryRaw)。 */
function saveState(userId: string, state: SummaryState): void {
  writeSummaryRaw(summaryStateKey(userId), JSON.stringify(state));
}

const LOOK: Record<SummaryNotice["kind"], { tone: ToastTone; icon: ToastIcon }> = {
  next_action: { tone: "amber", icon: "calendar" },
  inquiry_new: { tone: "indigo", icon: "inbox" },
  registry_job_done: { tone: "green", icon: "file" },
};

export function SummaryPoller() {
  const { data: session, status } = useSession();
  const userId = status === "authenticated" ? ((session?.user as { id?: string } | undefined)?.id ?? null) : null;
  const { notify, toast } = useNotices();

  useEffect(() => {
    if (!userId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    // このタブを開いた時点の後片付けの合図。違ってきたら、このタブは前の人のもの=何もしない。
    const mark = readSwitchMark();
    const switched = () => readSwitchMark() !== mark;

    const schedule = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      const wait = document.visibilityState === "hidden" ? SUMMARY_HIDDEN_INTERVAL_MS : SUMMARY_VISIBLE_INTERVAL_MS;
      timer = setTimeout(() => void tick(), wait);
    };

    const show = (n: SummaryNotice) => {
      notify({ kind: n.kind, tag: n.tag, title: n.title, body: n.body, url: n.url, osWhenHidden: true });
      if (document.visibilityState === "visible") {
        toast({
          ...LOOK[n.kind],
          title: n.title,
          body: n.body,
          action: (
            <Link href={n.url} className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
              開く
            </Link>
          ),
        });
      }
    };

    const tick = async () => {
      if (stopped || inFlight) return;
      if (switched()) {
        stopped = true;
        return;
      }
      inFlight = true;
      try {
        const qs = summaryQuery(loadState(userId));
        const res = await fetch(`/api/notifications/summary${qs ? `?${qs}` : ""}`, { cache: "no-store" });
        if (stopped) return;
        if (res.status === 400) {
          // カーソルが読めない(鍵が変わった等): 捨てて次から初回として取り直す。
          withNoticeLock(() => {
            if (stopped || switched()) return;
            saveState(userId, resetCursors(loadState(userId)));
          });
          return;
        }
        if (!res.ok) return;
        const body = (await res.json()) as SummaryResponse;
        withNoticeLock(() => {
          // 順番を待つ間に後片付けがあれば、書かない・出さない。
          if (stopped || switched()) return;
          const { state, notices } = decideSummaryNotices(loadState(userId), body, Date.now());
          saveState(userId, state);
          for (const n of notices) show(n);
        });
      } catch {
        /* 通信の失敗は次の回にまた取りに行く */
      } finally {
        inFlight = false;
        schedule();
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        if (timer) clearTimeout(timer);
        void tick();
      } else {
        schedule();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    // 画面を開いた直後に1回(次回対応の今の回はここで1回出ることがある=見落とし防止の側)。
    timer = setTimeout(() => void tick(), 0);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [userId, notify, toast]);

  return null;
}
