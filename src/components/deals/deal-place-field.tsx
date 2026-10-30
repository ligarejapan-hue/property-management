import { Field, SelectBox, inputCls } from "./form-parts";
import {
  PLACE_BANK_PART_MAX, PLACE_KIND_BANK, PLACE_KIND_OTHER, PLACE_OTHER_MAX, placeKindsFor, placeProblem, type PlaceForm,
} from "@/lib/deals/place";

/** 契約場所・決済場所。選ぶ欄+「その他」は場所、「銀行」は銀行名と支店名の手入力の欄を出す。 */
export function DealPlaceField({
  label, allowBank, value, onChange,
}: { label: string; allowBank: boolean; value: PlaceForm; onChange: (v: PlaceForm) => void }) {
  const problem = placeProblem(value);
  return (
    <div className="space-y-2">
      <Field label={label}>
        <SelectBox
          label={label}
          value={value.kind}
          onChange={(kind) => onChange({ ...value, kind })}
          options={placeKindsFor(allowBank).map((k) => ({ value: k, label: k }))}
          allowEmpty
        />
      </Field>
      {value.kind === PLACE_KIND_OTHER && (
        <Field label="場所">
          <input
            value={value.other} onChange={(e) => onChange({ ...value, other: e.target.value })}
            maxLength={PLACE_OTHER_MAX} aria-label={`${label}(場所)`} className={inputCls}
          />
        </Field>
      )}
      {value.kind === PLACE_KIND_BANK && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="銀行名">
            <input
              value={value.bank} onChange={(e) => onChange({ ...value, bank: e.target.value })}
              maxLength={PLACE_BANK_PART_MAX} aria-label={`${label}(銀行名)`} className={inputCls}
            />
          </Field>
          <Field label="支店名">
            <input
              value={value.branch} onChange={(e) => onChange({ ...value, branch: e.target.value })}
              maxLength={PLACE_BANK_PART_MAX} aria-label={`${label}(支店名)`} className={inputCls}
            />
          </Field>
        </div>
      )}
      {problem && <p className="text-xs text-amber-700 dark:text-amber-400">{problem}</p>}
    </div>
  );
}
