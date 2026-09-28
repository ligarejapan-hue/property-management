/**
 * 「AIで文章を作る」手順の小さな案内(発注者決定 2026-09-27「AIで文章を作る手順も案内に入れる」)。
 * 書類のアイコンで開く文面の枠(お手紙の本文・LP型の文章)の上に出す。
 */
export function AiTextSteps({ saveLabel }: { saveLabel: string }) {
  return (
    <ol className="mt-2 space-y-0.5 rounded bg-indigo-50/60 px-2 py-1.5 text-gray-700 dark:bg-indigo-950/30 dark:text-gray-200">
      <li>① 下の指示文を「コピー」</li>
      <li>② お手元のAI(ChatGPT など)に貼って送る</li>
      <li>③ 返ってきた文章を一番下の欄に貼り、「{saveLabel}」</li>
    </ol>
  );
}
