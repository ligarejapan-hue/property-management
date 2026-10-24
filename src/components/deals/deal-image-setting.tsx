"use client";

import { useState } from "react";
import { ImageIcon, Trash2 } from "lucide-react";
import FileDropZone from "@/components/ui/file-drop-zone";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { dealsApi, DealApiError, errorText } from "@/lib/deals/client";
import { DEAL_IMAGE_LABELS, DEAL_IMAGE_MAX_BYTES, type DealImageKind } from "@/lib/deals/branding";
import type { DealSettingsView } from "@/lib/deals/settings";

const USE: Record<DealImageKind, string> = {
  logo: "資金計画表などの会社欄の上に出します。",
  seal: "領収書などの会社名の横に押します(個人の売主の書類には出しません)。",
};

/** ロゴ・角印の1つ分。登録・差し替え・外すは、その場で保存する(ほかの欄の入力は消さない)。 */
export function DealImageSetting({ kind, settings, onChanged }: {
  kind: DealImageKind;
  settings: DealSettingsView;
  onChanged: (s: DealSettingsView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const label = DEAL_IMAGE_LABELS[kind];
  const has = kind === "logo" ? settings.hasLogo : settings.hasSeal;

  const run = async (op: () => Promise<{ settings: DealSettingsView }>) => {
    setBusy(true);
    setError(null);
    try {
      onChanged((await op()).settings);
    } catch (e) {
      setError(e instanceof DealApiError && e.code === "VERSION_CONFLICT"
        ? "ほかの人が先に取引の設定を保存しました。画面を読み込み直してから、もう一度選んでください。"
        : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = (files: File[]) => {
    const file = files[0];
    if (file.size > DEAL_IMAGE_MAX_BYTES) {
      setError(`${label}の画像は 1MB 以下にしてください`);
      return;
    }
    void run(() => dealsApi.uploadSettingsImage(kind, file, settings.version));
  };

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="text-sm font-medium text-gray-700 dark:text-gray-300">{label}</div>
      <p className="text-xs text-gray-500">{USE[kind]}</p>
      {has && (
        <div className="flex items-end gap-3">
          {/* 見本は管理者だけの道から。版の番号で差し替え後の画像を読み直す。縦横比はそのまま。 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/admin/deal-settings/images/${kind}?v=${settings.version}`}
            alt={`登録している${label}`}
            className="h-auto max-h-20 w-auto max-w-[200px] rounded border border-gray-200 bg-white p-1 dark:border-gray-700"
          />
          <Button variant="ghost" size="sm" onClick={() => setConfirm(true)} disabled={busy}>
            <Trash2 className="h-4 w-4" />
            外す
          </Button>
        </div>
      )}
      <FileDropZone
        accept="image/png,image/jpeg"
        onFiles={pick}
        title={has ? `差し替える${label}の画像をここにドラッグ＆ドロップ` : `${label}の画像をここにドラッグ＆ドロップ`}
        hint="PNG か JPEG・1MB まで。背景が透明な PNG がきれいに出ます。"
        icon={ImageIcon}
        size="sm"
        busy={busy ? "保存中…" : undefined}
      />
      {error && <p className="text-xs text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {confirm && (
        <ConfirmDialog
          title={`${label}を外しますか？`}
          message={`登録している${label}の画像を消します。これから作る書類には出なくなります(発行済みの書類はそのままです)。`}
          confirmLabel="外す"
          onConfirm={() => { setConfirm(false); void run(() => dealsApi.deleteSettingsImage(kind, settings.version)); }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </div>
  );
}
