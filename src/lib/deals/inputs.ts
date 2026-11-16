import {
  DEFAULT_ASSESSMENTS, DEFAULT_COSTS, DEFAULT_TERMS, OVERRIDE_KEYS, assessmentsSchema, costsSchema, leaseSchema,
  paymentEntrySchema, settlementTermsSchema, yenInt, PAYMENT_FIXED_KEYS,
  type Assessments, type Costs, type Lease, type Overrides, type PaymentEntry, type Payments, type SettlementTerms,
} from "./schemas";

const obj = (json: unknown): Record<string, unknown> =>
  json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};

/** 保存済みの JSON を読む。足りない項目は初期値で補い、それでも壊れていれば初期値(段1で入れた空の値も読める)。 */
export function readAssessments(json: unknown): Assessments {
  const r = assessmentsSchema.safeParse({ ...DEFAULT_ASSESSMENTS, ...obj(json) });
  return r.success ? r.data : DEFAULT_ASSESSMENTS;
}
export function readCosts(json: unknown): Costs {
  const r = costsSchema.safeParse({ ...DEFAULT_COSTS, ...obj(json) });
  return r.success ? r.data : DEFAULT_COSTS;
}
/**
 * 精算の条件を読む。overrides は取引の上書きの JSON(作り直し前の取引の読み方を決めるため)。
 * 入力のしかたが無い(作り直し前の)取引は、年税額が入っているか、固都税を手で直した値があれば「合計額だけ」として読む
 * (年税額が空でも、手で直した値で精算していた取引の行を消さない・最終レビュー I-1)。
 */
export function readTerms(json: unknown, overrides?: unknown): SettlementTerms {
  const src = obj(json);
  const legacyTotal = src.taxInputMode === undefined && (
    typeof src.fixedAssetTax === "number" || typeof src.cityPlanningTax === "number"
    || obj(overrides)["settlement.propertyTax"] !== undefined
  );
  const r = settlementTermsSchema.safeParse({ ...DEFAULT_TERMS, ...(legacyTotal ? { taxInputMode: "total" } : {}), ...src });
  return r.success ? r.data : DEFAULT_TERMS;
}
/** 賃貸条件は行ごとに読み、壊れた行だけ落とす。 */
export function readLeases(json: unknown): Lease[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((row) => {
    const r = leaseSchema.safeParse(row);
    return r.success ? [r.data] : [];
  });
}
/** お金の受け渡しは項目ごとに読み、壊れた項目だけ落とす(落ちた項目は「未定」)。 */
export function readPayments(json: unknown): Payments {
  const src = obj(json);
  const out: Payments = {};
  for (const k of PAYMENT_FIXED_KEYS) {
    const r = paymentEntrySchema.safeParse(src[k]);
    // 「残金と一緒に」は精算金だけ(ほかの鍵に入っていたら未定として読む)。
    if (r.success) out[k] = k !== "settlement" && r.data.method === "with_balance" ? { ...r.data, method: "undecided" } : r.data;
  }
  const others: Record<string, PaymentEntry> = {};
  for (const [label, v] of Object.entries(obj(src.others))) {
    const r = paymentEntrySchema.safeParse(v);
    if (r.success && label.trim() !== "" && label.length <= 50) others[label] = r.data.method === "with_balance" ? { ...r.data, method: "undecided" } : r.data;
  }
  if (Object.keys(others).length > 0) out.others = others;
  return out;
}
export function readOverrides(json: unknown): Overrides {
  const src = obj(json);
  const out: Overrides = {};
  for (const k of OVERRIDE_KEYS) {
    const r = yenInt.safeParse(src[k]);
    if (r.success) out[k] = r.data;
  }
  return out;
}
