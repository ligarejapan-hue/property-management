/**
 * Mock data for UI development without DB connection.
 * Controlled by NEXT_PUBLIC_USE_MOCK env var.
 */

// ---------- Users ----------

export const MOCK_USERS = [
  { id: "u1", name: "田中太郎", role: "admin", email: "tanaka@example.com" },
  { id: "u2", name: "佐藤花子", role: "office_staff", email: "sato@example.com" },
  { id: "u3", name: "鈴木一郎", role: "field_staff", email: "suzuki@example.com" },
];

export const MOCK_CURRENT_USER = MOCK_USERS[0];

// ---------- Properties ----------

export const MOCK_PROPERTIES = [
  {
    id: "p1",
    propertyType: "land",
    address: "東京都千代田区丸の内1-1-1",
    lotNumber: "1番1",
    buildingNumber: null,
    realEstateNumber: "1300012345678",
    registryStatus: "obtained",
    dmStatus: "send",
    caseStatus: "dm_target",
    isArchived: false,
    updatedAt: "2026-03-20T10:00:00Z",
    createdAt: "2026-01-15T09:00:00Z",
    assignedTo: "u2",
    gpsLat: 35.6812,
    gpsLng: 139.7671,
    investigationConfirmedAt: "2026-02-10T14:00:00Z",
    version: 3,
    note: "駅から徒歩3分。角地。",
    zoningDistrict: "商業地域",
    buildingCoverageRatio: 80,
    floorAreaRatio: 600,
    heightDistrict: "指定なし",
    firePreventionZone: "防火地域",
    scenicRestriction: null,
    roadType: "公道",
    roadWidth: 12.0,
    frontageWidth: 8.5,
    frontageDirection: "南",
    setbackRequired: "不要",
    rosenkaValue: 1500000,
    rosenkaYear: 2025,
    rebuildPermission: "可",
    architectureNote: null,
    assignee: { id: "u2", name: "佐藤花子" },
    creator: { id: "u1", name: "田中太郎" },
    propertyOwners: [
      {
        id: "po1",
        isPrimary: true,
        relationship: "所有者",
        createdAt: "2026-01-15T09:00:00Z",
        owner: {
          id: "o1",
          name: "山田太郎",
          nameKana: "ヤマダタロウ",
          phone: "***-****-1234",
          zip: "100-****",
          address: "東京都千代田区",
          note: null,
        },
      },
      {
        id: "po2",
        isPrimary: false,
        relationship: "共有者",
        createdAt: "2026-01-20T09:00:00Z",
        owner: {
          id: "o3",
          name: "山田次郎",
          nameKana: "ヤマダジロウ",
          phone: "***-****-5678",
          zip: "100-****",
          address: "東京都千代田区",
          note: null,
        },
      },
    ],
    photos: [],
    nextActions: [
      {
        id: "na1",
        content: "DM送付準備",
        actionType: "確認",
        scheduledAt: "2026-04-01",
        isCompleted: false,
        assignee: { id: "u2", name: "佐藤花子" },
      },
    ],
  },
  {
    id: "p2",
    propertyType: "building",
    address: "東京都新宿区西新宿2-8-1",
    lotNumber: "8番1",
    buildingNumber: "西新宿ビル101",
    realEstateNumber: "1301098765432",
    registryStatus: "obtained",
    dmStatus: "no_send",
    caseStatus: "site_checked",
    isArchived: false,
    updatedAt: "2026-03-18T15:30:00Z",
    createdAt: "2026-02-01T10:00:00Z",
    assignedTo: "u3",
    gpsLat: 35.6896,
    gpsLng: 139.6922,
    investigationConfirmedAt: null,
    version: 2,
    note: null,
    zoningDistrict: "商業地域",
    buildingCoverageRatio: 80,
    floorAreaRatio: 500,
    heightDistrict: null,
    firePreventionZone: "準防火地域",
    scenicRestriction: null,
    roadType: "公道",
    roadWidth: 8.0,
    frontageWidth: 6.0,
    frontageDirection: "東",
    setbackRequired: "不要",
    rosenkaValue: 2200000,
    rosenkaYear: 2025,
    rebuildPermission: "可",
    architectureNote: null,
    assignee: { id: "u3", name: "鈴木一郎" },
    creator: { id: "u2", name: "佐藤花子" },
    propertyOwners: [
      {
        id: "po3",
        isPrimary: true,
        relationship: "所有者",
        createdAt: "2026-02-01T10:00:00Z",
        owner: {
          id: "o2",
          name: "鈴木花子",
          nameKana: "スズキハナコ",
          phone: "***-****-9012",
          zip: "160-****",
          address: "東京都新宿区",
          note: null,
        },
      },
    ],
    photos: [],
    nextActions: [],
  },
  {
    id: "p3",
    propertyType: "land",
    address: "神奈川県横浜市中区本町1-3",
    lotNumber: "1番3",
    buildingNumber: null,
    realEstateNumber: null,
    registryStatus: "unconfirmed",
    dmStatus: "hold",
    caseStatus: "new_case",
    isArchived: false,
    updatedAt: "2026-03-25T08:00:00Z",
    createdAt: "2026-03-10T11:00:00Z",
    assignedTo: null,
    gpsLat: 35.4478,
    gpsLng: 139.6425,
    investigationConfirmedAt: null,
    version: 1,
    note: "空き地。雑草あり。",
    zoningDistrict: null,
    buildingCoverageRatio: null,
    floorAreaRatio: null,
    heightDistrict: null,
    firePreventionZone: null,
    scenicRestriction: null,
    roadType: null,
    roadWidth: null,
    frontageWidth: null,
    frontageDirection: null,
    setbackRequired: null,
    rosenkaValue: null,
    rosenkaYear: null,
    rebuildPermission: null,
    architectureNote: null,
    assignee: null,
    creator: { id: "u3", name: "鈴木一郎" },
    propertyOwners: [],
    photos: [],
    nextActions: [],
  },
  {
    id: "p4",
    propertyType: "building",
    address: "大阪府大阪市北区梅田3-1-3",
    lotNumber: "3番1",
    buildingNumber: "梅田マンション202",
    realEstateNumber: "2700055556666",
    registryStatus: "scheduled",
    dmStatus: "hold",
    caseStatus: "waiting_registry",
    isArchived: false,
    updatedAt: "2026-03-22T13:00:00Z",
    createdAt: "2026-02-20T10:00:00Z",
    assignedTo: "u2",
    gpsLat: 34.7006,
    gpsLng: 135.4942,
    investigationConfirmedAt: "2026-03-01T09:00:00Z",
    version: 4,
    note: "登記取得中。4月上旬に完了予定。",
    zoningDistrict: "近隣商業地域",
    buildingCoverageRatio: 60,
    floorAreaRatio: 300,
    heightDistrict: null,
    firePreventionZone: "準防火地域",
    scenicRestriction: null,
    roadType: "公道",
    roadWidth: 6.0,
    frontageWidth: 5.0,
    frontageDirection: "西",
    setbackRequired: null,
    rosenkaValue: 980000,
    rosenkaYear: 2025,
    rebuildPermission: null,
    architectureNote: null,
    assignee: { id: "u2", name: "佐藤花子" },
    creator: { id: "u1", name: "田中太郎" },
    propertyOwners: [
      {
        id: "po4",
        isPrimary: true,
        relationship: "所有者",
        createdAt: "2026-02-20T10:00:00Z",
        owner: {
          id: "o4",
          name: "高橋誠",
          nameKana: "タカハシマコト",
          phone: "***-****-3456",
          zip: "530-****",
          address: "大阪府大阪市北区",
          note: null,
        },
      },
    ],
    photos: [],
    nextActions: [
      {
        id: "na2",
        content: "登記取得確認の電話",
        actionType: "電話",
        scheduledAt: "2026-04-05",
        isCompleted: false,
        assignee: { id: "u2", name: "佐藤花子" },
      },
    ],
  },
  {
    id: "p5",
    propertyType: "unknown",
    address: "愛知県名古屋市中区栄4-1-1",
    lotNumber: null,
    buildingNumber: null,
    realEstateNumber: null,
    registryStatus: "unconfirmed",
    dmStatus: "hold",
    caseStatus: "new_case",
    isArchived: false,
    updatedAt: "2026-03-26T16:00:00Z",
    createdAt: "2026-03-26T16:00:00Z",
    assignedTo: "u3",
    gpsLat: null,
    gpsLng: null,
    investigationConfirmedAt: null,
    version: 1,
    note: null,
    zoningDistrict: null,
    buildingCoverageRatio: null,
    floorAreaRatio: null,
    heightDistrict: null,
    firePreventionZone: null,
    scenicRestriction: null,
    roadType: null,
    roadWidth: null,
    frontageWidth: null,
    frontageDirection: null,
    setbackRequired: null,
    rosenkaValue: null,
    rosenkaYear: null,
    rebuildPermission: null,
    architectureNote: null,
    assignee: { id: "u3", name: "鈴木一郎" },
    creator: { id: "u3", name: "鈴木一郎" },
    propertyOwners: [],
    photos: [],
    nextActions: [],
  },
];

// ---------- Owners ----------

export const MOCK_OWNERS = [
  { id: "o1", name: "山田太郎", nameKana: "ヤマダタロウ", phone: "090-1234-1234", zip: "100-0001", address: "東京都千代田区丸の内1-1-1", note: "連絡は午前中希望", version: 1 },
  { id: "o2", name: "鈴木花子", nameKana: "スズキハナコ", phone: "080-5678-9012", zip: "160-0023", address: "東京都新宿区西新宿2-8-1", note: null, version: 1 },
  { id: "o3", name: "山田次郎", nameKana: "ヤマダジロウ", phone: "070-3456-5678", zip: "100-0002", address: "東京都千代田区皇居外苑1-1", note: null, version: 1 },
  { id: "o4", name: "高橋誠", nameKana: "タカハシマコト", phone: "090-7890-3456", zip: "530-0001", address: "大阪府大阪市北区梅田3-1-3", note: null, version: 1 },
];

// ---------- Comments ----------

export const MOCK_COMMENTS = [
  {
    id: "c1",
    body: "現地確認しました。建物の老朽化が進んでいます。",
    authorId: "u3",
    createdAt: "2026-03-15T10:30:00Z",
    author: { id: "u3", name: "鈴木一郎" },
    replies: [
      {
        id: "c2",
        body: "写真は撮れましたか？",
        authorId: "u2",
        createdAt: "2026-03-15T11:00:00Z",
        author: { id: "u2", name: "佐藤花子" },
        replies: [],
      },
      {
        id: "c3",
        body: "はい、3枚撮影済みです。",
        authorId: "u3",
        createdAt: "2026-03-15T11:15:00Z",
        author: { id: "u3", name: "鈴木一郎" },
        replies: [],
      },
    ],
  },
  {
    id: "c4",
    body: "DM送付の判断をお願いします。",
    authorId: "u2",
    createdAt: "2026-03-18T09:00:00Z",
    author: { id: "u2", name: "佐藤花子" },
    replies: [],
  },
];

// ---------- Next Actions ----------

export const MOCK_NEXT_ACTIONS = [
  {
    id: "na1",
    propertyId: "p1",
    content: "DM送付準備",
    actionType: "確認",
    scheduledAt: "2026-04-01",
    isCompleted: false,
    completedAt: null,
    assignee: { id: "u2", name: "佐藤花子" },
    creator: { id: "u1", name: "田中太郎" },
    createdAt: "2026-03-20T10:00:00Z",
  },
  {
    id: "na2",
    propertyId: "p1",
    content: "所有者への電話確認",
    actionType: "電話",
    scheduledAt: "2026-03-25",
    isCompleted: true,
    completedAt: "2026-03-25T14:00:00Z",
    assignee: { id: "u3", name: "鈴木一郎" },
    creator: { id: "u2", name: "佐藤花子" },
    createdAt: "2026-03-18T09:00:00Z",
  },
];

// ---------- Attachments ----------

export const MOCK_ATTACHMENTS = [
  {
    id: "att1",
    fileName: "現地写真_正面.jpg",
    fileUrl: "#",
    fileSize: 2457600,
    mimeType: "image/jpeg",
    createdAt: "2026-03-15T10:35:00Z",
    uploader: { id: "u3", name: "鈴木一郎" },
  },
  {
    id: "att2",
    fileName: "登記簿謄本.pdf",
    fileUrl: "#",
    fileSize: 524288,
    mimeType: "application/pdf",
    createdAt: "2026-02-20T14:00:00Z",
    uploader: { id: "u2", name: "佐藤花子" },
  },
];

// ---------- Change Logs ----------

export const MOCK_CHANGE_LOGS = [
  {
    id: "cl1",
    targetTable: "properties",
    targetId: "p1",
    fieldName: "dmStatus",
    oldValue: "hold",
    newValue: "send",
    source: "manual",
    changedAt: "2026-03-20T10:00:00Z",
    changer: { id: "u1", name: "田中太郎" },
  },
  {
    id: "cl2",
    targetTable: "properties",
    targetId: "p1",
    fieldName: "registryStatus",
    oldValue: "unconfirmed",
    newValue: "obtained",
    source: "pdf_import",
    changedAt: "2026-02-15T11:00:00Z",
    changer: { id: "u2", name: "佐藤花子" },
  },
  {
    id: "cl3",
    targetTable: "properties",
    targetId: "p1",
    fieldName: "caseStatus",
    oldValue: "new_case",
    newValue: "site_checked",
    source: "manual",
    changedAt: "2026-02-10T14:00:00Z",
    changer: { id: "u3", name: "鈴木一郎" },
  },
  {
    id: "cl4",
    targetTable: "properties",
    targetId: "p1",
    fieldName: "caseStatus",
    oldValue: "site_checked",
    newValue: "dm_target",
    source: "manual",
    changedAt: "2026-03-18T09:30:00Z",
    changer: { id: "u1", name: "田中太郎" },
  },
];

// ---------- Candidates ----------

export const MOCK_CANDIDATES = [
  {
    id: "p2",
    address: "東京都千代田区丸の内1-1-2",
    lotNumber: "1番2",
    realEstateNumber: "1300012345679",
    propertyType: "building",
    caseStatus: "site_checked",
    distance: 12.5,
    strength: "strong",
    matchType: "gps",
    similarity: 0.75,
  },
  {
    id: "p6",
    address: "東京都千代田区丸の内一丁目1番3号",
    lotNumber: "1番3",
    realEstateNumber: null,
    propertyType: "land",
    caseStatus: "new_case",
    distance: null,
    strength: "medium",
    matchType: "address",
    similarity: 0.85,
  },
];

// ---------- Quality Issues ----------

export const MOCK_QUALITY_ISSUES: Array<{ propertyId: string; address: string; severity: "error" | "warning" | "info"; code: string; message: string }> = [
  { propertyId: "p3", address: "神奈川県横浜市中区本町1-3", severity: "error", code: "REGISTRY_NOT_OBTAINED", message: "登記が未取得のまま30日以上経過しています" },
  { propertyId: "p2", address: "東京都新宿区西新宿2-8-1", severity: "warning", code: "INVESTIGATION_NOT_CONFIRMED", message: "調査情報が未確認です" },
  { propertyId: "p3", address: "神奈川県横浜市中区本町1-3", severity: "warning", code: "NO_OWNER", message: "所有者が紐付けられていません" },
  { propertyId: "p3", address: "神奈川県横浜市中区本町1-3", severity: "warning", code: "NO_ASSIGNEE", message: "担当者が未設定です" },
  { propertyId: "p3", address: "神奈川県横浜市中区本町1-3", severity: "warning", code: "INVESTIGATION_NOT_CONFIRMED", message: "調査情報が未確認です" },
  { propertyId: "p5", address: "愛知県名古屋市中区栄4-1-1", severity: "info", code: "NO_LOT_NUMBER", message: "地番が未入力です" },
  { propertyId: "p5", address: "愛知県名古屋市中区栄4-1-1", severity: "info", code: "NO_REAL_ESTATE_NUMBER", message: "不動産番号が未入力です" },
  { propertyId: "p5", address: "愛知県名古屋市中区栄4-1-1", severity: "warning", code: "NO_OWNER", message: "所有者が紐付けられていません" },
  { propertyId: "p5", address: "愛知県名古屋市中区栄4-1-1", severity: "warning", code: "INVESTIGATION_NOT_CONFIRMED", message: "調査情報が未確認です" },
];

// ---------- Import Jobs ----------

export const MOCK_IMPORT_JOBS = [
  {
    id: "ij1",
    jobType: "property_csv",
    fileName: "物件一覧_2026Q1.csv",
    status: "completed",
    totalRows: 25,
    successCount: 23,
    errorCount: 2,
    createdAt: "2026-03-10T09:00:00Z",
    executor: { id: "u2", name: "佐藤花子" },
    _count: { rows: 25 },
  },
  {
    id: "ij2",
    jobType: "property_pdf",
    fileName: "謄本_丸の内.pdf",
    status: "completed",
    totalRows: 1,
    successCount: 1,
    errorCount: 0,
    createdAt: "2026-03-15T14:00:00Z",
    executor: { id: "u1", name: "田中太郎" },
    _count: { rows: 1 },
  },
];

// ---------- Photos ----------

export const MOCK_PHOTOS = [
  { id: "ph1", url: "/mock/photo1.jpg", caption: "正面外観", sortOrder: 0, createdAt: "2026-03-15T10:35:00Z", propertyId: "p1" },
  { id: "ph2", url: "/mock/photo2.jpg", caption: "道路側", sortOrder: 1, createdAt: "2026-03-15T10:36:00Z", propertyId: "p1" },
  { id: "ph3", url: "/mock/photo3.jpg", caption: "裏手", sortOrder: 2, createdAt: "2026-03-15T10:37:00Z", propertyId: "p1" },
  { id: "ph4", url: "/mock/photo4.jpg", caption: "周辺環境", sortOrder: 3, createdAt: "2026-03-16T09:00:00Z", propertyId: "p2" },
];

// ---------- Investigation Results (mock external data fetch) ----------

export const MOCK_INVESTIGATION_RESULTS: Record<string, {
  status: "idle" | "fetching" | "done" | "error";
  fetchedAt: string | null;
  data: Record<string, string | number | null>;
  source: string;
}> = {
  p1: {
    status: "done",
    fetchedAt: "2026-02-10T14:00:00Z",
    data: {
      zoningDistrict: "商業地域",
      buildingCoverageRatio: 80,
      floorAreaRatio: 600,
      firePreventionZone: "防火地域",
      roadType: "公道",
      roadWidth: 12.0,
      rosenkaValue: 1500000,
      rosenkaYear: 2025,
    },
    source: "国土数値情報API",
  },
  p2: {
    status: "done",
    fetchedAt: "2026-03-01T09:00:00Z",
    data: {
      zoningDistrict: "商業地域",
      buildingCoverageRatio: 80,
      floorAreaRatio: 500,
      firePreventionZone: "準防火地域",
      roadType: "公道",
      roadWidth: 8.0,
      rosenkaValue: 2200000,
      rosenkaYear: 2025,
    },
    source: "国土数値情報API",
  },
  p3: {
    status: "idle",
    fetchedAt: null,
    data: {},
    source: "",
  },
};

// ---------- Audit Logs ----------

export const MOCK_AUDIT_LOGS = [
  { id: "al1", action: "create", targetTable: "properties", targetId: "p1", detail: { address: "東京都千代田区丸の内1-1-1" }, createdAt: "2026-01-15T09:00:00Z", user: { id: "u1", name: "田中太郎" } },
  { id: "al2", action: "update", targetTable: "properties", targetId: "p1", detail: { updatedFields: ["registryStatus"] }, createdAt: "2026-02-15T11:00:00Z", user: { id: "u2", name: "佐藤花子" } },
  { id: "al3", action: "csv_import", targetTable: "import_jobs", targetId: "ij1", detail: { fileName: "物件一覧_2026Q1.csv", successCount: 23 }, createdAt: "2026-03-10T09:00:00Z", user: { id: "u2", name: "佐藤花子" } },
  { id: "al4", action: "property_view", targetTable: "properties", targetId: "p1", detail: null, createdAt: "2026-03-20T10:00:00Z", user: { id: "u3", name: "鈴木一郎" } },
];
