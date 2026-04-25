"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  MapPin,
  Hash,
  FileText,
  Map,
  Loader2,
  Check,
  X,
  Minus,
  ChevronDown,
  ChevronUp,
  Link2,
} from "lucide-react";
import { fetchCandidates as apiFetchCandidates } from "@/lib/api-client";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";

interface Candidate {
  id: string;
  address: string;
  lotNumber: string | null;
  realEstateNumber: string | null;
  propertyType: string;
  caseStatus: string;
  distance: number | null;
  strength: string;
  matchType: string;
  similarity: number;
}

type Judgment = "same" | "different" | "pending";

const strengthConfig: Record<
  string,
  { label: string; badge: string; border: string }
> = {
  strong: {
    label: "強",
    badge: "bg-red-100 text-red-800",
    border: "border-l-red-500",
  },
  medium: {
    label: "中",
    badge: "bg-amber-100 text-amber-800",
    border: "border-l-amber-500",
  },
  weak: {
    label: "弱",
    badge: "bg-blue-100 text-blue-800",
    border: "border-l-blue-500",
  },
};

const matchTypeConfig: Record<
  string,
  { label: string; icon: typeof MapPin }
> = {
  gps: { label: "GPS", icon: MapPin },
  address: { label: "住所", icon: Map },
  lot_number: { label: "地番", icon: Hash },
  real_estate_number: { label: "不動産番号", icon: FileText },
};

const CASE_STATUS_LABELS: Record<string, string> = {
  active: "進行中",
  closed: "完了",
  pending: "保留",
};

const judgmentConfig: Record<
  Judgment,
  { label: string; icon: typeof Check; color: string }
> = {
  same: { label: "同一物件", icon: Check, color: "text-green-600" },
  different: { label: "別物件", icon: X, color: "text-red-600" },
  pending: { label: "保留", icon: Minus, color: "text-gray-500" },
};

function getMatchReason(candidate: Candidate): string {
  switch (candidate.matchType) {
    case "gps":
      return `GPS座標が${candidate.distance ?? 0}m以内`;
    case "address":
      return `住所の類似度${Math.round(candidate.similarity * 100)}%`;
    case "lot_number":
      return "地番が一致";
    case "real_estate_number":
      return "不動産番号が一致";
    default:
      return "一致";
  }
}

function CandidateCard({
  candidate,
  judgment,
  onJudge,
}: {
  candidate: Candidate;
  judgment: Judgment | undefined;
  onJudge: (id: string, judgment: Judgment) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const sConfig = strengthConfig[candidate.strength] ?? strengthConfig.weak;
  const mConfig =
    matchTypeConfig[candidate.matchType] ?? matchTypeConfig.gps;
  const MatchIcon = mConfig.icon;
  const matchReason = getMatchReason(candidate);
  const jConfig = judgment ? judgmentConfig[judgment] : null;
  const JudgmentIcon = jConfig?.icon;

  return (
    <div
      className={`rounded-lg border border-gray-200 border-l-4 ${sConfig.border} bg-white shadow-sm transition-all duration-200 hover:shadow-md`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="shrink-0 flex items-center gap-1 text-gray-500">
          <MatchIcon className="h-4 w-4" />
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${sConfig.badge}`}
        >
          {sConfig.label}
        </span>
        <Link
          href={`/properties/${candidate.id}`}
          className="flex-1 min-w-0 flex items-center gap-1 text-sm text-blue-600 hover:underline font-medium truncate"
        >
          <Link2 className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{candidate.address}</span>
        </Link>
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          aria-label={expanded ? "詳細を閉じる" : "詳細を開く"}
        >
          {expanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* Body */}
      <div className="px-4 pb-2">
        <p className="text-xs text-gray-600 mb-2">
          <span className="font-medium text-gray-700">一致理由:</span>{" "}
          {matchReason}
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500">
          <span>
            種別:{" "}
            {PROPERTY_TYPE_LABELS[candidate.propertyType] ??
              candidate.propertyType}
          </span>
          <span>
            状態:{" "}
            {CASE_STATUS_LABELS[candidate.caseStatus] ??
              candidate.caseStatus}
          </span>
          {candidate.lotNumber && (
            <span>地番: {candidate.lotNumber}</span>
          )}
        </div>
      </div>

      {/* Expandable detail */}
      <div
        className={`overflow-hidden transition-all duration-200 ${
          expanded ? "max-h-40 opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-500 space-y-1">
          <div>ID: {candidate.id}</div>
          {candidate.realEstateNumber && (
            <div>不動産番号: {candidate.realEstateNumber}</div>
          )}
          {candidate.distance != null && (
            <div>距離: {candidate.distance}m</div>
          )}
          {candidate.similarity > 0 && (
            <div>
              類似度: {Math.round(candidate.similarity * 100)}%
            </div>
          )}
        </div>
      </div>

      {/* Footer: judgment buttons / result */}
      <div className="border-t border-gray-100 px-4 py-2">
        {judgment ? (
          <div
            className={`flex items-center gap-1.5 text-xs font-medium ${jConfig!.color}`}
          >
            {JudgmentIcon && <JudgmentIcon className="h-4 w-4" />}
            <span>判定: {jConfig!.label}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onJudge(candidate.id, "same")}
              className="rounded px-3 py-1 text-xs font-medium text-white bg-green-600 hover:bg-green-700 transition-colors"
            >
              同一物件
            </button>
            <button
              type="button"
              onClick={() => onJudge(candidate.id, "different")}
              className="rounded px-3 py-1 text-xs font-medium text-white bg-red-600 hover:bg-red-700 transition-colors"
            >
              別物件
            </button>
            <button
              type="button"
              onClick={() => onJudge(candidate.id, "pending")}
              className="rounded px-3 py-1 text-xs font-medium text-gray-600 bg-gray-200 hover:bg-gray-300 transition-colors"
            >
              保留
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CandidateList({
  propertyId,
}: {
  propertyId: string;
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [judgments, setJudgments] = useState<Record<string, Judgment>>({});

  useEffect(() => {
    let cancelled = false;
    async function loadCandidates() {
      try {
        const json = await apiFetchCandidates(propertyId);
        if (!cancelled) {
          setCandidates(json.data as Candidate[]);
        }
      } catch {
        if (!cancelled) setMessage("候補の取得に失敗しました");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadCandidates();
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  const handleJudge = (id: string, judgment: Judgment) => {
    setJudgments((prev) => ({ ...prev, [id]: judgment }));
  };

  const judgedCount = Object.keys(judgments).length;

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
        <span className="text-xs text-gray-400">候補を検索中...</span>
      </div>
    );
  }

  if (message) {
    return <p className="text-xs text-gray-400 py-4">{message}</p>;
  }

  if (candidates.length === 0) {
    return (
      <p className="text-xs text-gray-400 py-4">候補物件はありません</p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500">
          {candidates.length}件中 {judgedCount}件判定済み
        </p>
      </div>
      {candidates.map((c) => (
        <CandidateCard
          key={c.id}
          candidate={c}
          judgment={judgments[c.id]}
          onJudge={handleJudge}
        />
      ))}
    </div>
  );
}
