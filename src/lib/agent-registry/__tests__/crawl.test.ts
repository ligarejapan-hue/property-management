import { describe, it, expect } from "vitest";
import {
  AUTHORITIES,
  crawlStep,
  cycleOf,
  inNightWindow,
  nextNightStart,
  type CrawlState,
  type CrawlStore,
  type StepBudget,
} from "@/lib/agent-registry/crawl";
import { FetchError, type RegistryClient } from "@/lib/agent-registry/client";
import type { Detail, ListPage, ListRow } from "@/lib/agent-registry/parse";

// ---- 偽の先方(行政庁ごとにページの配列) ----
type Site = Record<string, ListRow[][]>;

function row(key: string, name = `会社${key}`, address = `住所${key}`): ListRow {
  return { licenseKey: key, authority: key.slice(0, 2), licenseLabel: `L${key}`, companyName: name, address, isMain: true };
}

/** 5行政庁×2ページ×1社の小さな先方。 */
function smallSite(): Site {
  const s: Site = {};
  for (const a of AUTHORITIES) s[a] = [[row(`${a}000001`)], [row(`${a}000002`)]];
  return s;
}

function fakeClient(
  site: Site,
  opts: { failAt?: Set<number>; failKind?: FetchError["kind"]; brokenDetail?: string } = {},
) {
  let n = 0;
  const log: string[] = [];
  const hit = (what: string) => {
    n++;
    log.push(what);
    if (opts.failAt?.has(n)) throw new FetchError(opts.failKind ?? "http_5xx");
    if (opts.brokenDetail && what === `detail ${opts.brokenDetail}`) throw new FetchError("layout");
  };
  // 本物の client と同じく、ページ数より先のページは空の結果を返す。
  const page = (a: string, p: number): ListPage => {
    const pages = site[a] ?? [];
    return { total: pages.flat().length, pages: pages.length, page: pages.length ? p : 0, rows: pages[p - 1] ?? [] };
  };
  const client: RegistryClient = {
    async searchFirst(a) {
      hit(`list ${a} 1`);
      return page(a, 1);
    },
    async selectPage(a, p) {
      hit(`list ${a} ${p}`);
      return page(a, p);
    },
    async detail(key): Promise<Detail> {
      hit(`detail ${key}`);
      return { licenseKey: key, companyKana: `カナ${key}`, address: `住所${key}`, phone: `03-${key.slice(-4)}`, validUntil: null };
    },
    get requestCount() {
      return n;
    },
  };
  return { client, log };
}

// ---- メモリ上の保存 ----
type Rec = ListRow & {
  listed: boolean;
  seenCycle: string | null;
  needsDetail: boolean;
  detailAt: Date | null;
  detailFailCount: number;
  phone: string | null;
  companyKana: string | null;
};

function memoryStore() {
  let states: CrawlState[] = [];
  const recs = new Map<string, Rec>();
  const store: CrawlStore = {
    async loadStates() {
      return states.map((s) => ({ ...s }));
    },
    async saveStates(next) {
      states = next.map((s) => ({ ...s }));
    },
    async upsertListRows(rows, cycle) {
      for (const r of rows) {
        const prev = recs.get(r.licenseKey);
        const changed =
          !prev || prev.companyName !== r.companyName || prev.address !== r.address || prev.licenseLabel !== r.licenseLabel;
        recs.set(r.licenseKey, {
          ...(prev ?? { phone: null, companyKana: null, detailAt: null, detailFailCount: 0 }),
          ...r,
          listed: true,
          seenCycle: cycle,
          needsDetail: changed ? true : prev!.needsDetail,
          detailFailCount: prev && prev.seenCycle === cycle ? prev.detailFailCount : 0,
        } as Rec);
      }
      return rows.length;
    },
    async nextNeedingDetail(cycle, limit) {
      return [...recs.values()]
        .filter((r) => r.needsDetail && r.listed && r.seenCycle === cycle && r.detailFailCount < 3)
        .sort((a, b) => a.detailFailCount - b.detailFailCount || a.licenseKey.localeCompare(b.licenseKey))
        .map((r) => r.licenseKey)
        .slice(0, limit);
    },
    async markDetailFailed(key) {
      const r = recs.get(key)!;
      recs.set(key, { ...r, detailFailCount: r.detailFailCount + 1 });
    },
    async saveDetail(d, at) {
      const r = recs.get(d.licenseKey)!;
      recs.set(d.licenseKey, { ...r, phone: d.phone, companyKana: d.companyKana, needsDetail: false, detailAt: at, detailFailCount: 0 });
    },
    async closeCycle(cycle) {
      let n = 0;
      for (const [k, r] of recs) {
        if (r.listed && r.seenCycle !== cycle) {
          recs.set(k, { ...r, listed: false });
          n++;
        }
      }
      return n;
    },
  };
  return { store, recs, getStates: () => states };
}

// 日本時間 2026-10-05 23:00 = UTC 14:00
const NIGHT = new Date("2026-10-05T14:00:00Z");
const BIG: StepBudget = { deadlineMs: 60 * 60 * 1000, maxRequests: 10_000 };

function clockAt(start: Date) {
  let t = start.getTime();
  return { now: () => new Date(t), advance: (ms: number) => (t += ms), set: (d: Date) => (t = d.getTime()) };
}

describe("夜間の判定・一巡の名前", () => {
  it("日本時間 22:00〜翌7:00 だけ", () => {
    expect(inNightWindow(new Date("2026-10-05T12:59:00Z"))).toBe(false); // 21:59
    expect(inNightWindow(new Date("2026-10-05T13:00:00Z"))).toBe(true); // 22:00
    expect(inNightWindow(new Date("2026-10-05T21:59:00Z"))).toBe(true); // 翌6:59
    expect(inNightWindow(new Date("2026-10-05T22:00:00Z"))).toBe(false); // 翌7:00
  });
  it("一巡は日本時間の年月・次の晩の始まり", () => {
    expect(cycleOf(new Date("2026-10-31T15:30:00Z"))).toBe("2026-11"); // JST 11/1 0:30
    expect(nextNightStart(new Date("2026-10-05T14:00:00Z")).toISOString()).toBe("2026-10-06T13:00:00.000Z"); // 23時→翌22時
    expect(nextNightStart(new Date("2026-10-05T18:00:00Z")).toISOString()).toBe("2026-10-06T13:00:00.000Z"); // 3時→その日の22時
  });
});

describe("進め方", () => {
  it("夜間の外は先方に1回もアクセスしない", async () => {
    const { client, log } = fakeClient(smallSite());
    const { store } = memoryStore();
    const r = await crawlStep({ client, store, now: () => new Date("2026-10-05T03:00:00Z"), budget: BIG });
    expect(r.stopped).toBe("outside_window");
    expect(log).toEqual([]);
  });

  it("一覧(5行政庁の全ページ)→詳細→一巡の締め、の順に最後まで進む", async () => {
    const { client, log } = fakeClient(smallSite());
    const { store, recs, getStates } = memoryStore();
    const r = await crawlStep({ client, store, now: () => NIGHT, budget: BIG });
    expect(r.stopped).toBeNull();
    expect(log.slice(0, 10)).toEqual(AUTHORITIES.flatMap((a) => [`list ${a} 1`, `list ${a} 2`]));
    expect(log.slice(10)).toEqual([...recs.keys()].sort().map((k) => `detail ${k}`));
    expect(recs.size).toBe(10);
    for (const rec of recs.values()) {
      expect(rec.listed).toBe(true);
      expect(rec.needsDetail).toBe(false);
      expect(rec.phone).not.toBeNull();
    }
    expect(getStates().every((s) => s.phase === "done" && s.cycle === "2026-10")).toBe(true);
    // 同じ月のうちは、もう何もしない
    const again = await crawlStep({ client, store, now: () => NIGHT, budget: BIG });
    expect(again.requests).toBe(0);
  });

  it("★一覧の途中で失敗 → その回は止まり、次の回は同じページから", async () => {
    const { client, log } = fakeClient(smallSite(), { failAt: new Set([4]) }); // 4回目=13 の2ページ目
    const { store } = memoryStore();
    const r1 = await crawlStep({ client, store, now: () => NIGHT, budget: BIG });
    expect(r1.stopped).toBe("http_5xx");
    expect(log).toEqual(["list 00 1", "list 00 2", "list 13 1", "list 13 2"]);
    await crawlStep({ client, store, now: () => NIGHT, budget: BIG });
    expect(log[4]).toBe("list 13 2");
  });

  it("★詳細の途中で予算切れ → 次の回は取り終えた会社を取り直さない", async () => {
    const { client, log } = fakeClient(smallSite());
    const { store } = memoryStore();
    await crawlStep({ client, store, now: () => NIGHT, budget: { ...BIG, maxRequests: 13 } });
    const firstDetails = log.filter((l) => l.startsWith("detail"));
    expect(firstDetails).toHaveLength(3);
    await crawlStep({ client, store, now: () => NIGHT, budget: BIG });
    const all = log.filter((l) => l.startsWith("detail"));
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(10);
  });

  it("予算の時間切れでも止まる(先方を叩き続けない)", async () => {
    const site = smallSite();
    const { log } = fakeClient(site);
    const clock = clockAt(NIGHT);
    const slow: RegistryClient = (() => {
      const base = fakeClient(site);
      return {
        searchFirst: async (a) => {
          clock.advance(5000);
          return base.client.searchFirst(a);
        },
        selectPage: async (a, p) => {
          clock.advance(5000);
          return base.client.selectPage(a, p);
        },
        detail: async (k) => {
          clock.advance(5000);
          return base.client.detail(k);
        },
        get requestCount() {
          return base.client.requestCount;
        },
      };
    })();
    void log;
    const { store } = memoryStore();
    const r = await crawlStep({ client: slow, store, now: clock.now, budget: { deadlineMs: 12_000, maxRequests: 1000 } });
    expect(r.stopped).toBe("budget");
    expect(r.requests).toBe(3);
  });

  it("★途中で止まった一巡では「一覧に無い」にしない・最後まで終えた一巡で見なかった会社だけ", async () => {
    const site = smallSite();
    const { client } = fakeClient(site);
    const { store, recs } = memoryStore();
    await crawlStep({ client, store, now: () => NIGHT, budget: BIG }); // 10月の一巡を終える
    // 11月: 13000002 が廃業して一覧から消えた
    site["13"] = [[row("13000001")]];
    const nov = new Date("2026-11-05T14:00:00Z");
    const c2 = fakeClient(site, { failAt: new Set([8]) }); // 一覧の途中(14 の2ページ目)で止まる
    const r = await crawlStep({ client: c2.client, store, now: () => nov, budget: BIG });
    expect(r.stopped).toBe("http_5xx");
    expect(recs.get("13000002")!.listed).toBe(true);
    await crawlStep({ client: c2.client, store, now: () => nov, budget: BIG });
    expect(recs.get("13000002")!.listed).toBe(false);
    expect([...recs.values()].filter((x) => !x.listed)).toHaveLength(1);
  });

  it("★一巡の途中で月が変わったら、前の一巡を終えてから次の一巡へ", async () => {
    const { client } = fakeClient(smallSite());
    const { store, getStates } = memoryStore();
    await crawlStep({ client, store, now: () => new Date("2026-10-31T14:00:00Z"), budget: { ...BIG, maxRequests: 3 } });
    expect(getStates()[0].cycle).toBe("2026-10");
    const nov = new Date("2026-11-01T14:00:00Z");
    await crawlStep({ client, store, now: () => nov, budget: BIG });
    expect(getStates().every((s) => s.cycle === "2026-10" && s.phase === "done")).toBe(true);
    await crawlStep({ client, store, now: () => nov, budget: { ...BIG, maxRequests: 1 } });
    expect(getStates().every((s) => s.cycle === "2026-11")).toBe(true);
  });

  it("★3回続けて失敗したら、その晩はもう動かない・翌晩は動く", async () => {
    const { client, log } = fakeClient(smallSite(), { failAt: new Set([1, 2, 3]) });
    const { store } = memoryStore();
    for (let i = 0; i < 3; i++) await crawlStep({ client, store, now: () => NIGHT, budget: BIG });
    expect(log).toHaveLength(3);
    const r = await crawlStep({ client, store, now: () => new Date(NIGHT.getTime() + 60 * 60 * 1000), budget: BIG });
    expect(r.stopped).toBe("day_off");
    expect(log).toHaveLength(3);
    const tomorrow = await crawlStep({ client, store, now: () => new Date("2026-10-06T13:10:00Z"), budget: BIG });
    expect(tomorrow.stopped).toBeNull();
    expect(log.length).toBeGreaterThan(3);
  });

  it("client が夜間の外で止めた(outside_window)は失敗に数えない・次の晩は続きから", async () => {
    const { client, log } = fakeClient(smallSite(), { failAt: new Set([3]), failKind: "outside_window" });
    const { store, getStates } = memoryStore();
    const r = await crawlStep({ client, store, now: () => NIGHT, budget: BIG });
    expect(r.stopped).toBe("outside_window");
    expect(getStates().every((s) => s.failStreak === 0 && s.dayOffUntil === null)).toBe(true);
    await crawlStep({ client, store, now: () => NIGHT, budget: BIG });
    expect(log[3]).toBe("list 13 1");
  });

  it("成功すると失敗の回数は0に戻る(とびとびの失敗では止まらない)", async () => {
    const { client } = fakeClient(smallSite(), { failAt: new Set([1, 3, 5]) });
    const { store, getStates } = memoryStore();
    for (let i = 0; i < 3; i++) await crawlStep({ client, store, now: () => NIGHT, budget: BIG });
    expect(getStates().every((s) => s.dayOffUntil === null)).toBe(true);
  });

  it("先方が別のページを返した(ページ番号が合わない)→ 推測せず layout で止める", async () => {
    const { client } = fakeClient(smallSite());
    const wrong: RegistryClient = {
      ...client,
      searchFirst: client.searchFirst,
      selectPage: async (a, p) => ({ ...(await client.selectPage(a, p)), page: p + 1 }),
      detail: client.detail,
      get requestCount() {
        return client.requestCount;
      },
    };
    const { store } = memoryStore();
    const r = await crawlStep({ client: wrong, store, now: () => NIGHT, budget: BIG });
    expect(r.stopped).toBe("layout");
  });

  it("★詳細がいつも読めない会社が1社あっても、ほかの会社は進み、一巡は終わる(その会社だけ3回で諦める)", async () => {
    const { client, log } = fakeClient(smallSite(), { brokenDetail: "13000001" });
    const { store, recs, getStates } = memoryStore();
    for (let night = 0; night < 3; night++) {
      const at = new Date(NIGHT.getTime() + night * 24 * 60 * 60 * 1000);
      for (let i = 0; i < 6; i++) await crawlStep({ client, store, now: () => at, budget: BIG });
    }
    expect(getStates().every((s) => s.phase === "done")).toBe(true);
    expect(recs.get("13000001")!.needsDetail).toBe(true);
    expect([...recs.values()].filter((r) => r.phone !== null)).toHaveLength(9);
    expect(log.filter((l) => l === "detail 13000001")).toHaveLength(3);
  });

  it("★止まっている間にページ数が減った → その行政庁を1ページ目から読み直す(前のページへずれた会社を消さない・@codex #477)", async () => {
    const site = smallSite();
    site["13"] = [[row("13000001")], [row("13000002")], [row("13000003")]];
    const { client, log } = fakeClient(site);
    const { store, recs, getStates } = memoryStore();
    await crawlStep({ client, store, now: () => NIGHT, budget: BIG }); // 10月の一巡を終える
    const nov = new Date("2026-11-05T14:00:00Z");
    await crawlStep({ client, store, now: () => nov, budget: { ...BIG, maxRequests: 4 } }); // 00 の2ページ+13 の2ページ
    expect(getStates().find((s) => s.authority === "13")!.nextPage).toBe(3);
    // 13000001 が廃業 → 残りが前へずれ、13000003 は(読み終えた)2ページ目へ移った
    site["13"] = [[row("13000002")], [row("13000003")]];
    const before = log.length;
    const r = await crawlStep({ client, store, now: () => nov, budget: BIG });
    expect(r.stopped).toBeNull();
    expect(log.slice(before, before + 3)).toEqual(["list 13 3", "list 13 1", "list 13 2"]);
    expect(getStates().every((s) => s.phase === "done")).toBe(true);
    expect(recs.get("13000003")!.listed).toBe(true); // ずれた会社は消さない(読み直さなければ消えていた)
    // 廃業した 13000001 は、この一巡の前半(1ページ目)で読んでいるので、消えるのは次の一巡の締め。
  });

  it("★行政庁の件数が0(メンテナンス画面など)→ 推測せず layout で止め、だれも「一覧に無い」にしない", async () => {
    const site = smallSite();
    const { client } = fakeClient(site);
    const { store, recs } = memoryStore();
    await crawlStep({ client, store, now: () => NIGHT, budget: BIG });
    site["13"] = [];
    const nov = new Date("2026-11-05T14:00:00Z");
    const r = await crawlStep({ client: fakeClient(site).client, store, now: () => nov, budget: BIG });
    expect(r.stopped).toBe("layout");
    expect([...recs.values()].every((x) => x.listed)).toBe(true);
  });

  it("★失敗する位置を総当たり: どこで止まっても、続けて回せば失敗なしと同じ結果・詳細の二重取得なし", async () => {
    const baseline = memoryStore();
    await crawlStep({ client: fakeClient(smallSite()).client, store: baseline.store, now: () => NIGHT, budget: BIG });
    const want = JSON.stringify([...baseline.recs.entries()].sort().map(([k, r]) => [k, r.listed, r.needsDetail, r.phone]));
    const totalRequests = 20;
    for (let failAt = 1; failAt <= totalRequests; failAt++) {
      const { client, log } = fakeClient(smallSite(), { failAt: new Set([failAt]) });
      const m = memoryStore();
      for (let i = 0; i < 5; i++) await crawlStep({ client, store: m.store, now: () => NIGHT, budget: BIG });
      const got = JSON.stringify([...m.recs.entries()].sort().map(([k, r]) => [k, r.listed, r.needsDetail, r.phone]));
      expect(got, `failAt=${failAt}`).toBe(want);
      const okDetails = log.filter((l, i) => l.startsWith("detail") && i + 1 !== failAt);
      expect(new Set(okDetails).size, `failAt=${failAt}`).toBe(okDetails.length);
      expect(m.getStates().every((s) => s.phase === "done"), `failAt=${failAt}`).toBe(true);
    }
  });
});
