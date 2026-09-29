"use client";

/**
 * 右上のベルの結線(通知 段階1)。見た目は `components/ui/notification-panel.tsx`。
 * 開くと件数の丸は消える(開いた時点の未確認は、閉じるまで背景色で残す)。
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BellButton,
  NotificationPanel,
  type NotificationPanelItem,
} from "@/components/ui/notification-panel";
import { unreadNoticeCount, type Notice } from "@/lib/notifications/notice-store";
import { useNotices } from "./notice-provider";

function formatMeta(n: Notice, now: Date): string {
  const d = new Date(n.at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const day = sameDay ? hm : d.toDateString() === yesterday.toDateString() ? `昨日 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  return n.context ? `${n.context} ・ ${day}` : day;
}

export function toPanelItem(n: Notice, highlighted: boolean, now: Date): NotificationPanelItem {
  return {
    id: n.id,
    icon: n.kind === "edit_lock_warn" ? "clock" : n.kind === "edit_lock_lost" ? "unlock" : "logout",
    tone: n.kind === "edit_lock_lost" ? "red" : "amber",
    message: n.message,
    meta: formatMeta(n, now),
    unread: highlighted,
    href: n.url,
  };
}

function isSmartphone(): boolean {
  return typeof navigator !== "undefined" && /iPhone|Android.+Mobile/i.test(navigator.userAgent);
}

export function HeaderBell() {
  const { notices, markAllRead, permission, requestPermission } = useNotices();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const [requesting, setRequesting] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setHighlight(new Set(notices.filter((n) => !n.read).map((n) => n.id)));
    if (unreadNoticeCount(notices) > 0) markAllRead();
    setOpen(true);
  };

  const now = new Date();
  const items = notices.map((n) => toPanelItem(n, highlight.has(n.id), now));

  return (
    <div ref={wrapRef} className="relative">
      <BellButton unreadCount={unreadNoticeCount(notices)} open={open} onClick={toggle} />
      {open && (
        <NotificationPanel
          items={items}
          permission={permission}
          deviceLabel={isSmartphone() ? "このスマホ" : "この PC"}
          requesting={requesting}
          onMarkAllRead={() => {
            markAllRead();
            setHighlight(new Set());
          }}
          onItemClick={(item) => {
            setOpen(false);
            if (item.href && item.href !== window.location.pathname) router.push(item.href);
          }}
          onRequestPermission={async () => {
            setRequesting(true);
            try {
              await requestPermission();
            } finally {
              setRequesting(false);
            }
          }}
        />
      )}
    </div>
  );
}
