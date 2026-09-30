import { describe, expect, it } from "vitest";
import { toPanelItem } from "../header-bell";
import type { Notice } from "@/lib/notifications/notice-store";

const n = (over: Partial<Notice>): Notice => ({
  id: "1",
  kind: "edit_lock_lost",
  tag: "t",
  message: "m",
  at: new Date(2026, 8, 29, 14, 32).getTime(),
  read: false,
  ...over,
});

describe("toPanelItem", () => {
  const now = new Date(2026, 8, 29, 15, 0);
  it("種類ごとのアイコンと色", () => {
    expect(toPanelItem(n({ kind: "edit_lock_lost" }), false, now)).toMatchObject({ icon: "unlock", tone: "red" });
    expect(toPanelItem(n({ kind: "edit_lock_warn" }), false, now)).toMatchObject({ icon: "clock", tone: "amber" });
    expect(toPanelItem(n({ kind: "idle_logout_warn" }), false, now)).toMatchObject({ icon: "logout", tone: "amber" });
  });
  it("時刻は今日なら HH:mm、昨日なら「昨日」を付け、補足を前に置く", () => {
    expect(toPanelItem(n({ context: "物件の編集" }), true, now).meta).toBe("物件の編集 ・ 14:32");
    const y = new Date(2026, 8, 28, 17, 55).getTime();
    expect(toPanelItem(n({ at: y }), false, now).meta).toBe("昨日 17:55");
    const old = new Date(2026, 8, 25, 9, 5).getTime();
    expect(toPanelItem(n({ at: old }), false, now).meta).toBe("9/25 09:05");
  });
});
