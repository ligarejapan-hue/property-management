"use client";

import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { FileText, Upload, type LucideIcon } from "lucide-react";
import { pickAcceptedFiles, pickNotice } from "@/lib/file-accept";

/**
 * システム共通のファイルを入れる枠(点線の枠)。
 * 「受付帳CSVから物件を新規作成」の枠と同じ見た目・操作にそろえる:
 *   - ここへドラッグ＆ドロップ / クリック(または Tab で移って Enter・Space)でファイル選択
 *   - ドロップされたファイルも accept の形式で選り分ける(選択の窓と同じ基準)
 *   - 単一選択の枠に複数置かれたら最初の1件だけを使う
 * 大きさ上限などの画面ごとの検証は呼び出し側(onFiles の先)に残す。
 */
export default function FileDropZone({
  accept,
  multiple = false,
  disabled = false,
  onFiles,
  title,
  hint,
  fileName,
  icon: Icon = Upload,
  size = "md",
  busy,
  hideFileNames = false,
  className = "",
}: {
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  /** 形式が合ったファイルだけが届く(1件以上のときだけ呼ばれる)。 */
  onFiles: (files: File[]) => void;
  /** 1行目。例: 「CSV または Excel(.xlsx) ファイルをここにドラッグ＆ドロップ」 */
  title: ReactNode;
  /** 対応形式・上限などの小さな注記。 */
  hint?: ReactNode;
  /** 選んであるファイル名(枠の中に表示)。 */
  fileName?: string | null;
  icon?: LucideIcon;
  /** lg=取込画面の大きい枠 / md=タブ内の枠 / sm=一覧の上の細い帯 */
  size?: "lg" | "md" | "sm";
  /** アップロード中などに枠の中身を差し替える(この間は選択もドロップも受け付けない)。 */
  busy?: ReactNode;
  /** 除いたファイルの知らせにファイル名を出さない(謄本など所有者名を含み得るもの)。 */
  hideFileNames?: boolean;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inactive = disabled || Boolean(busy);

  const deliver = (list: FileList | null | undefined) => {
    const picked = pickAcceptedFiles(Array.from(list ?? []), accept, multiple);
    setNotice(pickNotice(picked, { hideFileNames }));
    if (picked.accepted.length > 0) onFiles(picked.accepted);
  };

  const openPicker = () => {
    if (!inactive) inputRef.current?.click();
  };

  // 使えない間もブラウザ既定(ファイルを開いて画面を離れる)は止める。
  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (inactive) return;
    dragDepth.current += 1;
    setDragActive(true);
    setNotice(null);
  };
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = inactive ? "none" : "copy";
  };
  // 子要素をまたぐたびに leave が来るので、深さで数えて枠を出たときだけ消す。
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDragActive(false);
    if (inactive) return;
    deliver(e.dataTransfer.files);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPicker();
    }
  };

  const pad = size === "lg" ? "p-12" : size === "md" ? "p-6" : "px-4 py-3";
  const iconSize = size === "lg" ? "h-10 w-10 mb-3" : size === "md" ? "h-8 w-8 mb-2" : "h-4 w-4";
  const tone = dragActive
    ? "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-500/10"
    : inactive
      ? "border-gray-300 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/50"
      : "border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800/50 dark:hover:border-gray-600 dark:hover:bg-gray-800";

  return (
    <div
      data-file-drop-zone
      role="button"
      tabIndex={inactive ? -1 : 0}
      aria-disabled={inactive || undefined}
      onClick={openPicker}
      onKeyDown={onKeyDown}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`group rounded-lg border-2 border-dashed text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${pad} ${tone} ${
        inactive ? (busy ? "cursor-wait" : "cursor-not-allowed opacity-60") : "cursor-pointer"
      } ${className}`}
    >
      {busy ? (
        <div className="flex items-center justify-center gap-2 text-sm text-gray-600 dark:text-gray-300">{busy}</div>
      ) : (
        <div className={size === "sm" ? "flex flex-wrap items-center justify-center gap-x-2 gap-y-1" : ""}>
          <Icon
            aria-hidden="true"
            className={`${size === "sm" ? "" : "mx-auto"} ${iconSize} ${
              dragActive ? "text-blue-500" : "text-gray-400 dark:text-gray-500"
            }`}
          />
          <p className="text-sm font-medium text-gray-700 dark:text-gray-200">{title}</p>
          <p className={`text-xs text-gray-500 dark:text-gray-400 ${size === "sm" ? "" : "mt-1"}`}>
            またはクリックしてファイルを選択{multiple ? "（まとめて複数可）" : ""}
          </p>
          {hint && size !== "sm" && (
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{hint}</p>
          )}
        </div>
      )}
      {fileName && !busy && (
        <p className="mt-3 inline-flex max-w-full items-center gap-1 break-all rounded bg-blue-50 px-3 py-1 text-sm text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">
          <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {fileName}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          {notice}
        </p>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={inactive}
        tabIndex={-1}
        className="hidden"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          deliver(e.target.files);
          // 同じファイルを選び直しても届くように空へ戻す。
          e.target.value = "";
        }}
      />
    </div>
  );
}
