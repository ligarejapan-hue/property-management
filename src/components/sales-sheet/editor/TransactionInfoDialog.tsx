"use client";

import { useState } from "react";
import type { FooterBandData } from "@/lib/sales-sheet/footer-band";
import { TRANSACTION_TYPE, AD_TYPE, COMPENSATION } from "@/lib/sales-sheet/option-master";

/**
 * select の選択肢を組む。「選択してください」＋プリセット選択肢に加え、現在値が
 * プリセットに無い(旧データ/作成APIが受ける任意文字列)場合はその値の一時 option を
 * 先頭に足す。これが無いと選択肢外の既存値は select が空欄表示になり、ユーザーが
 * 「未設定」と誤認して上書き＝値を黙って失うため。
 */
function SelectOptions({ value, options }: { value: string; options: readonly string[] }) {
  const inList = (options as readonly string[]).includes(value);
  return (
    <>
      <option value="">選択してください</option>
      {value !== "" && !inList && <option value={value}>{value}</option>}
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </>
  );
}

/**
 * 会社帯の物件別6項目(取引態様/広告/報酬/担当者/取引士/特記事項)を
 * まとめて編集するモーダル。開いた時点の initial を初期値とし、「適用」で
 * onApply(現在値) を1回だけ呼ぶ(帯の取引部分の再生成は親の editFooterData 側)。
 */
export function TransactionInfoDialog({
  open,
  initial,
  onApply,
  onClose,
}: {
  open: boolean;
  initial: FooterBandData;
  onApply: (data: FooterBandData) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<FooterBandData>(initial);
  if (!open) return null;

  const set = (patch: Partial<FooterBandData>) => setValues((v) => ({ ...v, ...patch }));
  const labelCls = "w-24 shrink-0 text-sm text-gray-700 dark:text-gray-300";
  const fieldCls =
    "flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className="w-full max-w-[380px] rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-800"
        data-transaction-info-dialog
      >
        <h2 className="mb-3 text-base font-bold text-gray-900 dark:text-gray-100">取引情報</h2>
        <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
          物件ごとに変わる項目です。空欄にすると図面の帯からその行は消えます。
        </p>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label htmlFor="tx-transaction-type" className={labelCls}>取引態様</label>
            <select
              id="tx-transaction-type"
              aria-label="取引態様"
              value={values.transactionType ?? ""}
              onChange={(e) => set({ transactionType: e.target.value })}
              className={fieldCls}
            >
              <SelectOptions value={values.transactionType ?? ""} options={TRANSACTION_TYPE} />
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="tx-ad-type" className={labelCls}>広告</label>
            <select
              id="tx-ad-type"
              aria-label="広告"
              value={values.adType ?? ""}
              onChange={(e) => set({ adType: e.target.value })}
              className={fieldCls}
            >
              <SelectOptions value={values.adType ?? ""} options={AD_TYPE} />
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="tx-compensation" className={labelCls}>報酬</label>
            <input
              id="tx-compensation"
              aria-label="報酬"
              list="tx-compensation-list"
              value={values.compensation ?? ""}
              onChange={(e) => set({ compensation: e.target.value })}
              className={fieldCls}
            />
            <datalist id="tx-compensation-list">
              {COMPENSATION.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="tx-staff" className={labelCls}>担当者</label>
            <input
              id="tx-staff"
              aria-label="担当者"
              value={values.staff ?? ""}
              onChange={(e) => set({ staff: e.target.value })}
              className={fieldCls}
            />
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="tx-agent" className={labelCls}>取引士</label>
            <input
              id="tx-agent"
              aria-label="取引士"
              value={values.agent ?? ""}
              onChange={(e) => set({ agent: e.target.value })}
              className={fieldCls}
            />
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="tx-special-notes" className={labelCls}>特記事項</label>
            <input
              id="tx-special-notes"
              aria-label="特記事項"
              value={values.specialNotes ?? ""}
              onChange={(e) => set({ specialNotes: e.target.value })}
              className={fieldCls}
            />
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-neutral-700"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => onApply(values)}
            className="rounded bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            適用
          </button>
        </div>
      </div>
    </div>
  );
}
