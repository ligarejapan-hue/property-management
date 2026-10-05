import { vi } from "vitest";
import type { BuildingLinkTx } from "@/lib/building-link/apply";

export interface FakeBuilding {
  id: string; name: string; address: string;
  nameKey: string | null; areaKey: string | null;
  createdAt: Date; createdBy: string;
}
export interface FakeProperty { id: string; buildingId: string | null; buildingName: string | null }
export interface FakeAuditLog {
  userId: string | null; action: string; targetTable: string | null; targetId: string | null; detail: unknown;
}
/** auditLogs: tx の中で書いた監査ログ(取込の目印。tx が巻き戻れば一緒に消える前提の行)。 */
export interface FakeDb { buildings: FakeBuilding[]; properties: FakeProperty[]; executed: string[]; auditLogs?: FakeAuditLog[] }

/** テンプレート文字列の SQL を、値を埋めた1本の文字列にする(検査用)。 */
function sqlText(strings: TemplateStringsArray, values: unknown[]): string {
  return strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""), "");
}

/**
 * applyBuildingLink が使う tx の口だけを、配列の上で写す。
 * ⚠apply.ts が新しい口を使ったら、ここにも足す(足さないとテストが TypeError で落ちて気づける)。
 * lock: 渡すと $executeRaw の advisory lock で順番待ちを写す(同時保存のテスト用)。
 */
export function createFakeBuildingTx(db: FakeDb, lock?: (key: string) => Promise<void>) {
  const fake = buildFake(db, lock);
  // ⚠Prisma の型を全部は満たさないので、apply に渡せる形へ寄せる(テストからは vi.fn も触れる)。
  return fake as unknown as typeof fake & BuildingLinkTx;
}

function buildFake(db: FakeDb, lock?: (key: string) => Promise<void>) {
  let seq = db.buildings.length;
  const count = (id: string) => db.properties.filter((p) => p.buildingId === id).length;
  const view = (b: FakeBuilding) => ({ ...b, _count: { properties: count(b.id) } });
  return {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sqlText(strings, values);
      db.executed.push(text);
      if (/pg_advisory_xact_lock/.test(text) && lock) await lock(String(values[0]));
      const skip = /UPDATE "buildings" SET "name_key" = (.*), "area_key" = (.*) WHERE "id" = \(SELECT/.exec(text);
      if (skip) {
        const id = String(values[2]);
        const b = db.buildings.find((x) => x.id === id && x.nameKey === null);
        if (b) {
          b.nameKey = values[0] as string | null;
          b.areaKey = values[1] as string | null;
          return 1;
        }
        return 0;
      }
      return 0;
    }),
    building: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const b = db.buildings.find((x) => x.id === where.id);
        return b ? view(b) : null;
      }),
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
        const rows = db.buildings.filter((b) =>
          Object.entries(where).every(([k, v]) => (b as unknown as Record<string, unknown>)[k] === v),
        );
        return rows.slice(0, take ?? rows.length).map(view);
      }),
      create: vi.fn(async ({ data }: { data: Omit<FakeBuilding, "id" | "createdAt"> }) => {
        seq += 1;
        const b: FakeBuilding = { id: `new-${seq}`, createdAt: new Date(2026, 9, 5, 0, 0, seq), ...data };
        db.buildings.push(b);
        return { id: b.id, name: b.name };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: FakeAuditLog }) => {
        (db.auditLogs ??= []).push(data);
        return { id: `log-${db.auditLogs.length}` };
      }),
    },
    property: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeProperty> }) => {
        const p = db.properties.find((x) => x.id === where.id);
        if (!p) throw new Error("property not found");
        Object.assign(p, data);
        return p;
      }),
    },
  };
}
