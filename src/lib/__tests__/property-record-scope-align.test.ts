/**
 * 物件配下 API の**担当者スコープ統一**（認可・PII 横断監査 2026-07-30）。
 *
 * 【背景】物件本体 (GET/PATCH /api/properties/[id]) は field_staff を担当分だけに
 * 絞るのに、配下のコメント・次アクション・調査情報・重複候補判定は絞っておらず、
 * **同じ物件なのに経路によって見える範囲が違う**状態だった。
 *
 * 【発注者判断 2026-07-30】
 *   「担当外に見せてよいのは地図上の線やヒートマップ。顧客一覧は話が違う」
 *   → 顧客・物件に紐づくデータは**物件本体と同じ担当分だけ**に揃える。
 *   → 踏破の面 (coverage/cells) と線 (coverage/tracks) は**対象外**で全員閲覧を維持。
 *
 * ここでは共通ガード `assertPropertyRecordAccess` の振る舞いと、
 * 各 route が実際にそれを通しているか（＝スコープを一箇所に集約できているか）を固定する。
 * route ごとの HTTP 検証は既存の route テスト群（property-access-routes-scope 等）に倣い、
 * ここでは「どの route が通っているか」の配線をソースで固定する。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { ApiError: MockApiError };
});

vi.mock("@/lib/prisma", () => ({
  default: { property: { findUnique: vi.fn() } },
}));

import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import {
  assertPropertyRecordAccess,
  propertyRecordScopeFilter,
} from "@/lib/property-record-guard";
import { canAccessPropertyRecord } from "@/lib/property-access";

const findUnique = (prisma as unknown as {
  property: { findUnique: Mock };
}).property.findUnique;

const PROP = "11111111-1111-4111-8111-111111111111";
const field = { id: "u-field", role: "field_staff" };
const office = { id: "u-office", role: "office_staff" };
const admin = { id: "u-admin", role: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertPropertyRecordAccess", () => {
  it("担当者スコープの判定に必要な列だけを読む（PII を巻き込まない）", async () => {
    findUnique.mockResolvedValue({ createdBy: field.id, assignedTo: null });
    await assertPropertyRecordAccess(PROP, field);
    const arg = findUnique.mock.calls[0][0];
    expect(arg.where).toEqual({ id: PROP });
    // address / memo 等を select しない（判定に不要な PII を読まない）
    expect(Object.keys(arg.select).sort()).toEqual(["assignedTo", "createdBy"]);
  });

  it("field_staff は自分が作成した物件を通す", async () => {
    findUnique.mockResolvedValue({ createdBy: field.id, assignedTo: null });
    await expect(assertPropertyRecordAccess(PROP, field)).resolves.toBeUndefined();
  });

  it("field_staff は自分が担当の物件を通す", async () => {
    findUnique.mockResolvedValue({ createdBy: "someone", assignedTo: field.id });
    await expect(assertPropertyRecordAccess(PROP, field)).resolves.toBeUndefined();
  });

  it("field_staff は担当外の物件で 403（作成者でも担当者でもない）", async () => {
    findUnique.mockResolvedValue({ createdBy: "someone", assignedTo: "other" });
    const p = assertPropertyRecordAccess(PROP, field);
    await expect(p).rejects.toBeInstanceOf(ApiError);
    await expect(p).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it("admin / office_staff は素通し（既存の可視範囲を狭めない）", async () => {
    findUnique.mockResolvedValue({ createdBy: "someone", assignedTo: "other" });
    await expect(assertPropertyRecordAccess(PROP, admin)).resolves.toBeUndefined();
    await expect(assertPropertyRecordAccess(PROP, office)).resolves.toBeUndefined();
  });

  it("存在しない物件は 404（スコープ判定より先）", async () => {
    // ⚠順序が逆だと、担当外の物件について「存在するか」だけが漏れる。
    findUnique.mockResolvedValue(null);
    const p = assertPropertyRecordAccess(PROP, field);
    await expect(p).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("文言は読み取り系と更新系で出し分ける", async () => {
    findUnique.mockResolvedValue({ createdBy: "someone", assignedTo: "other" });
    await expect(
      assertPropertyRecordAccess(PROP, field, "read"),
    ).rejects.toMatchObject({ message: "この物件を閲覧する権限がありません" });
    await expect(
      assertPropertyRecordAccess(PROP, field, "write"),
    ).rejects.toMatchObject({ message: "この物件を操作する権限がありません" });
  });
});

describe("propertyRecordScopeFilter（書き込みの where に畳み込む述語）", () => {
  it("field_staff は作成 or 担当の OR 述語を返す", () => {
    expect(propertyRecordScopeFilter(field)).toEqual({
      OR: [{ createdBy: field.id }, { assignedTo: field.id }],
    });
  });

  it("admin / office_staff は undefined（条件を積まない）", () => {
    expect(propertyRecordScopeFilter(admin)).toBeUndefined();
    expect(propertyRecordScopeFilter(office)).toBeUndefined();
  });

  it("canAccessPropertyRecord と同じ条件になっている（定義のズレを防ぐ）", () => {
    // 述語と関数判定が食い違うと、読める物件が書けない（またはその逆）が起きる。
    const pred = propertyRecordScopeFilter(field)!;
    const own = { createdBy: field.id, assignedTo: null };
    const assigned = { createdBy: "x", assignedTo: field.id };
    const other = { createdBy: "x", assignedTo: "y" };
    const matches = (p: { createdBy: string; assignedTo: string | null }) =>
      pred.OR.some(
        (c) =>
          ("createdBy" in c && c.createdBy === p.createdBy) ||
          ("assignedTo" in c && c.assignedTo === p.assignedTo),
      );
    expect(matches(own)).toBe(canAccessPropertyRecord(field, own));
    expect(matches(assigned)).toBe(canAccessPropertyRecord(field, assigned));
    expect(matches(other)).toBe(canAccessPropertyRecord(field, other));
  });
});

describe("書き込みの原子性（@codex #338 P2）", () => {
  const read = (p: string) =>
    readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
  const src = () =>
    read("src/app/api/properties/[id]/next-actions/[actionId]/route.ts");

  it("更新は updateMany + スコープ述語で、0 件なら 403", () => {
    // 受付時点のガードだけでは、判定から更新までの間に担当が付け替わると
    // 担当外の予定を書き換えてしまう。1 文に畳み込んで原子的にする。
    const s = src();
    expect(s).toMatch(/nextAction\.updateMany\(\{[\s\S]{0,200}?property: scope/);
    expect(s).toContain("applied.count === 0");
    expect(s).not.toMatch(/nextAction\.update\(\{/);
  });

  it("削除も deleteMany + スコープ述語で、0 件なら 403", () => {
    const s = src();
    expect(s).toMatch(/nextAction\.deleteMany\(\{[\s\S]{0,200}?property: scope/);
    expect(s).toContain("removed.count === 0");
    expect(s).not.toMatch(/nextAction\.delete\(\{/);
  });

  it("where には propertyId も含める（別物件の子を触らせない）", () => {
    const s = src();
    const wheres = s.match(/where: \{ id: actionId,[^}]*\}/g) ?? [];
    expect(wheres.length).toBeGreaterThanOrEqual(2);
    for (const w of wheres) expect(w).toContain("propertyId");
  });

  it("調査の編集・確認済み設定も更新文にスコープを畳み込む（@codex #338 R2）", () => {
    // patchInvestigation / confirmInvestigationRecord は lib 内で無条件 update
    // していたため、受付時点のガードを通った後に担当が外れても編集が残った。
    // ⚠confirm は**物件本体にも書き戻す**ので、担当外の用途地域・建蔽率まで
    // 書き換わり得た。両方 updateMany + 0件403 にする。
    const lib = read("src/lib/investigation/fetch-investigation.ts");
    expect(lib).toContain("scopeSession?: { id: string; role: string }");
    expect(lib).toContain("assertScopedWrite(");

    // 対象は**利用者の直接編集**である2関数に限る。外部取得の結果保存
    // (runAndUpsertInvestigation) は「認可された利用者が始めた処理の結果」なので
    // 途中の担当変更で破棄しない（下の別テストで意図を固定）。
    const body = (name: string) => {
      const start = lib.indexOf(`export async function ${name}(`);
      expect(start).toBeGreaterThan(0);
      const next = lib.indexOf("\nexport ", start + 1);
      return lib.slice(start, next === -1 ? undefined : next);
    };
    for (const name of ["patchInvestigation", "confirmInvestigationRecord"]) {
      const fn = body(name);
      // 無条件 update が残っていない
      expect(fn, name).not.toMatch(/\.update\(\{/);
      const scoped = fn.match(/updateMany\(\{[\s\S]{0,200}?\}\)/g) ?? [];
      expect(scoped.length, name).toBeGreaterThanOrEqual(1);
      for (const u of scoped) expect(u, name).toContain("scope");
    }
    // confirm は調査と物件の2文とも守る（片方だけ守る形を残さない）
    expect(
      (body("confirmInvestigationRecord").match(/assertScopedWrite\(/g) ?? [])
        .length,
    ).toBe(2);
  });

  it("調査の書き込みは1トランザクション（0件403で中途状態を残さない・@codex #338 R3）", () => {
    // ⚠2文に分けたままだと「調査は confirmed になったが物件へのコピーが 403 で
    // 止まり監査も無い」中途状態が残る（2文化そのものが持ち込んだ退行）。
    // 「0件なら何も残さない」と言うには、拒否の throw で全体が rollback される必要がある。
    const lib = read("src/lib/investigation/fetch-investigation.ts");
    const body = (name: string) => {
      const start = lib.indexOf(`export async function ${name}(`);
      const next = lib.indexOf("\nexport ", start + 1);
      return lib.slice(start, next === -1 ? undefined : next);
    };
    for (const name of ["patchInvestigation", "confirmInvestigationRecord"]) {
      const fn = body(name);
      expect(fn, name).toContain("prisma.$transaction(async (tx)");
      // 書き込みと監査ログが tx 経由（prisma 直呼びが残っていない）
      expect(fn, name).not.toMatch(/await prisma\.propertyInvestigationAuditLog\.create/);
      expect(fn, name).toContain("tx.propertyInvestigationAuditLog.create");
      // 0件拒否は tx の中（外に出すと rollback されない）
      const txBody = fn.slice(fn.indexOf("$transaction"));
      expect(txBody, name).toContain("assertScopedWrite(");
    }
  });

  it("重複候補の判定もスコープを畳み込む（パス物件側のリレーションで・@codex #338 R3）", () => {
    // 候補は2物件(A/B)を参照するが、スコープが効くのは URL パスの物件。
    // A/B どちらが該当かは route が検証済みなので、その側にスコープを掛ける。
    const src = read(
      "src/app/api/properties/[id]/candidates/[candidateId]/judge/route.ts",
    );
    expect(src).not.toMatch(/propertyMatchCandidate\.update\(\{/);
    expect(src).toContain("propertyMatchCandidate.updateMany(");
    expect(src).toContain("{ propertyAId: id, propertyA: scope }");
    expect(src).toContain("{ propertyBId: id, propertyB: scope }");
    expect(src).toContain("applied.count === 0");

    // ⚠CAS(updateMany) と読み直しは同一 tx（@codex #338 R5・#328 R3 と同じ結論）。
    // 分けると同じ候補を2人が同時に判定したとき、相手の結果を読んで応答・監査に
    // 食い違いが残る（更新は自分、result は相手）。
    expect(src).toContain("prisma.$transaction(async (tx)");
    const tx = src.slice(src.indexOf("prisma.$transaction"));
    expect(tx).toContain("tx.propertyMatchCandidate.updateMany(");
    expect(tx).toContain("tx.propertyMatchCandidate.findUniqueOrThrow(");
    // 監査ログは意図的に tx の外（監査失敗で判定を rollback しない既存規約）
    expect(src.indexOf("writeAuditLog(")).toBeGreaterThan(
      src.indexOf("});", src.indexOf("findUniqueOrThrow(")),
    );
    expect(src).toMatch(/監査ログは\*\*意図的に tx の外\*\*/);
  });

  it("新規作成は行ロックで原子化する（create は where を持てない・@codex #338 R4）", () => {
    // create にスコープ述語は書けないので、トランザクション内で物件行を
    // FOR UPDATE でロックし、担当の付け替えを待たせて窓を閉じる。
    const guard = read("src/lib/property-record-guard.ts");
    expect(guard).toContain("lockPropertyRecordForWrite");
    expect(guard).toContain("FOR UPDATE");
    // スコープはパラメータのみで表現（生SQLの既存前例と同じ形）
    expect(guard).toContain("${scopeUserId}::uuid IS NULL");
    // updatedAt を触る touch 方式は採らない（一覧の更新日が意味を失う）
    expect(guard).not.toContain("updatedAt: new Date()");

    for (const p of [
      "src/app/api/properties/[id]/comments/route.ts",
      "src/app/api/properties/[id]/next-actions/route.ts",
    ]) {
      const src = read(p);
      // 作成が tx 内で、ロックの後に来ている
      expect(src, p).toContain("lockPropertyRecordForWrite(tx, propertyId, session)");
      const tx = src.slice(src.indexOf("prisma.$transaction"));
      expect(tx.indexOf("lockPropertyRecordForWrite"), p).toBeLessThan(
        tx.indexOf(".create({"),
      );
      // tx 外の素の create が残っていない
      expect(src, p).not.toMatch(/await prisma\.(comment|nextAction)\.create\(/);
    }
  });

  it("【横断】書き込みの tx は必ず親の物件行ロックで始まる（@codex #338 R7）", () => {
    // ⚠リレーション述語だけでは親の properties 行がロックされず、READ COMMITTED では
    // 文の開始スナップショットで古い担当を見て 1 件更新が通る（更新対象行が別なので
    // 担当付け替えと同時に commit できる）。FOR UPDATE で親を押さえて順序を作る。
    // 規約を1文に統一: **物件配下を書き換える tx は最初に lock を呼ぶ**。
    // ⚠検査の単位は **route はファイル内の tx ごと / lib は関数ごと**。
    // ソース全体を1つの正規表現で走査すると、意図的にスコープ対象外の経路
    // （外部取得の結果保存にある監査ログ作成）まで拾って誤検知する（実際に踏んだ）。
    const assertLockFirst = (label: string, text: string) => {
      const writeIdx = text.search(/tx\.\w+\.(updateMany|deleteMany|create)\(/);
      expect(writeIdx, `${label}: tx 内の書き込みが無い`).toBeGreaterThan(0);
      const lockIdx = text.indexOf("lockPropertyRecordForWrite(tx,");
      expect(lockIdx, `${label}: 書き込み tx が lock で始まっていない`).toBeGreaterThan(0);
      expect(lockIdx, `${label}: lock が書き込みより後ろ`).toBeLessThan(writeIdx);
    };

    for (const p of [
      "src/app/api/properties/[id]/comments/route.ts",
      "src/app/api/properties/[id]/next-actions/route.ts",
      "src/app/api/properties/[id]/next-actions/[actionId]/route.ts",
      "src/app/api/properties/[id]/candidates/[candidateId]/judge/route.ts",
    ]) {
      const src = read(p);
      const txs = src.match(/\$transaction\(async \(tx\) => \{[\s\S]*?\n {4}\}\);/g) ?? [];
      const writeTxs = txs.filter((t) =>
        /tx\.\w+\.(updateMany|deleteMany|create)\(/.test(t),
      );
      expect(writeTxs.length, `${p}: 書き込み tx が見つからない`).toBeGreaterThan(0);
      for (const t of writeTxs) assertLockFirst(p, t);
    }

    // lib は「利用者の直接編集」の2関数だけ（取得経路は意図的に対象外）。
    const lib = read("src/lib/investigation/fetch-investigation.ts");
    for (const name of ["patchInvestigation", "confirmInvestigationRecord"]) {
      const start = lib.indexOf(`export async function ${name}(`);
      const next = lib.indexOf("\nexport ", start + 1);
      assertLockFirst(name, lib.slice(start, next === -1 ? undefined : next));
    }
  });

  it("【横断】CAS した後の読み直しは必ず同一 tx 内（@codex #338 R5/R6・#328 R3 の再発防止）", () => {
    // updateMany の行ロックは文の終わりで解放される。読み直しを外に出すと
    // 相手の結果を返す／相手が消していれば 500 になる。同じ指摘を2巡連続で
    // 別ファイルに受けたので、**このPRが触る全ファイルを横断で固定**する。
    const files = [
      "src/app/api/properties/[id]/next-actions/[actionId]/route.ts",
      "src/app/api/properties/[id]/candidates/[candidateId]/judge/route.ts",
      "src/lib/investigation/fetch-investigation.ts",
    ];
    for (const p of files) {
      const src = read(p);
      // prisma 直呼びの findUniqueOrThrow（= tx 外の読み直し）が無いこと。
      // tx 内は `tx.` 経由になるのでこの検査を素通りする。
      expect(src, `${p}: tx 外の読み直しが残っている`).not.toMatch(
        /await prisma\.\w+\.findUniqueOrThrow\(/,
      );
      // updateMany を使うなら $transaction も使っている
      if (/\.updateMany\(/.test(src)) {
        expect(src, `${p}: updateMany があるのに $transaction が無い`).toContain(
          "$transaction",
        );
      }
    }
  });

  it("【デッドロック回避】取得経路も親→子のロック順にする（認可はしない・自己レビュー検出）", () => {
    // ⚠監査ログ (property_investigation_audit_logs) は properties への必須 FK を持つ
    // ため、その INSERT で参照整合性トリガが親行に FOR KEY SHARE を取る。つまり
    // 「子を更新 → 監査を INSERT」の順に書くと**暗黙に子→親**の順でロックする。
    // 編集経路は親から FOR UPDATE を取るので、混ざると循環して 40P01（500）になり、
    // 取得経路が犠牲になると**課金済みの取得結果が rollback されて status が
    // fetching のまま固着する**（この差分の R7 が持ち込んだ新しい危険）。
    const lib = read("src/lib/investigation/fetch-investigation.ts");
    const body = (name: string) => {
      const start = lib.indexOf(`export async function ${name}(`);
      const next = lib.indexOf("\nexport ", start + 1);
      return lib.slice(start, next === -1 ? undefined : next);
    };
    const fetchFn = body("runAndUpsertInvestigation");
    // ⚠tx の終端を正規表現で当てるのは脆い（インデントで誤爆する）。
    // 「$transaction の出現位置から次の $transaction まで」で区切る。
    const marker = "$transaction(async (tx) => {";
    const segments: string[] = [];
    let from = fetchFn.indexOf(marker);
    while (from !== -1) {
      const next = fetchFn.indexOf(marker, from + marker.length);
      segments.push(fetchFn.slice(from, next === -1 ? undefined : next));
      from = next;
    }
    const writeSegments = segments.filter((s) =>
      /tx\.\w+\.(update|upsert|create|updateMany)\(/.test(s),
    );
    expect(writeSegments.length, "取得経路の書き込み tx が3つ見つからない").toBe(3);
    for (const t of writeSegments) {
      const lockIdx = t.search(/lockPropertyRow\(tx,|lockPropertyRecordForWrite\(tx,/);
      const writeIdx = t.search(/tx\.\w+\.(update|upsert|create|updateMany)\(/);
      expect(lockIdx, "取得経路の tx がロックで始まっていない").toBeGreaterThan(0);
      expect(lockIdx, "ロックが書き込みより後ろ").toBeLessThan(writeIdx);
    }
    // 結果保存は認可しない（スコープ述語を付けない）が、ロックは取る
    expect(lib).toContain("export async function runAndUpsertInvestigation");
    expect(read("src/lib/property-record-guard.ts")).toContain(
      "export async function lockPropertyRow(",
    );
  });

  it("取得の開始は担当者スコープで守る（開始前ならまだ課金していない・@codex #338 R8）", () => {
    const lib = read("src/lib/investigation/fetch-investigation.ts");
    const start = lib.indexOf("export async function runAndUpsertInvestigation(");
    const step1End = lib.indexOf("Step 2", start);
    const step1 = lib.slice(start, step1End === -1 ? start + 3000 : step1End);
    // Step 1 だけは認可つきロック（scopeSession があれば）
    expect(step1).toContain("lockPropertyRecordForWrite(tx, propertyId, scopeSession)");
    // route が session を渡している
    expect(read("src/app/api/properties/[id]/investigation/fetch/route.ts")).toMatch(
      /runAndUpsertInvestigation\([\s\S]{0,400}?session,\s*\n\s*\);/,
    );
  });

  it("物件へ書き戻す値と監査の before はロック後に読む（自己レビュー検出）", () => {
    // tx/ロックの外で読むと、確認済みにした調査の値と物件へコピーされる値が
    // 食い違う（しかもその値は販売図面に自動反映される）。監査の before 像も
    // 連続編集で同じ値を2回記録し、実際の遷移が復元できなくなる。
    const lib = read("src/lib/investigation/fetch-investigation.ts");
    for (const name of ["patchInvestigation", "confirmInvestigationRecord"]) {
      const start = lib.indexOf(`export async function ${name}(`);
      const next = lib.indexOf("\nexport ", start + 1);
      const fn = lib.slice(start, next === -1 ? undefined : next);
      // tx の前に prisma 直の findUnique を置かない（= 読み取りが tx 内）
      const beforeTx = fn.slice(0, fn.indexOf("$transaction"));
      expect(beforeTx, `${name}: ロック前に読んでいる`).not.toMatch(
        /prisma\.propertyInvestigation\.findUnique\(/,
      );
      // tx 内でロックより後に読む
      const tx = fn.slice(fn.indexOf("$transaction"));
      const lockIdx = tx.search(/lockPropertyRow\(tx,|lockPropertyRecordForWrite\(tx,/);
      const readIdx = tx.indexOf("tx.propertyInvestigation.findUnique(");
      expect(readIdx, `${name}: tx 内の読み取りが無い`).toBeGreaterThan(0);
      expect(lockIdx, `${name}: 読み取りがロックより前`).toBeLessThan(readIdx);
    }
  });

  it("外部取得の結果保存はスコープで破棄しない（意図を明記してある）", () => {
    // 取得は認可された利用者が開始したもので、外部呼び出しに数秒かかる。
    // 途中で担当が変わったからといって取得済みの結果を捨てると、課金した
    // 取得が無駄になり status が fetching のまま残る。直接編集とは性質が違う。
    const lib = read("src/lib/investigation/fetch-investigation.ts");
    expect(lib).toMatch(/取得の結果保存[\s\S]{0,400}?スコープで破棄しない/);
  });

  it("route はセッションを lib へ渡している（渡し忘れると素通しになる）", () => {
    // lib 側が session からスコープ述語と親行ロックの両方を導出する（@codex #338 R7）。
    // 渡し忘れると scopeSession が undefined になり、ロックも述語も掛からない。
    for (const [p, fn] of [
      ["src/app/api/properties/[id]/investigation/route.ts", "patchInvestigation"],
      [
        "src/app/api/properties/[id]/investigation/confirm/route.ts",
        "confirmInvestigationRecord",
      ],
    ]) {
      const src = read(p);
      const call = src.slice(src.indexOf(`await ${fn}(`));
      expect(call.slice(0, 260), p).toContain("session,");
    }
  });
});

describe("配線: 物件配下 route が担当者スコープを通している", () => {
  const read = (p: string) =>
    readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

  const guarded = [
    "src/app/api/properties/[id]/comments/route.ts",
    "src/app/api/properties/[id]/next-actions/route.ts",
    "src/app/api/properties/[id]/next-actions/[actionId]/route.ts",
    "src/app/api/properties/[id]/investigation/route.ts",
    "src/app/api/properties/[id]/investigation/audit-logs/route.ts",
    "src/app/api/properties/[id]/investigation/confirm/route.ts",
    "src/app/api/properties/[id]/candidates/[candidateId]/judge/route.ts",
  ];

  it.each(guarded)("%s が共通ガードを呼ぶ", (p) => {
    const src = read(p);
    expect(src).toContain("assertPropertyRecordAccess");
    expect(src).toContain('from "@/lib/property-record-guard"');
  });

  it("各ハンドラの数だけガードが入っている（片方の口だけ守る取りこぼしを防ぐ）", () => {
    for (const p of guarded) {
      const src = read(p);
      const handlers = (src.match(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g) ?? []).length;
      const guards = (src.match(/await assertPropertyRecordAccess\(/g) ?? []).length;
      expect(guards, `${p}: handlers=${handlers} guards=${guards}`).toBe(handlers);
    }
  });

  it("コメント投稿は property:write を要求する（read で書けない）", () => {
    const src = read("src/app/api/properties/[id]/comments/route.ts");
    const post = src.slice(src.indexOf("export async function POST"));
    expect(post).toContain('hasPermission(perms, "property", "write")');
  });

  it("調査の外部取得は住所を送る前に担当者スコープで弾く", () => {
    // 担当外の物件の住所を外部プロバイダへ送信させられる経路のため、
    // 送信処理 (runAndUpsertInvestigation) より前にガードが来ること。
    const src = read("src/app/api/properties/[id]/investigation/fetch/route.ts");
    const guardIdx = src.indexOf("canAccessPropertyRecord(session, property)");
    const sendIdx = src.indexOf("runAndUpsertInvestigation(");
    expect(guardIdx).toBeGreaterThan(0);
    expect(sendIdx).toBeGreaterThan(guardIdx);
  });

  it("物件横断検索はキーワード条件を AND で包む（OR の枝にしない）", () => {
    // OR の枝として足すと「キーワード一致 or 自分の物件」になり全物件が出る。
    const src = read("src/app/api/properties/search/route.ts");
    expect(src).toContain("fieldStaffScope");
    expect(src).toMatch(/AND:\s*\[\s*\n\s*\.\.\.fieldStaffScope/);
  });

  it("クイック操作は担当者スコープを持つ（assign_to_me による自己拡張を防ぐ）", () => {
    const src = read("src/app/api/properties/[id]/actions/route.ts");
    expect(src).toContain("canAccessPropertyRecord(session, current)");
    // 判定は execute（assign_to_me を含む）より前
    expect(src.indexOf("canAccessPropertyRecord(session, current)")).toBeLessThan(
      src.indexOf("actionDef.execute("),
    );
  });

  it("踏破の面と線は対象外のまま（全員が見られる設計を維持）", () => {
    // 発注者判断: 担当外に見せてよいのは地図の線・ヒートマップ。
    // 二度歩きを避けるのが目的なので、歩く当人が他の人の踏破を見られないと意味がない。
    for (const p of [
      "src/app/api/field-survey/coverage/cells/route.ts",
      "src/app/api/field-survey/coverage/tracks/route.ts",
    ]) {
      const src = read(p);
      expect(src).not.toContain("assertPropertyRecordAccess");
      expect(src).not.toContain("canAccessPropertyRecord");
    }
  });
});
