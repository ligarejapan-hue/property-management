/**
 * ドライブの見回り 全体(第2段b): 接続の有無・物件ごとの順番・上限・失敗の記録。
 */
import { describe, it, expect } from "vitest";
import { DriveApiError } from "../client";
import { DriveAuthError } from "../oauth";
import { runDriveSync, type RunDeps } from "../sync-run";
import { emptyLinkResult, type LinkInfo } from "../sync-link";

const links: LinkInfo[] = [
  { id: "L1", propertyId: "P1", folderId: "F1" },
  { id: "L2", propertyId: "P2", folderId: "F2" },
  { id: "L3", propertyId: "P3", folderId: "F3" },
];

function deps(over: Partial<RunDeps> = {}) {
  const saved: Array<{ ok: boolean; error: string | null }> = [];
  const visited: string[] = [];
  const d: RunDeps = {
    async loadConnection() {
      return { connected: true, uploaderId: "U1" };
    },
    async loadLinks() {
      return links;
    },
    async getDrive() {
      return {} as never;
    },
    makeRepo: () => ({}) as never,
    async syncLink(_d, _r, link, budget) {
      visited.push(link.id);
      budget.transfers -= 1;
      return { ...emptyLinkResult(), imported: 1 };
    },
    async saveStatus(s) {
      saved.push(s);
    },
    ...over,
  };
  return { d, saved, visited };
}

describe("runDriveSync", () => {
  it("つながっていなければ何もしない(状態も書かない)", async () => {
    const { d, saved, visited } = deps({ loadConnection: async () => ({ connected: false, uploaderId: null }) });
    expect(await runDriveSync(d, { budget: 20, startAt: 0 })).toMatchObject({ skipped: "not_connected" });
    expect(saved).toEqual([]);
    expect(visited).toEqual([]);
  });

  it("全物件を回り、件数を足して、成功を記録", async () => {
    const { d, saved, visited } = deps();
    const r = await runDriveSync(d, { budget: 20, startAt: 0 });
    expect(visited).toEqual(["L1", "L2", "L3"]);
    expect(r.totals.imported).toBe(3);
    expect(saved).toEqual([{ ok: true, error: null }]);
  });

  it("前回の続きの物件から回る(上限で毎回同じ物件だけにならない)", async () => {
    const { d, visited } = deps();
    await runDriveSync(d, { budget: 20, startAt: 2 });
    expect(visited).toEqual(["L3", "L1", "L2"]);
  });

  it("上限を使い切ったらそこで止め、次の開始位置を返す", async () => {
    const { d, visited } = deps();
    const r = await runDriveSync(d, { budget: 2, startAt: 0 });
    expect(visited).toEqual(["L1", "L2"]);
    expect(r.nextStartAt).toBe(2);
  });

  it("1物件の失敗(フォルダが消えた など)は数えて続け、一部失敗として記録", async () => {
    const { d, saved, visited } = deps({
      async syncLink(_d, _r, link, budget) {
        visited.push(link.id);
        budget.transfers--;
        if (link.id === "L2") throw new DriveApiError(404, "x");
        return emptyLinkResult();
      },
    });
    const r = await runDriveSync(d, { budget: 20, startAt: 0 });
    expect(visited).toEqual(["L1", "L2", "L3"]);
    expect(r.linkErrors).toBe(1);
    expect(saved).toEqual([{ ok: false, error: "一部のフォルダを読めませんでした(1件)" }]);
  });

  it("認可切れ(401・invalid_grant)は見回りを止めて「再接続が必要です」", async () => {
    const a = deps({
      async syncLink() {
        throw new DriveApiError(401, "x");
      },
    });
    await runDriveSync(a.d, { budget: 20, startAt: 0 });
    expect(a.saved).toEqual([{ ok: false, error: "Google ドライブへの再接続が必要です" }]);

    const b = deps({
      async getDrive() {
        throw new DriveAuthError("invalid_grant", "x");
      },
    });
    await runDriveSync(b.d, { budget: 20, startAt: 0 });
    expect(b.saved).toEqual([{ ok: false, error: "Google ドライブへの再接続が必要です" }]);
  });

  it("認可切れのときはメモリのアクセストークンも捨てる(次の見回りで取り直す)", async () => {
    let forgot = 0;
    const { d } = deps({
      async syncLink() {
        throw new DriveApiError(401, "x");
      },
      forgetToken: () => {
        forgot++;
      },
    });
    await runDriveSync(d, { budget: 20, startAt: 0 });
    expect(forgot).toBe(1);
  });

  it("クライアント設定(app.env)が無ければ休眠(状態も書かない)", async () => {
    const { d, saved } = deps({
      async getDrive() {
        throw new DriveAuthError("not_configured", "x");
      },
    });
    expect(await runDriveSync(d, { budget: 20, startAt: 0 })).toMatchObject({ skipped: "not_configured" });
    expect(saved).toEqual([]);
  });

  it("取り込みに使う人(接続した管理者)が無効なら止める", async () => {
    const { d, saved, visited } = deps({ loadConnection: async () => ({ connected: true, uploaderId: null }) });
    await runDriveSync(d, { budget: 20, startAt: 0 });
    expect(visited).toEqual([]);
    expect(saved).toEqual([{ ok: false, error: "接続した管理者が無効です。管理者がつなぎ直してください" }]);
  });
});
