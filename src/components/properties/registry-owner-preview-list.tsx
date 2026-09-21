/**
 * 添付済みの謄本から読み取った所有者の下見。
 *
 * 表示だけの部品(状態を持たない)。確認ダイアログの中身として使う。
 * 単体テストは `renderToStaticMarkup` で行うため、ここに副作用を持ち込まないこと。
 */
import type { RegistryOwnerCandidate } from "@/lib/api-client";

export interface RegistryOwnerPreviewListProps {
  owners: RegistryOwnerCandidate[];
  /** 読み取り元の謄本のファイル名。どの書類から入るのかを明示する。 */
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
        ここに出ている内容がそのまま登録されます。違っていれば「やめる」を押して、手入力してください。
      </p>
    </div>
  );
}
