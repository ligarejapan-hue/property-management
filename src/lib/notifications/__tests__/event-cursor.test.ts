import { describe, it, expect } from "vitest";
import { advanceCursor, afterCursorWhere, compareCursor, rereadWhere } from "../event-cursor";

const t = (iso: string) => new Date(iso);
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

describe("カーソルの比べ方(時刻と ID の組)", () => {
  it("時刻が先・同じ時刻なら ID", () => {
    expect(compareCursor({ t: t("2026-10-02T00:00:00.001Z"), i: A }, { t: t("2026-10-02T00:00:00.000Z"), i: B })).toBe(1);
    expect(compareCursor({ t: t("2026-10-02T00:00:00.000Z"), i: A }, { t: t("2026-10-02T00:00:00.000Z"), i: B })).toBe(-1);
    expect(compareCursor({ t: t("2026-10-02T00:00:00.000Z"), i: B.toUpperCase() }, { t: t("2026-10-02T00:00:00.000Z"), i: B })).toBe(0);
  });
  it("次のカーソルは戻さない(読み直し範囲の古い行だけが返っても動かない)", () => {
    const cur = { t: t("2026-10-02T00:05:00Z"), i: A };
    expect(advanceCursor(cur, [])).toBe(cur);
    expect(advanceCursor(cur, [{ t: t("2026-10-02T00:01:00Z"), i: B }])).toBe(cur);
    const later = { t: t("2026-10-02T00:06:00Z"), i: A };
    expect(advanceCursor(cur, [{ t: t("2026-10-02T00:05:30Z"), i: B }, later])).toBe(later);
  });
});

describe("条件(既存の一覧の向きとは逆)", () => {
  const c = { t: t("2026-10-02T00:05:00.000Z"), i: A };
  it("① カーソルより後 = t > ct または (t = ct かつ id > ci)。同じミリ秒の2件目も拾う", () => {
    expect(afterCursorWhere("submittedAt", c)).toEqual({
      OR: [{ submittedAt: { gt: c.t } }, { submittedAt: c.t, id: { gt: A } }],
    });
  });
  it("② 読み直し = 5分前から (t, id) <= カーソル", () => {
    expect(rereadWhere("completedAt", c)).toEqual({
      completedAt: { gte: t("2026-10-02T00:00:00.000Z") },
      OR: [{ completedAt: { lt: c.t } }, { completedAt: c.t, id: { lte: A } }],
    });
  });
});
