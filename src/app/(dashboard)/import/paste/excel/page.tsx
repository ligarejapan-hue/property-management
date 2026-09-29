"use client";

/**
 * 「貼り付けて物件化」のまとめて版: 査定サイトの反響を書き溜めた顧客管理表(Excel)を
 * 読み、迷いのない行をまとめて物件+所有者として登録する。
 *
 * ⚠登録は**1行ずつ既存の登録API(/api/import/paste/commit)**を呼ぶ。二重登録の止め・
 *   項目ごとの権限・監査は貼り付けと同じ1本の経路を通る(ここで別の保存経路を作らない)。
 * ⚠要確認の行(似た物件・同名の所有者・読めない項目)は登録しない。人が
 *   「貼り付けて物件化」で確かめる。
 */
import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import ImportSwitcher from "@/components/import/import-switcher";
import {
  ExcelLeadTable,
  excelLeadRowKey,
  type ExcelLeadRow,
  type ExcelLeadResult,
} from "@/components/import/excel-lead-table";
import {
  excelLeadCommitBody,
  commitOutcome,
} from "@/components/import/excel-lead-commit-body";

/** 非2xx応答からエラーメッセージを取り出す(貼り付け画面と同じ姿勢)。 */
async function readApiErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? `処理に失敗しました（${res.status}）`;
}

/** File → base64(先頭の data:...;base64, を外す)。 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("ファイルを読み込めませんでした"));
    reader.readAsDataURL(file);
  });
}

export default function ExcelLeadImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [rows, setRows] = useState<ExcelLeadRow[] | null>(null);
  const [results, setResults] = useState<Record<string, ExcelLeadResult>>({});
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  /** 中止の合図。押された行の登録は終わらせ、次の行から止める。 */
  const stopRef = useRef(false);

  const readyRows = (rows ?? []).filter(
    (r) => r.status === "ready" && results[excelLeadRowKey(r)] === undefined,
  );
  const counts = {
    ready: (rows ?? []).filter((r) => r.status === "ready").length,
    review: (rows ?? []).filter((r) => r.status === "review").length,
    registered: (rows ?? []).filter((r) => r.status === "registered").length,
  };
  const done = Object.values(results);
  const createdCount = done.filter((r) => r.kind === "created").length;
  const failedCount = done.filter((r) => r.kind === "failed").length;

  const handleRead = useCallback(async () => {
    if (!file) return;
    setReading(true);
    setReadError(null);
    try {
      const xlsxBase64 = await fileToBase64(file);
      const res = await fetch("/api/import/paste/excel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, xlsxBase64 }),
      });
      if (!res.ok) throw new Error(await readApiErrorMessage(res));
      const data = (await res.json()) as { rows: ExcelLeadRow[] };
      setRows(data.rows);
      setResults({});
    } catch (e) {
      setReadError(e instanceof Error ? e.message : "読み取りに失敗しました");
    } finally {
      setReading(false);
    }
  }, [file]);

  const handleRegisterAll = useCallback(async () => {
    setConfirming(false);
    setRunning(true);
    setProgress(0);
    stopRef.current = false;
    const targets = readyRows;
    setTotal(targets.length);
    for (let i = 0; i < targets.length; i++) {
      if (stopRef.current) break;
      const row = targets[i];
      let result: ExcelLeadResult;
      try {
        // ⚠重複の確認は**登録APIの中で作成と同じロックの内側**で行う
        //   (requireNoDuplicates・@codex PR#456 1巡目 ①/4巡目 ①)。下見は取込前の
        //   DBに対する判定なので、前の行や他の人の取込で作られた所有者・物件が
        //   映っていない。確定の時点で候補が見つかった行は 409 NEEDS_REVIEW で
        //   返り、要確認になる。
        const res = await fetch("/api/import/paste/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(excelLeadCommitBody(row)),
        });
        result = commitOutcome(res.status, await res.json().catch(() => null));
      } catch (e) {
        result = { kind: "failed", message: e instanceof Error ? e.message : "通信に失敗しました" };
      }
      const key = excelLeadRowKey(row);
      setResults((prev) => ({ ...prev, [key]: result }));
      setProgress(i + 1);
    }
    setRunning(false);
  }, [readyRows]);

  return (
    // ⚠画面の最上位に PII 保護の印を付ける(貼り付け画面と同じ)。氏名・電話・
    //   メール・住所・管理のメモが一覧にまとめて並ぶ。
    <div data-pii-protected data-pii-surface="import" className="space-y-6">
      <ImportSwitcher />
      <PageHeader
        title="Excelからまとめて物件化"
        description="査定サイトの反響を書き溜めた顧客管理表（Excel）を読み、物件と所有者をまとめて登録します。似た物件や同じ名前の所有者がいる行は登録せず、「要確認」として残します。"
      />
      <p className="text-sm">
        <Link href="/import/paste" className="text-indigo-600 hover:underline dark:text-indigo-400">
          ← 1件ずつ貼り付けて登録する
        </Link>
      </p>

      <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <label htmlFor="excel-lead-file" className="block text-sm font-medium text-gray-800 dark:text-gray-200">
          顧客管理表（.xlsx）
        </label>
        <input
          id="excel-lead-file"
          type="file"
          accept=".xlsx"
          className="block text-sm text-gray-700 dark:text-gray-300"
          disabled={reading || running}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setRows(null);
            setResults({});
            setReadError(null);
          }}
        />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          すべてのシートを読みます。「姓名」の列がある表（反響メール本文の「URL」列つき、または「物件所在地」の列つき）に対応しています。読み取っただけでは何も登録されません。
        </p>
        {readError && (
          <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
            {readError}
          </div>
        )}
        <Button onClick={handleRead} disabled={!file || reading || running}>
          {reading ? "読み取っています…" : "読み取る"}
        </Button>
      </section>

      {rows && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-gray-200 bg-white p-4 text-sm dark:border-gray-700 dark:bg-gray-800">
            <span>全{rows.length}件</span>
            <span>登録できる {counts.ready}件</span>
            <span>要確認 {counts.review}件</span>
            <span>登録済み {counts.registered}件</span>
            {done.length > 0 && (
              <span className="font-medium">
                今回登録 {createdCount}件{failedCount > 0 ? `・登録できなかった ${failedCount}件` : ""}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {running ? (
                <>
                  <span>登録しています… {progress}/{total}</span>
                  <Button variant="secondary" size="sm" onClick={() => { stopRef.current = true; }}>
                    中止
                  </Button>
                </>
              ) : (
                <Button onClick={() => setConfirming(true)} disabled={readyRows.length === 0}>
                  登録できる {readyRows.length}件をまとめて登録
                </Button>
              )}
            </div>
          </div>

          <ExcelLeadTable rows={rows} results={results} />
        </section>
      )}

      {confirming && (
        // ⚠削除用の ConfirmDialog(赤いボタン)は使わない。取り消せない操作ではあるが
        //   危険な操作ではないので、ふつうの確認にする。
        <ModalShell
          size="sm"
          title={`${readyRows.length}件を登録しますか？`}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)}>キャンセル</Button>
              <Button onClick={() => { void handleRegisterAll(); }}>登録する</Button>
            </>
          }
        >
          <p className="text-sm text-gray-500 dark:text-gray-400">
            物件と所有者を1件ずつ登録します。途中で「中止」を押すと、その時点で止まります（登録済みの分は残ります）。
          </p>
        </ModalShell>
      )}
    </div>
  );
}
