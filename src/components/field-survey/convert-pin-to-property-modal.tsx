"use client";

import { useEffect, useRef, useState } from "react";
import { X, Loader2, AlertTriangle, MapPin } from "lucide-react";
import { PROPERTY_TYPE_OPTIONS } from "@/lib/property-types";
import { convertPinToProperty, suggestPinAddress } from "@/lib/api-client";
import { normalizeRealEstateNumber } from "@/lib/address-normalizer";
import { AddressLookupControls } from "@/components/address/address-lookup-controls";
import { useScreenProtection } from "@/components/screen-protection/screen-protection-provider";

interface Props {
  pinId: string;
  onClose: () => void;
  onConverted: (propertyId: string) => void;
}

/**
 * 「物件化候補」ピンを物件にする modal。
 * - 位置(GPS)は入力せず、サーバーがピンから継承する。
 * - 種別/住所(+補完)/地番/家屋番号を収集し、所在検索に必要な項目を満たす。
 */
export default function ConvertPinToPropertyModal({ pinId, onClose, onConverted }: Props) {
  const [propertyType, setPropertyType] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [address, setAddress] = useState("");
  const [addressEdited, setAddressEdited] = useState(false);
  const [lotNumber, setLotNumber] = useState("");
  const [buildingNumber, setBuildingNumber] = useState("");
  // 不動産番号が既に分かっている場合の近道 (13桁)。あれば通常の謄本自動取得が
  // 所在検索より確実に使える。API/validator は元々受け付けており入力欄のみ追加。
  const [realEstateNumber, setRealEstateNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ピンの座標からの住所自動入力（住居表示・町丁目まで）。
  //  - 座標は client に降ろさない（server がピンから読んで逆ジオコーディングする）
  //  - 無料APIの限界で**番・号は入らない**→ 取得後に追記を促すヒントを出す
  //  - 値は通常の入力欄なのでいつでも手で直せる
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  // 非空住所の上書きは確認してから（AddressLookupControls の確認 UI と同じ姿勢・
  // Codex R9 P2）。1回目のクリックで予告し、続けてもう一度押したときだけ実行する。
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  // env 未設定の環境では「ピンの位置から住所を入力」導線ごと出さない（押すと必ず
  // 503 になるため・Codex R5 P2）。capabilities=null（未取得/失敗）も出さない側へ倒す。
  const { capabilities } = useScreenProtection();
  const reverseGeocodeEnabled = capabilities?.reverseGeocode === true;
  // 取得中(最長8秒)の手編集を応答で上書きしないための現在値 ref（Codex R2 P2）。
  const addressRef = useRef(address);
  useEffect(() => {
    addressRef.current = address;
  }, [address]);
  const postalCodeRef = useRef(postalCode);
  useEffect(() => {
    postalCodeRef.current = postalCode;
  }, [postalCode]);
  const lotNumberRef = useRef(lotNumber);
  useEffect(() => {
    lotNumberRef.current = lotNumber;
  }, [lotNumber]);

  const handleSuggestAddress = async () => {
    const startAddress = addressRef.current;
    const startZip = postalCodeRef.current;
    const startLot = lotNumberRef.current;
    // 手入力済みの住所（番地・号まで入っていることもある）を、確認なしで町丁目まで
    // の粗い値に上書きしない（Codex R9 P2）。取得（=座標の外部送信）より前に確認を
    // 求めるので、確認だけなら外部送信も発生しない。
    if (startAddress.trim() !== "" && !confirmOverwrite) {
      setConfirmOverwrite(true);
      setSuggestNote(
        "入力済みの住所をピンの位置から調べた住所で上書きします。よろしければもう一度ボタンを押してください。",
      );
      return;
    }
    setConfirmOverwrite(false);
    setSuggesting(true);
    setSuggestNote(null);
    setError(null);
    try {
      const { result } = await suggestPinAddress(pinId);
      if (result.found) {
        if (
          addressRef.current !== startAddress ||
          postalCodeRef.current !== startZip
        ) {
          // 取得中にユーザーが住所または郵便番号を編集した（郵便番号候補の適用は
          // 住所+郵便番号を同時に書き換える）→ 提案全体を stale として反映しない
          // （Codex R2/R8 P2: 片方だけ勝たせると不一致ペアが保存され得る）。
          setSuggestNote(
            "取得中に住所または郵便番号が編集されたため、自動入力は反映しませんでした。もう一度ボタンを押すと再取得します。",
          );
          return;
        }
        setAddress(result.address);
        // user-edit signal を明示的に下ろす（Codex R2 P1）: ボタン押下前に手入力が
        // あると addressEdited=true のまま残り、この programmatic な住所変更を
        // AddressLookupControls が user-edit とみなして日本郵便 API へ自動送信して
        // しまう（二次送信）。false に戻せばこの address 変化では検索されない。
        // 郵便番号補完による上書きは「住所欄が非空なら確認 UI を出す」既存フローが防ぐ。
        setAddressEdited(false);
        // 旧住所に対応していた郵便番号を残すと「郵便番号と住所の不一致」のまま
        // 保存され得る（Codex R3 P2）→ 住所を**実際に置き換えたときだけ**郵便番号も消す。
        // 取得結果が現在の住所と同一なら消さない（検索候補で入れた正しい郵便番号を
        // 巻き添えにしない・Codex R6 P2）。取得中の編集は上の stale ガードで反映ごと
        // 中止済み＝ここでは住所・郵便番号とも開始時の値のまま。
        const clearedZip =
          result.address !== startAddress && startZip.trim() !== "";
        if (clearedZip) setPostalCode("");
        // 精度で案内を変える: rsdt=号まで(出典: デジタル庁 アドレス・ベース・レジストリ) /
        // block=番まで(出典: 国土交通省 位置参照情報) / town=町丁目まで(出典: 国土地理院)。
        const base =
          result.precision === "rsdt"
            ? "ピンの位置から号まで自動入力しました（出典: デジタル庁 アドレス・ベース・レジストリ）。自動判定のため隣の建物の号が入ることがあります。保存前に確認してください。"
            : result.precision === "block"
              ? "ピンの位置から番まで自動入力しました（出典: 国土交通省 位置参照情報）。続き（号など）は現地やGoogleマップで確認して追記してください。"
              : "ピンの位置から自動入力しました（町丁目まで・出典: 国土地理院）。番・号は現地やGoogleマップで確認して追記してください。";
        // 住居表示未実施の地域では取得値が地番そのもの(Codex R3 P2)。捨てると
        // 謄本の所在検索に使える値を失うため、**開始時から空のまま変化が無い**
        // ときだけ初期値として入れる(Codex R5 P2: 取得中に「消した」操作も編集=
        // 復元しない。開始時 snapshot と現在値の両方で判定)。要確認の案内を出す。
        let filledLot = false;
        if (
          result.precision === "block" &&
          result.lotNumber &&
          startLot.trim() === "" &&
          lotNumberRef.current === startLot
        ) {
          setLotNumber(result.lotNumber);
          filledLot = true;
        }
        setSuggestNote(
          base +
            (filledLot
              ? "この地域は住居表示未実施のため、地番欄にも同じ番号を入れました（登記に使う地番は謄本・公図で必ず確認してください）。"
              : "") +
            (clearedZip
              ? "郵便番号は新しい住所に合わせて入れ直してください。"
              : ""),
        );
      } else {
        setSuggestNote(
          "この位置の住所を取得できませんでした。お手数ですが手で入力してください。",
        );
      }
    } catch (err) {
      setSuggestNote(
        err instanceof Error ? err.message : "住所の自動取得に失敗しました",
      );
    } finally {
      setSuggesting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!propertyType) {
      setError("物件種別を選択してください");
      return;
    }
    if (!address.trim()) {
      setError("住所を入力してください");
      return;
    }
    // 不動産番号は正規化して保存する (全角数字・区切り付きの生値のまま保存すると
    // CSV 取込の重複判定 [完全一致] をすり抜けて二重登録になり得る。Codex P2)。
    // 新規入力は 13 桁ちょうどを要求する (Codex P2: 桁足らずでも値が入ると
    // 所在検索が「番号あり」と誤認して無効化され、謄本自動取得には不正な
    // 番号がそのまま渡る = この欄の目的である確実な取得経路を自ら塞ぐ)。
    const rawRen = realEstateNumber.trim();
    const normalizedRen = normalizeRealEstateNumber(rawRen);
    if (
      rawRen !== "" &&
      !(
        /^[0-9０-９\s　\-‐-―ー－−]+$/.test(rawRen) &&
        /^\d{13}$/.test(normalizedRen)
      )
    ) {
      setError("不動産番号は13桁の数字で入力してください");
      return;
    }
    setSubmitting(true);
    try {
      const result = await convertPinToProperty(pinId, {
        propertyType,
        postalCode: postalCode.trim() || null,
        address: address.trim(),
        lotNumber: lotNumber.trim() || null,
        buildingNumber: buildingNumber.trim() || null,
        realEstateNumber: rawRen === "" ? null : normalizedRen,
      });
      onConverted(result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "物件化に失敗しました");
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-[90vw] sm:max-w-md max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-gray-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 px-6 py-4">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">この場所を物件にする</h2>
          <button
            onClick={onClose}
            disabled={submitting}
            className="rounded-md p-1 text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-400">位置(GPS)はこの調査ピンから自動で引き継ぎます。</p>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              物件種別 <span className="text-red-500">*</span>
            </label>
            <select
              value={propertyType}
              onChange={(e) => setPropertyType(e.target.value)}
              disabled={submitting}
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50 dark:disabled:bg-gray-800"
            >
              <option value="">選択してください</option>
              {PROPERTY_TYPE_OPTIONS.filter((o) => !["building", "unit"].includes(o.value)).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              住所 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={address}
              onChange={(e) => {
                setAddressEdited(true);
                setAddress(e.target.value);
              }}
              disabled={submitting}
              placeholder="例: 東京都千代田区丸の内1-1-1"
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50 dark:disabled:bg-gray-800"
            />
            <div className="mt-1.5 flex flex-col gap-1.5">
              {reverseGeocodeEnabled && (
                <>
                  <div>
                    <button
                      type="button"
                      onClick={handleSuggestAddress}
                      disabled={submitting || suggesting}
                      className="inline-flex items-center gap-1.5 rounded-md border border-indigo-300 dark:border-indigo-700 bg-white dark:bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-gray-800 disabled:opacity-50"
                      title="ピンの位置から住所を自動入力します（無料）"
                    >
                      {suggesting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <MapPin className="h-3.5 w-3.5" />
                      )}
                      ピンの位置から住所を入力
                    </button>
                  </div>
                  {/* 位置情報(座標)は保護対象 → 押す前に「どこへ何を送るか」を明示する
                      (Codex R4 P2: 事前開示なしに座標を外部送信しない)。結果表示後は
                      suggestNote に置き換わる(1行ずつ・画面を混雑させない)。 */}
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {suggestNote ??
                      "ボタンを押すと、ピンの位置から住所を調べます（無料）。手元の住所データで見つからない場合のみ、ピンの座標を国土地理院（国の機関）に送信します。座標以外の情報は送信しません。"}
                  </p>
                </>
              )}
              <AddressLookupControls
                zip={postalCode}
                address={address}
                onZipChange={setPostalCode}
                onAddressChange={setAddress}
                addressEdited={addressEdited}
                disabled={submitting}
                mode="both"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              地番 <span className="text-xs text-gray-400 dark:text-gray-500">任意</span>
            </label>
            <input
              type="text"
              value={lotNumber}
              onChange={(e) => setLotNumber(e.target.value)}
              disabled={submitting}
              placeholder="例: 1番1"
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50 dark:disabled:bg-gray-800"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              家屋番号 <span className="text-xs text-gray-400 dark:text-gray-500">任意(建物)</span>
            </label>
            <input
              type="text"
              value={buildingNumber}
              onChange={(e) => setBuildingNumber(e.target.value)}
              disabled={submitting}
              placeholder="例: 1番1の1"
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50 dark:disabled:bg-gray-800"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              不動産番号 <span className="text-xs text-gray-400 dark:text-gray-500">任意(13桁・分かる場合)</span>
            </label>
            <input
              type="text"
              inputMode="numeric"
              value={realEstateNumber}
              onChange={(e) => setRealEstateNumber(e.target.value)}
              disabled={submitting}
              placeholder="例: 0123456789012"
              data-testid="convert-real-estate-number"
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50 dark:disabled:bg-gray-800"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              入力しておくと、謄本の自動取得をすぐに使えます。
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-gray-100 dark:border-gray-800 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              物件にする
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
