/**
 * 謄本の名義の確認: システムの所有者と謄本の名義を、似ている人どうしで横に並べる(見た目だけ)。
 * 2026-11-08 作成・2026-11-09 違う部分に色(発注者依頼)。
 *
 * - 組になった2人は、違う文字だけに色と波線(色だけに頼らない)
 * - 謄本だけの人=薄い緑「＋ 謄本だけ」/システムだけの人=薄い赤「− システムだけ」/同じ=「✓ 同じ」
 * - 住所は参考(違う文字に色と点線だけ・名義の判定には使わない)
 * ⚠組にする・色を付けるのは見せ方だけ。「謄本の名義に直す」で外す・足す人は API の plan のまま。
 */
import type { RegistryOwnerReviewDetail } from "@/lib/api-client";
import { diffChars, ownerDiff, type OwnerDiffRow, type PairKind, type Segment } from "@/lib/registry-owner-check/diff";

export interface OwnerComparisonProps {
  systemOwners: RegistryOwnerReviewDetail["systemOwners"];
  registryOwners: RegistryOwnerReviewDetail["registryOwners"];
  registryLabel: string;
}

const badge = "ml-2 rounded px-1.5 py-0.5 text-[11px] font-medium";
const SYSTEM_DIFF =
  "rounded-sm bg-red-100 px-px text-red-800 underline decoration-wavy underline-offset-4 dark:bg-red-950 dark:text-red-200";
const REGISTRY_DIFF =
  "rounded-sm bg-green-100 px-px text-green-800 underline decoration-wavy underline-offset-4 dark:bg-green-950 dark:text-green-200";
const ADDRESS_DIFF = "bg-amber-100 underline decoration-dotted underline-offset-2 dark:bg-amber-900/60";

const PAIR_MARK: Record<PairKind, string> = {
  gaiji: "外字（読めない字）",
  kanji: "字が違う",
  corp: "法人の書き方",
  partial: "名前の一部が違う",
};

/** 違う文字だけに印。data-diff は印の付いた字(テスト・読み上げの手がかり)。 */
export function DiffText({ segments, diffClass, side }: { segments: Segment[]; diffClass: string; side: string }) {
  return (
    <>
      {segments.map((s, i) =>
        s.diff ? (
          <span key={i} className={diffClass} data-diff={side}>
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function rowTone(row: OwnerDiffRow): string {
  if (row.status === "registry_only") return "bg-green-50 dark:bg-green-950/40";
  if (row.status === "system_only") return "bg-red-50 dark:bg-red-950/40";
  return "bg-white dark:bg-gray-900";
}

function RowMark({ row }: { row: OwnerDiffRow }) {
  if (row.status === "same") return <span className="text-gray-600 dark:text-gray-300">✓ 同じ</span>;
  if (row.status === "registry_only")
    return <span className="font-semibold text-green-800 dark:text-green-300">＋ 謄本だけ</span>;
  if (row.status === "system_only")
    return <span className="font-semibold text-red-800 dark:text-red-300">− システムだけ</span>;
  return (
    <span className="text-amber-800 dark:text-amber-300">≠ {row.pairKinds.map((k) => PAIR_MARK[k]).join("・")}</span>
  );
}

export default function OwnerComparison({ systemOwners, registryOwners, registryLabel }: OwnerComparisonProps) {
  const diff = ownerDiff(
    registryOwners.map((o) => o.name),
    systemOwners.map((o) => o.name),
  );
  const unreadable = registryOwners.length === 0;

  return (
    <div className="space-y-3">
      {!unreadable && diff.kinds.length > 0 ? (
        <p className="rounded bg-gray-100 px-3 py-2 text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-100">
          <span className="font-semibold">違いの種類:</span> {diff.kinds.map((k) => k.label).join("・")}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-x-3 text-xs font-semibold text-gray-600 md:grid-cols-[1fr_1fr_9rem] dark:text-gray-300">
        <h3>システムの所有者</h3>
        <h3>
          謄本の名義<span className="ml-2 font-normal text-gray-400">{registryLabel}</span>
        </h3>
      </div>

      {unreadable ? (
        <p className="text-sm text-amber-700 dark:text-amber-400">謄本から名義を読み取れませんでした。</p>
      ) : null}

      <ul className="space-y-1.5">
        {diff.rows.map((row) => {
          const sys = row.systemIndex !== null ? systemOwners[row.systemIndex] : null;
          const reg = row.registryIndex !== null ? registryOwners[row.registryIndex] : null;
          const addr = sys?.address && reg?.address ? diffChars(sys.address, reg.address) : null;
          const replaced = row.status === "differs" && (sys?.willBeRemoved || reg?.willBeAdded);
          return (
            <li
              key={`${row.systemIndex ?? "-"}:${row.registryIndex ?? "-"}`}
              data-row={row.status}
              className={`grid grid-cols-2 gap-x-3 gap-y-1 rounded border border-gray-200 px-3 py-2 text-sm md:grid-cols-[1fr_1fr_9rem] dark:border-gray-700 ${rowTone(row)}`}
            >
              <div>
                {sys && row.system ? (
                  <>
                    <span className="text-gray-900 dark:text-gray-100">
                      <DiffText segments={row.system} diffClass={SYSTEM_DIFF} side="system" />
                    </span>
                    {sys.isPrimary ? (
                      <span className={`${badge} bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300`}>主</span>
                    ) : null}
                    {sys.address ? (
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        {addr ? <DiffText segments={addr.a} diffClass={ADDRESS_DIFF} side="address" /> : sys.address}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <span className="text-xs text-gray-400">（システムにいない）</span>
                )}
              </div>
              <div>
                {reg && row.registry ? (
                  <>
                    <span className="text-gray-900 dark:text-gray-100">
                      <DiffText segments={row.registry} diffClass={REGISTRY_DIFF} side="registry" />
                    </span>
                    {reg.share ? <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">持分 {reg.share}</span> : null}
                    {reg.address ? (
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        {addr ? <DiffText segments={addr.b} diffClass={ADDRESS_DIFF} side="address" /> : reg.address}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <span className="text-xs text-gray-400">（謄本にいない）</span>
                )}
              </div>
              <div className="col-span-2 text-xs md:col-span-1">
                <RowMark row={row} />
                {replaced ? (
                  <p className="mt-0.5 text-gray-500 dark:text-gray-400">直すと、この人を入れ替えます</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {!unreadable ? (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          <span>
            <span className={SYSTEM_DIFF}>字</span> システムだけにある字
          </span>
          <span>
            <span className={REGISTRY_DIFF}>字</span> 謄本だけにある字
          </span>
          <span>
            <span className={ADDRESS_DIFF}>字</span> 住所の違い（参考・名義の判定には使いません）
          </span>
        </p>
      ) : null}
    </div>
  );
}
