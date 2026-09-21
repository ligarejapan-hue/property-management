import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * review Important 5(H5): 従来は既知4ファイルの**ホワイトリスト**に
 * `await deleteEditLocksFor(` があるかを見るだけだった。今後 `property.delete(` や
 * `owner.delete(` を書く経路、または `isArchived: true` を書く経路が1本増えても、
 * ホワイトリストに無ければ検出できず、資源だけ消えて鍵が孤児になる
 * (=この機能が持ってはいけない唯一の失敗)。
 *
 * `src/` 全体を**掃き出す**(`version-increment-scan.test.ts` と同じ `extractBalancedSpan`
 * 方式): `property.delete(` / `owner.delete(` の呼び出し行と、`.update(`/`.updateMany(`/
 * `.upsert(` の呼び出しのうち `data:` オブジェクトが `isArchived: true` を含むものを
 * 検出する。検出した箇所は1件残らず下の一覧(KNOWN_CLEANUP_SITES)に載っていること、
 * かつ一覧の各箇所が実際に `deleteEditLocksFor` を(同じファイル内で)呼んでいることを
 * 確認する。
 *
 * 今日時点の正しい全体像(review本文で実測確認済み): `property.delete(` が2本
 * (物件の削除・取込の取り消し)、`isArchived: true` を書く箇所が2本(所有者の
 * アーカイブ・所有者の統合で消えるsource)の計4本。`owner.delete(` は無い(所有者は
 * 物理削除しない)。物件をアーカイブする書き込み経路も無い。
 */
const KNOWN_CLEANUP_SITES: Record<string, string> = {
  "src/app/api/properties/[id]/route.ts:550": "property.delete(物件の削除)",
  "src/app/api/import/jobs/[jobId]/rollback/route.ts:419": "property.delete(取込の取り消し)",
  "src/app/api/admin/owners/[id]/correction/archive/route.ts:247":
    "owner.updateMany({ isArchived: true })(所有者のアーカイブ)",
  "src/app/api/admin/owners/correction/merge/route.ts:638":
    "owner.updateMany({ isArchived: true })(統合で消えるsourceのアーカイブ)",
};

const EXCLUDE_DIRS = new Set(["__tests__", "generated", "node_modules"]);

/** `version-increment-scan.test.ts` と同じ走査(.ts/.tsx・CRLFはLFへ正規化)。 */
function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      files.push(...listSourceFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(full);
    }
  }
  return files;
}

/**
 * `version-increment-scan.test.ts` の `extractBalancedSpan` と同じ実装(文字列
 * リテラル・コメントの中の括弧は数えない)。走査テストは互いに独立したファイルとして
 * 意図的に重複させる(共有ヘルパに割ると、片方のテストだけを見て安全と誤解しやすい)。
 */
function extractBalancedSpan(
  text: string,
  startIdx: number,
  openChar: string,
  closeChar: string,
): string {
  let depth = 1;
  let i = startIdx;
  const n = text.length;
  while (i < n && depth > 0) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) depth--;
    i++;
  }
  return text.slice(startIdx, Math.max(startIdx, i - 1));
}

function lineStartOffsets(lines: string[]): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    offsets.push(offsets[i] + lines[i].length + 1);
  }
  return offsets;
}

/** 呼び出し(`.update(`/`.updateMany(`/`.upsert(`)自身の引数括弧の中身。 */
function callArgsSpanForLine(
  fullSrc: string,
  lines: string[],
  offsets: number[],
  lineIdx: number,
): string | null {
  const lineText = lines[lineIdx];
  const m = /\.(update|updateMany|upsert)\(/.exec(lineText);
  if (!m) return null;
  const openParenAbs = offsets[lineIdx] + m.index + m[0].length;
  return extractBalancedSpan(fullSrc, openParenAbs, "(", ")");
}

/** 呼び出し引数の中の `data:` がその場のオブジェクトリテラルなら、その中身を返す。 */
function inlineDataObjectSpan(callArgs: string): string | null {
  const m = /\bdata\s*:\s*\{/.exec(callArgs);
  if (!m) return null;
  const openBraceAbs = m.index + m[0].length;
  return extractBalancedSpan(callArgs, openBraceAbs, "{", "}");
}

const DELETE_PATTERN = /\b(?:property|owner)\.delete\(/;
const WRITE_CALL_PATTERN = /\b(?:property|owner)\.(?:update|updateMany|upsert)\(/;
const IS_ARCHIVED_TRUE_PATTERN = /\bisArchived\s*:\s*true\b/;

/**
 * `src/` を掃き出して、資源を消す/アーカイブする書き込みの箇所(`相対パス:行番号`)を
 * 1件残らず返す。ホワイトリストではなく、実際のパターンマッチで見つける。
 */
function findCleanupSites(): string[] {
  const root = join(process.cwd(), "src");
  const sites: string[] = [];
  for (const file of listSourceFiles(root)) {
    const fullSrc = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const rel = relative(process.cwd(), file).replace(/\\/g, "/");
    const lines = fullSrc.split("\n");
    const offsets = lineStartOffsets(lines);
    for (let i = 0; i < lines.length; i++) {
      if (DELETE_PATTERN.test(lines[i])) {
        sites.push(`${rel}:${i + 1}`);
        continue;
      }
      if (WRITE_CALL_PATTERN.test(lines[i])) {
        const callArgs = callArgsSpanForLine(fullSrc, lines, offsets, i);
        if (callArgs === null) continue;
        const dataSpan = inlineDataObjectSpan(callArgs);
        const target = dataSpan ?? callArgs;
        if (IS_ARCHIVED_TRUE_PATTERN.test(target)) {
          sites.push(`${rel}:${i + 1}`);
        }
      }
    }
  }
  return sites;
}

describe("鍵の後始末(仕様4.6/8.2・スイープ)", () => {
  it("物件・所有者を消す/アーカイブする書き込みは、1件残らず一覧に載っている", () => {
    const known = new Set(Object.keys(KNOWN_CLEANUP_SITES));
    const sites = findCleanupSites();
    const unknown = sites.filter((s) => !known.has(s));
    expect(
      unknown,
      unknown.length > 0
        ? `新しい削除/アーカイブ箇所が見つかった: ${unknown.join(", ")}\n` +
            "この箇所は同じファイル内で deleteEditLocksFor を呼ぶよう直し、" +
            "KNOWN_CLEANUP_SITES に理由つきで追記すること。"
        : undefined,
    ).toEqual([]);
  });

  it("一覧に載っている箇所は、今もその場所に存在する(行のずれを検出する)", () => {
    const sites = new Set(findCleanupSites());
    const stale = Object.keys(KNOWN_CLEANUP_SITES).filter((k) => !sites.has(k));
    expect(
      stale,
      stale.length > 0
        ? `一覧の行が実際のコードからずれている: ${stale.join(", ")}\n` +
            "ファイルが編集されて行番号がずれたか、書き込み自体が消えた。行番号を更新すること。"
        : undefined,
    ).toEqual([]);
  });

  it("検出パターン自体が空振りしていない(健全性の確認)", () => {
    // 現時点で4箇所(delete 2 + isArchived:true 2)を検出している。0件はパターン自体が
    // 壊れているサイン。
    expect(findCleanupSites().length).toBeGreaterThanOrEqual(4);
  });

  for (const [key, desc] of Object.entries(KNOWN_CLEANUP_SITES)) {
    it(`${key} は同じファイル内で deleteEditLocksFor を呼ぶ(${desc})`, () => {
      const file = key.slice(0, key.lastIndexOf(":"));
      const src = readFileSync(join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n");
      // review Minor 10: `await deleteEditLocksFor(` まで要求する。`deleteEditLocksFor` という
      // 文字列だけなら import 文やコメントでも素通りしてしまう。
      expect(src).toMatch(/await deleteEditLocksFor\(/);
    });
  }

  // review Important 5: 行ロックが無いまま後始末だけを足しても孤児化は防げない
  // (これがこの task の核心)。archive はこれまで owner 行を一切ロックしていなかったため、
  // 新規に足した lockOwnerRow がこの走査でも・実際の順序テスト(owner-archive-route.test.ts)
  // でも両方から固定されている必要がある。
  it("owners archive は lockOwnerRow(行ロック)を呼んでから鍵を消す", () => {
    const src = readFileSync(
      join(process.cwd(), "src/app/api/admin/owners/[id]/correction/archive/route.ts"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(src).toMatch(/await lockOwnerRow\(/);
  });
});

// ⚠走査(名前が出てくるか)だけでは順序の穴を防げない(@codex R11 P2)。
//   取り消し(rollback)の経路は、これまで物件行をロックせずに削除していたため、
//   後始末をただ同じ tx に足すだけでは「まだ commit されていない acquireEditLock」を
//   取りこぼし、鍵が孤児になる窓が残る。$transaction をモックして
//   ["tx","lockRows","deleteLocks","deleteProperty"] の順で呼ばれることを固定する。

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  getApiSession: vi.fn(),
  getUserPermissions: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) => Response.json(body as object, { status })),
  handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
    Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 }),
  ),
}));
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({ recordChanges: vi.fn() }));
vi.mock("@/lib/edit-lock/service", () => ({ deleteEditLocksFor: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { findUnique: vi.fn() },
    property: { findMany: vi.fn(), delete: vi.fn() },
    changeLog: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { deleteEditLocksFor } from "@/lib/edit-lock/service";
import prisma from "@/lib/prisma";
import { POST as rollbackPOST } from "@/app/api/import/jobs/[jobId]/rollback/route";

type PrismaMock = {
  importJob: { findUnique: Mock };
  property: { findMany: Mock; delete: Mock };
  changeLog: { findMany: Mock };
  $transaction: Mock;
};
const pm = prisma as unknown as PrismaMock;

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const PROP_ID = "22222222-2222-4222-8222-222222222222";
const COMPLETED_AT = new Date("2026-01-01T00:05:00Z");

const JOB = {
  id: JOB_ID,
  status: "completed" as const,
  jobType: "property_csv" as const,
  executedBy: "u1",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  completedAt: COMPLETED_AT,
  rows: [
    {
      id: "row-1",
      rowNumber: 1,
      status: "success" as const,
      errorMessage: null,
      createdId: PROP_ID,
    },
  ],
};

const rollbackRequest = (body: unknown) =>
  new Request("http://localhost/api/import/jobs/x/rollback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof rollbackPOST>[0];

describe("取り消しは 行ロック → 後始末 → 削除 の順", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "u1", role: "admin" });
    (getUserPermissions as unknown as Mock).mockResolvedValue([]);
    pm.importJob.findUnique.mockResolvedValue(JOB);
    pm.property.findMany.mockResolvedValue([
      {
        id: PROP_ID,
        updatedAt: COMPLETED_AT,
        _count: {
          photos: 0,
          attachments: 0,
          propertyOwners: 0,
          comments: 0,
          nextActions: 0,
          dmLogs: 0,
          investigationLogs: 0,
        },
      },
    ]);
    pm.changeLog.findMany.mockResolvedValue([]);
  });

  it("物件の行をロックしてから鍵を消し、最後に物件を消す", async () => {
    const order: string[] = [];
    let txClient: unknown;
    // review Important 4: "lockRows" というラベルは、どんな tx.$queryRaw 呼び出しでも
    // push されてしまい、FOR UPDATE や ORDER BY id を落としても緑のまま通り得る。
    // 実際に投げられた SQL テンプレートと束縛値を控えて、あとで文面そのものを検査する。
    let lockRowsCall: unknown[] | null = null;

    pm.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      order.push("tx");
      txClient = {
        importJob: {
          findUnique: vi.fn(async () => ({ status: "completed" })),
          update: vi.fn(async () => ({})),
        },
        property: {
          delete: vi.fn(async () => {
            order.push("deleteProperty");
            return {};
          }),
        },
        $queryRaw: vi.fn((...args: unknown[]) => {
          order.push("lockRows");
          lockRowsCall = args;
          return Promise.resolve([]);
        }),
      };
      return fn(txClient);
    });
    (deleteEditLocksFor as unknown as Mock).mockImplementation(async () => {
      order.push("deleteLocks");
      return 1;
    });

    const res = await rollbackPOST(rollbackRequest({ dryRun: false }), {
      params: Promise.resolve({ jobId: JOB_ID }),
    });

    expect(res.status).toBe(200);
    expect(order).toEqual(["tx", "lockRows", "deleteLocks", "deleteProperty"]);
    // ⚠tx そのもの(identity)に対して呼ばれたこと・base client には漏れていないことを固定する。
    expect((deleteEditLocksFor as unknown as Mock).mock.calls[0][0]).toBe(txClient);
    expect(pm.property.delete).not.toHaveBeenCalled();

    // review Important 4: FOR UPDATE と ORDER BY id、そして削除対象の id が
    // 実際に SQL テンプレートに乗っていることまで固定する(名前だけの検査にしない)。
    expect(lockRowsCall).not.toBeNull();
    const [strings, ...values] = lockRowsCall as unknown as [TemplateStringsArray, ...unknown[]];
    const sql = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? `{${String(values[i])}}` : ""),
      "",
    );
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/ORDER BY id/);
    expect(sql).toContain(PROP_ID);
  });
});
