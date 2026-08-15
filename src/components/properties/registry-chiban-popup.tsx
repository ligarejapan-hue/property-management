"use client";

import { useState } from "react";
import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react";
import { isReadableChiban } from "@/lib/registry-fetch/chiban-input";

/**
 * 地番を人が地図で確認して入れるポップアップ。
 *
 * 設計: docs/superpowers/specs/2026-08-12-registry-chiban-popup-design.md §3.2 / §3.3 / §4.1 / §4.3
 *
 * ## なぜ要るのか
 * 謄本は**地番**でしか取れない。住所の番号（住居表示）とは別のもので、
 * たまたま一致することはあっても前提にできない。地番を知る手段は
 * **地番検索サービスの地図で該当の筆をクリックする**しかない。
 *
 * ## この画面がやること
 * `PATCH /api/properties/[id]` で `lotNumber` を保存するだけ。
 * ⚠**検索は投げない**。保存できたら閉じて、既存の確認パネル（料金の確認）へ進む。
 * ここから検索を投げると、その確認を飛ばすことになる（設計 §4.1）。
 *
 * ⚠**家屋番号はここから保存しない**。地図が返すのは地番であって家屋番号ではないので、
 * 保存させると「地番を家屋番号として建物検索」することになり、
 * 一括なら候補1件で自動購入まで進む（設計 §3.3）。
 */

const CHIBAN_MAP_BASE = "https://minji-houmu.rmp.glbs.jp/view/chiban_search/map/";

/**
 * 地番検索サービスのURL。
 * ⚠ズーム18は**筆界と地番が見える倍率**（発注者の実機画面で確認済み。#15 では筆界が出ない）。
 * ⚠座標が無ければトップを開くだけ（住所は渡さない）。
 *
 * ⚠**座標は文字列で来る**（@codex #373 R5 P2）。DBの緯度経度は Prisma の Decimal で、
 * 物件詳細APIはそのまま返すため JSON 上は string になる。number だけを受け付けると
 * **本番のすべての物件でトップページしか開かない**（地図が現地に寄らない）。
 * このリポは地図APIでも同じ変換をしている（field-survey-map-util の coerceLat/coerceLng）。
 */
export function chibanMapUrl(
  lat: number | string | null | undefined,
  lng: number | string | null | undefined,
): string {
  const n = (v: number | string | null | undefined): number | null => {
    if (v == null || v === "") return null;
    const num = typeof v === "number" ? v : Number(v);
    return Number.isFinite(num) ? num : null;
  };
  const la = n(lat);
  const ln = n(lng);
  if (la == null || ln == null) return CHIBAN_MAP_BASE;
  return `${CHIBAN_MAP_BASE}#18/${la.toFixed(6)}/${ln.toFixed(6)}`;
}

interface RegistryChibanPopupProps {
  propertyId: string;
  /** 物件の所在（画面でコピーしてもらう。⚠外部へは渡さない）。 */
  propertyAddress: string;
  /** 保存に必要な現在の版番号。 */
  propertyVersion: number;
  /** ⚠number とは限らない（Decimal は JSON 上 string）。 */
  gpsLat: number | string | null;
  gpsLng: number | string | null;
  /** property:write。無ければ入力欄を出さず案内だけにする。 */
  canWriteProperty: boolean;
  /**
   * 建物の道（家屋番号が要る案内）も見せるか。
   * ⚠土地だと分かっている種別以外はすべて true（@codex #373 R10 P2）。
   *   駐車場・その他・不明は土地とも建物とも決まっていないので、
   *   黙って地番の入力へ送ると「建物の謄本が欲しかった」人が行き止まる。
   */
  offerBuildingPath: boolean;
  /**
   * 保存できた。引数は**保存後の版番号**（読めなければ null）。
   * ⚠呼び出し側はこれを次の保存に使う。物件の取り直しを待たずに流れを続けるため
   *   （取り直すとこの画面ごと作り直されて流れが消える・@codex #373 R10 P2）。
   */
  onSaved: (nextVersion: number | null) => void;
  onClose: () => void;
}

export default function RegistryChibanPopup({
  propertyId,
  propertyAddress,
  propertyVersion,
  gpsLat,
  gpsLng,
  canWriteProperty,
  offerBuildingPath,
  onSaved,
  onClose,
}: RegistryChibanPopupProps) {
  // 「建物の登記／土地の登記」のどちらを取るかを先に選んでもらう（設計 §3.3）。
  // ⚠土地だと分かっている種別のときだけ、地番の入力へ直行する。
  const [route, setRoute] = useState<"choose" | "land">(
    offerBuildingPath ? "choose" : "land",
  );
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const readable = isReadableChiban(value);
  const canSave = canWriteProperty && readable && !saving;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // ⚠物件本体を更新する共通ラッパーはこのリポに無い（編集フォームも素の fetch）。
      //   1つだけラッパーを増やすと二重管理になるので、同じ形に揃える。
      const res = await fetch(`/api/properties/${propertyId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // ⚠version は更新スキーマの必須項目。地番だけ送るときも必ず入れる。
        // ⚠保存するのは lotNumber だけ（家屋番号を保存する口を作らない）。
        body: JSON.stringify({ version: propertyVersion, lotNumber: value.trim() }),
      });
      if (res.ok) {
        // ⚠保存後の版番号を持ち帰る。物件の取り直しを待たずに次の保存ができる
        //   （取り直すと詳細ページが読み込み中に切り替わり、この画面ごと消える）。
        const saved = (await res.json().catch(() => null)) as {
          version?: unknown;
        } | null;
        const nextVersion =
          typeof saved?.version === "number" ? saved.version : null;
        // ⚠ここで検索を投げない。料金の確認（既存の確認パネル）を必ず経由する。
        onSaved(nextVersion);
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      setError(
        body?.error?.code === "VERSION_CONFLICT"
          ? "他の担当者が先に更新しました。画面を開き直してからやり直してください。"
          : "保存できませんでした。入力を確認してもう一度お試しください。",
      );
    } catch {
      setError("保存できませんでした。通信の状態を確認してください。");
    } finally {
      setSaving(false);
    }
  }

  const mapUrl = chibanMapUrl(gpsLat, gpsLng);

  return (
    <div className="mt-2 space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-400/30 dark:bg-amber-500/10">
      {route === "choose" ? (
        <>
          <div className="flex items-start gap-2 font-medium text-amber-900 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>この物件には地番も家屋番号も入っていません</span>
          </div>
          <p className="text-gray-700 dark:text-gray-300">
            どちらの登記を取りますか。
          </p>
          <div className="space-y-2">
            <div className="rounded border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-900">
              <div className="font-medium text-gray-800 dark:text-gray-100">
                建物の登記を取る
              </div>
              <p className="mt-1 text-gray-600 dark:text-gray-400">
                建物の謄本には「家屋番号」が要ります。
                ⚠家屋番号は<strong>地番検索サービスの地図では分かりません</strong>
                （地図が示すのは土地の地番です）。
                権利証・固定資産税の通知・過去の謄本などでご確認のうえ、
                物件の「家屋番号」欄に入力してから実行してください。
              </p>
            </div>
            <button
              type="button"
              onClick={() => setRoute("land")}
              className="w-full rounded border border-indigo-400 bg-indigo-600 px-2.5 py-1.5 text-left font-medium text-white hover:bg-indigo-700"
            >
              土地の登記を取る（地図で地番を確認して入れる）
            </button>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-gray-300 px-2.5 py-1 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              閉じる
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-start gap-2 font-medium text-amber-900 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>地番が必要です</span>
          </div>
          <p className="text-gray-700 dark:text-gray-300">
            謄本は「地番」でしか取れません。住所の番号（住居表示）とは別のものです。
            地図で確認してください。
          </p>

          <div className="space-y-1">
            <div className="text-[11px] text-gray-500 dark:text-gray-400">
              この物件の住所
            </div>
            <div className="flex items-center gap-2">
              <span className="break-all text-gray-800 dark:text-gray-100">
                {propertyAddress}
              </span>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(propertyAddress).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                }}
                className="shrink-0 rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                {copied ? "コピーしました" : "コピー"}
              </button>
            </div>
          </div>

          {/* ⚠**この地図は単独では開けない**（2026-08-15 実機で判明）。押すと地図ではなく
              「現在サービスを利用できません。再度登記情報提供サービスの不動産請求画面から
              利用を開始してください。」が返る＝登記情報提供サービスのセッションが要る。
              ボタンは残す（住所のコピーと地番の入力欄が同じ場所にある利点があるため）が、
              **前提をリンクより前に置く**（押してから気づく順にしない）。 */}
          <div className="rounded border border-amber-300 bg-amber-50 p-2 dark:border-amber-400/30 dark:bg-amber-950/40">
            <p className="font-medium text-amber-900 dark:text-amber-200">
              先に登記情報提供サービスへログインしてください
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-amber-900/90 dark:text-amber-200/90">
              この地図は<strong>単独では開けません</strong>
              。登記情報提供サービスにログインし、
              <strong>不動産請求画面</strong>
              から始めた状態でないと「現在サービスを利用できません」と表示されます。
            </p>
          </div>

          {/* ⚠外部サービスへ物件の位置を渡す導線。自動では開かない・自動では送らない。
              ⚠「相手に渡っていない」とは書かない（フラグメントでも相手の JavaScript が読み、
              地図データの取得もその範囲について行われる＝座標は渡っている）。 */}
          <div className="space-y-1">
            <a
              href={mapUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded border border-indigo-300 bg-white px-2.5 py-1 font-medium text-indigo-700 hover:bg-indigo-50 dark:border-indigo-400/30 dark:bg-gray-900 dark:text-indigo-300 dark:hover:bg-gray-800"
            >
              <ExternalLink className="h-3 w-3" />
              地番検索サービスを開く（無料・別タブ）
            </a>
            <p className="text-[11px] text-gray-600 dark:text-gray-400">
              この物件の位置を地図サービスへ渡して開きます（法務省の無料サービス）。
            </p>
            <p className="text-[11px] leading-relaxed text-gray-600 dark:text-gray-400">
              ①登記情報提供サービスに<strong>ログイン</strong> → ②
              <strong>不動産請求画面</strong>へ進む → ③このボタンで地図を開く →
              ④住所で検索 → ⑤地図を拡大 → ⑥<strong>該当の筆をクリック</strong> →
              ⑦出てきた地番をここへ入れてください。
            </p>
          </div>

          {canWriteProperty ? (
            <div className="space-y-1">
              <label className="block text-[11px] font-medium text-gray-700 dark:text-gray-200">
                地番
              </label>
              <input
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="69-2"
                className="w-full rounded border border-gray-300 px-2 py-1 font-mono dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
              {value.trim() !== "" && !readable && (
                <p className="text-[11px] text-red-600 dark:text-red-400">
                  地図に表示された地番をそのまま入れてください（例: 69-2）。
                </p>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-gray-600 dark:text-gray-400">
              地番を入力してから実行してください（地番の編集権限が必要です）。
            </p>
          )}

          {/* ⚠費用の書き分け（設計 §3.2）。候補一覧は「無料/有料/課金/費用」の語を
              出さないテストで固定されているので、ここにだけ書く。 */}
          <p className="text-[11px] text-gray-600 dark:text-gray-400">
            この画面の操作では課金されません（地番検索サービスは無料）。課金は次の取得のときです。
          </p>

          {error && (
            <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-gray-300 px-2.5 py-1 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              キャンセル
            </button>
            {canWriteProperty && (
              <button
                type="button"
                onClick={save}
                disabled={!canSave}
                className="inline-flex items-center gap-1 rounded border border-indigo-400 bg-indigo-600 px-2.5 py-1 font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-300 dark:disabled:border-gray-700 dark:disabled:bg-gray-700"
              >
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                保存して確認へ
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
