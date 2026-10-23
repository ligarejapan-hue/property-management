"use client";

/**
 * 謄本取込の確認画面に出す「登記の現況」カード。
 *
 * 全部事項の下線（抹消事項）と「N番…抹消」の登記を読んで、今も効力のある内容だけを示す
 * （判定は `src/lib/registry-strike/analyze.ts`）。**表示専用**で、物件・所有者には反映しない。
 * 取込の画面の控え（下書き）には入れない（読み直せば作り直せるため。氏名・住所を余計に残さない）。
 */
import type { RegistryRightsSummary } from "@/lib/registry-strike/analyze";

const card = "rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6";
const sub = "mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200";
const muted = "font-normal text-gray-400 dark:text-gray-500";

/** 全部事項でない（権利部が無い）謄本では出さない。 */
export function shouldShowRegistryRights(r: RegistryRightsSummary | null | undefined): r is RegistryRightsSummary {
  return !!r && (r.hasKouku || r.hasOtsuku);
}

export function RegistryRightsCard({ rights }: { rights: RegistryRightsSummary }) {
  const cancelledTotal = rights.cancelled.kouku + rights.cancelled.otsuku;
  return (
    <div className={card} data-testid="registry-rights-card">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100">登記の現況</h3>
        {rights.underlineDetected ? (
          <span className="rounded-full bg-emerald-50 dark:bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-200 dark:ring-emerald-400/20">
            下線（抹消事項）を読み取り済み
          </span>
        ) : (
          <span className="rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-300">
            下線の情報なし（「N番…抹消」から判定）
          </span>
        )}
      </div>
      <p className="mb-5 text-sm text-gray-600 dark:text-gray-400">
        下線のある事項（抹消事項）と、「N番…抹消」で消された登記を除いた、今も効力のある内容です。確認用の表示で、物件・所有者にはまだ反映しません。
      </p>

      <div className="space-y-5">
        {rights.hasKouku && (
          <section>
            <h4 className={sub}>
              今の所有者 <span className={muted}>（甲区）</span>
            </h4>
            {rights.currentOwners.length > 0 ? (
              <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-800">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-gray-800/50 text-left text-xs text-gray-500 dark:text-gray-400">
                    <tr>
                      <th className="px-4 py-2 font-medium">氏名・名称</th>
                      <th className="px-4 py-2 font-medium">住所</th>
                      <th className="px-4 py-2 font-medium">持分</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                    {rights.currentOwners.map((o, i) => (
                      <tr key={i}>
                        <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{o.name}</td>
                        <td className="px-4 py-2 text-gray-900 dark:text-gray-100">
                          {o.address ?? <span className="text-gray-400 dark:text-gray-500">（目視で確認）</span>}
                        </td>
                        <td className="px-4 py-2 tabular-nums text-gray-900 dark:text-gray-100">{o.share ?? "単独"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">判定できませんでした（下の注記を確認してください）</p>
            )}
          </section>
        )}

        {rights.hasOtsuku && (
          <section>
            <h4 className={sub}>
              残っている権利 <span className={muted}>（乙区）</span>
            </h4>
            {rights.activeRights.length > 0 ? (
              <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-800">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-gray-800/50 text-left text-xs text-gray-500 dark:text-gray-400">
                    <tr>
                      <th className="px-4 py-2 font-medium">順位</th>
                      <th className="px-4 py-2 font-medium">登記の目的</th>
                      <th className="px-4 py-2 font-medium">債権額・極度額</th>
                      <th className="px-4 py-2 font-medium">権利者</th>
                      <th className="px-4 py-2 font-medium">債務者</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                    {rights.activeRights.map((r) => (
                      <tr key={r.rank}>
                        <td className="whitespace-nowrap px-4 py-2 text-gray-900 dark:text-gray-100">{r.rank}番</td>
                        <td className="px-4 py-2 text-gray-900 dark:text-gray-100">
                          {r.purpose}
                          {r.activeAnnotations > 0 && (
                            <span className="ml-1 text-xs text-gray-400 dark:text-gray-500">付記{r.activeAnnotations}件を反映</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 tabular-nums text-gray-900 dark:text-gray-100">{r.amount ?? "—"}</td>
                        <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{r.holder ?? "—"}</td>
                        <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{r.debtor ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">残っている権利はありません</p>
            )}
          </section>
        )}

        {cancelledTotal > 0 && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            抹消済みと判定：甲区 {rights.cancelled.kouku}件・乙区 {rights.cancelled.otsuku}件（付記を含む）
          </p>
        )}

        <section>
          <h4 className={sub}>注意が必要な登記</h4>
          {rights.cautions.length > 0 ? (
            <ul className="space-y-2">
              {rights.cautions.map((c, i) => (
                <li
                  key={i}
                  className="rounded-md border border-amber-200 dark:border-amber-400/20 bg-amber-50 dark:bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300"
                >
                  {c.section} {c.rank}番「{c.purpose}」が残っています。取引前に内容と解除の見込みを確認してください。
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">ありません</p>
          )}
        </section>

        {rights.notes.length > 0 && (
          <ul className="space-y-1 rounded-md border border-blue-200 dark:border-blue-400/20 bg-blue-50 dark:bg-blue-500/10 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
            {rights.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
