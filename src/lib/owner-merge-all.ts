/**
 * 重複候補のグループを「この1人に全部まとめる」（2026-11-24 発注者承認）。
 *
 * 選んだ master に、グループの残りの人を**1人ずつ順番に**統合する。
 * 1人ごとに「確認（POST /merge dryRun=true）→ 実行（dryRun=false）」を呼ぶ。
 *
 * - ⚠統合のたびに master の版が上がるので、版は毎回その場の確認で取り直す
 *   （前の人の統合前の版で実行すると version_mismatch で止まる）。
 * - ⚠確認には統合 API の dryRun を使う。実行と同じ門（現住所の引き継ぎ・法人のペアの
 *   緩め方・権限）で判定されるので、確認は通ったのに実行で止まる食い違いが出にくい。
 * - 途中で止まった人がいても残りは続ける（止まった人は統合されず、そのまま残る）。
 * - 新しい API は作らない（1ペアずつの既存の統合 API を呼ぶだけ）。
 *
 * 返す値は ID・理由コード・サーバーのエラー文だけ（名前・住所は扱わない）。
 */

const MERGE_ENDPOINT = "/api/admin/owners/correction/merge";

export interface GroupMergeMemberResult {
  sourceId: string;
  ok: boolean;
  /** 止まった理由コード（OwnerMergeBlockReason）。 */
  reasons: string[];
  /** サーバーのエラー文・通信エラー。無ければ null。 */
  message: string | null;
}

interface MergeApiJson {
  eligible?: boolean;
  blockReasons?: unknown;
  summary?: { masterVersion?: number | null; sourceVersion?: number | null };
  error?: { message?: string; blockReasons?: unknown };
}

function reasonsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((r): r is string => typeof r === "string") : [];
}

async function postMerge(
  fetchFn: typeof fetch,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; json: MergeApiJson }> {
  const res = await fetchFn(MERGE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as MergeApiJson;
  return { ok: res.ok, json };
}

async function mergeOne(
  fetchFn: typeof fetch,
  masterId: string,
  sourceId: string,
): Promise<GroupMergeMemberResult> {
  // 1. 確認（その場の版を取る）
  const check = await postMerge(fetchFn, {
    masterId,
    sourceId,
    // 版は確認では見ない（dryRun でも不一致は理由に出るので、仮に 1 を渡す）
    masterVersion: 1,
    sourceVersion: 1,
    dryRun: true,
  });
  if (!check.ok) {
    return {
      sourceId,
      ok: false,
      reasons: reasonsOf(check.json.error?.blockReasons),
      message: check.json.error?.message ?? "確認に失敗しました",
    };
  }
  // 版の不一致は「仮の版」のせいなので、確認の段では理由にしない。
  const blockers = reasonsOf(check.json.blockReasons).filter(
    (r) => r !== "version_mismatch",
  );
  const masterVersion = check.json.summary?.masterVersion;
  const sourceVersion = check.json.summary?.sourceVersion;
  if (blockers.length > 0) {
    return { sourceId, ok: false, reasons: blockers, message: null };
  }
  if (typeof masterVersion !== "number" || typeof sourceVersion !== "number") {
    return { sourceId, ok: false, reasons: [], message: "確認の結果が読めませんでした" };
  }

  // 2. 実行（確認で取った最新の版で）
  const exec = await postMerge(fetchFn, {
    masterId,
    sourceId,
    masterVersion,
    sourceVersion,
    dryRun: false,
  });
  if (!exec.ok) {
    return {
      sourceId,
      ok: false,
      reasons: reasonsOf(exec.json.error?.blockReasons),
      message: exec.json.error?.message ?? "統合に失敗しました",
    };
  }
  return { sourceId, ok: true, reasons: [], message: null };
}

export async function runGroupMergeAll(input: {
  masterId: string;
  sourceIds: readonly string[];
  fetchFn?: typeof fetch;
  /** 1人終わるごとに呼ぶ（画面の進み具合の表示用）。 */
  onProgress?: (done: number, total: number) => void;
}): Promise<GroupMergeMemberResult[]> {
  const fetchFn = input.fetchFn ?? fetch;
  const targets = input.sourceIds.filter((id) => id !== input.masterId);
  const results: GroupMergeMemberResult[] = [];
  for (const sourceId of targets) {
    try {
      results.push(await mergeOne(fetchFn, input.masterId, sourceId));
    } catch (e) {
      results.push({
        sourceId,
        ok: false,
        reasons: [],
        message: e instanceof Error ? e.message : "通信に失敗しました",
      });
    }
    input.onProgress?.(results.length, targets.length);
  }
  return results;
}
