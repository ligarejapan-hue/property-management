"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Building,
  Plus,
  Search,
  Loader2,
  ChevronRight,
} from "lucide-react";
import { fetchBuildings, createBuilding } from "@/lib/api-client";

interface BuildingItem {
  id: string;
  name: string;
  address: string;
  totalFloors: number | null;
  totalUnits: number | null;
  builtYear: number | null;
  structureType: string | null;
  _count: { properties: number };
  creator: { id: string; name: string };
  updatedAt: string;
}

export default function BuildingsPage() {
  const [buildings, setBuildings] = useState<BuildingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchBuildings(keyword || undefined);
      setBuildings(res.data as BuildingItem[]);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [keyword]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-800">マンション棟一覧</h2>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          新規棟登録
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="マンション名・住所で検索..."
          className="w-full rounded-md border border-gray-300 py-2.5 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      ) : buildings.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white py-16 text-center">
          <Building className="mx-auto mb-3 h-10 w-10 text-gray-300" />
          <p className="text-sm text-gray-500">マンション棟がありません</p>
        </div>
      ) : (
        <div className="space-y-2">
          {buildings.map((b) => (
            <Link
              key={b.id}
              href={`/buildings/${b.id}`}
              className="flex items-center gap-4 rounded-lg border border-gray-200 bg-white px-5 py-4 hover:bg-gray-50 transition-colors"
            >
              <Building className="h-6 w-6 shrink-0 text-blue-500" />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-800">{b.name}</p>
                <p className="text-sm text-gray-500 truncate">{b.address}</p>
              </div>
              <div className="hidden sm:flex items-center gap-6 text-xs text-gray-500">
                {b.totalFloors && <span>{b.totalFloors}階建</span>}
                {b.builtYear && <span>{b.builtYear}年築</span>}
                <span className="font-medium text-gray-700">
                  {b._count.properties}戸
                </span>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />
            </Link>
          ))}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <CreateBuildingModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function CreateBuildingModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    name: "",
    address: "",
    totalFloors: "",
    totalUnits: "",
    builtYear: "",
    structureType: "",
    managementCompany: "",
    note: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await createBuilding({
        name: form.name,
        address: form.address,
        totalFloors: form.totalFloors ? Number(form.totalFloors) : undefined,
        totalUnits: form.totalUnits ? Number(form.totalUnits) : undefined,
        builtYear: form.builtYear ? Number(form.builtYear) : undefined,
        structureType: form.structureType || undefined,
        managementCompany: form.managementCompany || undefined,
        note: form.note || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "作成に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const setField = (key: string, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-lg">
        <h3 className="mb-4 text-lg font-bold text-gray-800">新規マンション棟</h3>
        {error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              マンション名 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              required
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              住所 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              required
              value={form.address}
              onChange={(e) => setField("address", e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                階数
              </label>
              <input
                type="number"
                value={form.totalFloors}
                onChange={(e) => setField("totalFloors", e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                総戸数
              </label>
              <input
                type="number"
                value={form.totalUnits}
                onChange={(e) => setField("totalUnits", e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                築年
              </label>
              <input
                type="number"
                value={form.builtYear}
                onChange={(e) => setField("builtYear", e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                構造
              </label>
              <input
                type="text"
                value={form.structureType}
                onChange={(e) => setField("structureType", e.target.value)}
                placeholder="RC造、SRC造 等"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                管理会社
              </label>
              <input
                type="text"
                value={form.managementCompany}
                onChange={(e) => setField("managementCompany", e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              備考
            </label>
            <textarea
              value={form.note}
              onChange={(e) => setField("note", e.target.value)}
              rows={2}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              登録
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
