/**
 * 同じ所有者あての2通目を外す(2026-11-16 発注者決定)。
 * 決まり=登録がいちばん新しい送付可の物件の手紙だけ残す/宛先が残らなかった物件は DM判断を「送付不可」に。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Prop = { dmStatus: string; isArchived: boolean; ownerIds: string[]; version: number };
let props: Record<string, Prop>;
let sendLinks: Array<{ ownerId: string; propertyId: string; property: { createdAt: Date } }>;
let logs: Array<Record<string, unknown>>;
let lockedIds: Set<string>;
let failIds: Set<string>;
const lockCalls: string[] = [];

// 今回の対象に無い物件の所有者(resolveSecondLetters が読む)。住所で宛先を分ける。
let offProps: Record<string, Array<{ id: string; address: string }>>;
// 拒否・宛先不明など(terminal-exclusion.ts の集合)。
let terminalOwners: Set<string>;
let terminalProps: Set<string>;

const tx = {
  property: {
    findMany: vi.fn(async (a: { where: { id: { in: string[] } } }) =>
      a.where.id.in
        .filter((id) => offProps[id])
        .map((id) => ({
          id,
          propertyOwners: offProps[id].map((o, i) => ({
            isPrimary: i === 0,
            owner: { id: o.id, zip: null, address: o.address, currentZip: null, currentAddress: null },
          })),
        })),
    ),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const p = props[where.id];
      return p ? { dmStatus: p.dmStatus, isArchived: p.isArchived, propertyOwners: p.ownerIds.map((ownerId) => ({ ownerId })) } : null;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      if (failIds.has(where.id)) throw new Error("write failed");
      const p = props[where.id];
      p.dmStatus = data.dmStatus as string;
      if (data.version) p.version += 1;
    }),
  },
  // 送付可の物件のつながり。問い合わせた所有者の分だけ返す(本物と同じ)。
  propertyOwner: {
    findMany: vi.fn(async (a: { where: { ownerId: { in: string[] } } }) =>
      sendLinks.filter((l) => a.where.ownerId.in.includes(l.ownerId)),
    ),
  },
  changeLog: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      logs.push(data);
    }),
  },
};

vi.mock("@/lib/prisma", () => ({ default: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } }));
vi.mock("@/lib/property-record-guard", () => ({
  lockPropertyRow: vi.fn(async (_tx: unknown, id: string) => {
    lockCalls.push(id);
  }),
}));
vi.mock("@/lib/dm-batch/terminal-exclusion", async (orig) => ({
  ...(await orig<typeof import("@/lib/dm-batch/terminal-exclusion")>()),
  findTerminalExclusions: vi.fn(async () => ({
    ownerIds: terminalOwners,
    propertyIds: terminalProps,
    agentOwnerIds: new Set<string>(),
    gaijiOwnerIds: new Set<string>(),
  })),
}));
vi.mock("@/lib/edit-lock/service", () => ({
  isResourceEditLocked: vi.fn(async (_tx: unknown, t: { resourceId: string }) => lockedIds.has(t.resourceId)),
}));

import {
  keptPropertyByOwner,
  isSecondLetter,
  propertiesToDemote,
  pickSecondLetters,
  resolveSecondLetters,
  everyOwnerHasNewerProperty,
  SECOND_LETTER_MAX_HOPS,
  findSendPropertyLinks,
  type ResolveSecondLetterTx,
  findKeptPropertyByOwner,
  demoteSecondLetterProperties,
  type SecondLetterTx,
} from "../second-letter";

const d = (s: string) => new Date(s);

beforeEach(() => {
  vi.clearAllMocks();
  lockCalls.length = 0;
  logs = [];
  lockedIds = new Set();
  failIds = new Set();
  offProps = {};
  terminalOwners = new Set();
  terminalProps = new Set();
  props = {
    pOld: { dmStatus: "send", isArchived: false, ownerIds: ["o1"], version: 1 },
    pNew: { dmStatus: "send", isArchived: false, ownerIds: ["o1"], version: 1 },
  };
  sendLinks = [
    { ownerId: "o1", propertyId: "pOld", property: { createdAt: d("2026-01-01T00:00:00Z") } },
    { ownerId: "o1", propertyId: "pNew", property: { createdAt: d("2026-06-01T00:00:00Z") } },
  ];
});

describe("keptPropertyByOwner: 所有者ごとに、登録がいちばん新しい物件を残す", () => {
  it("新しいほうが残る(並びに関係なく)", () => {
    const links = [
      { ownerId: "o1", propertyId: "pNew", createdAt: d("2026-06-01T00:00:00Z") },
      { ownerId: "o1", propertyId: "pOld", createdAt: d("2026-01-01T00:00:00Z") },
      { ownerId: "o1", propertyId: "pMid", createdAt: d("2026-03-01T00:00:00Z") },
    ];
    expect(keptPropertyByOwner(links).get("o1")).toBe("pNew");
    expect(keptPropertyByOwner([...links].reverse()).get("o1")).toBe("pNew");
  });
  it("所有者ごとに別々に決める", () => {
    const kept = keptPropertyByOwner([
      { ownerId: "o1", propertyId: "p1", createdAt: d("2026-01-01T00:00:00Z") },
      { ownerId: "o1", propertyId: "p2", createdAt: d("2026-02-01T00:00:00Z") },
      { ownerId: "o2", propertyId: "p1", createdAt: d("2026-01-01T00:00:00Z") },
    ]);
    expect(kept.get("o1")).toBe("p2");
    expect(kept.get("o2")).toBe("p1");
  });
  it("登録日時が同じなら、毎回同じ物件(id の大きいほう)", () => {
    const a = { ownerId: "o1", propertyId: "pA", createdAt: d("2026-01-01T00:00:00Z") };
    const b = { ownerId: "o1", propertyId: "pB", createdAt: d("2026-01-01T00:00:00Z") };
    expect(keptPropertyByOwner([a, b]).get("o1")).toBe("pB");
    expect(keptPropertyByOwner([b, a]).get("o1")).toBe("pB");
  });
});

describe("isSecondLetter", () => {
  const kept = new Map([["o1", "pNew"], ["o2", "pOld"]]);
  it("残す物件の手紙は2通目ではない・ほかの物件の手紙は2通目", () => {
    expect(isSecondLetter(kept, { propertyId: "pNew", ownerIds: ["o1"] })).toBe(false);
    expect(isSecondLetter(kept, { propertyId: "pOld", ownerIds: ["o1"] })).toBe(true);
  });
  it("共有者の1人でも新しい物件を持っていれば、その宛先ごと2通目(同じ住所に新しい物件の手紙が届く)", () => {
    expect(isSecondLetter(kept, { propertyId: "pOld", ownerIds: ["o2", "o1"] })).toBe(true);
  });
  it("残す物件が分からない所有者は、外す理由にしない", () => {
    expect(isSecondLetter(kept, { propertyId: "pOld", ownerIds: ["o9"] })).toBe(false);
    expect(isSecondLetter(new Map(), { propertyId: "pOld", ownerIds: ["o1"] })).toBe(false);
  });
});

describe("propertiesToDemote: 宛先が1つも残らなかった物件だけ", () => {
  it("2通目で全部外れた物件を選ぶ", () => {
    expect(propertiesToDemote([{ propertyId: "p1", outcome: "second" }])).toEqual(["p1"]);
  });
  it("残った宛先がある物件は選ばない(住所の違う共有者には送る)", () => {
    expect(
      propertiesToDemote([
        { propertyId: "p1", outcome: "second" },
        { propertyId: "p1", outcome: "kept" },
      ]),
    ).toEqual([]);
  });
  it("ほかの理由(拒否など)で外れた宛先がある物件は選ばない(その人に新しい物件があるとは限らない)", () => {
    expect(
      propertiesToDemote([
        { propertyId: "p1", outcome: "second" },
        { propertyId: "p1", outcome: "other" },
        { propertyId: "p2", outcome: "other" },
      ]),
    ).toEqual([]);
  });
  it("所有者のつながりが変わっていた宛先がある物件は選ばない", () => {
    expect(
      propertiesToDemote([
        { propertyId: "p1", outcome: "second" },
        { propertyId: "p1", outcome: "unknown" },
      ]),
    ).toEqual([]);
  });
});

describe("pickSecondLetters: 新しい物件の手紙が実際に残るときだけ外す", () => {
  const link = (ownerId: string, propertyId: string, iso: string) => ({ ownerId, propertyId, createdAt: d(iso) });
  const L = (propertyId: string, ownerIds: string[], eligible = true) => ({ propertyId, ownerIds, eligible });

  it("同じ所有者の2物件: 新しいほうを残し、古いほうを外す(並びに関係なく)", () => {
    const links = [link("o1", "pOld", "2026-01-01T00:00:00Z"), link("o1", "pNew", "2026-06-01T00:00:00Z")];
    expect(pickSecondLetters([L("pOld", ["o1"]), L("pNew", ["o1"])], links)).toEqual([true, false]);
    expect(pickSecondLetters([L("pNew", ["o1"]), L("pOld", ["o1"])], links)).toEqual([false, true]);
  });
  it("新しい物件が今回の対象に無い → 届くものとして外す(売却DMは1回50通まで)", () => {
    const links = [link("o1", "pOld", "2026-01-01T00:00:00Z"), link("o1", "pNew", "2026-06-01T00:00:00Z")];
    expect(pickSecondLetters([L("pOld", ["o1"])], links)).toEqual([true]);
  });
  it("★共有者でつながる3物件: 新しい物件の手紙が外れるなら、古い物件は外さない(誰にも届かないのに外さない)", () => {
    // A(X と Y の共有)・B(X だけ・A より古い)・C(Y だけ・いちばん新しい)。
    const links = [
      link("x", "A", "2026-02-01T00:00:00Z"),
      link("y", "A", "2026-02-01T00:00:00Z"),
      link("x", "B", "2026-01-01T00:00:00Z"),
      link("y", "C", "2026-03-01T00:00:00Z"),
    ];
    const letters = [L("B", ["x"]), L("A", ["x", "y"]), L("C", ["y"])];
    // C は残る。A は Y の C があるので外れる。B は、X に届く新しい手紙が無い(A は外れた)ので残る。
    expect(pickSecondLetters(letters, links)).toEqual([false, true, false]);
  });
  it("新しい物件の宛先が拒否などで外れているなら、古い物件は外さない(その人に届く手紙が無くなるため)", () => {
    const links = [link("o1", "pOld", "2026-01-01T00:00:00Z"), link("o1", "pNew", "2026-06-01T00:00:00Z")];
    // pNew の宛先は物件単位の拒否で対象外(eligible=false)=2通目にも数えない。
    expect(pickSecondLetters([L("pOld", ["o1"]), L("pNew", ["o1"], false)], links)).toEqual([false, false]);
  });
  it("共有者の1人が新しい物件から届くなら、その宛先ごと外す。住所の違う共有者の宛先は残る", () => {
    const links = [
      link("o1", "p1", "2026-01-01T00:00:00Z"),
      link("o2", "p1", "2026-01-01T00:00:00Z"),
      link("o3", "p1", "2026-01-01T00:00:00Z"),
      link("o1", "pNew", "2026-06-01T00:00:00Z"),
    ];
    expect(pickSecondLetters([L("p1", ["o1", "o2"]), L("p1", ["o3"])], links)).toEqual([true, false]);
  });
  it("登録日時が同じ2物件は、片方だけ残す(毎回同じ=id の大きいほう)", () => {
    const links = [link("o1", "pA", "2026-01-01T00:00:00Z"), link("o1", "pB", "2026-01-01T00:00:00Z")];
    expect(pickSecondLetters([L("pA", ["o1"]), L("pB", ["o1"])], links)).toEqual([true, false]);
  });
  it("送付可の物件のつながりが引けない(空)なら、何も外さない", () => {
    expect(pickSecondLetters([L("p1", ["o1"]), L("p2", ["o1"])], [])).toEqual([false, false]);
  });
});

describe("resolveSecondLetters: 今回の対象に無い新しい物件も、手紙が本当に届くかを確かめる(@codex PR#741 1巡目)", () => {
  const rtx = tx as unknown as ResolveSecondLetterTx;
  const L = (propertyId: string, ownerIds: string[], eligible = true) => ({ propertyId, ownerIds, eligible });
  const lnk = (ownerId: string, propertyId: string, iso: string) => ({ ownerId, propertyId, property: { createdAt: d(iso) } });

  it("新しい物件(対象外)から届く → 古い物件の宛先は2通目", async () => {
    offProps = { pNew: [{ id: "o1", address: "東京都A" }] };
    expect(await resolveSecondLetters(rtx, [L("pOld", ["o1"])])).toEqual([true]);
  });
  it("★新しい物件(対象外)に物件単位の拒否がある → そこからは届かないので、古い物件は外さない", async () => {
    offProps = { pNew: [{ id: "o1", address: "東京都A" }] };
    terminalProps = new Set(["pNew"]);
    expect(await resolveSecondLetters(rtx, [L("pOld", ["o1"])])).toEqual([false]);
  });
  it("★新しい物件(対象外)で、同じ住所の共有者が拒否 → その宛先は出ないので、古い物件は外さない", async () => {
    offProps = { pNew: [{ id: "o1", address: "東京都A" }, { id: "o9", address: "東京都A" }] };
    terminalOwners = new Set(["o9"]);
    expect(await resolveSecondLetters(rtx, [L("pOld", ["o1"])])).toEqual([false]);
  });
  it("新しい物件(対象外)で拒否の共有者が別の住所 → o1 あては出るので、古い物件は2通目", async () => {
    offProps = { pNew: [{ id: "o1", address: "東京都A" }, { id: "o9", address: "神奈川県B" }] };
    terminalOwners = new Set(["o9"]);
    expect(await resolveSecondLetters(rtx, [L("pOld", ["o1"])])).toEqual([true]);
  });
  it("★対象外の物件をはさむ連鎖: 新しい物件の宛先が、さらに新しい物件のために出ないなら、古い物件は外さない", async () => {
    // pOld(o1)が対象。pMid(o1 と o2 が同じ住所)は対象外・pTop(o2)はいちばん新しい(対象外)。
    // pMid の宛先は o2 の pTop があるので出ない → o1 に届く新しい手紙は無い → pOld は残す。
    sendLinks = [
      lnk("o1", "pOld", "2026-01-01T00:00:00Z"),
      lnk("o1", "pMid", "2026-02-01T00:00:00Z"),
      lnk("o2", "pMid", "2026-02-01T00:00:00Z"),
      lnk("o2", "pTop", "2026-03-01T00:00:00Z"),
    ];
    offProps = {
      pMid: [{ id: "o1", address: "東京都A" }, { id: "o2", address: "東京都A" }],
      pTop: [{ id: "o2", address: "東京都A" }],
    };
    expect(await resolveSecondLetters(rtx, [L("pOld", ["o1"])])).toEqual([false]);
  });
  it("ほかの理由で外れている宛先の所有者は調べない・2通目にしない。宛先が空なら DB を引かない", async () => {
    expect(await resolveSecondLetters(rtx, [L("pOld", ["o1"], false)])).toEqual([false]);
    expect(await resolveSecondLetters(rtx, [])).toEqual([]);
    expect(tx.propertyOwner.findMany).not.toHaveBeenCalled();
    expect(tx.property.findMany).not.toHaveBeenCalled();
  });
  it("たどる段数には上限がある(所有者の読み込みは SECOND_LETTER_MAX_HOPS 回まで)", async () => {
    // o1→p1(o1,o2)→p2(o2,o3)→p3(o3,o4)→… と、共有者でどこまでもつながる。
    sendLinks = [lnk("o0", "p0", "2026-01-01T00:00:00Z")];
    for (let i = 1; i <= 8; i += 1) {
      const iso = `2026-02-0${i}T00:00:00Z`;
      sendLinks.push(lnk(`o${i - 1}`, `p${i}`, iso), lnk(`o${i}`, `p${i}`, iso));
      offProps[`p${i}`] = [{ id: `o${i - 1}`, address: "東京都A" }, { id: `o${i}`, address: "東京都A" }];
    }
    await resolveSecondLetters(rtx, [L("p0", ["o0"])]);
    expect(tx.property.findMany).toHaveBeenCalledTimes(SECOND_LETTER_MAX_HOPS);
  });
});

describe("everyOwnerHasNewerProperty", () => {
  const kept = new Map([["o1", "pNew"], ["o2", "pOld"]]);
  it("全員に新しい物件があるときだけ真", () => {
    expect(everyOwnerHasNewerProperty(kept, { propertyId: "pOld", ownerIds: ["o1"] })).toBe(true);
    expect(everyOwnerHasNewerProperty(kept, { propertyId: "pOld", ownerIds: ["o1", "o2"] })).toBe(false);
    expect(everyOwnerHasNewerProperty(kept, { propertyId: "pOld", ownerIds: ["o1", "o9"] })).toBe(false);
    expect(everyOwnerHasNewerProperty(kept, { propertyId: "pOld", ownerIds: [] })).toBe(false);
  });
});

describe("findSendPropertyLinks / findKeptPropertyByOwner", () => {
  it("つながりを(所有者・物件・登録日時)で返す", async () => {
    const rows = await findSendPropertyLinks(tx as unknown as SecondLetterTx, ["o1"]);
    expect(rows).toEqual([
      { ownerId: "o1", propertyId: "pOld", createdAt: d("2026-01-01T00:00:00Z") },
      { ownerId: "o1", propertyId: "pNew", createdAt: d("2026-06-01T00:00:00Z") },
    ]);
    expect(await findSendPropertyLinks(tx as unknown as SecondLetterTx, [])).toEqual([]);
  });
  it("送付可・アーカイブでない物件と、アーカイブでない所有者だけを引く(氏名・住所は読まない)", async () => {
    const kept = await findKeptPropertyByOwner(tx as unknown as SecondLetterTx, ["o1", "o1"]);
    expect(kept.get("o1")).toBe("pNew");
    const arg = tx.propertyOwner.findMany.mock.calls[0][0] as { where: unknown; select: unknown };
    expect(arg.where).toEqual({
      ownerId: { in: ["o1"] },
      owner: { isArchived: false },
      property: { dmStatus: "send", isArchived: false },
    });
    expect(arg.select).toEqual({ ownerId: true, propertyId: true, property: { select: { createdAt: true } } });
  });
  it("所有者が空なら DB を引かない", async () => {
    expect((await findKeptPropertyByOwner(tx as unknown as SecondLetterTx, [])).size).toBe(0);
    expect(tx.propertyOwner.findMany).not.toHaveBeenCalled();
  });
});

describe("demoteSecondLetterProperties: 宛先が残らなかった物件を「送付不可」にする", () => {
  it("送付可で、所有者にもっと新しい送付可の物件がある → 送付不可・版を上げる・変更履歴は自動", async () => {
    expect(await demoteSecondLetterProperties(["pOld"], "u9")).toBe(1);
    expect(props.pOld).toMatchObject({ dmStatus: "no_send", version: 2 });
    expect(props.pNew).toMatchObject({ dmStatus: "send", version: 1 });
    expect(lockCalls).toEqual(["pOld"]);
    expect(logs).toEqual([
      { targetTable: "properties", targetId: "pOld", fieldName: "dmStatus", oldValue: "send", newValue: "no_send", source: "auto", changedBy: "u9" },
    ]);
  });
  it("残す側の物件(いちばん新しい)を渡されても書かない", async () => {
    expect(await demoteSecondLetterProperties(["pNew"], "u9")).toBe(0);
    expect(props.pNew.dmStatus).toBe("send");
    expect(logs).toEqual([]);
  });
  it("読み直したら送付可でない・アーカイブ・物件が無い → 書かない", async () => {
    props.pOld.dmStatus = "hold";
    expect(await demoteSecondLetterProperties(["pOld"], "u9")).toBe(0);
    props.pOld.dmStatus = "send";
    props.pOld.isArchived = true;
    expect(await demoteSecondLetterProperties(["pOld", "pGone"], "u9")).toBe(0);
    expect(tx.property.update).not.toHaveBeenCalled();
  });
  it("読み直したら、もう新しい物件が送付可でない(相手が先に変わった) → 書かない", async () => {
    sendLinks = sendLinks.filter((l) => l.propertyId !== "pNew");
    expect(await demoteSecondLetterProperties(["pOld"], "u9")).toBe(0);
    expect(props.pOld.dmStatus).toBe("send");
  });
  it("★作ったあとに足された所有者(新しい物件を持たない)がいたら書かない(その人あての手紙はこの物件から出す)", async () => {
    props.pOld.ownerIds = ["o1", "oAdded"];
    expect(await demoteSecondLetterProperties(["pOld"], "u9")).toBe(0);
    expect(props.pOld).toMatchObject({ dmStatus: "send", version: 1 });
    expect(logs).toEqual([]);
  });
  it("誰かが編集中(編集の鍵がある)なら書かない(その人の保存を止めない)", async () => {
    lockedIds.add("pOld");
    expect(await demoteSecondLetterProperties(["pOld"], "u9")).toBe(0);
    expect(props.pOld).toMatchObject({ dmStatus: "send", version: 1 });
  });
  it("1件で失敗しても止まらない(控え・発送は出来ている)。同じ id は1回だけ", async () => {
    props.pOld2 = { dmStatus: "send", isArchived: false, ownerIds: ["o1"], version: 1 };
    sendLinks.push({ ownerId: "o1", propertyId: "pOld2", property: { createdAt: d("2025-01-01T00:00:00Z") } });
    failIds.add("pOld");
    expect(await demoteSecondLetterProperties(["pOld2", "pOld", "pOld2"], "u9")).toBe(1);
    expect(props.pOld2.dmStatus).toBe("no_send");
    expect(lockCalls).toEqual(["pOld", "pOld2"]);
  });
});
