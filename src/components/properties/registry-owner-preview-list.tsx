/**
 * 添付済みの謄本から読み取った所有者の下見。
 *
 * 表示だけの部品(状態を持たない)。確認ダイアログの中身として使う。
 * 単体テストは `renderToStaticMarkup` で行うため、ここに副作用を持ち込まないこと。
 */
import type { RegistryOwnerCandidate } from "@/lib/api-client";

export interface RegistryOwnerPreviewListProps {
  owners: RegistryOwnerCandidate[];
  /**
   * 読み取り元の謄本の呼び名。どの書類から入るのかを示す。
   * ⚠**生ファイル名は渡さない**(氏名や住所を含みうる)。固定の呼び名を使う。
   */
  fileName: string;
}

export default function RegistryOwnerPreviewList({
  owners,
  fileName,
}: RegistryOwnerPreviewListProps) {
  if (owners.length === 0) {
    return (
      <p className="text-sm text-gray-600 dark:text-gray-300">
        この謄本から所有者を読み取れませんでした。お手数ですが「所有者を追加」から手入力してください。
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600 dark:text-gray-300">
        <span className="font-medium">{fileName}</span> から、次の
        {owners.length}名を登録します。
      </p>
      <ul className="divide-y divide-gray-200 rounded-md border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
        {owners.map((owner, index) => (
          <li key={`${owner.name}-${index}`} className="px-3 py-2">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {owner.name}
              </span>
              {owner.share ? (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  持分 {owner.share}
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
              {owner.address ?? "住所は読み取れませんでした（あとから入力できます）"}
            </p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        氏名と住所がそのまま登録されます。違っていれば「やめる」を押して、手入力してください。
      </p>
      {owners.some((o) => o.share) ? (
        // ⚠持分の割合を保存する場所が無い(所有者の欄にも紐付けの欄にも無い)。
        //   いまは「共有者」という区分になるだけなので、登録されると書かない。
        <p className="text-xs text-amber-700 dark:text-amber-400">
          持分の割合は保存されません。共有者として登録され、割合が必要な場合は備考などに手入力してください。
        </p>
      ) : null}
    </div>
  );
}
