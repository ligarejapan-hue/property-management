"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
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
} from "lucide-react";
import Link from "next/link";
import {
  importCsv,
  fetchImportJobs,
  previewCsvDuplicates,
  previewReceptionOwnerCsv,
  importReceptionOwnerCsv,
  parseFileForPreview,
  readFileForImport,
  type ReceptionOwnerPreviewResponse,
  type ReceptionOwnerImportResponse,
} from "@/lib/api-client";
import { detectImportFileType } from "@/lib/import-file-type";
import { readCsvFileAsText } from "@/lib/csv-decode";
import ImportSwitcher from "@/components/import/import-switcher";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImportJobSummary {
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  needsReviewCount: number;
  errorCount: number;
  totalCount: number;
}

interface ImportJob {
  id: string;
  jobType: string;
  fileName: string;
  status: string;
  totalRows: number | null;
  successCount: number | null;
  errorCount: number | null;
  createdAt: string;
  executor: { id: string; name: string };
  // 段階A: API 側で動的計算した 5 区分の集計を含む。旧データや
  // フォールバック時は undefined になる可能性があるため optional。
  summary?: ImportJobSummary;
}

interface ImportJobFilters {
  jobType: string; // "" = すべて
  executedBy: string; // "" = すべて
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

const JOB_TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "すべての種別" },
  { value: "property_csv", label: "物件CSV" },
  { value: "owner_csv", label: "所有者CSV" },
  { value: "property_pdf", label: "謄本PDF" },
  { value: "dm_history_csv", label: "DM履歴CSV" },
  { value: "investigation_csv", label: "調査CSV" },
];

interface ImportResult {
  jobId: string;
  totalRows: number;
  successCount: number;
  updateCount?: number;
  errorCount: number;
  needsReviewCount: number;
  parseErrors: Array<{ row: number; message: string }>;
}

type Step = 1 | 2 | 3 | 4;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET_FIELDS = [
  "住所",
  "地番",
  "家屋番号",
  "不動産番号",
  "種別",
  "登記状況",
  "DM判断",
  "案件ステータス",
  "用途地域",
  "路線価",
  "緯度",
  "経度",
  "備考",
  "リンクキー",
] as const;

type TargetField = (typeof TARGET_FIELDS)[number];

// 表示専用ラベル: サーバへ送る値 (TARGET_FIELDS) は変えず、UI でだけ
// 「住所」が物件住所であることを明示。必須項目は「(必須)」を付与。
// 値変更するとサーバ側 JAPANESE_FIELD_MAP と整合しなくなるため値は変えない。
const TARGET_FIELD_LABELS: Record<TargetField, string> = {
  "住所": "物件住所 (必須)",
  "地番": "地番",
  "家屋番号": "家屋番号",
  "不動産番号": "不動産番号",
  "種別": "種別",
  "登記状況": "登記状況",
  "DM判断": "DM判断",
  "案件ステータス": "案件ステータス",
  "用途地域": "用途地域",
  "路線価": "路線価",
  "緯度": "緯度",
  "経度": "経度",
  "備考": "物件メモ",
  "リンクキー": "リンクキー (所有者と紐付け)",
};

const TEMPLATES: Record<
  string,
  { label: string; columns: string[] }
> = {
  standard: {
    label: "標準物件CSV",
    columns: [
      "住所(必須)",
      "地番",
      "家屋番号",
      "不動産番号",
      "種別",
      "登記状況",
      "DM判断",
      "案件ステータス",
      "用途地域",
      "路線価",
      "緯度",
      "経度",
      "備考",
    ],
  },
  homukyoku: {
    label: "法務局形式",
    columns: [
      "所在地",
      "地番",
      "家屋番号",
      "不動産番号",
      "地目",
      "地積",
      "登記年月日",
      "権利者",
    ],
  },
  gyosha: {
    label: "不動産業者形式",
    columns: [
      "物件名",
      "所在地",
      "価格",
      "面積",
      "築年数",
      "構造",
      "用途地域",
      "備考",
    ],
  },
};

/** Auto-mapping from common header names to target fields. */
const AUTO_MAP: Record<string, TargetField> = {
  "住所": "住所",
  "所在地": "住所",
  "物件住所": "住所",
  "address": "住所",
  "地番": "地番",
  "家屋番号": "家屋番号",
  "不動産番号": "不動産番号",
  "種別": "種別",
  "地目": "種別",
  "登記状況": "登記状況",
  "DM判断": "DM判断",
  "dm判断": "DM判断",
  "案件ステータス": "案件ステータス",
  "ステータス": "案件ステータス",
  "用途地域": "用途地域",
  "路線価": "路線価",
  "緯度": "緯度",
  "lat": "緯度",
  "経度": "経度",
  "lng": "経度",
  "lon": "経度",
  "備考": "備考",
  "メモ": "備考",
  "リンクキー": "リンクキー",
  "外部キー": "リンクキー",
  "link_key": "リンクキー",
  "externalLinkKey": "リンクキー",
};

const STATUS_CONFIG: Record<
  string,
  { label: string; icon: typeof CheckCircle2; color: string }
> = {
  completed: { label: "完了", icon: CheckCircle2, color: "text-green-600" },
  failed: { label: "エラーあり", icon: XCircle, color: "text-red-600" },
  processing: { label: "処理中", icon: Loader2, color: "text-blue-600" },
  pending: { label: "待機中", icon: AlertTriangle, color: "text-amber-600" },
};

const STEP_META: Record<Step, { label: string; icon: typeof Upload }> = {
  1: { label: "ファイル選択", icon: FileUp },
  2: { label: "カラム対応", icon: Table2 },
  3: { label: "プレビュー", icon: ClipboardCheck },
  4: { label: "取込結果", icon: DownloadCloud },
};

// ---------------------------------------------------------------------------
// CSV Parsing (client-side, handles quoted fields)
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
// Validation helpers
// ---------------------------------------------------------------------------

type RowStatus = "valid" | "warning" | "error";

function validateRow(
  row: string[],
  headers: string[],
  mapping: Record<string, string>
): { status: RowStatus; message: string } {
  // Find which column index maps to 住所
  const addressIdx = headers.findIndex((h) => mapping[h] === "住所");
  if (addressIdx === -1) {
    return { status: "warning", message: "住所カラム未設定" };
  }
  const addressVal = row[addressIdx] ?? "";
  if (!addressVal.trim()) {
    return { status: "error", message: "住所が空です" };
  }
  // Check for unusually short address
  if (addressVal.length < 3) {
    return { status: "warning", message: "住所が短すぎる可能性" };
  }
  return { status: "valid", message: "" };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function RoStat({
  label,
  value,
  tone = "blue",
}: {
  label: string;
  value: number;
  tone?: "blue" | "green" | "amber" | "gray";
}) {
  const toneClass = {
    blue: "text-blue-700",
    green: "text-green-700",
    amber: "text-amber-700",
    gray: "text-gray-600",
  }[tone];
  return (
    <div className="rounded bg-white px-3 py-2 shadow-sm">
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className={`text-lg font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

// 要レビュー行に対して、レビュー担当が「次にどこを直せば取り込めるか」が一目で分かるよう
// 理由ごとに具体的な修正先 / 確認先を示す。propertyId / 候補ID は preview API が
// 返してくる範囲のみで判定し、無理に推測しない。
function ReviewActionHint({
  sample,
}: {
  sample: ReceptionOwnerPreviewResponse["reviewSamples"][number];
}) {
  switch (sample.reason) {
    case "owner_unmatched":
      // 物件は特定できているが、所有者CSV側に同キーの行が無い → 所有者CSVのC列を確認
      return (
        <div className="space-y-1">
          <div className="text-gray-700">
            所有者CSV C列のキー
            <code className="mx-1 rounded bg-gray-100 px-1 font-mono text-[10px]">
              {sample.matchKey || "(空)"}
            </code>
            と一致する行を確認
          </div>
          {sample.propertyId && (
            <Link
              href={`/properties/${sample.propertyId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-blue-600 hover:underline"
            >
              対象物件を開く <ArrowRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      );
    case "property_not_found":
      // 物件未特定: DBに該当物件なし。新規登録 or 既存物件側を修正
      return (
        <div className="space-y-1">
          <div className="text-gray-700">
            該当物件が未登録
            {sample.lotNumber && (
              <>
                （地番:
                <code className="mx-1 rounded bg-gray-100 px-1 font-mono text-[10px]">
                  {sample.lotNumber}
                </code>
                ）
              </>
            )}
            {sample.buildingNumber && (
              <>
                （家屋番号:
                <code className="mx-1 rounded bg-gray-100 px-1 font-mono text-[10px]">
                  {sample.buildingNumber}
                </code>
                ）
              </>
            )}
          </div>
          <Link
            href="/properties"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-blue-600 hover:underline"
          >
            物件一覧で確認 / 新規登録 <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      );
    case "property_multiple":
      // 候補複数: いずれかを正として確定する必要がある
      return (
        <div className="space-y-1">
          <div className="text-gray-700">
            候補が {sample.candidateCount} 件あります。正しい物件を選んで直接更新してください。
          </div>
          {sample.candidatePropertyIds.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {sample.candidatePropertyIds.map((pid, i) => (
                <Link
                  key={pid}
                  href={`/properties/${pid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-blue-700 hover:bg-blue-100"
                >
                  候補{i + 1} <ArrowRight className="h-3 w-3" />
                </Link>
              ))}
            </div>
          )}
        </div>
      );
    case "property_no_key":
      // 受付帳側に地番/家屋番号が抽出できていない → F列(区分)とK列を確認
      return (
        <div className="space-y-1">
          <div className="text-gray-700">
            受付帳の地番/家屋番号が空。F列(区分=
            <code className="mx-1 rounded bg-gray-100 px-1 font-mono text-[10px]">
              {sample.fColumn || "(空)"}
            </code>
            )とK列(=
            <code className="mx-1 rounded bg-gray-100 px-1 font-mono text-[10px]">
              {sample.kColumn || "(空)"}
            </code>
            )を確認してください。
          </div>
        </div>
      );
    default:
      return <span className="text-gray-400">-</span>;
  }
}

export default function ImportPage() {
  // Step state
  const [step, setStep] = useState<Step>(1);

  // File state
  const [csvText, setCsvText] = useState("");
  const [xlsxBase64, setXlsxBase64] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [dragActive, setDragActive] = useState(false);

  // Template
  const [template, setTemplate] = useState<string>("standard");

  // Parsed CSV
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);

  // Column mapping
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>(
    {}
  );

  // Import state
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Duplicate preview
  const [duplicatePreview, setDuplicatePreview] = useState<{
    totalRows: number;
    validRows: number;
    errorRows: number;
    duplicateCount: number;
    duplicates: Array<{ rowNumber: number; address: string; matchedAddress: string; matchReason: string }>;
    updateCount?: number;
    updates?: Array<{ rowNumber: number; address: string; matchedAddress: string; matchReason: string }>;
    fileType?: "reception" | "owner" | "ambiguous" | "unknown";
    fileTypeLabel?: string | null;
    fileTypeError?: string | null;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Job history
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobFilters, setJobFilters] = useState<ImportJobFilters>({
    jobType: "",
    executedBy: "",
    from: "",
    to: "",
  });

  // Reception × Owner (2-file) state
  // csvText または xlsxBase64 のどちらかが入る
  const [receptionFile, setReceptionFile] = useState<{
    name: string;
    csvText?: string;
    xlsxBase64?: string;
  } | null>(null);
  const [ownerFile, setOwnerFile] = useState<{
    name: string;
    csvText?: string;
    xlsxBase64?: string;
  } | null>(null);
  const [roPreview, setRoPreview] = useState<ReceptionOwnerPreviewResponse | null>(null);
  const [roResult, setRoResult] = useState<ReceptionOwnerImportResponse | null>(null);
  const [roLoading, setRoLoading] = useState(false);
  const [roError, setRoError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ------ Jobs ------
  // jobFilters はクライアント State なので最新値をクロージャに焼き込むため
  // useCallback の deps に含める。
  const fetchJobs = useCallback(async () => {
    setJobsLoading(true);
    try {
      // 日付フィルタは「YYYY-MM-DD」を受け取り、ISO 文字列に変換して渡す。
      // from は 00:00:00、to は 23:59:59 として丸める（同日入力で 0 件にならないように）。
      const fromIso =
        jobFilters.from !== ""
          ? new Date(`${jobFilters.from}T00:00:00`).toISOString()
          : undefined;
      const toIso =
        jobFilters.to !== ""
          ? new Date(`${jobFilters.to}T23:59:59.999`).toISOString()
          : undefined;
      const json = await fetchImportJobs({
        jobType: jobFilters.jobType || undefined,
        executedBy: jobFilters.executedBy || undefined,
        from: fromIso,
        to: toIso,
        // 段階AではページングUIは入れない（先頭50件まで）。
        page: 1,
        limit: 50,
      });
      setJobs((json.data ?? []) as ImportJob[]);
    } catch {
      // ignore
    } finally {
      setJobsLoading(false);
    }
  }, [jobFilters]);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // 実行者ドロップダウンの選択肢は「現在ロード済の jobs に出てくる実行者」
  // から動的に組み立てる。ユーザマスタを別途取得しないため、フィルタ前の
  // 一覧に含まれていない実行者は選べないが、段階A では妥協する。
  const executorOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const job of jobs) {
      if (job.executor && !map.has(job.executor.id)) {
        map.set(job.executor.id, job.executor.name);
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [jobs]);

  const handleResetJobFilters = () =>
    setJobFilters({ jobType: "", executedBy: "", from: "", to: "" });

  // ------ File handling ------
  const processFile = useCallback(async (file: File) => {
    setFileName(file.name);
    setError(null);
    setResult(null);
    const isXlsx = file.name.toLowerCase().endsWith(".xlsx");
    try {
      if (isXlsx) {
        // xlsx: headers + rows(Record) + base64 を取得
        const [{ headers: h, rows: r }, buf] = await Promise.all([
          parseFileForPreview(file),
          readFileForImport(file),
        ]);
        setCsvText("");
        setXlsxBase64(buf.xlsxBase64 ?? null);
        setHeaders(h);
        // rows(Record) → string[][] にそろえる
        setRows(r.map((row) => h.map((col) => row[col] ?? "")));

        const mapping: Record<string, string> = {};
        h.forEach((header) => {
          const normalized = header.trim();
          if (AUTO_MAP[normalized]) {
            mapping[normalized] = AUTO_MAP[normalized];
          }
        });
        setColumnMapping(mapping);
        setStep(2);
        return;
      }
      // csv: UTF-8 BOM / UTF-8 / Shift-JIS(CP932) を自動判定して decode する。
      // 旧実装は UTF-8 固定で読んでおり、Excel 出力 (Shift-JIS / CP932) の
      // 日本語CSVが文字化けしていたため共通デコーダ経由に変更。
      const text = await readCsvFileAsText(file);
      setCsvText(text);
      setXlsxBase64(null);
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
    void processFile(file);
  };

  // ------ Drag & Drop ------
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
      if (file) void processFile(file);
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
      const v = validateRow(row, headers, columnMapping);
      rowStatuses.push(v);
      if (v.status === "valid") valid++;
      else if (v.status === "warning") warnings++;
      else errors++;
    });
    return { valid, warnings, errors, rowStatuses };
  }, [rows, headers, columnMapping]);

  // ------ Import ------
  const handleImport = async () => {
    if (!csvText.trim() && !xlsxBase64) return;
    setUploading(true);
    setError(null);
    setResult(null);

    try {
      const json = await importCsv(
        fileName || "import.csv",
        csvText || null,
        columnMapping,
        xlsxBase64 ?? undefined,
      );
      setResult(json as ImportResult);
      setStep(4);
      fetchJobs();
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
    setXlsxBase64(null);
    setFileName("");
    setHeaders([]);
    setRows([]);
    setColumnMapping({});
    setResult(null);
    setError(null);
    setDuplicatePreview(null);
    setPreviewLoading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ------ Reception × Owner ------
  const handleRoFile = async (which: "reception" | "owner", file: File | null) => {
    setRoError(null);
    setRoPreview(null);
    setRoResult(null);
    if (!file) {
      if (which === "reception") setReceptionFile(null);
      else setOwnerFile(null);
      return;
    }
    const detect = detectImportFileType(file.name);
    if (which === "reception" && detect.type !== "reception") {
      setRoError(`受付帳として認識できません: ${detect.error ?? "ファイル名に『受付帳』を含めてください"}`);
      return;
    }
    if (which === "owner" && detect.type !== "owner") {
      setRoError(`所有者として認識できません: ${detect.error ?? "ファイル名に『所有者』を含めてください"}`);
      return;
    }
    try {
      const buf = await readFileForImport(file);
      const entry = {
        name: file.name,
        csvText: buf.csvText,
        xlsxBase64: buf.xlsxBase64,
      };
      if (which === "reception") setReceptionFile(entry);
      else setOwnerFile(entry);
    } catch (e) {
      setRoError(e instanceof Error ? e.message : "ファイル読込に失敗しました");
    }
  };

  const handleRoPreview = async () => {
    if (!receptionFile || !ownerFile) return;
    setRoLoading(true);
    setRoError(null);
    setRoResult(null);
    try {
      const res = await previewReceptionOwnerCsv({
        receptionFileName: receptionFile.name,
        ownerFileName: ownerFile.name,
        receptionCsv: receptionFile.csvText,
        ownerCsv: ownerFile.csvText,
        receptionXlsxBase64: receptionFile.xlsxBase64,
        ownerXlsxBase64: ownerFile.xlsxBase64,
      });
      setRoPreview(res);
    } catch (e) {
      setRoError(e instanceof Error ? e.message : "プレビューに失敗しました");
    } finally {
      setRoLoading(false);
    }
  };

  const handleRoImport = async () => {
    if (!receptionFile || !ownerFile) return;
    if (!window.confirm("一意特定できた行だけを既存物件に反映します。よろしいですか？")) return;
    setRoLoading(true);
    setRoError(null);
    try {
      const res = await importReceptionOwnerCsv({
        receptionFileName: receptionFile.name,
        ownerFileName: ownerFile.name,
        receptionCsv: receptionFile.csvText,
        ownerCsv: ownerFile.csvText,
        receptionXlsxBase64: receptionFile.xlsxBase64,
        ownerXlsxBase64: ownerFile.xlsxBase64,
      });
      setRoResult(res);
      fetchJobs();
    } catch (e) {
      setRoError(e instanceof Error ? e.message : "取込に失敗しました");
    } finally {
      setRoLoading(false);
    }
  };

  const handleRoReset = () => {
    setReceptionFile(null);
    setOwnerFile(null);
    setRoPreview(null);
    setRoResult(null);
    setRoError(null);
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
      <ImportSwitcher />
      <h2 className="mb-6 text-2xl font-bold text-gray-800">物件CSV / Excel(.xlsx) 取込</h2>

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
                  className={`mx-1 h-4 w-4 shrink-0 ${
                    isDone ? "text-blue-500" : "text-gray-300"
                  }`}
                />
              )}
              <button
                onClick={() => {
                  if (isDone) setStep(s);
                }}
                disabled={!isDone}
                className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-blue-600 text-white"
                    : isDone
                      ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                      : "bg-gray-100 text-gray-400"
                }`}
              >
                {isDone ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Icon className="h-3.5 w-3.5" />
                )}
                {meta.label}
              </button>
            </div>
          );
        })}
      </div>

      {/* ============ Step 1: File Upload ============ */}
      {step === 1 && (
        <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="mb-4 text-lg font-semibold text-gray-700">
            ファイル選択
          </h3>

          {/* Template selection */}
          <div className="mb-5">
            <label className="mb-1 block text-sm font-medium text-gray-600">
              テンプレート
            </label>
            <div className="relative inline-block">
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                className="appearance-none rounded-md border border-gray-300 bg-white py-2 pl-3 pr-9 text-sm text-gray-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {Object.entries(TEMPLATES).map(([key, t]) => (
                  <option key={key} value={key}>
                    {t.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            </div>
            <div className="mt-2 rounded bg-gray-50 p-3 text-xs text-gray-500">
              <span className="font-medium text-gray-600">対応カラム: </span>
              {TEMPLATES[template].columns.join(", ")}
            </div>
          </div>

          {/* Drag & Drop zone */}
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
            <Upload
              className={`mx-auto mb-3 h-10 w-10 ${
                dragActive ? "text-blue-500" : "text-gray-400"
              }`}
            />
            <p className="mb-1 text-sm font-medium text-gray-700">
              CSV または Excel(.xlsx) ファイルをここにドラッグ＆ドロップ
            </p>
            <p className="text-xs text-gray-400">
              またはクリックしてファイルを選択
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.tsv,.txt,.xlsx"
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>

          {fileName && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <FileText className="h-4 w-4" />
                <span>{fileName}</span>
                <span className="text-gray-400">
                  ({rows.length} 行)
                </span>
              </div>
              {(() => {
                const det = detectImportFileType(fileName);
                if (det.label) {
                  return (
                    <div className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {det.label}
                    </div>
                  );
                }
                if (det.error) {
                  return (
                    <div className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {det.error}
                    </div>
                  );
                }
                return null;
              })()}
            </div>
          )}
        </div>
      )}

      {/* ============ Step 2: Column Mapping ============ */}
      {step === 2 && (
        <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="mb-4 text-lg font-semibold text-gray-700">
            カラム対応設定
          </h3>
          <p className="mb-4 text-sm text-gray-500">
            CSVのヘッダーと取込先フィールドを対応させてください。
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  <th className="px-3 py-2 font-medium text-gray-600 w-8"></th>
                  <th className="px-3 py-2 font-medium text-gray-600">
                    CSVヘッダー
                  </th>
                  <th className="px-3 py-2 font-medium text-gray-600 w-8">
                    <ArrowRight className="h-4 w-4" />
                  </th>
                  <th className="px-3 py-2 font-medium text-gray-600">
                    取込先フィールド
                  </th>
                  <th className="px-3 py-2 font-medium text-gray-600 w-12">
                    状態
                  </th>
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
                      <td className="px-3 py-2 font-mono text-gray-800">
                        {header}
                      </td>
                      <td className="px-3 py-2 text-gray-300">
                        <ArrowRight className="h-4 w-4" />
                      </td>
                      <td className="px-3 py-2">
                        <div className="relative inline-block">
                          <select
                            value={mapped}
                            onChange={(e) =>
                              updateMapping(header, e.target.value)
                            }
                            className="appearance-none rounded border border-gray-300 bg-white py-1 pl-2 pr-7 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          >
                            <option value="">-- 未設定 --</option>
                            {TARGET_FIELDS.map((f) => (
                              <option
                                key={f}
                                value={f}
                                disabled={
                                  mappedFields.has(f) && mapped !== f
                                }
                              >
                                {TARGET_FIELD_LABELS[f]}
                                {mappedFields.has(f) && mapped !== f
                                  ? " (使用済)"
                                  : ""}
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
              {Object.keys(columnMapping).length} / {headers.length}{" "}
              カラム対応済
            </span>
            {!mappedFields.has("住所") && (
              <span className="text-amber-600 font-medium">
                <AlertTriangle className="mr-1 inline h-4 w-4" />
                住所フィールドの対応を推奨
              </span>
            )}
          </div>

          <div className="mt-6 flex gap-3">
            <button
              onClick={() => setStep(1)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              戻る
            </button>
            <button
              onClick={async () => {
                setStep(3);
                setPreviewLoading(true);
                setDuplicatePreview(null);
                try {
                  const res = await previewCsvDuplicates(
                    csvText || null,
                    columnMapping,
                    fileName,
                    xlsxBase64 ?? undefined,
                  );
                  setDuplicatePreview(res as typeof duplicatePreview);
                } catch {
                  // preview is best-effort
                } finally {
                  setPreviewLoading(false);
                }
              }}
              className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Eye className="h-4 w-4" />
              プレビューへ
            </button>
          </div>
        </div>
      )}

      {/* ============ Step 3: Preview & Validate ============ */}
      {step === 3 && (
        <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="mb-4 text-lg font-semibold text-gray-700">
            プレビュー・検証
          </h3>

          {/* Summary cards */}
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-center">
              <div className="text-2xl font-bold text-gray-800">
                {rows.length}
              </div>
              <div className="text-xs text-gray-500">総行数</div>
            </div>
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-center">
              <div className="text-2xl font-bold text-green-700">
                {validationSummary.valid}
              </div>
              <div className="text-xs text-green-600">有効</div>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-center">
              <div className="text-2xl font-bold text-amber-700">
                {validationSummary.warnings}
              </div>
              <div className="text-xs text-amber-600">警告</div>
            </div>
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-center">
              <div className="text-2xl font-bold text-red-700">
                {validationSummary.errors}
              </div>
              <div className="text-xs text-red-600">エラー</div>
            </div>
          </div>

          {/* Preview table (first 5 rows) */}
          <p className="mb-2 text-sm font-medium text-gray-600">
            先頭5行プレビュー
          </p>
          <div className="overflow-x-auto rounded border border-gray-200">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  <th className="px-2 py-1.5 font-medium text-gray-500 w-8">
                    #
                  </th>
                  <th className="px-2 py-1.5 font-medium text-gray-500 w-10">
                    状態
                  </th>
                  {headers.map((h) => (
                    <th
                      key={h}
                      className="px-2 py-1.5 font-medium text-gray-600 whitespace-nowrap"
                    >
                      {h}
                      {columnMapping[h] && (
                        <span className="ml-1 text-blue-500 font-normal">
                          ({columnMapping[h]})
                        </span>
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
            <p className="mt-1 text-xs text-gray-400">
              ...他 {rows.length - 5} 行
            </p>
          )}

          {/* Duplicate preview section */}
          {previewLoading && (
            <div className="mt-4 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 p-4 text-sm text-blue-700">
              <Loader2 className="h-4 w-4 animate-spin" />
              重複チェック中...
            </div>
          )}

          {duplicatePreview && !previewLoading && (
            <div className="mt-4">
              {/* ファイル種別判定結果 */}
              {duplicatePreview.fileTypeLabel && (
                <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" />
                  <strong>{duplicatePreview.fileTypeLabel}</strong>
                  <span className="text-xs text-emerald-600">
                    （ファイル名: {fileName || "未設定"}）
                  </span>
                </div>
              )}
              {duplicatePreview.fileTypeError && (
                <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div>
                    <div className="font-medium">{duplicatePreview.fileTypeError}</div>
                    <div className="text-xs text-amber-600 mt-0.5">
                      （ファイル名: {fileName || "未設定"}）
                    </div>
                  </div>
                </div>
              )}
              <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-2 text-center">
                  <div className="text-lg font-bold text-gray-800">{duplicatePreview.totalRows}</div>
                  <div className="text-xs text-gray-500">総行数(サーバー)</div>
                </div>
                <div className="rounded-lg border border-green-200 bg-green-50 p-2 text-center">
                  <div className="text-lg font-bold text-green-700">{duplicatePreview.validRows}</div>
                  <div className="text-xs text-green-600">新規登録予定</div>
                </div>
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-2 text-center">
                  <div className="text-lg font-bold text-blue-700">{duplicatePreview.updateCount ?? 0}</div>
                  <div className="text-xs text-blue-600">更新候補</div>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-center">
                  <div className="text-lg font-bold text-amber-700">{duplicatePreview.duplicateCount}</div>
                  <div className="text-xs text-amber-600">重複スキップ</div>
                </div>
                <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-center">
                  <div className="text-lg font-bold text-red-700">{duplicatePreview.errorRows}</div>
                  <div className="text-xs text-red-600">エラー行</div>
                </div>
              </div>

              {duplicatePreview.updates && duplicatePreview.updates.length > 0 && (
                <div className="mb-3 rounded-md border border-blue-200 bg-blue-50 p-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium text-blue-800">
                    <RefreshCw className="h-4 w-4" />
                    更新候補 ({duplicatePreview.updateCount ?? 0}件)
                  </div>
                  <p className="mb-3 text-xs text-blue-600">
                    以下の行は既存物件に一致する識別子/棟内部屋番号があるため、取込実行時に既存レコードを更新します（空欄の値は上書きしません）。
                  </p>
                  <div className="overflow-x-auto rounded border border-blue-200 bg-white">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-blue-100 bg-blue-50">
                        <tr>
                          <th className="px-2 py-1.5 font-medium text-blue-700">行番号</th>
                          <th className="px-2 py-1.5 font-medium text-blue-700">CSV住所</th>
                          <th className="px-2 py-1.5 font-medium text-blue-700">既存物件住所</th>
                          <th className="px-2 py-1.5 font-medium text-blue-700">一致理由</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-blue-50">
                        {duplicatePreview.updates.map((d, i) => (
                          <tr key={i} className="hover:bg-blue-50/50">
                            <td className="px-2 py-1.5 text-gray-600">{d.rowNumber}</td>
                            <td className="px-2 py-1.5 text-gray-800 max-w-[200px] truncate" title={d.address}>{d.address}</td>
                            <td className="px-2 py-1.5 text-gray-800 max-w-[200px] truncate" title={d.matchedAddress}>{d.matchedAddress}</td>
                            <td className="px-2 py-1.5">
                              <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700">{d.matchReason}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {(duplicatePreview.updateCount ?? 0) > 20 && (
                    <p className="mt-2 text-xs text-blue-500">
                      ※ 上位20件のみ表示（全{duplicatePreview.updateCount}件）
                    </p>
                  )}
                </div>
              )}

              {duplicatePreview.duplicates.length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-800">
                    <AlertTriangle className="h-4 w-4" />
                    重複スキップ候補 ({duplicatePreview.duplicateCount}件)
                  </div>
                  <p className="mb-3 text-xs text-amber-600">
                    以下の行は住所一致のみなど取り違えリスクがあるため、取込実行時は「要レビュー」として記録し、既存レコードを更新しません。
                  </p>
                  <div className="overflow-x-auto rounded border border-amber-200 bg-white">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-amber-100 bg-amber-50">
                        <tr>
                          <th className="px-2 py-1.5 font-medium text-amber-700">行番号</th>
                          <th className="px-2 py-1.5 font-medium text-amber-700">CSV住所</th>
                          <th className="px-2 py-1.5 font-medium text-amber-700">既存物件住所</th>
                          <th className="px-2 py-1.5 font-medium text-amber-700">一致理由</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-amber-50">
                        {duplicatePreview.duplicates.map((d, i) => (
                          <tr key={i} className="hover:bg-amber-50/50">
                            <td className="px-2 py-1.5 text-gray-600">{d.rowNumber}</td>
                            <td className="px-2 py-1.5 text-gray-800 max-w-[200px] truncate" title={d.address}>{d.address}</td>
                            <td className="px-2 py-1.5 text-gray-800 max-w-[200px] truncate" title={d.matchedAddress}>{d.matchedAddress}</td>
                            <td className="px-2 py-1.5">
                              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700">{d.matchReason}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {duplicatePreview.duplicateCount > 20 && (
                    <p className="mt-2 text-xs text-amber-500">
                      ※ 上位20件のみ表示（全{duplicatePreview.duplicateCount}件）
                    </p>
                  )}
                </div>
              )}

              {duplicatePreview.duplicates.length === 0 && duplicatePreview.duplicateCount === 0 && (
                <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" />
                  重複候補はありません
                </div>
              )}
            </div>
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

      {/* ============ Step 4: Import Result ============ */}
      {step === 4 && result && (
        <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="mb-4 text-lg font-semibold text-gray-700">
            取込結果
          </h3>

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
                <strong className="text-green-700">
                  {result.successCount}
                </strong>
              </div>
              <div>
                <span className="text-blue-600">うち更新:</span>{" "}
                <strong className="text-blue-700">
                  {result.updateCount ?? 0}
                </strong>
              </div>
              <div>
                <span className="text-amber-600">要レビュー:</span>{" "}
                <strong className="text-amber-700">
                  {result.needsReviewCount}
                </strong>
              </div>
              <div>
                <span className="text-red-600">エラー:</span>{" "}
                <strong className="text-red-700">{result.errorCount}</strong>
              </div>
            </div>
            {result.parseErrors.length > 0 && (
              <div className="mt-3 border-t border-green-200 pt-3">
                <p className="mb-1 text-xs font-medium text-red-600">
                  パースエラー:
                </p>
                {result.parseErrors.map((e, i) => (
                  <p key={i} className="text-xs text-red-500">
                    行 {e.row}: {e.message}
                  </p>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <Link
              href={`/import/jobs/${result.jobId}`}
              className="flex items-center gap-2 rounded-md border border-blue-300 bg-white px-4 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50"
            >
              <Eye className="h-4 w-4" />
              ジョブ詳細を見る
            </Link>
            <button
              onClick={handleReset}
              className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              <RefreshCw className="h-4 w-4" />
              新しいファイルを取込
            </button>
          </div>
        </div>
      )}

      {/* ============ 受付帳 × 所有者 2ファイル突合 ============ */}
      <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
        <div className="mb-4 flex items-center gap-2">
          <FileUp className="h-5 w-5 text-blue-600" />
          <h3 className="text-lg font-semibold text-gray-700">
            受付帳 × 所有者 2ファイル突合（CSV / Excel(.xlsx) 対応）
          </h3>
          <span className="ml-2 rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
            既存物件に反映
          </span>
        </div>
        <p className="mb-4 text-sm text-gray-500">
          受付帳CSV（H/I/J/K列）と所有者CSV（C列）をキーに突合し、一意特定できた行だけを既存物件に反映します。
          共有名義人は複数行のまま残します。空値では上書きしません。
        </p>

        <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              受付帳CSV / Excel(.xlsx) <span className="text-xs text-gray-400">（ファイル名に「受付帳」を含める）</span>
            </label>
            <input
              type="file"
              accept=".csv,.tsv,.txt,.xlsx"
              onChange={(e) => handleRoFile("reception", e.target.files?.[0] ?? null)}
              className="block w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm"
            />
            {receptionFile && (
              <div className="mt-1 text-xs text-green-700">
                <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />
                {receptionFile.name}
              </div>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              所有者CSV / Excel(.xlsx) <span className="text-xs text-gray-400">（ファイル名に「所有者」を含める）</span>
            </label>
            <input
              type="file"
              accept=".csv,.tsv,.txt,.xlsx"
              onChange={(e) => handleRoFile("owner", e.target.files?.[0] ?? null)}
              className="block w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm"
            />
            {ownerFile && (
              <div className="mt-1 text-xs text-green-700">
                <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />
                {ownerFile.name}
              </div>
            )}
          </div>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button
            onClick={handleRoPreview}
            disabled={!receptionFile || !ownerFile || roLoading}
            className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {roLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
            プレビュー
          </button>
          <button
            onClick={handleRoImport}
            disabled={!roPreview || roLoading}
            className="flex items-center gap-2 rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {roLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            取り込み実行
          </button>
          <button
            onClick={handleRoReset}
            disabled={roLoading}
            className="flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            <RefreshCw className="h-4 w-4" />
            クリア
          </button>
        </div>

        {roError && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertTriangle className="mr-1 inline h-4 w-4" />
            {roError}
          </div>
        )}

        {roPreview && (
          <div className="mb-4 rounded-md border border-gray-200 bg-gray-50 p-4">
            <div className="mb-3 text-sm font-semibold text-gray-700">突合結果サマリ</div>
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <RoStat label="受付帳件数" value={roPreview.summary.receptionCount} />
              <RoStat label="所有者件数" value={roPreview.summary.ownerCount} />
              <RoStat label="所有者突合成功" value={roPreview.summary.ownerMatchedCount} tone="green" />
              <RoStat label="所有者未突合" value={roPreview.summary.ownerUnmatchedCount} tone="amber" />
              <RoStat label="物件一意特定" value={roPreview.summary.propertyMatchedCount} tone="green" />
              <RoStat label="物件未特定" value={roPreview.summary.propertyNotFoundCount} tone="amber" />
              <RoStat label="複数候補" value={roPreview.summary.propertyMultipleCount} tone="amber" />
              <RoStat label="キー不足" value={roPreview.summary.propertyNoKeyCount} tone="gray" />
              <RoStat label="除外（非データ行）" value={roPreview.summary.excludedCount} tone="gray" />
            </div>
            {roPreview.summary.excludedCount > 0 && (
              <div className="mt-2 text-[11px] text-gray-500">
                内訳: 空行 {roPreview.summary.excludedEmptyCount} / ヘッダ反復{" "}
                {roPreview.summary.excludedHeaderRepeatCount} / 集計行{" "}
                {roPreview.summary.excludedAggregateCount} / 共担{" "}
                {roPreview.summary.excludedCoCollateralCount}
                <span className="ml-2">※突合・レビューの対象外にしています</span>
              </div>
            )}

            {roPreview.matchedSamples.length > 0 && (
              <div className="mt-4">
                <div className="mb-1 text-xs font-semibold text-gray-600">
                  反映対象サンプル（最大20件）
                </div>
                <div className="max-h-52 overflow-auto rounded border border-gray-200 bg-white">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="px-2 py-1">行</th>
                        <th className="px-2 py-1">物件住所</th>
                        <th className="px-2 py-1">所有者数</th>
                        <th className="px-2 py-1">所有者名</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {roPreview.matchedSamples.map((s) => (
                        <tr key={s.rowNumber}>
                          <td className="px-2 py-1 text-gray-600">{s.rowNumber}</td>
                          <td className="px-2 py-1 text-gray-800">{s.propertyAddress}</td>
                          <td className="px-2 py-1 text-gray-600">{s.ownerCount}</td>
                          <td className="px-2 py-1 text-gray-600">{s.ownerNames.join(", ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {roPreview.reviewSamples.length > 0 && (
              <div className="mt-4">
                <div className="mb-1 flex items-center justify-between">
                  <div className="text-xs font-semibold text-amber-700">
                    要レビューサンプル（最大20件）
                  </div>
                  <div className="text-[10px] text-gray-500">
                    理由ごとに「次にどこを直せばよいか」を右端に表示します
                  </div>
                </div>
                <div className="max-h-72 overflow-auto rounded border border-amber-200 bg-white">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-amber-50 text-amber-700">
                      <tr>
                        <th className="px-2 py-1">行</th>
                        <th className="px-2 py-1">理由</th>
                        <th className="px-2 py-1">物件状態</th>
                        <th className="px-2 py-1">F列</th>
                        <th className="px-2 py-1">K列</th>
                        <th className="px-2 py-1">候補数</th>
                        <th className="px-2 py-1">所有者数</th>
                        <th className="px-2 py-1">次のアクション</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {roPreview.reviewSamples.map((s) => (
                        <tr key={s.rowNumber} className="align-top">
                          <td className="px-2 py-1 text-gray-600">{s.rowNumber}</td>
                          <td className="px-2 py-1 text-amber-700">{s.reasonLabel}</td>
                          <td className="px-2 py-1 text-gray-600">
                            {{
                              matched: "既存あり",
                              not_found: "未特定",
                              multiple: "複数候補",
                              no_key: "キー不足",
                            }[s.propertyStatus]}
                          </td>
                          <td className="px-2 py-1 text-gray-600">{s.fColumn}</td>
                          <td className="px-2 py-1 text-gray-600">{s.kColumn}</td>
                          <td className="px-2 py-1 text-gray-600">{s.candidateCount}</td>
                          <td className="px-2 py-1 text-gray-600">{s.ownerCount}</td>
                          <td className="px-2 py-1">
                            <ReviewActionHint sample={s} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {roResult && (
          <div className="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800">
            <div className="mb-2 flex items-center gap-2 font-semibold">
              <CheckCircle2 className="h-4 w-4" />
              取込完了（ジョブID: {roResult.jobId}）
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <div>反映: <b>{roResult.successCount}</b></div>
              <div>要レビュー: <b>{roResult.needsReviewCount}</b></div>
              <div>エラー: <b>{roResult.errorCount}</b></div>
              <div>物件更新: <b>{roResult.propertyUpdatedCount}</b></div>
              <div>所有者作成: <b>{roResult.ownerCreatedCount}</b></div>
              <div>所有者紐付: <b>{roResult.ownerLinkedCount}</b></div>
            </div>
          </div>
        )}
      </div>

      {/* ============ Job History ============ */}
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-700">取込履歴</h3>
          <button
            onClick={fetchJobs}
            className="rounded p-1 text-gray-400 hover:text-gray-600"
            title="再読み込み"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>

        {/* ---- フィルタ UI（段階A: 取込種別 / 実行者 / 日付範囲） ---- */}
        <div className="mb-4 grid grid-cols-1 gap-3 rounded-md border border-gray-200 bg-gray-50 p-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              種別
            </label>
            <select
              value={jobFilters.jobType}
              onChange={(e) =>
                setJobFilters((prev) => ({ ...prev, jobType: e.target.value }))
              }
              className="w-full rounded border border-gray-300 bg-white py-1 px-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {JOB_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              実行者
            </label>
            <select
              value={jobFilters.executedBy}
              onChange={(e) =>
                setJobFilters((prev) => ({
                  ...prev,
                  executedBy: e.target.value,
                }))
              }
              className="w-full rounded border border-gray-300 bg-white py-1 px-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">すべての実行者</option>
              {executorOptions.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              日付（開始）
            </label>
            <input
              type="date"
              value={jobFilters.from}
              onChange={(e) =>
                setJobFilters((prev) => ({ ...prev, from: e.target.value }))
              }
              className="w-full rounded border border-gray-300 bg-white py-1 px-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              日付（終了）
            </label>
            <input
              type="date"
              value={jobFilters.to}
              onChange={(e) =>
                setJobFilters((prev) => ({ ...prev, to: e.target.value }))
              }
              className="w-full rounded border border-gray-300 bg-white py-1 px-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={handleResetJobFilters}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-1 text-sm text-gray-600 hover:bg-gray-50"
            >
              フィルタをクリア
            </button>
          </div>
        </div>

        {jobsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
          </div>
        ) : jobs.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">
            条件に合う取込履歴はありません
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  <th className="px-3 py-2 font-medium text-gray-600">状態</th>
                  <th className="px-3 py-2 font-medium text-gray-600">
                    ファイル名
                  </th>
                  <th className="px-3 py-2 font-medium text-gray-600">種別</th>
                  <th className="px-3 py-2 font-medium text-gray-600">行数</th>
                  {/* 段階A: ImportJobRow から動的に算出した 5 区分。
                      旧データや行が空のジョブでは summary が無いので "-" 表示。 */}
                  <th
                    className="px-3 py-2 font-medium text-green-700"
                    title="新規作成（success かつ「更新」プレフィックス無し）"
                  >
                    新規
                  </th>
                  <th
                    className="px-3 py-2 font-medium text-blue-700"
                    title="既存レコード更新（success かつ errorMessage が「更新...」）"
                  >
                    更新
                  </th>
                  <th
                    className="px-3 py-2 font-medium text-gray-600"
                    title="スキップ（status === skipped）"
                  >
                    スキップ
                  </th>
                  <th
                    className="px-3 py-2 font-medium text-amber-700"
                    title="要レビュー（status === needs_review）"
                  >
                    要レビュー
                  </th>
                  <th
                    className="px-3 py-2 font-medium text-red-700"
                    title="純エラー（status === error。要レビューを含まない）"
                  >
                    エラー
                  </th>
                  <th className="px-3 py-2 font-medium text-gray-600">
                    実行者
                  </th>
                  <th className="px-3 py-2 font-medium text-gray-600">日時</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {jobs.map((job) => {
                  const config =
                    STATUS_CONFIG[job.status] ?? STATUS_CONFIG.pending;
                  const Icon = config.icon;
                  const summary = job.summary;
                  const cell = (n: number | undefined, color: string) =>
                    summary ? (
                      <span className={n && n > 0 ? color : "text-gray-300"}>
                        {n ?? 0}
                      </span>
                    ) : (
                      <span className="text-gray-300">-</span>
                    );
                  return (
                    <tr
                      key={job.id}
                      className="hover:bg-gray-50 cursor-pointer"
                      onClick={() =>
                        (window.location.href = `/import/jobs/${job.id}`)
                      }
                    >
                      <td className="px-3 py-2">
                        <span
                          className={`flex items-center gap-1 text-xs ${config.color}`}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {config.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-blue-600 hover:underline">
                        {job.fileName}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500">
                        {job.jobType}
                      </td>
                      <td className="px-3 py-2 text-gray-600">
                        {job.totalRows ?? "-"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {cell(summary?.createdCount, "text-green-700 font-medium")}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {cell(summary?.updatedCount, "text-blue-700 font-medium")}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {cell(summary?.skippedCount, "text-gray-700")}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {cell(summary?.needsReviewCount, "text-amber-700 font-medium")}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {cell(summary?.errorCount, "text-red-700 font-medium")}
                      </td>
                      <td className="px-3 py-2 text-gray-500">
                        {job.executor.name}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500">
                        {new Date(job.createdAt).toLocaleString("ja-JP")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
