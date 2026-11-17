/**
 * 金融機関データの控え(data/bank-directory/zengin.json)の形と読み方(純関数)。
 * 元データ: zengin-code/source-data(MIT ライセンス)。本番サーバーからは外へ取りに行かず、
 * リポジトリに置いた控えから表に入れる(scripts/import-bank-directory.ts)。
 * 控えの作り直しは scripts/build-bank-directory-snapshot.ts(元データを手元に取ってから)。
 */
import { z } from "zod";
import { formalBankName, formalBranchName, toSearchKey } from "./names";

/** 元データ(banks.json・branches/<code>.json)の1行。 */
export type SourceRow = { code: string; name: string; kana: string; hira: string; roma: string };

/** 控えの支店: [支店コード, 略称, ひらがなの読み, ローマ字]。 */
export type SnapshotBranch = [string, string, string, string];
/** 控えの金融機関: [コード, 略称, ひらがなの読み, ローマ字, 支店]。 */
export type SnapshotBank = [string, string, string, string, SnapshotBranch[]];
export type BankSnapshot = {
  version: string;
  source: string;
  license: string;
  commit: string;
  updatedAt: string;
  banks: SnapshotBank[];
};

const BANK_CODE = /^\d{4}$/;
const BRANCH_CODE = /^\d{3}$/;
const byCode = <T extends { code: string }>(a: T, b: T) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

export function buildSnapshot(
  banks: Record<string, SourceRow>,
  branchesByBank: Record<string, Record<string, SourceRow>>,
  meta: { source: string; commit: string; updatedAt: string },
): BankSnapshot {
  const rows: SnapshotBank[] = Object.values(banks).sort(byCode).map((b) => {
    if (!BANK_CODE.test(b.code)) throw new Error(`金融機関のコードの形が違います: ${b.code}`);
    const branches = Object.values(branchesByBank[b.code] ?? {}).sort(byCode).map((br): SnapshotBranch => {
      if (!BRANCH_CODE.test(br.code)) throw new Error(`支店のコードの形が違います: ${b.code}-${br.code}`);
      return [br.code, br.name, br.hira, br.roma];
    });
    return [b.code, b.name, b.hira, b.roma, branches];
  });
  return {
    version: `zengin-${meta.updatedAt}-${meta.commit.slice(0, 8)}`,
    source: meta.source,
    license: "MIT",
    commit: meta.commit,
    updatedAt: meta.updatedAt,
    banks: rows,
  };
}

const text = z.string().max(200);
const snapshotSchema = z.object({
  version: z.string().min(1).max(100),
  banks: z.array(z.tuple([
    z.string().regex(BANK_CODE), text.min(1), text, text,
    z.array(z.tuple([z.string().regex(BRANCH_CODE), text.min(1), text, text])),
  ])),
});

type Counts = { banks: number; branches: number };
/** 入れ替えで今より5%を超えて減るなら、その理由(控えが途中で切れている疑い)。問題なければ null。 */
export function shrinkProblem(existing: Counts, incoming: Counts): string | null {
  const shrunk = (now: number, next: number) => now > 0 && next < now * 0.95;
  if (shrunk(existing.banks, incoming.banks)) return `金融機関が ${existing.banks} → ${incoming.banks} に減ります`;
  if (shrunk(existing.branches, incoming.branches)) return `支店が ${existing.branches} → ${incoming.branches} に減ります`;
  return null;
}

export type BankRow ={ code: string; name: string; shortName: string; kana: string; roma: string };
export type BranchRow = BankRow & { bankCode: string };

/** 控え → 表に入れる行(正式な名前・検索のための読みを作る)。形が違えば throw。 */
export function parseSnapshot(raw: BankSnapshot): { version: string; banks: BankRow[]; branches: BranchRow[] } {
  const s = snapshotSchema.parse(raw);
  const seen = new Set<string>();
  const banks: BankRow[] = [];
  const branches: BranchRow[] = [];
  for (const [code, short, hira, roma, brs] of s.banks) {
    if (seen.has(code)) throw new Error(`金融機関のコードが重複しています: ${code}`);
    seen.add(code);
    banks.push({ code, name: formalBankName(code, short), shortName: short, kana: toSearchKey(hira), roma: roma.toLowerCase() });
    const seenBranch = new Set<string>();
    for (const [bcode, bshort, bhira, broma] of brs) {
      if (seenBranch.has(bcode)) throw new Error(`支店のコードが重複しています: ${code}-${bcode}`);
      seenBranch.add(bcode);
      branches.push({ bankCode: code, code: bcode, name: formalBranchName(code, bshort), shortName: bshort, kana: toSearchKey(bhira), roma: broma.toLowerCase() });
    }
  }
  return { version: s.version, banks, branches };
}
