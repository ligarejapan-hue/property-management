"use client";
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { LP_PREVIEW_URL } from "@/lib/api-client";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";

type Device = "sp" | "pc";
const WIDTH: Record<Device, number> = { sp: 390, pc: 1000 };

/** LP型のプレビュー(設計 §2.4 PR3)。同じページを幅 390px(スマホ)と 1000px(PC)の枠で見る。
 *  device は監査用の区別のみで HTML 自体は同じ(preview route 側の注記どおり)。
 *  ⚠実機確認(2026-09-11)で判明: LP型の欄は狭く(約260px)、この枠を欄の中に出すと
 *    1000px の枠が潰れて「実物と同じ見え方」にならない。そのため広いダイアログ
 *    (ModalShell size="xl" = 1080px)で開く(Ruling R7)。 */
export default function LpPreviewPanel({ campaignId, lpId, label, onClose }: { campaignId: string; lpId: string; label: string; onClose: () => void }) {
  const [device, setDevice] = useState<Device>("sp");
  const src = LP_PREVIEW_URL(campaignId, lpId, device);
  return (
    <ModalShell
      title={`「${label}」のプレビュー(見本の差し込み・送付前の帯付き)`}
      size="xl"
      onClose={onClose}
      footer={<Button type="button" variant="secondary" onClick={onClose}>閉じる</Button>}
    >
      <div className="text-xs">
        <div className="flex flex-wrap items-center gap-2">
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
        </div>
        <div className="mt-2 overflow-x-auto">
          {/* sandbox: 同一オリジンの自前ページなので allow-same-origin だけ許し、
              script・form 送信・別窓・親画面への遷移は禁じる(枠の中から画面を乗っ取らせない)。 */}
          <iframe
            key={device}
            src={LP_PREVIEW_URL(campaignId, lpId, device)}
            sandbox="allow-same-origin"
            title={label}
            style={{ width: WIDTH[device], maxWidth: "100%", height: 720 }}
            className="rounded border border-gray-300 bg-white"
          />
        </div>
      </div>
    </ModalShell>
  );
}
