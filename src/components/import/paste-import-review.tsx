"use client";

/**
 * 「貼り付けて物件化」確認画面の表示部品（Task 9）。
 *
 * 左に貼った原文、右に読み取り結果。読み取り結果の各欄は次の3状態を
 * 見た目で区別する:
 *   ① 拾えた   → 値 + どの見出しから来たかを小さく添える(emerald)
 *   ② 資料に無い → 空欄 + 「元の資料に記載がありません」(dashed gray・推測で埋めない)
 *   ③ 要確認   → 値 + 警告文(amber。今のところ物件種別が判別できなかった場合のみ)
 *
 * 値の保持は呼び出し元(page.tsx)が行う。この部品は`propertyValues`等の
 * controlled props を受け取り、`onXxxChange`へ差分を返すだけ(状態を持たない)。
 * ただし単体表示・テスト用に、props省略時は draft からそのまま初期値を作る。
 */
import type { ChangeEvent } from "react";
import Link from "next/link";
import type { DraftWarningCode, PasteDraft } from "@/lib/paste-import/types";
import { PROPERTY_TYPE_OPTIONS } from "@/lib/property-types";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// API 契約（POST /api/import/paste のレスポンスの一部）。
// この部品でしか使わないのでここに置く。page.tsx から re-export して使う。
// ---------------------------------------------------------------------------

export interface PasteDuplicatesResult {
  blocked: boolean;
  blockedByPropertyId: string | null;
  similarPropertyIds: string[];
}

export interface SimilarPropertySummary {
  id: string;
  address: string | null;
  lotNumber: string | null;
}

export type OwnerMatchKind = "current_address" | "registry_address" | "name_only";

export interface OwnerCandidateSummary {
  id: string;
  name: string;
  matchKind: OwnerMatchKind;
  /** 表示レベルを通した住所（**実際に一致した方**。name_only なら参考として1つ）。 */
  address: string | null;
  /** 上の住所がどちらの欄のものか（札と食い違わせないために必ず添える）。 */
  addressKind: "current" | "registry" | null;
  /** その所有者に紐づく物件の件数（非個人情報の識別の手がかり）。 */
  propertyCount: number;
}

const MATCH_KIND_LABELS: Record<OwnerMatchKind, string> = {
  current_address: "連絡先の住所も一致",
  registry_address: "登記上の住所と一致",
  name_only: "氏名だけ一致（同姓同名の別人かもしれません）",
};

/**
 * 所有者候補1件の表示文。
 *
 * ⚠**2つの候補が完全に同じ表示になってはいけない**(@codex PR#414 8巡目 ②)。
 *   氏名と一致種別だけだと、同姓同名・同一致種別の候補が**すべて同じ文字**に見え、
 *   どれを選んでいるか分からないまま選ぶことになる。別人に紐付ければ
 *   **他人にDMが届く**。
 * ⚠住所は表示レベルで伏せられうるので、住所だけに頼らない。
 *   所有物件の件数（非個人情報）と、所有者の管理番号（先頭8桁。応答に元から
 *   含まれている id の一部で、新たな露出ではない）を必ず添える。
 *   → **どの2件も必ず違う表示になる**（id が違えば必ず違う）。
 */
export function ownerCandidateLabel(c: OwnerCandidateSummary): string {
  const parts = [MATCH_KIND_LABELS[c.matchKind], `所有物件 ${c.propertyCount}件`];
  if (c.address) {
    // ⚠どちらの住所かを必ず添える。「登記上の住所と一致」の隣に
    //   連絡先住所が並ぶと、利用者は「この住所が一致した」と読んでしまう。
    const kind =
      c.addressKind === "registry"
        ? "登記上住所"
        : c.addressKind === "current"
          ? "連絡先住所"
          : null;
    parts.push(kind === null ? c.address : `${kind}: ${c.address}`);
  }
  parts.push(`管理番号 ${c.id.slice(0, 8)}`);
  return `${c.name}（${parts.join(" / ")}）`;
}

export type OwnerMode = "link" | "new" | "none";

export type PropertyFieldKey = keyof PasteDraft["property"];
export type PropertyValues = Record<PropertyFieldKey, string>;

export type OwnerFieldKey = "name" | "nameKana" | "phone" | "email" | "currentAddress";
export type OwnerValues = Record<OwnerFieldKey, string>;

const OCCUPANCY_OPTIONS: { value: string; label: string }[] = [
  { value: "vacant", label: "空室" },
  { value: "occupied", label: "入居中" },
  { value: "unknown", label: "不明" },
];

/** 欄の並び（設計書のサンプルに合わせた順）。 */
const PROPERTY_FIELD_LABELS: { key: PropertyFieldKey; label: string }[] = [
  { key: "address", label: "住所" },
  { key: "lotNumber", label: "地番" },
  { key: "buildingName", label: "建物名" },
  { key: "roomNo", label: "部屋番号" },
  { key: "propertyType", label: "種別" },
  { key: "exclusiveArea", label: "専有面積(m²)" },
  { key: "landArea", label: "土地面積(m²)" },
  { key: "layoutType", label: "間取り" },
  { key: "occupancyStatus", label: "現況" },
  { key: "builtYear", label: "築年" },
];

const OWNER_FIELD_LABELS: { key: OwnerFieldKey; label: string }[] = [
  { key: "name", label: "氏名" },
  { key: "nameKana", label: "フリガナ" },
  { key: "phone", label: "電話番号" },
  { key: "email", label: "メールアドレス" },
  { key: "currentAddress", label: "現住所" },
];

/**
 * 直したら**重複の見直し**を起こす欄。
 * ⚠住所の重複は登録APIが意図的にブロックしない(人が判断すべきなので)＝
 *   画面の警告が唯一の防御線。直したあとに効かないままでは防御にならない。
 */
export const DUPLICATE_INPUT_FIELDS: ReadonlySet<string> = new Set(["address", "lotNumber"]);
export const DUPLICATE_OWNER_FIELDS: ReadonlySet<string> = new Set(["name", "currentAddress"]);

/** 欄ごとに紐づく警告コード(要確認状態を出す欄のみ)。 */
const FIELD_WARNING_CODE: Partial<Record<PropertyFieldKey, DraftWarningCode>> = {
  propertyType: "property_type_unknown",
};

/**
 * ⚠Property に対応する列が無い欄(レビュー指摘: Critical/Important)。
 * `landArea`(土地面積)は元々 Property に列が無い。`builtYear`(築年)も、
 * schema.prisma の `builtYear Int? @map("built_year")` は Building モデルの列であり
 * Property モデルには同名の列が存在しない(確認: `awk '/^model Property \{/,/^\}/'
 * prisma/schema.prisma | grep -i built` はヒットなし)。/api/import/paste/commit の
 * CommitBody.property にもどちらの欄も無い(レビュー済みAPI契約そのまま)。
 * migration 追加は設計書で禁止されているため、値があれば備考へ行として足す
 * (`foldNoColumnFieldsIntoNote`)。欄自体は編集可能なまま残し、その旨をここで明記する。
 */
const FIELD_NO_COLUMN_HINT: Partial<Record<PropertyFieldKey, string>> = {
  landArea: "※専用の欄が無いため、備考に記録されます",
  builtYear: "※専用の欄が無いため、備考に記録されます",
};

/** 備考の行として使う日本語ラベル(登録時に "ラベル: 値" の形で備考へ足す)。 */
const NOTE_ONLY_FIELD_LABEL: Record<"landArea" | "builtYear", string> = {
  landArea: "土地面積",
  builtYear: "築年",
};

/**
 * 専用の DB 列が無い欄(土地面積・築年)の値を、既存の備考を消さずに行として足す。
 * 値が無い欄は行を足さない。両方無ければ元の備考をそのまま返す(空洞な空行を作らない)。
 */
/**
 * 人が専用欄に値を入れた項目について、備考に残っている**生値の行を取り除く**。
 *
 * ⚠追記だけだと矛盾した2行が並ぶ(@codex PR#414 11巡目 ②):
 *   `土地面積: 20坪（66.1㎡）`(読み取れなかった生値) と
 *   `土地面積: 66.1`(人が入れた値) が備考に同居する。
 * ⚠欄を**空のままにしたら生値の行は残す**(情報を失わない)。
 * ⚠取り除くのは `見出し: 生値` に**完全一致する行だけ**。人が備考を自分で
 *   書き換えていたら触らない。
 */
export function stripFilledRawLines(
  note: string,
  unreadable: PasteDraft["unreadable"],
  values: Record<string, string>,
): string {
  const targets = new Set(
    unreadable
      .filter((u) => (values[u.field] ?? "").trim() !== "")
      .map((u) => `${u.label}: ${u.value}`),
  );
  if (targets.size === 0) return note;
  return note
    .split("\n")
    .filter((line) => !targets.has(line.trim()))
    .join("\n")
    .trim();
}

export function foldNoColumnFieldsIntoNote(
  baseNote: string,
  values: { landArea: string; builtYear: string },
): string {
  const extraLines: string[] = [];
  if (values.landArea.trim() !== "") {
    extraLines.push(`${NOTE_ONLY_FIELD_LABEL.landArea}: ${values.landArea.trim()}`);
  }
  if (values.builtYear.trim() !== "") {
    extraLines.push(`${NOTE_ONLY_FIELD_LABEL.builtYear}: ${values.builtYear.trim()}`);
  }
  if (extraLines.length === 0) return baseNote;
  const base = baseNote.trim();
  return base === "" ? extraLines.join("\n") : `${base}\n${extraLines.join("\n")}`;
}

export function defaultPropertyValues(draft: PasteDraft): PropertyValues {
  return {
    address: draft.property.address.value ?? "",
    lotNumber: draft.property.lotNumber.value ?? "",
    buildingName: draft.property.buildingName.value ?? "",
    roomNo: draft.property.roomNo.value ?? "",
    propertyType: draft.property.propertyType.value ?? "",
    exclusiveArea: draft.property.exclusiveArea.value ?? "",
    landArea: draft.property.landArea.value ?? "",
    layoutType: draft.property.layoutType.value ?? "",
    occupancyStatus: draft.property.occupancyStatus.value ?? "",
    builtYear: draft.property.builtYear.value ?? "",
  };
}

export function defaultOwnerValues(draft: PasteDraft): OwnerValues {
  const o = draft.owner;
  return {
    name: o?.name.value ?? "",
    nameKana: o?.nameKana.value ?? "",
    phone: o?.phone.value ?? "",
    email: o?.email.value ?? "",
    currentAddress: o?.currentAddress.value ?? "",
  };
}

export function defaultOwnerMode(draft: PasteDraft): OwnerMode {
  return draft.owner ? "new" : "none";
}

// ---------------------------------------------------------------------------
// FieldRow: 1つの欄。3状態を見た目で分ける。
// ---------------------------------------------------------------------------

const BOX_BASE = "w-full rounded-md border px-3 py-2 text-sm";
const BOX_OK = `${BOX_BASE} border-emerald-600 bg-emerald-50 dark:border-emerald-500 dark:bg-emerald-500/10 dark:text-gray-100`;
const BOX_MISSING = `${BOX_BASE} border-dashed border-gray-300 bg-gray-50 text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300`;
const BOX_WARN = `${BOX_BASE} border-amber-400 bg-amber-50 dark:border-amber-500 dark:bg-amber-500/10 dark:text-gray-100`;

function FieldRow({
  fieldKey,
  label,
  value,
  sourceLabel,
  warningMessage,
  noColumnHint,
  onChange,
  onBlur,
  selectOptions,
  disabled,
}: {
  fieldKey: string;
  label: string;
  value: string;
  sourceLabel: string | null;
  warningMessage?: string;
  /** 専用のDB列が無い欄への案内(常に表示。値の有無に関係ない固定の注意書き)。 */
  noColumnHint?: string;
  onChange?: (value: string) => void;
  /** 入力を終えた（フォーカスが外れた）とき。重複の見直しを起こすために使う。 */
  onBlur?: () => void;
  selectOptions?: { value: string; label: string }[];
  /** 登録処理中は編集させない(直したつもりで無視される事故を防ぐ)。 */
  disabled?: boolean;
}) {
  const hasValue = value.trim() !== "";
  // ⚠**警告があるときは「元の資料に記載がありません」を出さない**
  //   (@codex PR#414 9巡目 ②)。元資料には書いてあるのに読み取れなかった、という
  //   場合にそう出すのは利用者への嘘になる。警告のほうを出す。
  const boxClass = warningMessage ? BOX_WARN : !hasValue ? BOX_MISSING : BOX_OK;
  const handleChange = (
    e: ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => onChange?.(e.target.value);

  return (
    <div
      data-field={fieldKey}
      data-value={hasValue ? value : undefined}
      className="grid grid-cols-1 gap-1 border-b border-dashed border-gray-200 py-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3 dark:border-gray-700"
    >
      <label htmlFor={`paste-field-${fieldKey}`} className="pt-2 text-xs font-medium text-gray-500 dark:text-gray-400">
        {label}
      </label>
      <div>
        {selectOptions ? (
          <select
            id={`paste-field-${fieldKey}`}
            className={boxClass}
            value={value}
            onChange={handleChange}
            onBlur={onBlur}
            disabled={disabled}
          >
            <option value="">（未選択）</option>
            {selectOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={`paste-field-${fieldKey}`}
            type="text"
            className={boxClass}
            value={value}
            onChange={handleChange}
            onBlur={onBlur}
            disabled={disabled}
          />
        )}
        {hasValue && sourceLabel && (
          <span className="mt-0.5 block text-[10px] text-gray-400 dark:text-gray-500">
            {sourceLabel} から
          </span>
        )}
        {!hasValue && !warningMessage && (
          <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
            元の資料に記載がありません
          </p>
        )}
        {warningMessage && (
          <p role="alert" className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400">
            {warningMessage}
          </p>
        )}
        {noColumnHint && (
          <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">
            {noColumnHint}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PasteImportReview 本体
// ---------------------------------------------------------------------------

export interface PasteImportReviewProps {
  draft: PasteDraft;
  rawText: string;

  propertyValues?: PropertyValues;
  onPropertyFieldChange?: (key: PropertyFieldKey, value: string) => void;

  ownerValues?: OwnerValues;
  onOwnerFieldChange?: (key: OwnerFieldKey, value: string) => void;

  note?: string;
  onNoteChange?: (value: string) => void;

  /**
   * 査定ナンバー等の外部キー。⚠**人が確認・修正できる欄として出す**
   * (設計書 §5.4「どの欄も編集できる」/ @codex PR#414 6巡目 ①)。
   * 誤った番号が保存されると、後日その番号の本物の反響が
   * 「登録済みです」で弾かれ、誤りが将来に持ち越される。
   */
  externalLinkKey?: string;
  onExternalLinkKeyChange?: (value: string) => void;

  /**
   * 住所・地番・査定ナンバー・所有者の氏名/現住所を**直し終えた**とき。
   * 呼び出し側が重複の見直し(/api/import/paste/recheck)を起こす。
   */
  onDuplicateInputBlur?: () => void;
  /** 見直しに失敗したときの断り(黙って古い判定のままにしない)。 */
  recheckError?: string | null;

  duplicates?: PasteDuplicatesResult;
  similar?: SimilarPropertySummary[];

  ownerCandidates?: OwnerCandidateSummary[];
  ownerMode?: OwnerMode;
  onOwnerModeChange?: (mode: OwnerMode) => void;
  linkedOwnerId?: string | null;
  onLinkedOwnerChange?: (ownerId: string) => void;

  onRegister?: () => void;
  registering?: boolean;
  registerError?: string | null;
}

export function PasteImportReview({
  draft,
  rawText,
  propertyValues,
  onPropertyFieldChange,
  ownerValues,
  onOwnerFieldChange,
  note,
  onNoteChange,
  externalLinkKey,
  onExternalLinkKeyChange,
  onDuplicateInputBlur,
  recheckError,
  duplicates,
  similar,
  ownerCandidates,
  ownerMode,
  onOwnerModeChange,
  linkedOwnerId,
  onLinkedOwnerChange,
  onRegister,
  registering,
  registerError,
}: PasteImportReviewProps) {
  const pValues = propertyValues ?? defaultPropertyValues(draft);
  const oValues = ownerValues ?? defaultOwnerValues(draft);
  const noteValue = note ?? draft.noteFromUnmapped;
  const externalKeyValue = externalLinkKey ?? draft.externalLinkKey ?? "";
  const dup = duplicates ?? { blocked: false, blockedByPropertyId: null, similarPropertyIds: [] };
  const similarList = similar ?? [];
  const candidates = ownerCandidates ?? [];
  const mode = ownerMode ?? defaultOwnerMode(draft);

  /**
   * ⚠「新しい所有者として登録する」を選んだまま氏名が空のとき、**登録を止める**
   *   (@codex PR#414 4巡目)。以前は氏名を消した瞬間に owner が null に落ち、
   *   そのまま登録すると**所有者なしで成功**して、入力済みの電話・メール・住所も
   *   捨てられていた。画面は「新しい所有者として登録する」を選んだままなのに、である。
   *   「所有者なしで登録する」という選択肢は別に用意してあるので、
   *   利用者が選んだ意図を勝手に読み替えない。
   */
  const ownerNameMissing = mode === "new" && oValues.name.trim() === "";
  /**
   * ⚠「既存の所有者に紐付ける」を選んだのに相手が選ばれていない状態
   *   (@codex PR#414 8巡目 ①)。再判定で候補が入れ替わると起こりうる。
   *   **見えない紐付けのまま登録させない**。
   */
  const linkTargetMissing = mode === "link" && !linkedOwnerId;
  /**
   * ⚠登録処理中（再判定・PDFのアップロードを含む）は**入力欄とラジオも触らせない**
   *   (@codex PR#414 9巡目 ③)。ボタンだけ止めていた頃は、「登録しています…」の
   *   間に直しても登録は捕捉済みの値で進み、**その修正は黙って無視された**。
   *   利用者は直したつもりでいる。
   */
  const busy = Boolean(registering);
  const blockReason = dup.blocked
    ? "この案件は登録済みのため登録できません"
    : ownerNameMissing
      ? "所有者の氏名を入力してください（所有者を作らない場合は「所有者なしで登録する」を選んでください）"
      : linkTargetMissing
        ? "紐付ける所有者が選ばれていません"
        : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      {/* 左: 貼った原文 */}
      <section>
        <h2 className="mb-2 text-xs font-bold tracking-wider text-gray-500 dark:text-gray-400">
          貼った原文
        </h2>
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-gray-200 bg-gray-50 p-3 text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
          {rawText}
        </pre>

        {/*
          「項目名：値」の形になっていなかった行(設計書 §4.2 の unlabeled)。
          ⚠**下書きに持たせるだけでは意味が無い**ので、ここに出して原文と
            突き合わせられるようにする。自由記述の連絡事項がここに落ちるため、
            右側の欄に入っていない情報がないかを人が確かめられる。
        */}
        {draft.unlabeled.length > 0 && (
          <div data-section="unlabeled" className="mt-3">
            <h3 className="mb-1 text-xs font-bold tracking-wider text-gray-500 dark:text-gray-400">
              項目として読み取れなかった行（{draft.unlabeled.length}行）
            </h3>
            <p className="mb-1 text-[11px] text-gray-500 dark:text-gray-400">
              「項目名：値」の形になっていないため、どの欄にも入っていません。必要な内容があれば、右の欄か備考へ手で写してください。
            </p>
            <ul className="max-h-40 list-disc overflow-auto rounded-md border border-dashed border-gray-300 bg-gray-50 py-2 pl-6 pr-3 text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300">
              {draft.unlabeled.map((line, i) => (
                <li key={`${i}-${line}`}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* 右: 読み取り結果 */}
      <section>
        <h2 className="mb-2 text-xs font-bold tracking-wider text-gray-500 dark:text-gray-400">
          読み取り結果（{draft.sourceProfileLabel}）
        </h2>

        {draft.warnings.map((w) => (
          <div
            key={w.code}
            role="alert"
            className="mb-3 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500 dark:bg-amber-950/40 dark:text-amber-300"
          >
            {w.message}
          </div>
        ))}

        {/*
          ⚠断りの帯は **blocked だけ**を条件にする。id の有無で出し分けない。
            サーバーは「ブロック相手が担当外の物件なら blocked は残して id だけ
            null にする」( /api/import/paste )。id を条件に足すと、その組み合わせで
            帯が消え、利用者に見えるのは**押せない灰色のボタンだけ**になる
            (理由は title 属性のみ＝スマホでは出ない)。サーバーが blocked を
            残した意味が画面の手前で消える。
        */}
        {dup.blocked && (
          <div
            role="alert"
            className="mb-3 rounded-md border border-red-400 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-500 dark:bg-red-950/40 dark:text-red-300"
          >
            この案件は登録済みです。{" "}
            {dup.blockedByPropertyId ? (
              <Link href={`/properties/${dup.blockedByPropertyId}`} className="underline">
                既存の物件を見る
              </Link>
            ) : (
              <span>（登録済みの物件は、担当外のため開けません。担当者にご確認ください）</span>
            )}
          </div>
        )}

        {similarList.length > 0 && (
          <div
            role="alert"
            className="mb-3 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500 dark:bg-amber-950/40 dark:text-amber-300"
          >
            似た物件が見つかりました。二重登録でないか確認してください（登録はブロックしません）。
            <ul className="mt-1 list-disc pl-5">
              {similarList.map((s) => (
                <li key={s.id}>
                  <Link href={`/properties/${s.id}`} className="underline">
                    {s.address ?? s.lotNumber ?? s.id}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {recheckError && (
          <div
            role="alert"
            className="mb-3 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500 dark:bg-amber-950/40 dark:text-amber-300"
          >
            {recheckError}
          </div>
        )}

        {/* 査定ナンバー(外部キー)。他の欄と同じように確認・修正できる。 */}
        <FieldRow
          fieldKey="externalLinkKey"
          label="査定ナンバー"
          value={externalKeyValue}
          sourceLabel={null}
          noColumnHint="※同じ番号の物件は登録できません。空にすると住所で判断します"
          onChange={(v) => onExternalLinkKeyChange?.(v)}
          onBlur={onDuplicateInputBlur}
          disabled={busy}
        />

        {PROPERTY_FIELD_LABELS.map((f) => {
          const draftField = draft.property[f.key];
          // ⚠欄に紐づく警告は **field** で引く(値を読み取れなかった警告はここに来る)。
          //   従来の code 指定は残す(片方だけ直る食い違いを作らない)。
          const warningCode = FIELD_WARNING_CODE[f.key];
          const warning =
            draft.warnings.find((w) => w.field === f.key) ??
            (warningCode ? draft.warnings.find((w) => w.code === warningCode) : undefined);
          return (
            <FieldRow
              key={f.key}
              fieldKey={f.key}
              label={f.label}
              value={pValues[f.key]}
              sourceLabel={draftField.sourceLabel}
              warningMessage={warning?.message}
              noColumnHint={FIELD_NO_COLUMN_HINT[f.key]}
              onChange={(v) => onPropertyFieldChange?.(f.key, v)}
              onBlur={DUPLICATE_INPUT_FIELDS.has(f.key) ? onDuplicateInputBlur : undefined}
              disabled={busy}
              selectOptions={
                f.key === "propertyType"
                  ? PROPERTY_TYPE_OPTIONS.filter((o) =>
                      ["land", "house", "apartment_unit", "apartment_building", "apartment_block", "store", "office", "warehouse", "factory", "parking", "other", "unknown"].includes(o.value),
                    )
                  : f.key === "occupancyStatus"
                    ? OCCUPANCY_OPTIONS
                    : undefined
              }
            />
          );
        })}

        {/* 備考: 辞書に無かった見出しをまとめたもの。人が直せる */}
        <div className="grid grid-cols-1 gap-1 border-b border-dashed border-gray-200 py-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3 dark:border-gray-700">
          <label htmlFor="paste-field-note" className="pt-2 text-xs font-medium text-gray-500 dark:text-gray-400">
            備考
          </label>
          <div>
            <textarea
              id="paste-field-note"
              rows={3}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              value={noteValue}
              onChange={(e) => onNoteChange?.(e.target.value)}
              aria-describedby="paste-field-note-visibility"
              disabled={busy}
            />
            {/*
              ⚠備考には、辞書に無かった見出しがそのまま入る(実サンプルの査定依頼には
                「年齢: 71 歳」が含まれる)。発注者の判断で**情報は落とさない**ため
                除外はしないが、備考は所有者欄のような項目ごとの表示制限の外にあり、
                物件を見られる人全員に見える。その事実をここで明示する
                (全体レビュー I-7)。
            */}
            <p
              id="paste-field-note-visibility"
              className="mt-1 text-[11px] text-amber-700 dark:text-amber-400"
            >
              ⚠ 備考に書いた内容は、この物件を見られる人全員に表示されます。所有者の電話番号などに掛かる項目ごとの表示制限は、備考には掛かりません。見せたくない内容はここから消してください。
            </p>
          </div>
        </div>

        {/*
          ⚠所有者の個人情報にあたる見出しは備考へ入れない(@codex PR#414 11巡目 ①)。
            Property.note は所有者の項目別マスクを通らずに表示されるため、
            そこへ流すと項目別権限チェックの迂回路になる。
            ただし**捨てない**。ここに出して、人が適切な欄へ移せるようにする。
        */}
        {draft.withheldFromNote.length > 0 && (
          <div
            data-section="withheld-from-note"
            role="alert"
            className="mt-3 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500 dark:bg-amber-950/40 dark:text-amber-300"
          >
            次の項目は<b>備考に入れません</b>。必要なら適切な欄へ移してください。
            <ul className="mt-1 list-disc pl-5">
              {draft.withheldFromNote.map((w, i) => (
                <li key={`${i}-${w.label}`}>
                  {w.label}: {w.value}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 所有者 */}
        <h3 className="mb-2 mt-4 text-xs font-bold tracking-wider text-gray-500 dark:text-gray-400">
          所有者
        </h3>

        <fieldset className="mb-3 space-y-2 rounded-md border border-gray-200 p-3 text-sm dark:border-gray-700">
          <legend className="px-1 text-xs text-gray-500 dark:text-gray-400">
            所有者の扱いを選んでください
          </legend>

          {candidates.map((c) => (
            <label key={c.id} className="flex items-center gap-2">
              <input
                type="radio"
                name="paste-owner-mode"
                disabled={busy}
                checked={mode === "link" && linkedOwnerId === c.id}
                onChange={() => {
                  onOwnerModeChange?.("link");
                  onLinkedOwnerChange?.(c.id);
                }}
              />
              <span>{ownerCandidateLabel(c)}</span>
            </label>
          ))}

          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="paste-owner-mode"
              disabled={busy}
              checked={mode === "new"}
              onChange={() => onOwnerModeChange?.("new")}
            />
            <span>新しい所有者として登録する</span>
          </label>

          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="paste-owner-mode"
              disabled={busy}
              checked={mode === "none"}
              onChange={() => onOwnerModeChange?.("none")}
            />
            <span>所有者なしで登録する</span>
          </label>
        </fieldset>

        {mode === "new" &&
          OWNER_FIELD_LABELS.map((f) => {
            const draftField = draft.owner ? draft.owner[f.key] : null;
            return (
              <FieldRow
                key={f.key}
                fieldKey={`owner-${f.key}`}
                label={f.label}
                value={oValues[f.key]}
                sourceLabel={draftField?.sourceLabel ?? null}
                onChange={(v) => onOwnerFieldChange?.(f.key, v)}
                onBlur={DUPLICATE_OWNER_FIELDS.has(f.key) ? onDuplicateInputBlur : undefined}
                disabled={busy}
              />
            );
          })}

        {/* 登録 */}
        <div className="mt-4 flex items-center gap-3">
          <Button
            onClick={onRegister}
            disabled={blockReason !== null || Boolean(registering)}
            title={blockReason ?? undefined}
          >
            {registering ? "登録しています…" : "この内容で登録"}
          </Button>
          {registerError && (
            <span role="alert" className="text-sm text-red-600 dark:text-red-400">
              {registerError}
            </span>
          )}
        </div>
        {/* ⚠止めた理由は title 属性だけにしない(スマホでは出ない)。画面に文字で出す。 */}
        {linkTargetMissing && !dup.blocked && (
          <p role="alert" className="mt-2 text-sm text-amber-700 dark:text-amber-400">
            紐付ける所有者が選ばれていません。候補から選ぶか、「新しい所有者として登録する」「所有者なしで登録する」を選んでください。
          </p>
        )}
        {ownerNameMissing && !dup.blocked && (
          <p role="alert" className="mt-2 text-sm text-amber-700 dark:text-amber-400">
            所有者の氏名を入力してください。所有者を作らない場合は「所有者なしで登録する」を選んでください。
          </p>
        )}
      </section>
    </div>
  );
}
