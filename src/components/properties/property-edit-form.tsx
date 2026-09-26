"use client";

import { useState, useEffect } from "react";
import { Loader2, X, Save, AlertTriangle } from "lucide-react";
import { USE_MOCK, fetchUsers, apiErrorCode, codeFromErrorBody } from "@/lib/api-client";
import { PROPERTY_TYPE_OPTIONS } from "@/lib/property-types";
import {
  BUILDING_NAME_MAX_LENGTH,
  supportsBuildingName,
} from "@/lib/property-building-name";
import { AddressLookupControls } from "@/components/address/address-lookup-controls";
import { formatBuiltYearMonth } from "@/lib/built-year-month";
// 編集中の鍵(仕様 6.1・6.2)。この画面が最初に配線する画面(Task 5)。
import { useEditLock } from "@/hooks/use-edit-lock";
import { ensureUniqueScreenToken, editLockHeaders } from "@/lib/edit-lock/screen-token-client";
import { EditLockBanner, BAND as EDIT_LOCK_BAND } from "@/components/edit-lock/edit-lock-banner";
// 保存可否の判断(決定層)。Task 6 fix round 1 #3 で src/lib/edit-lock/save-gate.ts へ
// 切り出した。ここでは呼ぶだけで、判断はコピーしない。
import { canSubmitSave, shouldShowLockUnavailableNotice } from "@/lib/edit-lock/save-gate";
// 423 EDIT_LOCKED の文言(氏名+時刻)の組み立て。鍵を持たない3入口とまったく同じ
// helper を通す(横断レビュー I2)。窓口の423は氏名・時刻を返さないため、状態の窓口へ
// 1回だけ問い合わせて差し替える。
import { showComposedEditLockedMessage } from "@/lib/edit-lock/locked-message";

interface AssigneeOption {
  id: string;
  name: string;
}

interface PropertyData {
  id: string;
  propertyType: string;
  address: string;
  lotNumber: string | null;
  buildingNumber: string | null;
  buildingName: string | null;
  realEstateNumber: string | null;
  registryStatus: string;
  dmStatus: string;
  gpsLat: number | null;
  gpsLng: number | null;
  zoningDistrict: string | null;
  buildingCoverageRatio: number | null;
  floorAreaRatio: number | null;
  heightDistrict: string | null;
  firePreventionZone: string | null;
  scenicRestriction: string | null;
  roadType: string | null;
  roadWidth: number | null;
  frontageWidth: number | null;
  frontageDirection: string | null;
  setbackRequired: string | null;
  rosenkaValue: number | null;
  rosenkaYear: number | null;
  rebuildPermission: string | null;
  architectureNote: string | null;
  note: string | null;
  assignedTo: string | null;
  version: number;
  // ── 「販売」区分(F3 Task7) ─────────────────────────────────────────────
  salePrice: number | null;
  saleTaxType: string | null;
  saleTaxAmount: number | null;
  access: string | null;
  landArea: number | null;
  landAreaMethod: string | null;
  totalFloorArea: number | null;
  builtYear: number | null;
  builtMonth: number | null;
  structureType: string | null;
  aboveFloors: number | null;
  basementFloors: number | null;
  parking: string | null;
  totalUnits: number | null;
  grossYield: number | null;
  expectedIncome: number | null;
  exclusiveArea: number | null;
  balconyArea: number | null;
  layoutType: string | null;
  orientation: string | null;
  floorNo: number | null;
  managementFee: number | null;
  repairReserveFee: number | null;
  // ⚠区分マンションの構造・地上階・総戸数・築年月・地下階は「棟の値が正」
  //   (既存設計)。この画面からは編集できない・読み取り専用表示のみ。
  building: {
    id: string;
    name: string;
    structureType: string | null;
    totalFloors: number | null;
    totalUnits: number | null;
    basementFloors: number | null;
    builtYear: number | null;
    builtMonth: number | null;
  } | null;
}

interface PropertyEditFormProps {
  property: PropertyData;
  onClose: () => void;
  onSaved: () => void;
}

interface FormField {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "textarea" | "clearOnly";
  options?: Array<{ value: string; label: string }>;
  section: string;
  /**
   * 文字数の上限 (保存時の検証と同じ値)。
   * ⚠input の `maxLength` には渡さない。生の文字数で打ち切ると、前後に空白の
   * ある上限ちょうどの値を貼ったときに**黙って実文字が削られる**。
   * 超過は注意書きで伝え、保存を止めるために使う。
   */
  maxLength?: number;
}

/** その項目が上限を超えているか。⚠**数える前に整える**。 */
function isOverMaxLength(
  field: FormField,
  value: string | undefined,
): boolean {
  if (field.maxLength == null) return false;
  return (value ?? "").trim().length > field.maxLength;
}

/**
 * その項目をいま画面に出すか。
 *
 * ⚠**描画と保存前の検証で同じ判定を使う** (@codex #354 P2)。別々に書くと、
 * 「隠れている項目のせいで保存できない」が起きる: 長すぎる物件名を入れたまま
 * 種別を対象外へ変えると欄は消えるのに検証だけ残り、**画面に無い項目を理由に
 * 保存が止まって直しようがなくなる**。
 */
function isFieldVisible(
  field: FormField,
  values: Record<string, string>,
  /** 元々(このフォームを開いた時点で)値が入っていた clearOnly 項目のキー。 */
  clearableKeys: ReadonlySet<string>,
): boolean {
  if (field.key === "buildingName") {
    return supportsBuildingName(values.propertyType);
  }
  // ⚠clearOnly は「新しく入れる」ためではなく「消す」ための欄。
  //   元から値がある物件でだけ出す(空の物件に欄が生えると、入れられてしまう)。
  //   判定は**開いた時点の値**で固定する。編集中に消した瞬間に欄が消えると、
  //   保存前に取り消せなくなる。
  if (field.type === "clearOnly") return clearableKeys.has(field.key);
  return true;
}

/** 区分マンション(新値/旧値どちらも)か。棟の項目を読み取り専用にする判定に使う。 */
function isMansionUnit(propertyType: string): boolean {
  return propertyType === "apartment_unit" || propertyType === "unit";
}

/**
 * 保存の fetch に渡す init を作る(編集中の鍵・仕様 6.1)。
 * ⚠ヘッダは必ず `editLockHeaders()` を通す(手組みしない・6つの入口すべてが通す契約)。
 *   タブの合言葉(X-Edit-Screen)は常に載せ、X-Edit-Lock は鍵を持っているとき(lockId
 *   があるとき)だけ載る。
 */
export function buildPropertySaveInit(payload: unknown, lockId: string | null): RequestInit {
  return {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...editLockHeaders(lockId) },
    body: JSON.stringify(payload),
  };
}

/**
 * 画面を開いたときに1回だけ行う試行(仕様 6.1・D6)。**内部専用・例外を投げる**。
 * ⚠**export しない**(task5 review round2 N4)。呼べるのは同じファイルの
 *   `runEditLockInit` だけにする。以前はこの関数自体を export していたため、
 *   後続の画面がこれを直接コピー&呼び出すと fail open の後始末(catch)を素通りし、
 *   round 1 の Critical(取得の失敗で保存ボタンが永久に押せなくなる)を再導入し
 *   かねなかった。安全な入口は常に `runEditLockInit` の1つだけにする。
 * ⚠**複製のタブでないことの確認(`ensureUniqueScreenToken`・最大300ms)が終わるまで
 *   鍵を取りに行かない**。判定より先に取得すると、複製されたタブが元のタブと同じ
 *   保持者として鍵を取ってしまう(D6違反=自分の別タブも待つ、が成り立たなくなる)。
 * `onReady` は tokenReady を立てる(このタイミングまでは何も起きていないので帯も出さない)。
 * ⚠(task5 review round2 N1) `ensureUniqueScreenToken` 自体が失敗しても(例:
 *   `BroadcastChannel` の `postMessage`/`onMessage` が例外を投げる)`onReady` は
 *   必ず呼ぶ(`finally`)。`screen-token-client.ts` が `BroadcastChannel` 不在時に
 *   既に取っている fail open の姿勢と揃える。呼ばないと、複製タブ確認そのものの
 *   失敗という更に狭い経路で round 1 の Critical(保存ボタンが永久に押せない)が
 *   再発し、しかも `runEditLockInit` が出す「保存は通常どおり行えます」の通知と
 *   自己矛盾する(通知は出るのに保存は実際には押せない)。
 */
async function initEditLockAttempt(
  ensureUniqueScreenToken: () => Promise<string>,
  onReady: () => void,
  acquire: () => Promise<void>,
): Promise<void> {
  try {
    await ensureUniqueScreenToken();
  } finally {
    onReady();
  }
  await acquire();
}

/**
 * `initEditLockAttempt` を実行し、結果に応じて `lockUnavailable` を更新する
 * (task5 review round1 Critical — fail open)。**画面から呼んでよい唯一の入口**
 * (task5 review round2 N4)。
 *
 * ⚠**取得(`acquire`。複製タブ確認自体の失敗も含む)を握りつぶさない、が画面を
 *   詰まらせもしない**。取得は401(未ログイン)・403(担当外)・404(削除済)・500・
 *   オフライン等、正当な理由でいつでも失敗しうる。一方でサーバ側
 *   (`properties/[id]/route.ts`)は「誰かが鍵を持っている」ときだけ保存を拒む
 *   契約なので、鍵を取れなかったこと**自体**は保存を止める理由にならない。
 *   サーバが最終的な権威であり続けるよう、ここでは新しい状態(`ui-state.ts` の
 *   kind)を増やさず、この画面ローカルの `lockUnavailable` フラグだけで
 *   「保存は通常どおり行える」に倒す(fail open)。
 * ⚠この関数自体は例外を投げない(呼び出し側の `void runEditLockInit(...)` が
 *   unhandled rejection を残さない)。
 */
export async function runEditLockInit(
  ensureUniqueScreenToken: () => Promise<string>,
  onReady: () => void,
  acquire: () => Promise<void>,
  setLockUnavailable: (unavailable: boolean) => void,
): Promise<void> {
  try {
    await initEditLockAttempt(ensureUniqueScreenToken, onReady, acquire);
    setLockUnavailable(false);
  } catch {
    setLockUnavailable(true);
  }
}

/**
 * 「販売」区分に出す欄(物件の種別ごと)。仕様書 §5.1。
 * ⚠区分マンションの構造・地上階・総戸数は含めない(棟の値が正・読み取り専用の
 *   別ブロックで表示する)。
 */
export function salesFieldsFor(propertyType: string): FormField[] {
  const price: FormField[] = [
    { key: "salePrice", label: "価格(万円)", type: "number", section: "販売" },
  ];
  const tax: FormField[] = [
    { key: "saleTaxType", label: "消費税", type: "text", section: "販売" },
    { key: "saleTaxAmount", label: "うち消費税(万円)", type: "number", section: "販売" },
  ];
  const access: FormField[] = [{ key: "access", label: "交通", type: "text", section: "販売" }];
  const land: FormField[] = [
    { key: "landArea", label: "土地面積(㎡)", type: "number", section: "販売" },
    { key: "landAreaMethod", label: "面積計測方式", type: "text", section: "販売" },
  ];
  const buildingBody: FormField[] = [
    { key: "totalFloorArea", label: "建物面積(延べ・㎡)", type: "number", section: "販売" },
    { key: "builtYear", label: "築年", type: "number", section: "販売" },
    { key: "builtMonth", label: "築月", type: "number", section: "販売" },
    { key: "structureType", label: "構造", type: "text", section: "販売" },
    { key: "aboveFloors", label: "地上階", type: "number", section: "販売" },
    { key: "basementFloors", label: "地下階", type: "number", section: "販売" },
    { key: "parking", label: "駐車場", type: "text", section: "販売" },
  ];
  switch (propertyType) {
    case "land":
      return [...price, ...access, ...land];
    case "house":
      return [...price, ...tax, ...access, ...land, ...buildingBody];
    case "apartment_building":
    case "apartment_block":
      return [
        ...price, ...tax, ...access, ...land, ...buildingBody,
        { key: "totalUnits", label: "総戸数", type: "number", section: "販売" },
        { key: "grossYield", label: "想定利回り(%)", type: "number", section: "販売" },
        { key: "expectedIncome", label: "満室想定収入(万円/年)", type: "number", section: "販売" },
      ];
    case "apartment_unit":
    case "unit":
      return [
        ...price, ...tax, ...access,
        { key: "exclusiveArea", label: "専有面積(㎡)", type: "number", section: "販売" },
        { key: "balconyArea", label: "バルコニー面積(㎡)", type: "number", section: "販売" },
        { key: "layoutType", label: "間取り", type: "text", section: "販売" },
        { key: "orientation", label: "向き", type: "text", section: "販売" },
        { key: "floorNo", label: "所在階", type: "number", section: "販売" },
        { key: "managementFee", label: "管理費(円/月)", type: "number", section: "販売" },
        { key: "repairReserveFee", label: "修繕積立金(円/月)", type: "number", section: "販売" },
        { key: "parking", label: "駐車場", type: "text", section: "販売" },
      ];
    default:
      return [];
  }
}

/**
 * [@codex P2] 「販売」区分に出しうる欄を、種別をまたいで重複なく集めたもの。
 *
 * 初期値の読み込みを**開いた時点の種別だけ**で行うと、編集中に種別を変えたときに
 * 新しく現れた欄が「空」のまま扱われる。保存は初期値(property)との差分で送るため、
 * その欄に値が入っている物件では「空へ変えた」と解釈され、**触っていない値が消える**。
 * 欄を出すかどうかは種別で決めるが、初期値は常に全部読み込む。
 */
export function allSalesFields(): FormField[] {
  // apartment_block / unit はそれぞれ apartment_building / apartment_unit の別名で
  // 同じ欄を返すため、代表の4種別で全ての欄を網羅できる。
  const seen = new Set<string>();
  const out: FormField[] = [];
  for (const t of ["land", "house", "apartment_building", "apartment_unit"]) {
    for (const f of salesFieldsFor(t)) {
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      out.push(f);
    }
  }
  return out;
}

const FORM_FIELDS: FormField[] = [
  { key: "propertyType", label: "種別", type: "select", section: "基本",
    options: PROPERTY_TYPE_OPTIONS },
  { key: "postalCode", label: "郵便番号", type: "text", section: "基本" },
  { key: "address", label: "住所", type: "text", section: "基本" },
  { key: "lotNumber", label: "地番", type: "text", section: "基本" },
  { key: "buildingNumber", label: "家屋番号", type: "text", section: "基本" },
  // 物件名(任意)。⚠**集合住宅の種別を選んでいるときだけ表示する**(描画側で判定)。
  // 土地や戸建には無い項目なので、常時出すと入力欄が無駄に増える。
  {
    key: "buildingName",
    label: "物件名",
    type: "text",
    section: "基本",
    maxLength: BUILDING_NAME_MAX_LENGTH,
  },
  // ⚠不動産番号は**新しく入れられない**が、**消すことはできる**(clearOnly)。
  //   番号が入ると所在検索の対象外になり、番号での取得は実サイトへ未配線=
  //   **謄本が取れない行き止まり**になる(2026-09-08 発注者判断=番号は作らない)。
  //   ⚠ただし CSV取込・謄本PDF取込からは**番号が入り得る**(重複判定の第1キー
  //   なので塞がない)。案内文が「番号を空にしてください」と言う以上、
  //   **空にする手段が画面に無ければ本当の行き止まりになる**(@codex #420 P1)。
  //   よって「元から値がある物件でだけ出る、消すだけの欄」を残す。
  { key: "realEstateNumber", label: "不動産番号", type: "clearOnly", section: "基本" },
  { key: "registryStatus", label: "登記状況", type: "select", section: "基本", options: [
    { value: "unconfirmed", label: "未取得" },
    { value: "scheduled", label: "取得中" },
    { value: "obtained", label: "取得済" },
  ]},
  { key: "dmStatus", label: "DM判断", type: "select", section: "基本", options: [
    { value: "send", label: "送付可" },
    { value: "hold", label: "未判断" },
    { value: "no_send", label: "送付不可" },
  ]},
  // assignedTo: options は users state から実行時に組み立てるため空のまま。
  // 詳細は JSX 内 select レンダリング特例 (field.key === "assignedTo") を参照。
  { key: "assignedTo", label: "担当者", type: "select", section: "基本", options: [] },
  { key: "gpsLat", label: "緯度", type: "number", section: "基本" },
  { key: "gpsLng", label: "経度", type: "number", section: "基本" },
  { key: "note", label: "備考", type: "textarea", section: "基本" },
  // Investigation
  { key: "zoningDistrict", label: "用途地域", type: "text", section: "調査" },
  { key: "buildingCoverageRatio", label: "建蔽率(%)", type: "number", section: "調査" },
  { key: "floorAreaRatio", label: "容積率(%)", type: "number", section: "調査" },
  { key: "heightDistrict", label: "高度地区", type: "text", section: "調査" },
  { key: "firePreventionZone", label: "防火地域", type: "text", section: "調査" },
  { key: "roadType", label: "道路種別", type: "text", section: "調査" },
  { key: "roadWidth", label: "道路幅員(m)", type: "number", section: "調査" },
  { key: "frontageWidth", label: "間口幅(m)", type: "number", section: "調査" },
  { key: "frontageDirection", label: "間口方角", type: "text", section: "調査" },
  { key: "rosenkaValue", label: "路線価(円/m²)", type: "number", section: "調査" },
  { key: "rosenkaYear", label: "路線価年度", type: "number", section: "調査" },
  { key: "architectureNote", label: "建築備考", type: "textarea", section: "調査" },
];

export default function PropertyEditForm({
  property,
  onClose,
  onSaved,
}: PropertyEditFormProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  // 住所補完の user-edit signal（Codex P2-G）。住所 input 直接編集時だけ true。
  const [addressEdited, setAddressEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<AssigneeOption[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);

  // 編集中の鍵(仕様 6.1・6.2)。この物件の編集ウィンドウが最初に配線する画面。
  const lock = useEditLock({ resourceType: "property", resourceId: property.id });
  // ⚠複製のタブでないことの確認(最大300ms)が終わるまで編集させない(D6)。
  //   判定が終わるまでは何も起きていないので、帯も出さない(lock.state は idle のまま)。
  const [tokenReady, setTokenReady] = useState(false);
  // ⚠(task5 review round1 Critical — fail open) 取得(acquire)が失敗しても保存を
  //   詰まらせない。サーバは鍵が無くても保存を受け付けるため、鍵を表示できないこと
  //   自体を理由に保存ボタンを永久にdisabledのままにしてはいけない。
  const [lockUnavailable, setLockUnavailable] = useState(false);
  useEffect(() => {
    let alive = true;
    void runEditLockInit(
      ensureUniqueScreenToken,
      () => {
        if (alive) setTokenReady(true);
      },
      // ⚠(review round1 minor) alive はここにも効かせる。300ms待ちの間に閉じられたら
      //   取得自体を送らない(送ってもすぐbeaconで手放すだけになる=自己完結はする
      //   ものの、不要な取得監査ログ・往復を避けられる)。
      () => (alive ? lock.acquire() : Promise.resolve()),
      (unavailable) => {
        if (alive) setLockUnavailable(unavailable);
      },
    );
    return () => {
      alive = false;
    };
    // 開いたとき1回だけ(依存を足さない=再取得はlock/controller側の責務)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ⚠「消すだけの欄」を出すかは**開いた時点の値**で決める(編集中に欄が
  //   消えて取り消せなくなるのを防ぐ)。property が差し替わった時だけ更新。
  const [clearableKeys, setClearableKeys] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  useEffect(() => {
    // 「販売」区分(F3 Task7)の欄は FORM_FIELDS に無いので、ここで併せて読み込む
    // (読み込まないと salePrice 等の初期値が空のままになる)。
    // ⚠[@codex P2] **開いた時点の種別だけ**で読むと、編集中に種別を変えて現れた欄が
    //   空扱いになり、保存の差分判定で「消した」と解釈されて既存値が飛ぶ。
    //   出す欄は種別で決めるが、初期値は全種別ぶん読む(allSalesFields のコメント参照)。
    const fieldsToLoad = [...FORM_FIELDS, ...allSalesFields()];
    const initial: Record<string, string> = {};
    for (const f of fieldsToLoad) {
      const val = (property as unknown as Record<string, unknown>)[f.key];
      initial[f.key] = val != null ? String(val) : "";
    }
    setValues(initial);
    setClearableKeys(
      new Set(
        fieldsToLoad
          .filter(
            (f) => f.type === "clearOnly" && (initial[f.key] ?? "").trim() !== "",
          )
          .map((f) => f.key),
      ),
    );
    // prop（既存値）再投入は user-edit ではない＝signal をリセット（初期ロードで検索しない）。
    setAddressEdited(false);
  }, [property]);

  // 「販売」区分の欄は種別ごとに変わる(編集中の select 変更にも追従する)。
  // ⚠values.propertyType は上の effect が走るまで未設定なので property.propertyType へ
  //   フォールバックする(初回描画のちらつき防止)。
  const salesFields = salesFieldsFor(values.propertyType ?? property.propertyType);
  const allFields = [...FORM_FIELDS, ...salesFields];
  const isMansion = isMansionUnit(values.propertyType ?? property.propertyType);

  useEffect(() => {
    let cancelled = false;
    setUsersLoading(true);
    fetchUsers()
      .then((res) => {
        if (cancelled) return;
        setUsers(res.data.map((u) => ({ id: u.id, name: u.name })));
      })
      .catch(() => {
        // 失敗時は「(未設定)」のみ。フォーム全体は落とさない。
        if (cancelled) return;
        setUsers([]);
      })
      .finally(() => {
        if (cancelled) return;
        setUsersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = (key: string, value: string) => {
    setValues((prev) => {
      const next = { ...prev, [key]: value };
      // ⚠種別を対象外へ変えたら物件名を**その場で消す**(新規登録フォームと同じ)。
      // 隠すだけだと、画面に無い値を保存へ送ることになる。API 側も同じ判断で
      // null にするが、画面上でも消えたことが見えるほうが分かりやすい。
      if (key === "propertyType" && !supportsBuildingName(value)) {
        next.buildingName = "";
      }
      return next;
    });
  };

  const handleSave = async () => {
    // 上限超過は保存前に止める (入力欄では打ち切っていないため)。
    // ⚠API も 422 で弾くが、どの項目かを画面で示すほうが直しやすい。
    // ⚠**いま表示している項目だけ**を見る。隠れている項目を理由に止めると、
    // 画面に無いものを直せと言うことになり手詰まりになる。
    const tooLong = allFields.find(
      (f) =>
        isFieldVisible(f, values, clearableKeys) &&
        isOverMaxLength(f, values[f.key]),
    );
    if (tooLong) {
      setError(
        `${tooLong.label}は${tooLong.maxLength}文字以内で入力してください（前後の空白は数えません）`,
      );
      return;
    }
    setSaving(true);
    setError(null);

    try {
      // Build update payload — 変更した項目だけ送る(PATCH)。既存の(CSV取込等で入った)不正値が残る項目を、
      // 無関係な項目の編集のたびに再送すると入力バリデーション(A2)で 422 になり「その物件が一切編集できない」
      // 状態に陥る。初期値(property)と一致する項目は送らないことでこれを防ぎ、未編集項目の上書き(競合)も避ける。
      const payload: Record<string, unknown> = { version: property.version };
      const propRecord = property as unknown as Record<string, unknown>;
      for (const f of allFields) {
        const raw = values[f.key] ?? "";
        const initialRaw = propRecord[f.key];
        const initialStr = initialRaw != null ? String(initialRaw) : "";
        if (raw === initialStr) continue; // 未変更 → 送らない
        if (f.type === "number") {
          payload[f.key] = raw ? Number(raw) : null;
        } else {
          payload[f.key] = raw || null;
        }
      }

      if (USE_MOCK) {
        // Mock: just simulate delay
        await new Promise((r) => setTimeout(r, 300));
        void lock.release();
        onSaved();
        return;
      }

      // ⚠ヘッダは必ず buildPropertySaveInit(→ editLockHeaders) を通す(手組みしない)。
      //   タブの合言葉は常に載り、鍵を持っているとき(lock.lockId)だけ世代も載る。
      const res = await fetch(
        `/api/properties/${property.id}`,
        buildPropertySaveInit(payload, lock.lockId),
      );

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        // ⚠コードの抽出は codeFromErrorBody(api-client.ts) 経由(review round1
        //   Important #4)。手組みで再現すると、封筒の形が変わったときここだけ
        //   古いまま残り、noteSaveError が黙って null を受け取り続ける。
        throw Object.assign(new Error(body?.error?.message ?? `エラー: ${res.status}`), {
          code: codeFromErrorBody(body),
        });
      }

      void lock.release();
      onSaved();
    } catch (err) {
      // ⚠コードの写像(期限切れ・強制解除・他の人が取った 等)はTask2の純関数に任せる。
      //   ここでは封筒から読んだコードをそのまま渡すだけ。
      const code = apiErrorCode(err);
      lock.noteSaveError(code, null);
      const message = err instanceof Error ? err.message : "保存に失敗しました";
      if (code === "EDIT_LOCKED") {
        // ⚠(横断レビュー I2) 段階1の窓口の423は氏名も時刻も返さない(「他の画面で
        //   編集中です」だけ)。鍵を持たない3入口とまったく同じ helper で状態窓口を
        //   1回だけ引き、届いたら「{氏名}さんが編集中です({HH:mm}〜)」へ差し替える
        //   (await しない=控えは即座に解放される)。
        showComposedEditLockedMessage("property", property.id, message, setError);
        return;
      }
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  /** 閉じる・キャンセルの共通後始末。⚠入力は消さず、鍵だけ返す。 */
  const handleClose = () => {
    void lock.release();
    onClose();
  };

  const sections = [...new Set(allFields.map((f) => f.section))];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 py-8">
      <div
        className="mx-4 w-full max-w-3xl rounded-lg bg-white dark:bg-gray-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        // ⚠入力・キー・ポインタの一番外側でnoteActivityを呼ぶ(期限切れの取り直しの
        //   引き金・仕様6.2)。帯の文字の選択・コピー自体はブロックしない(bubbling
        //   イベントを聞くだけで、pointerEventsやuserSelectには触れていない)。
        onInput={() => lock.noteActivity()}
        onKeyDown={() => lock.noteActivity()}
        onPointerDown={() => lock.noteActivity()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 px-6 py-4">
          <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100">物件情報を編集</h3>
          <button
            onClick={handleClose}
            className="rounded p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[70vh] overflow-y-auto px-6 py-4">
          {/* ⚠(task5 review round1 Critical — fail open) 鍵が取れなくても保存は
              通常どおり行える、という別の通知。lock.state は idle のまま(新しい
              state kindは増やさない)なので、EditLockBanner とは別に出す。
              ⚠(review round2 N3) idle の間だけ出す。取得は失敗した後、後から保存が
              423等で断られて state が idle 以外(taken/expired等)に動いたら、
              「保存は通常どおり行えます」と実際の鍵の帯が同時に出て矛盾しないよう
              この通知を消す。 */}
          {shouldShowLockUnavailableNotice(lockUnavailable, lock.state.kind) && (
            <div className={`${EDIT_LOCK_BAND} mb-4`}>
              編集中の表示を取得できませんでした。保存は通常どおり行えます
            </div>
          )}
          <EditLockBanner state={lock.state} warnIdle={lock.warnIdle} />
          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-md border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {sections.map((section) => (
            <div key={section} className="mb-6">
              <h4 className="mb-3 border-b border-gray-100 dark:border-gray-800 pb-1 text-sm font-semibold text-gray-600 dark:text-gray-300">
                {section}情報
              </h4>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {allFields.filter((f) => f.section === section)
                  // 条件つきの項目 (物件名など) はここで出し入れする。
                  // ⚠判定は保存前の検証と共有する (isFieldVisible)。
                  .filter((f) => isFieldVisible(f, values, clearableKeys))
                  .map(
                  (field) => (
                    <div
                      key={field.key}
                      className={
                        field.type === "textarea" ? "md:col-span-2" : ""
                      }
                    >
                      <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                        {field.label}
                      </label>
                      {field.type === "select" ? (
                        <select
                          value={values[field.key] ?? ""}
                          onChange={(e) =>
                            handleChange(field.key, e.target.value)
                          }
                          disabled={
                            field.key === "assignedTo" && usersLoading
                          }
                          className="w-full rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-1.5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none disabled:bg-gray-100 dark:disabled:bg-gray-800"
                        >
                          {field.key === "assignedTo" ? (
                            <>
                              <option value="">(未設定)</option>
                              {users.map((u) => (
                                <option key={u.id} value={u.id}>
                                  {u.name}
                                </option>
                              ))}
                            </>
                          ) : (
                            field.options?.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))
                          )}
                        </select>
                      ) : field.type === "clearOnly" ? (
                        // ⚠**消すだけの欄**。打ち直せないが空にはできる。
                        //   CSV取込等で入った番号がある物件は謄本を取れないため、
                        //   「番号を空にしてください」という案内に従う手段として必要。
                        <>
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              readOnly
                              value={values[field.key] ?? ""}
                              data-testid={`clear-only-${field.key}`}
                              placeholder="(なし)"
                              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400"
                            />
                            <button
                              type="button"
                              onClick={() => handleChange(field.key, "")}
                              disabled={(values[field.key] ?? "") === ""}
                              data-testid={`clear-only-${field.key}-clear`}
                              className="shrink-0 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                            >
                              空にする
                            </button>
                          </div>
                          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                            新しく入力することはできません。空にして保存すると、地番（建物は家屋番号）での謄本取得が使えるようになります。
                          </p>
                        </>
                      ) : field.type === "textarea" ? (
                        <textarea
                          value={values[field.key] ?? ""}
                          onChange={(e) =>
                            handleChange(field.key, e.target.value)
                          }
                          rows={3}
                          className="w-full rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-1.5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none resize-y"
                        />
                      ) : (
                        <input
                          type={field.type}
                          // ⚠**maxLength は使わない** (@codex #354 P2)。生の文字数で
                          // 打ち切るため、前後に空白のある上限ちょうどの値を貼ると
                          // ブラウザが**黙って実文字を削る**。超過は下の注意書きで
                          // 伝え、保存を止める。
                          value={values[field.key] ?? ""}
                          onChange={(e) => {
                            // 住所のユーザー直接編集だけ user-edit signal を立てる。
                            if (field.key === "address") setAddressEdited(true);
                            handleChange(field.key, e.target.value);
                          }}
                          step={field.type === "number" ? "any" : undefined}
                          className="w-full rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-1.5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                        />
                      )}
                      {/* 上限のある項目の超過を、打ち終える前に伝える。
                          ⚠数える前に trim する (前後の空白で弾かない)。 */}
                      {isOverMaxLength(field, values[field.key]) && (
                        <p
                          role="status"
                          data-testid={`edit-too-long-${field.key}`}
                          className="mt-1 text-xs text-amber-700 dark:text-amber-300"
                        >
                          {field.label}は{field.maxLength}
                          文字以内で入力してください（前後の空白は数えません）
                        </p>
                      )}
                      {field.key === "address" && (
                        <div className="mt-1.5">
                          {/* 郵便番号⇄住所 補完。候補確定は postalCode/address をペア反映。
                              onZipChange/onAddressChange は addressEdited を立てない。 */}
                          <AddressLookupControls
                            zip={values.postalCode ?? ""}
                            address={values.address ?? ""}
                            onZipChange={(z) => handleChange("postalCode", z)}
                            onAddressChange={(a) => handleChange("address", a)}
                            addressEdited={addressEdited}
                            disabled={saving}
                            mode="both"
                          />
                        </div>
                      )}
                    </div>
                  ),
                )}
              </div>
              {/* 区分マンション: 構造・地上階・地下階・総戸数・築年月は「棟の値が正」
                  (既存設計)。この画面では編集できない・読み取り専用表示+棟の画面への
                  リンクのみ(F3 Task7)。 */}
              {section === "販売" && isMansion && property.building && (
                <div className="mt-3 rounded border border-neutral-200 p-2 text-sm dark:border-neutral-700">
                  <p className="mb-1 font-semibold">棟の項目(この画面では変更できません)</p>
                  <p>
                    構造 {property.building.structureType ?? "—"} / 地上階{" "}
                    {property.building.totalFloors ?? "—"} / 地下階{" "}
                    {property.building.basementFloors ?? "—"} / 総戸数{" "}
                    {property.building.totalUnits ?? "—"} / 築年月{" "}
                    {/* @codex P2: 築年と築月は片方だけでも保存できる。両方に年・月を
                        付けると「2020年—月」のような読めない表示になるため、共通の
                        表示関数に任せる。 */}
                    {formatBuiltYearMonth(
                      property.building.builtYear,
                      property.building.builtMonth,
                    ) || "—"}
                  </p>
                  <a
                    href={`/buildings/${property.building.id}`}
                    className="text-blue-600 underline dark:text-blue-400"
                  >
                    棟の画面で直す
                  </a>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-gray-200 dark:border-gray-800 px-6 py-4">
          <span className="mr-auto text-xs text-gray-400 dark:text-gray-500">
            バージョン: {property.version}
          </span>
          <button
            onClick={handleClose}
            className="rounded-md border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            // ⚠複製タブ検知(tokenReady)が終わるまでは押せない(D6・仕様6.2)。鍵を
            //   持てていなくても、取得自体に失敗したとき(lockUnavailable)は
            //   fail openで押せる(サーバが最終的な権威・review round1 Critical)。
            // ⚠(横断レビュー I1) ただしfail openが効くのは鍵の状態が idle の間だけ。
            //   状態(lock.state.kind)を必ず渡す=取得の失敗後に423で帯が出たら
            //   ボタンも一緒に閉じる(帯と矛盾させない)。
            disabled={
              !canSubmitSave({
                tokenReady,
                canSave: lock.canSave,
                saving,
                lockUnavailable,
                stateKind: lock.state.kind,
              })
            }
            className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
