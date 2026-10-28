"use client";

/**
 * ファイルを入れる(2026-10-28 発注者決定・第2段)。
 *
 * 取り込みのファイルはどれもここに入れる。中身を見て行き先を決め(保存しない)、
 *   受付帳・所有者・顧客管理表・謄本・反響の PDF … 今ある取り込みの画面へファイルを持って進む(1件ずつ)
 *   書類(ほかの PDF・Word・画像・Excel) … まとめて書類の受け取り箱へ入れる
 *   決められない CSV … 人が選ぶ
 * 取り込みのやり方(下見・確認・登録・履歴)は、進んだ先の画面のまま変えない。
 * ⚠PDF は謄本かもしれない(ファイル名に所有者名が入り得る)ので、名前を出さず「◯件目のPDF」と書く。
 * ⚠受け取り箱を使えない人(現地担当など)は、書類を断って取り込みだけ使う(発注者決定)。
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import ImportSwitcher from "@/components/import/import-switcher";
import FileDropZone from "@/components/ui/file-drop-zone";
import {
  detectDropPdf,
  detectDropSheet,
  readFileForImport,
  uploadReportToInbox,
} from "@/lib/api-client";
import {
  DROP_TARGET_LABELS,
  HANDOFF_BUTTON_LABELS,
  HANDOFF_PATHS,
  dropFileKind,
  isHandoffTarget,
  type DropTarget,
  type HandoffTarget,
} from "@/lib/import-drop/detect";
import { putHandoff, type SheetEntry } from "@/lib/import-drop/handoff";
import { dropRowName, inboxErrorMessage, inboxSizeError } from "@/lib/import-drop/rows";

type RowState = "checking" | "ready" | "inbox" | "inbox_done" | "error";

interface Row {
  id: number;
  file: File;
  name: string;
  state: RowState;
  target: DropTarget | null;
  entry: SheetEntry | null;
  message: string | null;
}

export default function ImportDropPage() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);

  const update = (id: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  /** 書類の受け取り箱へ入れる。 */
  const sendToInbox = async (row: Row) => {
    const tooLarge = inboxSizeError(row.file);
    if (tooLarge) {
      update(row.id, { state: "error", target: "document", message: tooLarge });
      return;
    }
    update(row.id, { state: "inbox", target: "document", message: "受け取り箱に入れています…" });
    try {
      await uploadReportToInbox(row.file);
      update(row.id, { state: "inbox_done", message: "受け取り箱に入れました" });
    } catch (e) {
      update(row.id, { state: "error", message: inboxErrorMessage(e) });
    }
  };

  /** 中身を見て行き先を決める(保存しない)。書類はそのまま受け取り箱へ。 */
  const handleFiles = async (files: File[]) => {
    const base = Date.now();
    const added: Row[] = files.map((file, i) => ({
      id: base + i,
      file,
      name: dropRowName(file, i),
      state: "checking",
      target: null,
      entry: null,
      message: null,
    }));
    setRows(added);
    setBusy(true);
    try {
      for (const row of added) {
        const kind = dropFileKind(row.file);
        let target: DropTarget = "document";
        let entry: SheetEntry | null = null;
        try {
          if (kind === "sheet") {
            const read = await readFileForImport(row.file);
            entry = { name: row.file.name, csvText: read.csvText, xlsxBase64: read.xlsxBase64 };
            target = (await detectDropSheet(read)).target;
          } else if (kind === "pdf") {
            target = (await detectDropPdf(row.file)).target;
          }
        } catch (e) {
          update(row.id, { state: "error", message: e instanceof Error ? e.message : "中身を確かめられませんでした" });
          continue;
        }
        if (target === "document") {
          await sendToInbox(row);
        } else {
          update(row.id, { state: "ready", target, entry });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  /** 取り込みの画面へ、ファイルを持って進む。 */
  const go = (row: Row, target: HandoffTarget) => {
    if (target === "reception" || target === "owner") {
      if (!row.entry) return;
      putHandoff({ target, entry: row.entry });
    } else {
      putHandoff({ target, file: row.file });
    }
    router.push(HANDOFF_PATHS[target]);
  };

  return (
    <div>
      <ImportSwitcher />
      <PageHeader
        title="ファイルを入れる"
        description="取り込みのファイルは、どれもここに入れてください。中身を見て行き先を決めます(この画面では保存しません)。受付帳・所有者の一覧・顧客管理表・謄本・反響のPDFは、ボタンでそれぞれの取り込みの画面へ進み、いつもどおり確かめてから取り込みます。そのほかの書類は書類の受け取り箱に入ります。"
      />

      <div className="max-w-4xl space-y-6">
        <FileDropZone
          size="lg"
          accept=".csv,.tsv,.txt,.xlsx,.xls,.pdf,.docx,.jpg,.jpeg,.png,.webp,.heic"
          multiple
          hideFileNames
          disabled={busy}
          title="ファイルをここにドラッグ＆ドロップ"
          hint="CSV・Excel・PDF・Word・画像。何個でもまとめて入れられます。"
          onFiles={(files) => void handleFiles(files)}
        />

        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <th className="px-3 py-2 font-medium">入れたもの</th>
                  <th className="px-3 py-2 font-medium">見分けた中身</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-gray-100 last:border-0 dark:border-gray-800">
                    <td className="px-3 py-2 text-gray-800 dark:text-gray-100">{row.name}</td>
                    <td className="px-3 py-2 text-gray-600 dark:text-gray-300">
                      {row.state === "checking" ? (
                        <span className="inline-flex items-center gap-1">
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          中身を見ています…
                        </span>
                      ) : row.target ? (
                        DROP_TARGET_LABELS[row.target]
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <RowAction row={row} onGo={(t) => go(row, t)} onInbox={() => void sendToInbox(row)} busy={busy} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-gray-500 dark:text-gray-400">
          受け取り箱に入れた書類は、<Link href="/import/report-inbox" className="underline">書類の受け取り箱</Link>
          で物件を選んで添付します。書類が1冊にまとまったPDFを書類ごとに分けたいときは、物件の画面の「添付ファイル」に入れてください。
        </p>
      </div>
    </div>
  );
}

function RowAction({
  row,
  onGo,
  onInbox,
  busy,
}: {
  row: Row;
  onGo: (target: HandoffTarget) => void;
  onInbox: () => void;
  busy: boolean;
}) {
  if (row.state === "checking") return null;
  if (row.state === "inbox") {
    return (
      <span className="inline-flex items-center gap-1 text-gray-600 dark:text-gray-300">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        {row.message}
      </span>
    );
  }
  if (row.state === "inbox_done") {
    return <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">{row.message}</span>;
  }
  if (row.state === "error") {
    return <span className="text-xs text-red-700 dark:text-red-300">{row.message}</span>;
  }
  if (row.target === "unknown") {
    // 決められない CSV: 人が選ぶ(推測で取り込みへ回さない)。
    return (
      <span className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => onGo("reception")}>
          受付帳として
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => onGo("owner")}>
          所有者の一覧として
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onInbox}>
          書類として受け取り箱へ
        </Button>
      </span>
    );
  }
  if (row.target && isHandoffTarget(row.target)) {
    const target = row.target;
    return (
      <Button type="button" size="sm" disabled={busy} onClick={() => onGo(target)}>
        {HANDOFF_BUTTON_LABELS[target]}
      </Button>
    );
  }
  return null;
}
