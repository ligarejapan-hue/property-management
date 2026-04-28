"use client";

import { useState, useCallback, useRef } from "react";
import Link from "next/link";
import {
  FileText,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Upload,
  ClipboardPaste,
  Trash2,
  Plus,
  ArrowLeft,
  ArrowRight,
  Search,
  ExternalLink,
  Circle,
  Info,
} from "lucide-react";
import {
  importRegistryPdf,
  importRegistryPdfFile,
  parseRegistryPdfFile,
  parseRegistryPdfText,
  searchProperties,
} from "@/lib/api-client";
import ImportSwitcher from "@/components/import/import-switcher";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConfidenceLevel = "high" | "medium" | "low";

interface ExtractedField {
  value: string;
  confidence: ConfidenceLevel;
}

interface ExtractedOwner {
  name: string;
  address: string;
  share: string;
}

interface ParsedResult {
  realEstateNumber: string | null;
  address: string | null;
  lotNumber: string | null;
  buildingNumber: string | null;
  landCategory: string | null;
  area: string | null;
  owners: Array<{
    name: string;
    address: string | null;
    share: string | null;
  }>;
  confidence: number;
  warnings: string[];
}

interface ImportResult {
  jobId: string;
  action: "created" | "updated" | "matched";
  propertyId: string | null;
  parsed: ParsedResult;
}

type Step = "upload" | "extract" | "confirm" | "result";
type UploadTab = "file" | "text";
type RegistrationTarget = "new" | "existing" | "auto";

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  created: { label: "新規作成", color: "text-green-700 bg-green-50 border-green-200" },
  updated: { label: "既存更新", color: "text-blue-700 bg-blue-50 border-blue-200" },
  matched: { label: "既存一致", color: "text-amber-700 bg-amber-50 border-amber-200" },
};

const CONFIDENCE_COLOR: Record<ConfidenceLevel, string> = {
  high: "text-green-500",
  medium: "text-yellow-500",
  low: "text-red-500",
};

const CONFIDENCE_BG: Record<ConfidenceLevel, string> = {
  high: "bg-green-500",
  medium: "bg-yellow-500",
  low: "bg-red-500",
};

const STEPS: { key: Step; label: string }[] = [
  { key: "upload", label: "アップロード" },
  { key: "extract", label: "抽出・編集" },
  { key: "confirm", label: "確認" },
  { key: "result", label: "結果" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assignConfidence(value: string | null): ConfidenceLevel {
  if (!value || value.trim() === "") return "low";
  if (value.length >= 3) return "high";
  return "medium";
}

function overallScore(fields: Record<string, ExtractedField>): number {
  const entries = Object.values(fields);
  if (entries.length === 0) return 0;
  const score = entries.reduce((sum, f) => {
    if (f.confidence === "high") return sum + 1;
    if (f.confidence === "medium") return sum + 0.6;
    return sum + 0.2;
  }, 0);
  return score / entries.length;
}

// Mock parse: in real implementation, the server would do this.
function mockParseText(text: string): {
  fields: Record<string, ExtractedField>;
  owners: ExtractedOwner[];
  warnings: string[];
} {
  const get = (patterns: RegExp[]): string => {
    for (const p of patterns) {
      const m = text.match(p);
      if (m && m[1]) return m[1].trim();
    }
    return "";
  };

  const realEstateNumber = get([/不動産番号[:\s：]*([0-9０-９\-]+)/]);
  const address = get([/所在[:\s：]*(.+?)(?:\n|$)/, /住所[:\s：]*(.+?)(?:\n|$)/]);
  const lotNumber = get([/地番[:\s：]*(.+?)(?:\n|$)/]);
  const buildingNumber = get([/家屋番号[:\s：]*(.+?)(?:\n|$)/]);
  const landCategory = get([/地目[:\s：]*(.+?)(?:\n|$)/]);
  const area = get([/地積[:\s：]*(.+?)(?:\n|$)/, /面積[:\s：]*(.+?)(?:\n|$)/]);

  const fields: Record<string, ExtractedField> = {
    realEstateNumber: { value: realEstateNumber, confidence: assignConfidence(realEstateNumber) },
    address: { value: address, confidence: assignConfidence(address) },
    lotNumber: { value: lotNumber, confidence: assignConfidence(lotNumber) },
    buildingNumber: { value: buildingNumber, confidence: assignConfidence(buildingNumber) },
    landCategory: { value: landCategory, confidence: assignConfidence(landCategory) },
    area: { value: area, confidence: assignConfidence(area) },
  };

  const owners: ExtractedOwner[] = [];
  const ownerMatches = text.matchAll(/所有者[:\s：]*(.+?)(?:\s{2,}|\t)(.+?)(?:\n|$)/g);
  for (const m of ownerMatches) {
    owners.push({ name: m[1].trim(), address: m[2].trim(), share: "" });
  }
  if (owners.length === 0) {
    // Fallback: single owner line
    const singleOwner = text.match(/所有者[:\s：]*(\S+)/);
    if (singleOwner) {
      const ownerAddr = text.match(/所有者[:\s：]*\S+\s+(.+?)(?:\n|$)/);
      owners.push({
        name: singleOwner[1],
        address: ownerAddr ? ownerAddr[1].trim() : "",
        share: "",
      });
    }
  }

  const warnings: string[] = [];
  if (!realEstateNumber) warnings.push("不動産番号が抽出できませんでした");
  if (!address) warnings.push("所在/住所が抽出できませんでした");
  if (owners.length === 0) warnings.push("所有者情報が抽出できませんでした");

  return { fields, owners, warnings };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StepIndicator({ current }: { current: Step }) {
  const currentIdx = STEPS.findIndex((s) => s.key === current);
  return (
    <nav className="mb-8">
      <ol className="flex items-center gap-2">
        {STEPS.map((step, idx) => {
          const isActive = idx === currentIdx;
          const isDone = idx < currentIdx;
          return (
            <li key={step.key} className="flex items-center gap-2">
              {idx > 0 && (
                <div
                  className={`h-px w-8 ${isDone ? "bg-blue-500" : "bg-gray-200"}`}
                />
              )}
              <div className="flex items-center gap-1.5">
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                    isActive
                      ? "bg-blue-600 text-white"
                      : isDone
                        ? "bg-blue-100 text-blue-700"
                        : "bg-gray-100 text-gray-400"
                  }`}
                >
                  {isDone ? <CheckCircle2 className="h-4 w-4" /> : idx + 1}
                </span>
                <span
                  className={`text-sm font-medium ${
                    isActive
                      ? "text-blue-700"
                      : isDone
                        ? "text-blue-600"
                        : "text-gray-400"
                  }`}
                >
                  {step.label}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function ConfidenceDot({ level }: { level: ConfidenceLevel }) {
  return (
    <Circle
      className={`h-3 w-3 fill-current ${CONFIDENCE_COLOR[level]}`}
    />
  );
}

function ConfidenceBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  let color = "bg-green-500";
  if (pct < 50) color = "bg-red-500";
  else if (pct < 75) color = "bg-yellow-500";

  return (
    <div className="flex items-center gap-3">
      <div className="h-3 flex-1 rounded-full bg-gray-200">
        <div
          className={`h-3 rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-sm font-semibold text-gray-700">{pct}%</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field label map
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  realEstateNumber: "不動産番号",
  address: "所在/住所",
  lotNumber: "地番",
  buildingNumber: "家屋番号",
  landCategory: "地目",
  area: "地積/面積",
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function RegistryPdfPage() {
  // Step state
  const [step, setStep] = useState<Step>("upload");

  // Upload step
  const [uploadTab, setUploadTab] = useState<UploadTab>("file");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null); // 実 PDF ファイル
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Extract/Edit step
  const [fields, setFields] = useState<Record<string, ExtractedField>>({});
  const [owners, setOwners] = useState<ExtractedOwner[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [parsing, setParsing] = useState(false);

  // Target selection
  const [target, setTarget] = useState<RegistrationTarget>("auto");
  const [existingPropertyId, setExistingPropertyId] = useState("");
  const [propertySearchQuery, setPropertySearchQuery] = useState("");
  const [propertySearchResults, setPropertySearchResults] = useState<
    Array<{ id: string; address: string; lotNumber?: string | null; realEstateNumber?: string | null }>
  >([]);
  const [propertySearchLoading, setPropertySearchLoading] = useState(false);
  const searchTimerRef2 = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Confirm/Result
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const setFileState = useCallback((file: File) => {
    setFileName(file.name);
    setSelectedFile(file);
    // テキストはサーバー側で抽出するため readAsText は不要
    // プレビュー表示用に「ファイル選択済み」をマーク
    setText(""); // クリア（file モード時は text は使わない）
  }, []);

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    setFileState(file);
  }, [setFileState]);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setFileState(file);
    },
    [setFileState],
  );

  const handleParse = useCallback(async () => {
    setParsing(true);
    setError(null);
    try {
      let result: { parsed: ParsedResult };

      if (uploadTab === "file" && selectedFile) {
        // PDF ファイル → サーバー側テキスト抽出 + 解析
        result = await parseRegistryPdfFile(selectedFile) as { parsed: ParsedResult };
      } else {
        // テキスト貼り付け → サーバー側解析 (JSON 送信)
        if (!text.trim()) {
          setError("テキストを入力してください");
          return;
        }
        result = await parseRegistryPdfText(text, fileName ?? "paste.txt") as { parsed: ParsedResult };
      }

      const parsed = result.parsed;
      // フィールドを EditableField 形式に変換
      const toField = (v: string | null) => ({
        value: v ?? "",
        confidence: assignConfidence(v ?? ""),
      });
      setFields({
        realEstateNumber: toField(parsed.realEstateNumber),
        address: toField(parsed.address),
        lotNumber: toField(parsed.lotNumber),
        buildingNumber: toField(parsed.buildingNumber),
        landCategory: toField(parsed.landCategory),
        area: toField(parsed.area),
      });
      setOwners(
        parsed.owners.map((o) => ({
          name: o.name,
          address: o.address ?? "",
          share: o.share ?? "",
        })),
      );
      setWarnings(parsed.warnings);
      setStep("extract");
    } catch (err) {
      setError(err instanceof Error ? err.message : "解析に失敗しました");
    } finally {
      setParsing(false);
    }
  }, [uploadTab, selectedFile, text]);

  const updateField = (key: string, value: string) => {
    setFields((prev) => ({
      ...prev,
      [key]: { ...prev[key], value, confidence: assignConfidence(value) },
    }));
  };

  const updateOwner = (
    idx: number,
    field: keyof ExtractedOwner,
    value: string,
  ) => {
    setOwners((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  };

  const removeOwner = (idx: number) => {
    setOwners((prev) => prev.filter((_, i) => i !== idx));
  };

  const addOwner = () => {
    setOwners((prev) => [...prev, { name: "", address: "", share: "" }]);
  };

  const handleImport = async () => {
    setImporting(true);
    setError(null);
    setResult(null);

    const propId =
      target === "existing" ? existingPropertyId.trim() || null : null;

    try {
      let json;
      if (uploadTab === "file" && selectedFile) {
        // PDF ファイルモード
        json = await importRegistryPdfFile(
          selectedFile,
          propId,
          fileName ?? selectedFile.name,
        );
      } else {
        // テキスト貼り付けモード
        json = await importRegistryPdf(
          text.trim(),
          propId,
          fileName ?? "registry-paste.txt",
        );
      }
      setResult(json as ImportResult);
      setStep("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : "取込に失敗しました");
    } finally {
      setImporting(false);
    }
  };

  const handlePropertySearch = (value: string) => {
    setPropertySearchQuery(value);
    if (searchTimerRef2.current) clearTimeout(searchTimerRef2.current);
    if (value.length < 2) {
      setPropertySearchResults([]);
      return;
    }
    searchTimerRef2.current = setTimeout(async () => {
      setPropertySearchLoading(true);
      try {
        const res = await searchProperties(value);
        setPropertySearchResults(
          res.data as Array<{ id: string; address: string; lotNumber?: string | null; realEstateNumber?: string | null }>,
        );
      } catch {
        setPropertySearchResults([]);
      } finally {
        setPropertySearchLoading(false);
      }
    }, 300);
  };

  const handleReset = () => {
    setStep("upload");
    setText("");
    setFileName(null);
    setSelectedFile(null);
    setFields({});
    setOwners([]);
    setWarnings([]);
    setTarget("auto");
    setExistingPropertyId("");
    setResult(null);
    setError(null);
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="mx-auto max-w-4xl">
      <ImportSwitcher />
      <h2 className="mb-2 text-2xl font-bold text-gray-800">謄本PDF取込</h2>
      <p className="mb-6 text-sm text-gray-500">
        登記簿謄本のPDFまたはテキストから物件情報を抽出・登録します
      </p>

      <StepIndicator current={step} />

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertTriangle className="mr-1 inline h-4 w-4" />
          {error}
        </div>
      )}

      {/* ================================================================= */}
      {/* Step 1: Upload                                                     */}
      {/* ================================================================= */}
      {step === "upload" && (
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          {/* Tab switch */}
          <div className="mb-6 flex border-b border-gray-200">
            <button
              onClick={() => setUploadTab("file")}
              className={`flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                uploadTab === "file"
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              <Upload className="h-4 w-4" />
              ファイルアップロード
            </button>
            <button
              onClick={() => setUploadTab("text")}
              className={`flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                uploadTab === "text"
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              <ClipboardPaste className="h-4 w-4" />
              テキスト貼り付け
            </button>
          </div>

          {/* File upload tab */}
          {uploadTab === "file" && (
            <div>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleFileDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-12 transition-colors ${
                  dragOver
                    ? "border-blue-400 bg-blue-50"
                    : "border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-gray-100"
                }`}
              >
                <FileText className="mb-3 h-10 w-10 text-gray-400" />
                <p className="text-sm font-medium text-gray-700">
                  PDFファイルをドラッグ＆ドロップ
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  またはクリックしてファイルを選択
                </p>
                {fileName && (
                  <p className="mt-3 rounded bg-blue-50 px-3 py-1 text-sm text-blue-700">
                    <FileText className="mr-1 inline h-3.5 w-3.5" />
                    {fileName}
                  </p>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.txt"
                  className="hidden"
                  onChange={handleFileSelect}
                />
              </div>
              <p className="mt-2 text-xs text-gray-400">
                <Info className="mr-1 inline h-3 w-3" />
                現在はテキスト読み込みのみ対応（PDF直接解析は今後対応予定）
              </p>
            </div>
          )}

          {/* Text paste tab */}
          {uploadTab === "text" && (
            <div>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={14}
                placeholder={`謄本テキストを貼り付けてください。例:\n\n不動産番号: 1234567890123\n所在: 東京都千代田区丸の内一丁目\n地番: 1番1\n地目: 宅地\n地積: 150.00㎡\n\n所有者: 山田太郎  東京都千代田区丸の内1-1-1`}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none resize-y"
              />
            </div>
          )}

          {/* Preview of loaded text (file tab) */}
          {uploadTab === "file" && text && (
            <div className="mt-4">
              <label className="mb-1 block text-xs font-medium text-gray-500">
                読み込まれたテキスト（プレビュー）
              </label>
              <pre className="max-h-48 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
                {text.slice(0, 2000)}
                {text.length > 2000 && "\n...（省略）"}
              </pre>
            </div>
          )}

          {/* Next button */}
          <div className="mt-6 flex justify-end">
            <button
              onClick={handleParse}
              disabled={!text.trim() || parsing}
              className="flex items-center gap-2 rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {parsing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  解析中...
                </>
              ) : (
                <>
                  抽出開始
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* Step 2: Extract / Edit                                             */}
      {/* ================================================================= */}
      {step === "extract" && (
        <div className="space-y-6">
          {/* Extracted fields */}
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-gray-800">
              <FileText className="h-5 w-5 text-blue-600" />
              抽出データ
            </h3>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {Object.entries(FIELD_LABELS).map(([key, label]) => {
                const field = fields[key];
                if (!field) return null;
                return (
                  <div key={key}>
                    <label className="mb-1 flex items-center gap-1.5 text-sm font-medium text-gray-600">
                      {label}
                      <ConfidenceDot level={field.confidence} />
                    </label>
                    <input
                      type="text"
                      value={field.value}
                      onChange={(e) => updateField(key, e.target.value)}
                      placeholder={`${label}を入力`}
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                    />
                  </div>
                );
              })}
            </div>

            <div className="mt-4">
              <p className="flex items-center gap-3 text-xs text-gray-400">
                <span className="flex items-center gap-1">
                  <Circle className="h-2.5 w-2.5 fill-current text-green-500" />
                  高信頼
                </span>
                <span className="flex items-center gap-1">
                  <Circle className="h-2.5 w-2.5 fill-current text-yellow-500" />
                  中信頼
                </span>
                <span className="flex items-center gap-1">
                  <Circle className="h-2.5 w-2.5 fill-current text-red-500" />
                  低信頼
                </span>
              </p>
            </div>
          </div>

          {/* Owner table */}
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-gray-800">
              所有者情報
            </h3>

            {owners.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-left">
                      <th className="pb-2 pr-3 font-medium text-gray-500">
                        氏名
                      </th>
                      <th className="pb-2 pr-3 font-medium text-gray-500">
                        住所
                      </th>
                      <th className="pb-2 pr-3 font-medium text-gray-500">
                        持分
                      </th>
                      <th className="pb-2 w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {owners.map((owner, idx) => (
                      <tr
                        key={idx}
                        className="border-b border-gray-100 last:border-0"
                      >
                        <td className="py-2 pr-3">
                          <input
                            type="text"
                            value={owner.name}
                            onChange={(e) =>
                              updateOwner(idx, "name", e.target.value)
                            }
                            placeholder="氏名"
                            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            type="text"
                            value={owner.address}
                            onChange={(e) =>
                              updateOwner(idx, "address", e.target.value)
                            }
                            placeholder="住所"
                            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            type="text"
                            value={owner.share}
                            onChange={(e) =>
                              updateOwner(idx, "share", e.target.value)
                            }
                            placeholder="例: 1/2"
                            className="w-28 rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                          />
                        </td>
                        <td className="py-2">
                          <button
                            onClick={() => removeOwner(idx)}
                            className="rounded p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                            title="削除"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-gray-400">所有者が抽出されていません</p>
            )}

            <button
              onClick={addOwner}
              className="mt-3 flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <Plus className="h-4 w-4" />
              所有者を追加
            </button>
          </div>

          {/* Registration target */}
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <h3 className="mb-4 text-lg font-semibold text-gray-800">
              登録先の選択
            </h3>
            <div className="space-y-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="target"
                  value="auto"
                  checked={target === "auto"}
                  onChange={() => setTarget("auto")}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">
                  自動照合（システムが既存物件と照合し、一致なければ新規作成）
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="target"
                  value="new"
                  checked={target === "new"}
                  onChange={() => setTarget("new")}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">
                  新規物件として登録
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="target"
                  value="existing"
                  checked={target === "existing"}
                  onChange={() => setTarget("existing")}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">
                  既存物件を更新
                </span>
              </label>
              {target === "existing" && (
                <div className="ml-6 space-y-2">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                    <input
                      type="text"
                      value={propertySearchQuery}
                      onChange={(e) => handlePropertySearch(e.target.value)}
                      placeholder="住所・地番・不動産番号で検索..."
                      className="w-full rounded-md border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                    />
                  </div>
                  {propertySearchLoading && (
                    <div className="flex items-center gap-1 text-xs text-gray-400">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      検索中...
                    </div>
                  )}
                  {propertySearchResults.length > 0 && (
                    <div className="max-h-[200px] overflow-y-auto rounded border border-gray-200 bg-white">
                      {propertySearchResults.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => {
                            setExistingPropertyId(p.id);
                            setPropertySearchQuery(p.address);
                            setPropertySearchResults([]);
                          }}
                          className={`flex w-full items-start gap-2 border-b border-gray-100 px-3 py-2 text-left text-xs hover:bg-blue-50 last:border-b-0 ${
                            existingPropertyId === p.id ? "bg-blue-50" : ""
                          }`}
                        >
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-gray-800 truncate">
                              {p.address}
                            </p>
                            <p className="text-gray-500 truncate">
                              {[
                                p.lotNumber && `地番: ${p.lotNumber}`,
                                p.realEstateNumber && `不動産番号: ${p.realEstateNumber}`,
                              ]
                                .filter(Boolean)
                                .join(" / ")}
                            </p>
                          </div>
                          <span className="shrink-0 font-mono text-[10px] text-gray-400">
                            {p.id.slice(0, 8)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {existingPropertyId && (
                    <div className="rounded border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs text-blue-700">
                      選択中: {propertySearchQuery || existingPropertyId} ({existingPropertyId.slice(0, 8)}...)
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Warnings */}
          {warnings.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
              <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-amber-700">
                <AlertTriangle className="h-4 w-4" />
                注意事項
              </h4>
              <ul className="space-y-1">
                {warnings.map((w, i) => (
                  <li key={i} className="text-sm text-amber-600">
                    ・{w}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Navigation */}
          <div className="flex justify-between">
            <button
              onClick={() => setStep("upload")}
              className="flex items-center gap-1.5 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              戻る
            </button>
            <button
              onClick={() => setStep("confirm")}
              className="flex items-center gap-2 rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
            >
              確認画面へ
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* Step 3: Confirm                                                    */}
      {/* ================================================================= */}
      {step === "confirm" && (
        <div className="space-y-6">
          {/* Summary */}
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <h3 className="mb-4 text-lg font-semibold text-gray-800">
              登録内容の確認
            </h3>

            {/* Confidence bar */}
            <div className="mb-6">
              <label className="mb-1.5 block text-sm font-medium text-gray-600">
                総合信頼度
              </label>
              <ConfidenceBar score={overallScore(fields)} />
            </div>

            {/* Property data summary */}
            <div className="mb-6 rounded-md border border-gray-100 bg-gray-50 p-4">
              <h4 className="mb-3 text-sm font-semibold text-gray-700">
                物件情報
              </h4>
              <dl className="grid grid-cols-1 gap-y-2 gap-x-6 text-sm sm:grid-cols-2">
                {Object.entries(FIELD_LABELS).map(([key, label]) => {
                  const field = fields[key];
                  return (
                    <div key={key} className="flex gap-2">
                      <dt className="min-w-[6rem] text-gray-500">{label}</dt>
                      <dd className="font-medium text-gray-800">
                        {field?.value || (
                          <span className="text-gray-300">-</span>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>

            {/* Owner summary */}
            {owners.length > 0 && (
              <div className="mb-6 rounded-md border border-gray-100 bg-gray-50 p-4">
                <h4 className="mb-3 text-sm font-semibold text-gray-700">
                  所有者情報（{owners.length}名）
                </h4>
                <div className="space-y-2">
                  {owners.map((o, i) => (
                    <div
                      key={i}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
                    >
                      <span className="font-medium text-gray-800">
                        {o.name || "-"}
                      </span>
                      {o.share && (
                        <span className="text-gray-500">持分: {o.share}</span>
                      )}
                      {o.address && (
                        <span className="text-gray-400">{o.address}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Target */}
            <div className="mb-6 rounded-md border border-gray-100 bg-gray-50 p-4">
              <h4 className="mb-1 text-sm font-semibold text-gray-700">
                登録方法
              </h4>
              <p className="text-sm text-gray-600">
                {target === "auto" && "自動照合"}
                {target === "new" && "新規物件として登録"}
                {target === "existing" &&
                  `既存物件を更新（${existingPropertyId || "未指定"}）`}
              </p>
            </div>

            {/* Warnings */}
            {warnings.length > 0 && (
              <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-3">
                <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-amber-700">
                  <AlertTriangle className="h-4 w-4" />
                  警告
                </h4>
                <ul className="space-y-0.5">
                  {warnings.map((w, i) => (
                    <li key={i} className="text-sm text-amber-600">
                      ・{w}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex justify-between">
            <button
              onClick={() => setStep("extract")}
              className="flex items-center gap-1.5 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              戻る
            </button>
            <div className="flex gap-3">
              <button
                onClick={handleReset}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={handleImport}
                disabled={importing}
                className="flex items-center gap-2 rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {importing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    登録中...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    登録実行
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* Step 4: Result                                                     */}
      {/* ================================================================= */}
      {step === "result" && result && (
        <div className="space-y-6">
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            {/* Success header */}
            <div className="mb-6 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
                <CheckCircle2 className="h-6 w-6 text-green-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-800">
                  取込が完了しました
                </h3>
                <p className="text-sm text-gray-500">
                  ジョブID: {result.jobId}
                </p>
              </div>
            </div>

            {/* Action badge */}
            <div className="mb-6">
              <span
                className={`inline-block rounded-full border px-4 py-1.5 text-sm font-medium ${ACTION_LABELS[result.action]?.color ?? ""}`}
              >
                {ACTION_LABELS[result.action]?.label ?? result.action}
              </span>
            </div>

            {/* Parsed summary */}
            <div className="mb-6 rounded-md border border-gray-100 bg-gray-50 p-4">
              <h4 className="mb-3 text-sm font-semibold text-gray-700">
                登録されたデータ
              </h4>
              <dl className="grid grid-cols-1 gap-y-2 gap-x-6 text-sm sm:grid-cols-2">
                {[
                  ["不動産番号", result.parsed.realEstateNumber],
                  ["所在", result.parsed.address],
                  ["地番", result.parsed.lotNumber],
                  ["家屋番号", result.parsed.buildingNumber],
                  ["地目", result.parsed.landCategory],
                  ["地積", result.parsed.area],
                ].map(([label, value]) => (
                  <div key={label as string} className="flex gap-2">
                    <dt className="min-w-[6rem] text-gray-500">
                      {label as string}
                    </dt>
                    <dd className="font-medium text-gray-800">
                      {(value as string) || (
                        <span className="text-gray-300">-</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>

              {result.parsed.owners.length > 0 && (
                <div className="mt-3 border-t border-gray-200 pt-3">
                  <h5 className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">
                    所有者
                  </h5>
                  {result.parsed.owners.map((o, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 text-sm text-gray-700"
                    >
                      <span className="font-medium">{o.name}</span>
                      {o.share && (
                        <span className="text-xs text-gray-500">
                          ({o.share})
                        </span>
                      )}
                      {o.address && (
                        <span className="text-xs text-gray-400">
                          {o.address}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Confidence */}
            <div className="mb-6">
              <label className="mb-1 block text-sm font-medium text-gray-600">
                信頼度
              </label>
              <ConfidenceBar score={result.parsed.confidence} />
            </div>

            {/* Warnings */}
            {result.parsed.warnings.length > 0 && (
              <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-3">
                {result.parsed.warnings.map((w, i) => (
                  <p key={i} className="text-sm text-amber-600">
                    <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                    {w}
                  </p>
                ))}
              </div>
            )}

            {/* Link to property */}
            {result.propertyId && (
              <Link
                href={`/properties/${result.propertyId}`}
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100 transition-colors"
              >
                <ExternalLink className="h-4 w-4" />
                物件詳細を開く
              </Link>
            )}
          </div>

          {/* Start over */}
          <div className="flex justify-end">
            <button
              onClick={handleReset}
              className="flex items-center gap-1.5 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
            >
              新しい取込を開始
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
