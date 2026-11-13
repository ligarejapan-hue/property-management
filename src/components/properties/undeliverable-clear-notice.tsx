/**
 * 宛先不明の解除(2026-11-13 発注者決定)の、編集の欄に出す案内とチェック。
 *
 * 「この住所を宛先にする」で所有者の編集を開いたときだけ出す。
 * - 解除できる記録があれば、チェック「古い住所あての宛先不明を解除して DM に戻す」を出す。
 * - 共有でまとめて送った記録・そのほか解除しない記録があれば、その数と理由を出す
 *   (自動では解除しない=発注者決定)。
 * ⚠件数だけを出す(氏名・住所は持たない)。解除は、住所を保存できたあとにだけ行う。
 */
import {
  normalizeAddressForGroup,
  resolveMailingAddress,
  type OwnerAddressFields,
} from "@/lib/owner-mailing-address";

type AddressLike = { [K in keyof OwnerAddressFields]?: string | null };

/**
 * 保存の前後で「実際に郵送する宛先」が変わるか(@codex P2・2026-11-13)。
 * DM の宛先は、現住所があれば現住所・無ければ登記上の住所(resolveMailingAddress)。
 * ⚠現住所が登録されている方は、登記上の住所を替えても宛先は変わらない=宛先不明を解除すると、
 *   届かなかった同じ住所へまた送ることになる。変わらないときは解除しない。
 * 宛先が無くなる(空になる)ときも「変わった」とは扱わない。
 */
export function mailingAddressChanges(before: AddressLike, after: AddressLike): boolean {
  const pick = (o: AddressLike) =>
    normalizeAddressForGroup(
      resolveMailingAddress({
        zip: o.zip ?? null,
        address: o.address ?? null,
        currentZip: o.currentZip ?? null,
        currentAddress: o.currentAddress ?? null,
      }).address,
    );
  const next = pick(after);
  return next !== "" && next !== pick(before);
}

export interface UndeliverableSummaryProps {
  /** 住所を替えたときに解除できる宛先不明の記録の数 */
  clearable: number;
  /** 共有でまとめて送った記録(解除しない)の数 */
  shared: number;
  /** 物件の住所あて・担当できない物件などの記録(解除しない)の数 */
  other: number;
}

export function UndeliverableClearNotice({
  summary,
  checked,
  onChange,
  mailingChanges,
}: {
  summary: UndeliverableSummaryProps | null | undefined;
  checked: boolean;
  onChange: (next: boolean) => void;
  /** いまの入力で保存すると、実際の宛先が変わるか(mailingAddressChanges)。変わらなければ解除しない。 */
  mailingChanges: boolean;
}) {
  if (!summary || summary.clearable + summary.shared + summary.other === 0) return null;
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
      <p className="mb-1 font-semibold">この方には、DMの記録に「宛先不明」があります</p>
      {summary.clearable > 0 && !mailingChanges && (
        <p>
          このまま保存しても、DMの宛先は変わりません（現住所が登録されている方は、DMは現住所あてです）。
          宛先が変わらないあいだは、「宛先不明」は解除しません。
        </p>
      )}
      {summary.clearable > 0 && mailingChanges && (
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>
            古い住所あての「宛先不明」（{summary.clearable}件）を解除して、この方をDMに戻す
            <span className="block text-amber-800/80 dark:text-amber-200/80">
              保存すると、宛先不明の記録は残したまま、DMの対象から外す理由にしなくなります。
              宛先不明が理由で「送らない」になっていた物件は「送付可」に戻ります。
            </span>
          </span>
        </label>
      )}
      {summary.shared > 0 && (
        <p className="mt-1">
          共有の方とまとめて送った「宛先不明」が {summary.shared} 件あります。こちらは自動では解除しません
          （ほかの方は古い住所のままのため）。必要なときは、DM送付履歴で確かめてください。
        </p>
      )}
      {summary.other > 0 && (
        <p className="mt-1">
          このほか、解除しない「宛先不明」が {summary.other} 件あります（物件の住所あてに送ったもの・担当外の物件のものなど）。
        </p>
      )}
      {summary.clearable === 0 && (
        <p className="mt-1">住所を替えても、この方はDMの対象に戻りません。</p>
      )}
    </div>
  );
}

/** 解除の結果を、画面に出す1文にする(件数だけ)。 */
export function undeliverableClearResultMessage(r: {
  cleared: number;
  sharedSkipped: number;
  otherSkipped: number;
  flagsCleared: number;
  dmStatusRestored: number;
}): string {
  const parts: string[] = [];
  if (r.cleared > 0) {
    parts.push(`「宛先不明」を ${r.cleared} 件解除しました。`);
    if (r.dmStatusRestored > 0) parts.push(`DM可否を「送付可」に戻した物件: ${r.dmStatusRestored} 件。`);
  } else {
    parts.push("解除できる「宛先不明」はありませんでした。");
  }
  const left = r.sharedSkipped + r.otherSkipped;
  if (left > 0) {
    parts.push(`解除していない「宛先不明」が ${left} 件残っています（共有でまとめて送ったものなど）。この方はまだDMの対象に戻りません。`);
  }
  return parts.join("");
}
