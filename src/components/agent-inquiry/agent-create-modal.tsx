"use client";

import { useState } from "react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { createDeskAgent, type AgentHit } from "@/lib/api-client";
import { formatPhoneJp, isValidPhoneJp } from "@/lib/phone-format-jp";

const MLIT_SEARCH_URL = "https://etsuran2.mlit.go.jp/TAKKEN/";
const FIELDS = [
  ["companyName", "商号(必須)"],
  ["branchName", "支店名"],
  ["phone", "代表電話(必須)"],
  ["fax", "FAX"],
  ["email", "メール"],
  ["licenseNo", "免許番号"],
  ["address", "所在地"],
  ["note", "メモ"],
] as const;
type Key = (typeof FIELDS)[number][0];
const PHONE_KEYS = new Set<Key>(["phone", "fax"]);

/** 名簿にない業者をその場で登録する小窓(設計 §2.2-1・方針7)。会社の情報だけ。 */
export function AgentCreateModal({
  initialPhone,
  onClose,
  onCreated,
}: {
  initialPhone: string;
  onClose: () => void;
  onCreated: (hit: AgentHit) => void;
}) {
  const [v, setV] = useState<Record<Key, string>>({
    companyName: "",
    branchName: "",
    phone: initialPhone,
    fax: "",
    email: "",
    licenseNo: "",
    address: "",
    note: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: Key, val: string) => setV((p) => ({ ...p, [k]: val }));
  const submit = async () => {
    if (saving) return;
    if (!v.companyName.trim() || !v.phone.trim()) {
      setError("商号と代表電話を入れてください");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const phone = formatPhoneJp(v.phone).value;
      const blank = (s: string) => (s.trim() === "" ? null : s.trim());
      const { id } = await createDeskAgent({
        companyName: v.companyName.trim(),
        phone,
        branchName: blank(v.branchName),
        fax: blank(v.fax),
        email: blank(v.email),
        licenseNo: blank(v.licenseNo),
        address: blank(v.address),
        note: blank(v.note),
      });
      onCreated({
        id,
        companyName: v.companyName.trim(),
        branchName: blank(v.branchName),
        phone,
        lastContact: null,
        matchedBy: "text",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "登録できませんでした");
      setSaving(false);
    }
  };
  return (
    <ModalShell
      size="md"
      title="新しい業者"
      // 登録中は閉じない(閉じても登録は止まらず、取り消したつもりの業者が登録・選択される)。
      onClose={saving ? undefined : onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            やめる
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "登録中…" : "登録して戻る"}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {FIELDS.map(([k, label]) => (
          <label key={k} className="block text-sm">
            <span className="text-xs text-gray-500">{label}</span>
            <input
              value={v[k]}
              onChange={(e) => set(k, e.target.value)}
              onBlur={PHONE_KEYS.has(k) ? () => set(k, formatPhoneJp(v[k]).value) : undefined}
              inputMode={PHONE_KEYS.has(k) ? "tel" : undefined}
              className="mt-0.5 w-full rounded-md border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
            />
            {PHONE_KEYS.has(k) && v[k].trim() !== "" && !isValidPhoneJp(v[k]) && (
              <span className="text-[11px] text-amber-700 dark:text-amber-300">
                電話番号の桁をご確認ください(このままでも保存できます)
              </span>
            )}
          </label>
        ))}
        <a
          href={MLIT_SEARCH_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-sm text-teal-700 underline dark:text-teal-300"
        >
          国の宅建業者検索を開いて確かめる ↗
        </a>
        {error && <p className="text-sm text-rose-600">{error}</p>}
      </div>
    </ModalShell>
  );
}
