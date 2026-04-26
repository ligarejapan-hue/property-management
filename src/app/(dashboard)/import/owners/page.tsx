"use client";

import { useState, useCallback, useRef, useMemo } from "react";
import {
  Upload,
  FileText,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  ChevronRight,
  GripVertical,
  Eye,
  ArrowRight,
  Check,
  ChevronDown,
  FileUp,
  Table2,
  ClipboardCheck,
  DownloadCloud,
  Link2,
} from "lucide-react";
import { importOwnerCsv, relinkOwners } from "@/lib/api-client";
import type { RelinkOwnersResponse } from "@/lib/api-client";
import { readCsvFileAsText } from "@/lib/csv-decode";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImportResult {
  jobId: string;
  totalRows: number;
  successCount: number;
  errorCount: number;
  needsReviewCount: number;
  linkedCount: number;
  linkedByLinkKeyCount?: number;
  linkedByAddressCount?: number;
  addressLinkAmbiguousCount?: number;
}

type Step = 1 | 2 | 3 | 4;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OWNER_TARGET_FIELDS = [
  "氏名",
  "氏名カナ",
  "電話番号",
  "郵便番号",
  "住所",
  "備考",
  "リンクキー",
] as const;

type OwnerTargetField = (typeof OWNER_TARGET_FIELDS)[number];

const OWNER_TEMPLATES: Record<string, { label: string; columns: string[] }> = {
  standard: {
    label: "標準所有者CSV",
    columns: ["氏名(必須)", "氏名カナ", "電話番号", "郵便番号", "住所", "備考", "リンクキー"],
  },
  homukyoku: {
    label: "法務局形式",
    columns: ["権利者名", "フリガナ", "住所", "持分"],
  },
  simple: {
    label: "簡易リスト",
    columns: ["名前", "電話番号", "住所"],
  },
};

const AUTO_MAP: Record<string, OwnerTargetField> = {
  "氏名": "氏名",
  "名前": "氏名",
  "権利者名": "氏名",
  "権利者": "氏名",
  "所有者名": "氏名",
  "name": "氏名",
  "氏名カナ": "氏名カナ",
  "フリガナ": "氏名カナ",
  "カナ": "氏名カナ",
  "nameKana": "氏名カナ",
  "電話番号": "電話番号",
  "電話": "電話番号",
  "TEL": "電話番号",
  "phone": "電話番号",
  "郵便番号": "郵便番号",
  "〒": "郵便番号",
  "zip": "郵便番号",
  "住所": "住所",
  "所在地": "住所",
  "address": "住所",
  "備考": "備考",
  "メモ": "備考",
  "note": "備考",
  "リンクキー": "リンクキー",
  "外部キー": "リンクキー",
  "link_key": "リンクキー",
  "externalLinkKey": "リンクキー",
};

const STEP_META: Record<Step, { label: string; icon: typeof Upload }> = {
  1: { label: "ファイル選択", icon: FileUp },
  2: { label: "カラム対応", icon: Table2 },
  3: { label: "プレビュー", icon: ClipboardCheck },
  4: { label: "取込結果", icon: DownloadCloud },
};

// ---------------------------------------------------------------------------
// CSV Parsing
// ---------------------------------------------------------------------------

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
      } else if (ch === "," || ch === "\t") {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((l) => l.trim() !== "");
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine);
  return { headers, rows };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type RowStatus = "valid" | "warning" | "error";

function validateOwnerRow(
  row: string[],
  headers: string[],
  mapping: Record<string, string>
): { status: RowStatus; message: string } {
  const nameIdx = headers.findIndex((h) => mapping[h] === "氏名");
  if (nameIdx === -1) {
    return { status: "warning", message: "氏名カラム未設定" };
  }
  const nameVal = row[nameIdx] ?? "";
  if (!nameVal.trim()) {
    return { status: "error", message: "氏名が空です" };
  }
  if (nameVal.length < 2) {
    return { status: "warning", message: "氏名が短すぎる可能性" };
  }
  return { status: "valid", message: "" };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function OwnerImportPage() {
  const [step, setStep] = useState<Step>(1);
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [template, setTemplate] = useState<string>("standard");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 既存未リンク所有者の救済 (CSV 取込とは独立で実行できる)
  const [relinking, setRelinking] = useState(false);
  const [relinkResult, setRelinkResult] = useState<RelinkOwnersResponse | null>(null);
  const [relinkError, setRelinkError] = useState<string | null>(null);

  const handleRelink = async () => {
    if (relinking) return;
    if (!confirm("PropertyOwner を 1 件も持たない既存所有者を、リンクキー / 住所で物件に再リンクします。実行しますか？")) {
      return;
    }
    setRelinking(true);
    setRelinkError(null);
    setRelinkResult(null);
    try {
      const res = await relinkOwners();
      setRelinkResult(res);
    } catch (err) {
      setRelinkError(err instanceof Error ? err.message : "再リンクに失敗しました");
    } finally {
      setRelinking(false);
    }
  };

  // ------ File handling ------
  const processFile = useCallback(async (file: File) => {
    setFileName(file.name);
    setError(null);
    setResult(null);
    try {
      // UTF-8 BOM / UTF-8 / Shift-JIS(CP932) を自動判定して decode する。
      // 実務 CSV は Excel 出力の Shift-JIS が多いため、UTF-8 固定読み込みだと
      // 文字化けする → 共通デコーダ経由に変更。
      const text = await readCsvFileAsText(file);
      setCsvText(text);
      const { headers: h, rows: r } = parseCsv(text);
      setHeaders(h);
      setRows(r);
      const mapping: Record<string, string> = {};
      h.forEach((header) => {
        const normalized = header.trim();
        if (AUTO_MAP[normalized]) {
          mapping[normalized] = AUTO_MAP[normalized];
        }
      });
      setColumnMapping(mapping);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ファイル読込に失敗しました");
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    processFile(file);
  };

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      const file = e.dataTransfer.files?.[0];
      if (file) processFile(file);
    },
    [processFile]
  );

  // ------ Mapping ------
  const updateMapping = (header: string, value: string) => {
    setColumnMapping((prev) => {
      const next = { ...prev };
      if (value === "") {
        delete next[header];
      } else {
        next[header] = value;
      }
      return next;
    });
  };

  const mappedFields = useMemo(
    () => new Set(Object.values(columnMapping)),
    [columnMapping]
  );

  // ------ Validation ------
  const validationSummary = useMemo(() => {
    let valid = 0;
    let warnings = 0;
    let errors = 0;
    const rowStatuses: { status: RowStatus; message: string }[] = [];
    rows.forEach((row) => {
      const v = validateOwnerRow(row, headers, columnMapping);
      rowStatuses.push(v);
      if (v.status === "valid") valid++;
      else if (v.status === "warning") warnings++;
      else errors++;
    });
    return { valid, warnings, errors, rowStatuses };
  }, [rows, headers, columnMapping]);

  // Check if link key is mapped (for info display)
  const hasLinkKey = mappedFields.has("リンクキー");

  // ------ Import ------
  const handleImport = async () => {
    if (!csvText.trim()) return;
    setUploading(true);
    setError(null);
    setResult(null);

    try {
      const json = await importOwnerCsv(fileName || "owner-import.csv", csvText, columnMapping);
      setResult(json as ImportResult);
      setStep(4);
    } catch (err) {
      setError(err instanceof Error ? err.message : "取込に失敗しました");
    } finally {
      setUploading(false);
    }
  };

  // ------ Reset ------
  const handleReset = () => {
    setStep(1);
    setCsvText("");
    setFileName("");
    setHeaders([]);
    setRows([]);
    setColumnMapping({});
    setResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ------ Render helpers ------
  const statusIcon = (status: RowStatus) => {
    if (status === "valid")
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    if (status === "warning")
      return <AlertTriangle className="h-4 w-4 text-amber-500" />;
    return <XCircle className="h-4 w-4 text-red-500" />;
  };

  return (
    <div>
      <h2 className="mb-6 text-2xl font-bold text-gray-800">所有者CSV取込</h2>

      {/* ============ 既存未リンク所有者の救済 ============ */}
      <div className="mb-6 rounded-md border border-gray-200 bg-white p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="text-sm text-gray-700">
            <div className="mb-1 flex items-center gap-2 font-semibold text-gray-800">
              <Link2 className="h-4 w-4 text-blue-600" />
              既存未リンク所有者の再リンク
            </div>
            <div className="text-xs text-gray-600">
              過去の取込で物件に紐付かなかった所有者を、リンクキーまたは住所一致 (1物件に絞れる場合のみ) で自動リンクします。共有名義は壊しません。
            </div>
          </div>
          <button
            onClick={handleRelink}
            disabled={relinking}
            className="flex items-center gap-2 self-start whitespace-nowrap rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {relinking ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            未リンク所有者を再リンク
          </button>
        </div>
        {relinkError && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{relinkError}</span>
          </div>
        )}
        {relinkResult && (
          <div className="mt-3 space-y-2">
            <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                対象 <strong>{relinkResult.candidateOwnerCount}</strong> 件のうち
                {" "}
                <strong>{relinkResult.linkedCount}</strong> 件をリンクしました。
                {relinkResult.linkedByLinkKeyCount > 0 && (
                  <span className="ml-2 text-xs">
                    （リンクキー一致: {relinkResult.linkedByLinkKeyCount}）
                  </span>
                )}
                {relinkResult.linkedByAddressCount > 0 && (
                  <span className="ml-2 text-xs">
                    （住所一致: {relinkResult.linkedByAddressCount}）
                  </span>
                )}
              </div>
            </div>
            {relinkResult.addressLinkAmbiguousCount > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  {relinkResult.addressLinkAmbiguousCount} 件の所有者は同じ住所に複数物件があり自動紐付けを保留しました。物件詳細から手動で紐付けてください。
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ============ Step Indicator ============ */}
      <div className="mb-8 flex items-center justify-center gap-0">
        {([1, 2, 3, 4] as Step[]).map((s, idx) => {
          const meta = STEP_META[s];
          const Icon = meta.icon;
          const isActive = s === step;
          const isDone = s < step;
          return (
            <div key={s} className="flex items-center">
              {idx > 0 && (
                <ChevronRight
                  className={`mx-1 h-4 w-4 shrink-0 ${isDone ? "text-blue-500" : "text-gray-300"}`}
                />
              )}
              <button
                onClick={() => { if (isDone) setStep(s); }}
                disabled={!isDone}
                className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-blue-600 text-white"
                    : isDone
                      ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                      : "bg-gray-100 text-gray-400"
                }`}
              >
                {isDone ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                {meta.label}
              </button>
            </div>
          );
        })}
      </div>

      {/* ============ Step 1: File Upload ============ */}
      {step === 1 && (
        <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="mb-4 text-lg font-semibold text-gray-700">ファイル選択</h3>

          {/* Template */}
          <div className="mb-5">
            <label className="mb-1 block text-sm font-medium text-gray-600">テンプレート</label>
            <div className="relative inline-block">
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                className="appearance-none rounded-md border border-gray-300 bg-white py-2 pl-3 pr-9 text-sm text-gray-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {Object.entries(OWNER_TEMPLATES).map(([key, t]) => (
                  <option key={key} value={key}>{t.label}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            </div>
            <div className="mt-2 rounded bg-gray-50 p-3 text-xs text-gray-500">
              <span className="font-medium text-gray-600">対応カラム: </span>
              {OWNER_TEMPLATES[template].columns.join(", ")}
            </div>
          </div>

          {/* Link Key info */}
          <div className="mb-5 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
            <div className="flex items-center gap-2 font-medium">
              <Link2 className="h-4 w-4" />
              リンクキーについて
            </div>
            <p className="mt-1 text-xs text-blue-600">
              CSVに「リンクキー」列を含めると、同じリンクキーを持つ物件と所有者が自動的に紐付けられます。
              物件CSVにも同じリンクキーを設定してください。
            </p>
          </div>

          {/* Drop zone */}
          <div
            onDragEnter={handleDrag}
            onDragOver={handleDrag}
            onDragLeave={handleDrag}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`group cursor-pointer rounded-lg border-2 border-dashed p-12 text-center transition-colors ${
              dragActive
                ? "border-blue-500 bg-blue-50"
                : "border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-gray-100"
            }`}
          >
            <Upload className={`mx-auto mb-3 h-10 w-10 ${dragActive ? "text-blue-500" : "text-gray-400"}`} />
            <p className="mb-1 text-sm font-medium text-gray-700">
              所有者CSVファイルをここにドラッグ＆ドロップ
            </p>
            <p className="text-xs text-gray-400">またはクリックしてファイルを選択</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.tsv,.txt"
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>

          {fileName && (
            <div className="mt-4 flex items-center gap-2 text-sm text-gray-600">
              <FileText className="h-4 w-4" />
              <span>{fileName}</span>
              <span className="text-gray-400">({rows.length} 行)</span>
            </div>
          )}
        </div>
      )}

      {/* ============ Step 2: Column Mapping ============ */}
      {step === 2 && (
        <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="mb-4 text-lg font-semibold text-gray-700">カラム対応設定</h3>
          <p className="mb-4 text-sm text-gray-500">
            CSVのヘッダーと取込先フィールドを対応させてください。
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  <th className="px-3 py-2 font-medium text-gray-600 w-8"></th>
                  <th className="px-3 py-2 font-medium text-gray-600">CSVヘッダー</th>
                  <th className="px-3 py-2 font-medium text-gray-600 w-8">
                    <ArrowRight className="h-4 w-4" />
                  </th>
                  <th className="px-3 py-2 font-medium text-gray-600">取込先フィールド</th>
                  <th className="px-3 py-2 font-medium text-gray-600 w-12">状態</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {headers.map((header) => {
                  const mapped = columnMapping[header] ?? "";
                  const isMapped = mapped !== "";
                  return (
                    <tr key={header} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-gray-300">
                        <GripVertical className="h-4 w-4" />
                      </td>
                      <td className="px-3 py-2 font-mono text-gray-800">{header}</td>
                      <td className="px-3 py-2 text-gray-300">
                        <ArrowRight className="h-4 w-4" />
                      </td>
                      <td className="px-3 py-2">
                        <div className="relative inline-block">
                          <select
                            value={mapped}
                            onChange={(e) => updateMapping(header, e.target.value)}
                            className="appearance-none rounded border border-gray-300 bg-white py-1 pl-2 pr-7 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          >
                            <option value="">-- 未設定 --</option>
                            {OWNER_TARGET_FIELDS.map((f) => (
                              <option key={f} value={f} disabled={mappedFields.has(f) && mapped !== f}>
                                {f}
                                {mappedFields.has(f) && mapped !== f ? " (使用済)" : ""}
                              </option>
                            ))}
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {isMapped ? (
                          <CheckCircle2 className="h-5 w-5 text-green-500" />
                        ) : (
                          <AlertTriangle className="h-5 w-5 text-amber-400" />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
            <span>
              {Object.keys(columnMapping).length} / {headers.length} カラム対応済
            </span>
            <div className="flex gap-3">
              {!mappedFields.has("氏名") && (
                <span className="text-amber-600 font-medium">
                  <AlertTriangle className="mr-1 inline h-4 w-4" />
                  氏名フィールドの対応が必須
                </span>
              )}
              {hasLinkKey && (
                <span className="text-blue-600 font-medium">
                  <Link2 className="mr-1 inline h-4 w-4" />
                  リンクキー設定済
                </span>
              )}
            </div>
          </div>

          <div className="mt-6 flex gap-3">
            <button
              onClick={() => setStep(1)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              戻る
            </button>
            <button
              onClick={() => setStep(3)}
              className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Eye className="h-4 w-4" />
              プレビューへ
            </button>
          </div>
        </div>
      )}

      {/* ============ Step 3: Preview ============ */}
      {step === 3 && (
        <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="mb-4 text-lg font-semibold text-gray-700">プレビュー・検証</h3>

          {/* Summary cards */}
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-center">
              <div className="text-2xl font-bold text-gray-800">{rows.length}</div>
              <div className="text-xs text-gray-500">総行数</div>
            </div>
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-center">
              <div className="text-2xl font-bold text-green-700">{validationSummary.valid}</div>
              <div className="text-xs text-green-600">有効</div>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-center">
              <div className="text-2xl font-bold text-amber-700">{validationSummary.warnings}</div>
              <div className="text-xs text-amber-600">警告</div>
            </div>
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-center">
              <div className="text-2xl font-bold text-red-700">{validationSummary.errors}</div>
              <div className="text-xs text-red-600">エラー</div>
            </div>
          </div>

          {/* Link Key info */}
          {hasLinkKey && (
            <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 flex items-center gap-2">
              <Link2 className="h-4 w-4 shrink-0" />
              リンクキーが設定されています。取込後、既存物件と自動的に紐付けが行われます。
            </div>
          )}

          {/* Preview table */}
          <p className="mb-2 text-sm font-medium text-gray-600">先頭5行プレビュー</p>
          <div className="overflow-x-auto rounded border border-gray-200">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  <th className="px-2 py-1.5 font-medium text-gray-500 w-8">#</th>
                  <th className="px-2 py-1.5 font-medium text-gray-500 w-10">状態</th>
                  {headers.map((h) => (
                    <th key={h} className="px-2 py-1.5 font-medium text-gray-600 whitespace-nowrap">
                      {h}
                      {columnMapping[h] && (
                        <span className="ml-1 text-blue-500 font-normal">({columnMapping[h]})</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.slice(0, 5).map((row, i) => {
                  const v = validationSummary.rowStatuses[i];
                  return (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-2 py-1.5 text-gray-400">{i + 1}</td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          {statusIcon(v?.status ?? "valid")}
                        </div>
                      </td>
                      {headers.map((h, j) => (
                        <td
                          key={j}
                          className="px-2 py-1.5 text-gray-700 max-w-[200px] truncate whitespace-nowrap"
                          title={row[j] ?? ""}
                        >
                          {row[j] ?? ""}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > 5 && (
            <p className="mt-1 text-xs text-gray-400">...他 {rows.length - 5} 行</p>
          )}

          {error && (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="mt-6 flex gap-3">
            <button
              onClick={() => setStep(2)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              戻る
            </button>
            <button
              onClick={handleImport}
              disabled={uploading}
              className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {uploading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  取込中...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" />
                  取込実行
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* ============ Step 4: Result ============ */}
      {step === 4 && result && (
        <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="mb-4 text-lg font-semibold text-gray-700">取込結果</h3>

          <div className="mb-6 rounded-md border border-green-200 bg-green-50 p-5">
            <div className="mb-3 flex items-center gap-2 text-green-800">
              <CheckCircle2 className="h-5 w-5" />
              <span className="font-semibold">取込が完了しました</span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
              <div>
                <span className="text-gray-600">総行数:</span>{" "}
                <strong>{result.totalRows}</strong>
              </div>
              <div>
                <span className="text-green-600">成功:</span>{" "}
                <strong className="text-green-700">{result.successCount}</strong>
              </div>
              <div>
                <span className="text-red-600">エラー:</span>{" "}
                <strong className="text-red-700">{result.errorCount}</strong>
              </div>
              <div>
                <span className="text-amber-600">要レビュー:</span>{" "}
                <strong className="text-amber-700">{result.needsReviewCount}</strong>
              </div>
              <div>
                <span className="text-blue-600">物件紐付:</span>{" "}
                <strong className="text-blue-700">{result.linkedCount}</strong>
              </div>
            </div>
          </div>

          {result.linkedCount > 0 && (
            <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 flex items-start gap-2">
              <Link2 className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                {result.linkedCount} 件の物件-所有者紐付けが作成されました。
                {(result.linkedByLinkKeyCount ?? 0) > 0 && (
                  <span className="ml-2 text-xs text-blue-600">
                    （リンクキー一致: {result.linkedByLinkKeyCount}）
                  </span>
                )}
                {(result.linkedByAddressCount ?? 0) > 0 && (
                  <span className="ml-2 text-xs text-blue-600">
                    （住所一致: {result.linkedByAddressCount}）
                  </span>
                )}
              </div>
            </div>
          )}
          {(result.addressLinkAmbiguousCount ?? 0) > 0 && (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                {result.addressLinkAmbiguousCount} 件の所有者は同じ住所に複数物件があり自動紐付けを保留しました。物件詳細から手動で紐付けてください。
              </div>
            </div>
          )}

          <button
            onClick={handleReset}
            className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            <RefreshCw className="h-4 w-4" />
            新しいファイルを取込
          </button>
        </div>
      )}
    </div>
  );
}
