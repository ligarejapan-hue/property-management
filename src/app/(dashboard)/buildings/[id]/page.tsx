"use client";

import { useState, useEffect, useCallback, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Building,
  Edit,
  Loader2,
  Plus,
  ChevronRight,
  Save,
  X,
  Home,
  Users,
  Trash2,
} from "lucide-react";
import {
  fetchBuildingDetail,
  updateBuilding,
  deleteBuilding,
  fetchBuildingProperties,
  createBuildingUnit,
} from "@/lib/api-client";
import BuildingPhotoTab from "@/components/buildings/building-photo-tab";
import { AddressLookupControls } from "@/components/address/address-lookup-controls";
import { CASE_STATUS_LABELS as CASE_LABELS, OCCUPANCY_STATUS_LABELS } from "@/lib/property-types";

// ---------- Types ----------

interface BuildingData {
  id: string;
  name: string;
  postalCode: string | null;
  address: string;
  lotNumber: string | null;
  realEstateNumber: string | null;
  totalFloors: number | null;
  totalUnits: number | null;
  builtYear: number | null;
  structureType: string | null;
  managementCompany: string | null;
  note: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  creator: { id: string; name: string };
  _count: { properties: number };
}

interface UnitProperty {
  id: string;
  address: string;
  roomNo: string | null;
  floorNo: number | null;
  exclusiveArea: number | null;
  layoutType: string | null;
  orientation: string | null;
  occupancyStatus: string | null;
  caseStatus: string;
  registryStatus: string;
  propertyOwners: Array<{
    owner: { id: string; name: string };
  }>;
}

// 現況ラベルは shared 定数 (src/lib/property-types.ts) から参照
const OCCUPANCY_LABELS = OCCUPANCY_STATUS_LABELS;

const OCCUPANCY_COLORS: Record<string, string> = {
  vacant: "bg-green-100 text-green-800",
  occupied: "bg-blue-100 text-blue-800",
  unknown: "bg-gray-100 text-gray-600",
};

// ---------- Component ----------

export default function BuildingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [building, setBuilding] = useState<BuildingData | null>(null);
  const [units, setUnits] = useState<UnitProperty[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  // 住所補完の user-edit signal（Codex P2-G）。住所 input 直接編集時だけ true。
  const [addressEdited, setAddressEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showAddUnit, setShowAddUnit] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [bData, pData] = await Promise.all([
        fetchBuildingDetail(id),
        fetchBuildingProperties(id),
      ]);
      setBuilding(bData as BuildingData);
      setUnits((pData as { data: UnitProperty[] }).data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const startEdit = () => {
    if (!building) return;
    setEditForm({
      name: building.name,
      postalCode: building.postalCode ?? "",
      address: building.address,
      totalFloors: building.totalFloors?.toString() ?? "",
      totalUnits: building.totalUnits?.toString() ?? "",
      builtYear: building.builtYear?.toString() ?? "",
      structureType: building.structureType ?? "",
      managementCompany: building.managementCompany ?? "",
      note: building.note ?? "",
    });
    // 保存値ロードは user-edit ではない＝signal をリセット（開いただけでは検索しない）。
    setAddressEdited(false);
    setEditing(true);
  };

  const handleDelete = async () => {
    if (!building) return;
    if (building._count.properties > 0) {
      alert(
        `この棟には ${building._count.properties} 件の物件が紐づいているため削除できません。先に部屋を削除してください。`,
      );
      return;
    }
    const ok = window.confirm(
      `棟「${building.name}」を削除します。この操作は取り消せません。よろしいですか？`,
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await deleteBuilding(building.id);
      router.push("/buildings");
      router.refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "削除に失敗しました");
      setDeleting(false);
    }
  };

  const handleSave = async () => {
    if (!building) return;
    setSaving(true);
    try {
      await updateBuilding(building.id, {
        name: editForm.name,
        postalCode: editForm.postalCode || null,
        address: editForm.address,
        totalFloors: editForm.totalFloors ? Number(editForm.totalFloors) : null,
        totalUnits: editForm.totalUnits ? Number(editForm.totalUnits) : null,
        builtYear: editForm.builtYear ? Number(editForm.builtYear) : null,
        structureType: editForm.structureType || null,
        managementCompany: editForm.managementCompany || null,
        note: editForm.note || null,
        version: building.version,
      });
      setEditing(false);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400 dark:text-gray-500" />
      </div>
    );
  }

  if (error || !building) {
    return (
      <div className="py-10 text-center">
        <p className="mb-4 text-red-600 dark:text-red-400">{error ?? "棟が見つかりません"}</p>
        <Link href="/buildings" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
          棟一覧に戻る
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/buildings"
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <ArrowLeft className="h-4 w-4" />
          棟一覧
        </Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <Building className="h-5 w-5 text-blue-500" />
        <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100">{building.name}</h2>
        <div className="ml-auto flex items-center gap-2">
          {!editing && (
            <>
              <button
                onClick={startEdit}
                className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                <Edit className="h-4 w-4" />
                編集
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting || building._count.properties > 0}
                title={
                  building._count.properties > 0
                    ? "紐づく部屋があるため削除できません"
                    : undefined
                }
                className="flex items-center gap-1.5 rounded-md border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                削除
              </button>
            </>
          )}
        </div>
      </div>

      {/* Building info */}
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
        {editing ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {[
                { key: "name", label: "マンション名", required: true },
                { key: "postalCode", label: "郵便番号" },
                { key: "address", label: "住所", required: true },
                { key: "totalFloors", label: "階数", type: "number" },
                { key: "totalUnits", label: "総戸数", type: "number" },
                { key: "builtYear", label: "築年", type: "number" },
                { key: "structureType", label: "構造" },
                { key: "managementCompany", label: "管理会社" },
              ].map((f) => (
                <div key={f.key}>
                  <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                    {f.label}
                    {f.required && <span className="text-red-500">*</span>}
                  </label>
                  <input
                    type={f.type ?? "text"}
                    value={editForm[f.key] ?? ""}
                    onChange={(e) => {
                      // 住所のユーザー直接編集だけ user-edit signal を立てる。
                      if (f.key === "address") setAddressEdited(true);
                      setEditForm((p) => ({ ...p, [f.key]: e.target.value }));
                    }}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700"
                  />
                  {f.key === "address" && (
                    <div className="mt-1.5">
                      <AddressLookupControls
                        zip={editForm.postalCode ?? ""}
                        address={editForm.address ?? ""}
                        onZipChange={(z) =>
                          setEditForm((p) => ({ ...p, postalCode: z }))
                        }
                        onAddressChange={(a) =>
                          setEditForm((p) => ({ ...p, address: a }))
                        }
                        addressEdited={addressEdited}
                        disabled={saving}
                        mode="both"
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                備考
              </label>
              <textarea
                value={editForm.note ?? ""}
                onChange={(e) =>
                  setEditForm((p) => ({ ...p, note: e.target.value }))
                }
                rows={2}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-y dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                保存
              </button>
              <button
                onClick={() => setEditing(false)}
                className="flex items-center gap-1.5 rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                <X className="h-4 w-4" />
                キャンセル
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3 lg:grid-cols-4">
            <InfoField label="住所" value={building.address} />
            <InfoField label="階数" value={building.totalFloors ? `${building.totalFloors}階建` : null} />
            <InfoField label="総戸数" value={building.totalUnits ? `${building.totalUnits}戸` : null} />
            <InfoField label="築年" value={building.builtYear ? `${building.builtYear}年` : null} />
            <InfoField label="構造" value={building.structureType} />
            <InfoField label="管理会社" value={building.managementCompany} />
            <InfoField label="登録者" value={building.creator.name} />
            <InfoField
              label="更新日"
              value={new Date(building.updatedAt).toLocaleDateString("ja-JP")}
            />
            {building.note && (
              <div className="col-span-full">
                <InfoField label="備考" value={building.note} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Building photos */}
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
        <BuildingPhotoTab buildingId={building.id} />
      </div>

      {/* Units list */}
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100">
          部屋一覧
          <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
            ({units.length}戸)
          </span>
        </h3>
        <button
          onClick={() => setShowAddUnit(true)}
          className="flex items-center gap-1.5 rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-700"
        >
          <Plus className="h-4 w-4" />
          部屋を追加
        </button>
      </div>

      {units.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white py-12 text-center dark:border-gray-800 dark:bg-gray-900">
          <Home className="mx-auto mb-3 h-8 w-8 text-gray-300 dark:text-gray-600" />
          <p className="text-sm text-gray-500 dark:text-gray-400">部屋がまだ登録されていません</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                  部屋
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                  階
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                  間取り
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                  専有面積
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                  入居状況
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                  所有者
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                  ステータス
                </th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {units.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                  <td className="px-4 py-3 font-medium text-gray-800 dark:text-gray-100">
                    {u.roomNo || "-"}
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                    {u.floorNo != null ? `${u.floorNo}F` : "-"}
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                    {u.layoutType || "-"}
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                    {u.exclusiveArea != null
                      ? `${Number(u.exclusiveArea).toFixed(2)}m²`
                      : "-"}
                  </td>
                  <td className="px-4 py-3">
                    {u.occupancyStatus ? (
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                          OCCUPANCY_COLORS[u.occupancyStatus] ?? "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {OCCUPANCY_LABELS[u.occupancyStatus] ?? u.occupancyStatus}
                      </span>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                    {u.propertyOwners.length > 0 ? (
                      <span className="flex items-center gap-1">
                        <Users className="h-3 w-3" />
                        {u.propertyOwners.map((po) => po.owner.name).join(", ")}
                      </span>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {CASE_LABELS[u.caseStatus] ?? u.caseStatus}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/properties/${u.id}`}
                      className="rounded p-1 text-gray-400 hover:bg-indigo-50 hover:text-indigo-500"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add unit modal */}
      {showAddUnit && (
        <AddUnitModal
          buildingId={building.id}
          buildingAddress={building.address}
          onClose={() => setShowAddUnit(false)}
          onCreated={() => {
            setShowAddUnit(false);
            load();
          }}
        />
      )}
    </div>
  );
}

// ---------- Sub-components ----------

function InfoField({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
      <div className="mt-0.5 font-medium text-gray-800 dark:text-gray-100">
        {value || <span className="text-gray-300 dark:text-gray-600">-</span>}
      </div>
    </div>
  );
}

function AddUnitModal({
  buildingId,
  buildingAddress,
  onClose,
  onCreated,
}: {
  buildingId: string;
  buildingAddress: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    roomNo: "",
    floorNo: "",
    exclusiveArea: "",
    balconyArea: "",
    layoutType: "",
    orientation: "",
    managementFee: "",
    repairReserveFee: "",
    occupancyStatus: "unknown",
    note: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const roomSuffix = form.roomNo ? ` ${form.roomNo}` : "";
      await createBuildingUnit(buildingId, {
        address: `${buildingAddress}${roomSuffix}`,
        roomNo: form.roomNo || undefined,
        floorNo: form.floorNo ? Number(form.floorNo) : undefined,
        exclusiveArea: form.exclusiveArea ? Number(form.exclusiveArea) : undefined,
        balconyArea: form.balconyArea ? Number(form.balconyArea) : undefined,
        layoutType: form.layoutType || undefined,
        orientation: form.orientation || undefined,
        managementFee: form.managementFee ? Number(form.managementFee) : undefined,
        repairReserveFee: form.repairReserveFee ? Number(form.repairReserveFee) : undefined,
        occupancyStatus: form.occupancyStatus || undefined,
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
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-lg bg-white p-6 shadow-lg dark:bg-gray-900">
        <h3 className="mb-4 text-lg font-bold text-gray-800 dark:text-gray-100">部屋を追加</h3>
        {error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                部屋番号
              </label>
              <input
                type="text"
                value={form.roomNo}
                onChange={(e) => setField("roomNo", e.target.value)}
                placeholder="101"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700 dark:placeholder:text-gray-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                階数
              </label>
              <input
                type="number"
                value={form.floorNo}
                onChange={(e) => setField("floorNo", e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                専有面積 (m²)
              </label>
              <input
                type="number"
                step="0.01"
                value={form.exclusiveArea}
                onChange={(e) => setField("exclusiveArea", e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                バルコニー面積 (m²)
              </label>
              <input
                type="number"
                step="0.01"
                value={form.balconyArea}
                onChange={(e) => setField("balconyArea", e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                間取り
              </label>
              <input
                type="text"
                value={form.layoutType}
                onChange={(e) => setField("layoutType", e.target.value)}
                placeholder="3LDK"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700 dark:placeholder:text-gray-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                向き
              </label>
              <select
                value={form.orientation}
                onChange={(e) => setField("orientation", e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700"
              >
                <option value="">-</option>
                <option value="北">北</option>
                <option value="北東">北東</option>
                <option value="東">東</option>
                <option value="南東">南東</option>
                <option value="南">南</option>
                <option value="南西">南西</option>
                <option value="西">西</option>
                <option value="北西">北西</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                管理費 (円/月)
              </label>
              <input
                type="number"
                value={form.managementFee}
                onChange={(e) => setField("managementFee", e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                修繕積立金 (円/月)
              </label>
              <input
                type="number"
                value={form.repairReserveFee}
                onChange={(e) => setField("repairReserveFee", e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
              入居状況
            </label>
            <select
              value={form.occupancyStatus}
              onChange={(e) => setField("occupancyStatus", e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="unknown">不明</option>
              <option value="vacant">空室</option>
              <option value="occupied">入居中</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
              備考
            </label>
            <textarea
              value={form.note}
              onChange={(e) => setField("note", e.target.value)}
              rows={2}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-y dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-1.5 rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              追加
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
