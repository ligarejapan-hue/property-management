// 入力イベントごとの即時処理を間引くための debounce ユーティリティ。
// 連続呼び出しでは「最後の呼び出しから waitMs 経過後」に一度だけ fn を実行する。
// cancel() で保留中の実行を取り消す（アンマウント時・リセット時に使う）。
//
// 物件一覧の検索入力（keyword / 管理ID）に使い、毎キーストロークの
// /api/properties 再取得＝property_list 監査ログ量産を防ぐ目的で導入した。
export type DebouncedFunction<Args extends unknown[]> = {
  (...args: Args): void;
  cancel: () => void;
};

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
): DebouncedFunction<Args> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const debounced = (...args: Args): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };

  const result = debounced as DebouncedFunction<Args>;
  result.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return result;
}
