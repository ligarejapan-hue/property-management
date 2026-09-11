"use client";
import { useState } from "react";
import { Eye, ExternalLink, X } from "lucide-react";
import { LP_PREVIEW_URL } from "@/lib/api-client";

type Device = "sp" | "pc";
const WIDTH: Record<Device, number> = { sp: 390, pc: 1000 };

/** LP型のプレビュー(設計 §2.4 PR3)。同じページを幅 390px(スマホ)と 1000px(PC)の枠で見る。
 *  device は監査用の区別のみで HTML 自体は同じ(preview route 側の注記どおり)。 */
export default function LpPreviewPanel({ campaignId, lpId, label, onClose }: { campaignId: string; lpId: string; label: string; onClose: () => void }) {
  const [device, setDevice] = useState<Device>("sp");
  const src = LP_PREVIEW_URL(campaignId, lpId, device);
  return (
    <div className="mt-3 rounded-md border border-sky-200 bg-sky-50/40 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-gray-700">
          <Eye className="mr-1 inline h-3.5 w-3.5" />「{label}」のプレビュー(見本の差し込み・送付前の帯付き)
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={device === "sp"}
            onClick={() => setDevice("sp")}
            className={`rounded border px-2 py-1 ${device === "sp" ? "border-sky-500 bg-white text-sky-700" : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"}`}
          >
            スマホ
          </button>
          <button
            type="button"
            aria-pressed={device === "pc"}
            onClick={() => setDevice("pc")}
            className={`rounded border px-2 py-1 ${device === "pc" ? "border-sky-500 bg-white text-sky-700" : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"}`}
          >
            PC
          </button>
          <a href={src} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sky-700 hover:underline">
            <ExternalLink className="h-3 w-3" />別タブで開く
          </a>
          <button type="button" onClick={onClose} className="text-gray-500 hover:underline">
            <X className="inline h-3 w-3" /> 閉じる
          </button>
        </div>
      </div>
      <div className="mt-2 overflow-x-auto">
        <iframe
          key={device}
          src={LP_PREVIEW_URL(campaignId, lpId, device)}
          title={`LP型「${label}」のプレビュー(${device === "sp" ? "スマホ" : "PC"})`}
          style={{ width: WIDTH[device], maxWidth: "100%", height: 720 }}
          className="rounded border border-gray-300 bg-white"
        />
      </div>
    </div>
  );
}
