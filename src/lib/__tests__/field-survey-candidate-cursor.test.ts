/**
 * 完成待ち候補のページ送り (キーセット) の総当たり検証。
 *
 * 守りたいこと:
 *   1. where 断片と判定関数が**同じ意味**であること (片方だけ直すと崩れる)
 *   2. 読んでいる最中に行が消えても、**残った行が飛ばされない**こと
 *      (この一覧の存在意義=取りこぼし防止そのもの)
 *   3. 同時刻の行があっても順番が決まること
 */
import { describe, it, expect } from "vitest";
import {
  encodeCandidateCursor,
  decodeCandidateCursor,
  isAfterCandidateCursor,
  candidateKeysetWhere,
  type CandidateOrder,
  type CandidateCursor,
} from "@/lib/field-survey-candidate-cursor";

interface Row {
  id: string;
  createdAt: Date;
}

const ORDERS: CandidateOrder[] = ["newest", "oldest"];

/** テスト用の極小 Prisma where 評価器 (route が DB に投げる形をそのまま解釈)。 */
function matchesWhere(row: Row, where: ReturnType<typeof candidateKeysetWhere>) {
  if (!where) return true;
  return where.OR.some((clause) => {
    if ("createdAt" in clause && "lt" in (clause.createdAt as object)) {
      return row.createdAt.getTime() < (clause.createdAt as { lt: Date }).lt.getTime();
    }
    if ("createdAt" in clause && "gt" in (clause.createdAt as object)) {
      return row.createdAt.getTime() > (clause.createdAt as { gt: Date }).gt.getTime();
    }
    const and = (clause as { AND: [{ createdAt: Date }, { id: { lt?: string; gt?: string } }] }).AND;
    if (row.createdAt.getTime() !== and[0].createdAt.getTime()) return false;
    const idCond = and[1].id;
    return idCond.lt !== undefined ? row.id < idCond.lt : row.id > idCond.gt!;
  });
}

/**
 * route の orderBy と同じ 2 段の並べ替え。
 * newest = (createdAt, id) の降順 / oldest = 昇順。
 */
function sortRows(rows: Row[], order: CandidateOrder): Row[] {
  const asc = order === "oldest";
  return [...rows].sort((a, b) => {
    const d = a.createdAt.getTime() - b.createdAt.getTime();
    if (d !== 0) return asc ? d : -d;
    if (a.id === b.id) return 0;
    if (a.id < b.id) return asc ? -1 : 1;
    return asc ? 1 : -1;
  });
}

/** id は UUID 形式でないと decode を通らないので、連番から作る。 */
function uid(n: number): string {
  const h = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${h}`;
}

/** 同時刻を必ず含む小さな母集団 (時刻2種 × id4種)。 */
function buildRows(): Row[] {
  const t0 = new Date("2026-09-01T00:00:00.000Z");
  const t1 = new Date("2026-09-02T00:00:00.000Z");
  const out: Row[] = [];
  [t0, t1].forEach((t, ti) => {
    for (let i = 0; i < 4; i++) out.push({ id: uid(ti * 4 + i), createdAt: t });
  });
  return out;
}

describe("カーソルの読み書き", () => {
  it("往復して同じ値に戻る", () => {
    const c: CandidateCursor = {
      createdAt: new Date("2026-09-01T12:34:56.789Z"),
      id: uid(7),
    };
    const back = decodeCandidateCursor(encodeCandidateCursor(c));
    expect(back).not.toBeNull();
    expect(back!.id).toBe(c.id);
    expect(back!.createdAt.getTime()).toBe(c.createdAt.getTime());
  });

  it("壊れた指定は null (黙って先頭へ戻さない)", () => {
    const bad = [
      null,
      undefined,
      "",
      "   ",
      "_",
      "abc",
      "2026-09-01T00:00:00.000Z", // id が無い
      `_${uid(1)}`, // 日時が無い
      `2026-13-45T00:00:00.000Z_${uid(1)}`, // あり得ない日付
      "2026-09-01T00:00:00.000Z_not-a-uuid",
      `2026-09-01T00:00:00.000Z_${uid(1)}`.padEnd(300, "x"), // 長すぎ
    ];
    for (const b of bad) {
      expect(decodeCandidateCursor(b as string | null)).toBeNull();
    }
  });

  it("SQLらしき文字列を入れても null (そのままDBへ渡さない)", () => {
    expect(decodeCandidateCursor("' OR 1=1 --")).toBeNull();
    expect(decodeCandidateCursor("2026-09-01T00:00:00.000Z_'; DROP TABLE")).toBeNull();
  });
});

describe("where 断片と判定関数が一致する (総当たり)", () => {
  it("全ての行 × 全てのカーソル × 両方の並び順で同じ答えになる", () => {
    const rows = buildRows();
    let checked = 0;
    for (const order of ORDERS) {
      for (const cursorRow of rows) {
        const cursor: CandidateCursor = {
          createdAt: cursorRow.createdAt,
          id: cursorRow.id,
        };
        const where = candidateKeysetWhere(cursor, order);
        for (const row of rows) {
          expect(matchesWhere(row, where)).toBe(
            isAfterCandidateCursor(row, cursor, order),
          );
          checked++;
        }
      }
    }
    // 空振り防止: 実際に十分な回数を比べたことを固定する。
    expect(checked).toBe(rows.length * rows.length * ORDERS.length);
    expect(checked).toBeGreaterThan(100);
  });

  it("カーソル自身は次のページに入らない (同じ行を二度出さない)", () => {
    for (const order of ORDERS) {
      for (const r of buildRows()) {
        expect(isAfterCandidateCursor(r, { createdAt: r.createdAt, id: r.id }, order)).toBe(
          false,
        );
      }
    }
  });

  it("カーソル未指定なら絞り込まない", () => {
    for (const order of ORDERS) {
      expect(candidateKeysetWhere(null, order)).toBeUndefined();
    }
  });
});

/** ページ送りを実際に回す (pageSize ごとに where で絞って取る)。 */
function pageThrough(
  all: Row[],
  order: CandidateOrder,
  pageSize: number,
  onPage?: (seen: Row[]) => Row[],
): Row[] {
  let live = [...all];
  let cursor: CandidateCursor | null = null;
  const seen: Row[] = [];
  for (let guard = 0; guard < 100; guard++) {
    const where = candidateKeysetWhere(cursor, order);
    const page = sortRows(
      live.filter((r) => matchesWhere(r, where)),
      order,
    ).slice(0, pageSize);
    if (page.length === 0) break;
    seen.push(...page);
    const last = page[page.length - 1];
    cursor = { createdAt: last.createdAt, id: last.id };
    if (onPage) live = onPage(seen);
  }
  return seen;
}

describe("読んでいる最中に行が消えても飛ばさない", () => {
  it("何も消えなければ全件を順番どおり1回ずつ返す", () => {
    const rows = buildRows();
    for (const order of ORDERS) {
      for (const size of [1, 2, 3, 5, 8]) {
        const seen = pageThrough(rows, order, size);
        expect(seen.map((r) => r.id)).toEqual(sortRows(rows, order).map((r) => r.id));
      }
    }
  });

  it("1ページ読むたびに未読の行が1件消えても、残りは1件も飛ばない", () => {
    const rows = buildRows();
    for (const order of ORDERS) {
      for (const size of [1, 2, 3]) {
        const removed: string[] = [];
        const seen = pageThrough(rows, order, size, (already) => {
          const seenIds = new Set(already.map((r) => r.id));
          // まだ読んでいない行のうち、並びで最後のものを1件消す
          const rest = sortRows(rows, order).filter(
            (r) => !seenIds.has(r.id) && !removed.includes(r.id),
          );
          const victim = rest[rest.length - 1];
          if (victim) removed.push(victim.id);
          return rows.filter((r) => !removed.includes(r.id));
        });
        const seenIds = seen.map((r) => r.id);
        // 重複しない
        expect(new Set(seenIds).size).toBe(seenIds.length);
        // 消された行以外は全部見えている
        const expected = sortRows(rows, order)
          .map((r) => r.id)
          .filter((id) => !removed.includes(id));
        expect(seenIds).toEqual(expected);
      }
    }
  });

  it("直前に見た行そのものが消えても、続きから読める(位置を見失わない)", () => {
    const rows = buildRows();
    for (const order of ORDERS) {
      const sorted = sortRows(rows, order);
      // 3件目まで読んだ直後に、その3件目(=カーソルの行)が消えたとする
      const cursorRow = sorted[2];
      const cursor: CandidateCursor = {
        createdAt: cursorRow.createdAt,
        id: cursorRow.id,
      };
      const live = rows.filter((r) => r.id !== cursorRow.id);
      const where = candidateKeysetWhere(cursor, order);
      const next = sortRows(live.filter((r) => matchesWhere(r, where)), order);
      // 4件目以降がそのまま続く
      expect(next.map((r) => r.id)).toEqual(sorted.slice(3).map((r) => r.id));
    }
  });

  it("同時刻の行だけでもページ送りが止まらない(無限ループにならない)", () => {
    const t = new Date("2026-09-01T00:00:00.000Z");
    const rows: Row[] = Array.from({ length: 6 }, (_, i) => ({
      id: uid(i),
      createdAt: t,
    }));
    for (const order of ORDERS) {
      const seen = pageThrough(rows, order, 2);
      expect(seen.map((r) => r.id)).toEqual(sortRows(rows, order).map((r) => r.id));
    }
  });
});
