import { PrismaClient } from "../src/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashSync } from "bcryptjs";

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/property_management";
const adapter = new PrismaPg(connectionString);
const prisma = new PrismaClient({ adapter });

const isProd = process.env.NODE_ENV === "production";

async function main() {
  console.log(`🌱 Seeding database... (NODE_ENV=${process.env.NODE_ENV ?? "development"})`);

  // ============================================================
  // 1. システム設定 (候補距離閾値) ← 本番・開発 共通
  // ============================================================
  const settings = [
    { key: "match_threshold_strong", value: "20", label: "強候補 距離閾値 (m)" },
    { key: "match_threshold_medium", value: "30", label: "中候補 距離閾値 (m)" },
    { key: "match_threshold_weak", value: "50", label: "弱候補 距離閾値 (m)" },
    { key: "session_timeout_minutes", value: "30", label: "セッションタイムアウト (分)" },
    { key: "login_max_attempts", value: "5", label: "ログイン最大試行回数" },
    { key: "login_lock_duration_minutes", value: "30", label: "アカウントロック時間 (分)" },
    { key: "max_attachment_size_bytes", value: "8388608", label: "添付ファイル上限 (bytes)" },
    { key: "audit_log_retention_years", value: "3", label: "監査ログ保持期間 (年)" },
  ];

  for (const s of settings) {
    await prisma.systemSetting.upsert({
      where: { key: s.key },
      update: { value: s.value, label: s.label },
      create: s,
    });
  }
  console.log("  ✓ システム設定");

  // ============================================================
  // 2. マスタコード ← 本番・開発 共通
  // ============================================================
  const masterCodes = [
    // 道路種別
    { type: "road_type", value: "national", label: "国道", sortOrder: 1 },
    { type: "road_type", value: "prefectural", label: "県道", sortOrder: 2 },
    { type: "road_type", value: "municipal", label: "市道", sortOrder: 3 },
    { type: "road_type", value: "private", label: "私道", sortOrder: 4 },
    { type: "road_type", value: "42_2", label: "建基法42条2項道路", sortOrder: 5 },
    { type: "road_type", value: "43", label: "建基法43条但書", sortOrder: 6 },
    // 用途地域
    { type: "zoning", value: "category1_low_rise", label: "第一種低層住居専用地域", sortOrder: 1 },
    { type: "zoning", value: "category2_low_rise", label: "第二種低層住居専用地域", sortOrder: 2 },
    { type: "zoning", value: "category1_mid_rise", label: "第一種中高層住居専用地域", sortOrder: 3 },
    { type: "zoning", value: "category2_mid_rise", label: "第二種中高層住居専用地域", sortOrder: 4 },
    { type: "zoning", value: "category1_residential", label: "第一種住居地域", sortOrder: 5 },
    { type: "zoning", value: "category2_residential", label: "第二種住居地域", sortOrder: 6 },
    { type: "zoning", value: "commercial", label: "商業地域", sortOrder: 7 },
    { type: "zoning", value: "industrial", label: "工業地域", sortOrder: 8 },
    // 調査情報取得元
    { type: "investigation_source", value: "city_planning_api", label: "都市計画API", sortOrder: 1 },
    { type: "investigation_source", value: "rosenka_api", label: "路線価API", sortOrder: 2 },
    { type: "investigation_source", value: "manual", label: "手動入力", sortOrder: 3 },
    // 添付ファイル種別
    { type: "attachment_type", value: "registry_certificate", label: "登記簿謄本", sortOrder: 1 },
    { type: "attachment_type", value: "public_map", label: "公図", sortOrder: 2 },
    { type: "attachment_type", value: "appraisal", label: "査定書", sortOrder: 3 },
    { type: "attachment_type", value: "site_photo", label: "現地写真", sortOrder: 4 },
    { type: "attachment_type", value: "other", label: "その他", sortOrder: 99 },
    // 次回対応種別
    { type: "next_action_type", value: "phone", label: "電話", sortOrder: 1 },
    { type: "next_action_type", value: "visit", label: "訪問", sortOrder: 2 },
    { type: "next_action_type", value: "mail", label: "書面送付", sortOrder: 3 },
    { type: "next_action_type", value: "internal", label: "社内確認", sortOrder: 4 },
  ];

  for (const mc of masterCodes) {
    await prisma.masterCode.upsert({
      where: { type_value: { type: mc.type, value: mc.value } },
      update: { label: mc.label, sortOrder: mc.sortOrder },
      create: mc,
    });
  }
  console.log("  ✓ マスタコード");

  // ============================================================
  // 3. 権限テンプレート ← 本番・開発 共通
  // ============================================================
  const fieldStaffTemplate = await prisma.permissionTemplate.upsert({
    where: { name: "現地担当用" },
    update: {},
    create: {
      name: "現地担当用",
      description: "現地担当 (field_staff) 向けデフォルトテンプレート",
      isDefault: true,
      permissions: {
        property: { read: true, write: true, delete: false },
        owner: { read: true, write: false, delete: false },
        owner_name: { full: true },
        owner_name_kana: { full: true },
        owner_phone: { masked: true },
        owner_zip: { masked: true },
        owner_address: { partial: true },
        owner_note: { hidden: true },
        owner_email: { masked: true },
        csv_export: { read: false },
        csv_export_personal: { read: false },
        import: { read: false, write: false },
        user_management: { read: false, write: false },
        audit_log: { read: false },
      },
    },
  });

  const officeStaffTemplate = await prisma.permissionTemplate.upsert({
    where: { name: "事務担当用" },
    update: {},
    create: {
      name: "事務担当用",
      description: "事務担当 (office_staff) 向けデフォルトテンプレート",
      isDefault: true,
      permissions: {
        property: { read: true, write: true, delete: false },
        owner: { read: true, write: true, delete: false },
        owner_name: { full: true },
        owner_name_kana: { full: true },
        owner_phone: { full: true },
        owner_zip: { full: true },
        owner_address: { full: true },
        owner_note: { read: true },
        owner_email: { full: true },
        csv_export: { read: true },
        csv_export_personal: { read: false },
        import: { read: true, write: true },
        user_management: { read: false, write: false },
        audit_log: { read: false },
      },
    },
  });

  const adminTemplate = await prisma.permissionTemplate.upsert({
    where: { name: "管理者用" },
    update: {},
    create: {
      name: "管理者用",
      description: "管理者 (admin) 向けデフォルトテンプレート",
      isDefault: true,
      permissions: {
        property: { read: true, write: true, delete: true },
        owner: { read: true, write: true, delete: true },
        owner_name: { full: true },
        owner_name_kana: { full: true },
        owner_phone: { full: true },
        owner_zip: { full: true },
        owner_address: { full: true },
        owner_note: { edit: true },
        owner_email: { full: true },
        csv_export: { read: true },
        csv_export_personal: { read: true },
        import: { read: true, write: true },
        user_management: { read: true, write: true },
        audit_log: { read: true },
      },
    },
  });

  console.log("  ✓ 権限テンプレート");

  // ============================================================
  // 4. テンプレート権限エントリ (正規化テーブル) ← 本番・開発 共通
  // ============================================================
  const templateEntries = [
    // 現地担当
    { templateId: fieldStaffTemplate.id, resource: "property", action: "read", granted: true },
    { templateId: fieldStaffTemplate.id, resource: "property", action: "write", granted: true },
    { templateId: fieldStaffTemplate.id, resource: "owner", action: "read", granted: true },
    { templateId: fieldStaffTemplate.id, resource: "owner_name", action: "full", granted: true },
    { templateId: fieldStaffTemplate.id, resource: "owner_name_kana", action: "full", granted: true },
    { templateId: fieldStaffTemplate.id, resource: "owner_phone", action: "masked", granted: true },
    { templateId: fieldStaffTemplate.id, resource: "owner_zip", action: "masked", granted: true },
    { templateId: fieldStaffTemplate.id, resource: "owner_address", action: "partial", granted: true },
    { templateId: fieldStaffTemplate.id, resource: "owner_email", action: "masked", granted: true },
    // owner_note: not granted → hidden
    // 事務担当
    { templateId: officeStaffTemplate.id, resource: "property", action: "read", granted: true },
    { templateId: officeStaffTemplate.id, resource: "property", action: "write", granted: true },
    { templateId: officeStaffTemplate.id, resource: "owner", action: "read", granted: true },
    { templateId: officeStaffTemplate.id, resource: "owner", action: "write", granted: true },
    { templateId: officeStaffTemplate.id, resource: "owner_name", action: "full", granted: true },
    { templateId: officeStaffTemplate.id, resource: "owner_name_kana", action: "full", granted: true },
    { templateId: officeStaffTemplate.id, resource: "owner_phone", action: "full", granted: true },
    { templateId: officeStaffTemplate.id, resource: "owner_zip", action: "full", granted: true },
    { templateId: officeStaffTemplate.id, resource: "owner_address", action: "full", granted: true },
    { templateId: officeStaffTemplate.id, resource: "owner_note", action: "read", granted: true },
    { templateId: officeStaffTemplate.id, resource: "owner_email", action: "full", granted: true },
    { templateId: officeStaffTemplate.id, resource: "csv_export", action: "read", granted: true },
    { templateId: officeStaffTemplate.id, resource: "import", action: "write", granted: true },
    // 管理者
    { templateId: adminTemplate.id, resource: "property", action: "read", granted: true },
    { templateId: adminTemplate.id, resource: "property", action: "write", granted: true },
    { templateId: adminTemplate.id, resource: "property", action: "delete", granted: true },
    { templateId: adminTemplate.id, resource: "owner", action: "read", granted: true },
    { templateId: adminTemplate.id, resource: "owner", action: "write", granted: true },
    { templateId: adminTemplate.id, resource: "owner", action: "delete", granted: true },
    { templateId: adminTemplate.id, resource: "owner_name", action: "full", granted: true },
    { templateId: adminTemplate.id, resource: "owner_name_kana", action: "full", granted: true },
    { templateId: adminTemplate.id, resource: "owner_phone", action: "full", granted: true },
    { templateId: adminTemplate.id, resource: "owner_zip", action: "full", granted: true },
    { templateId: adminTemplate.id, resource: "owner_address", action: "full", granted: true },
    { templateId: adminTemplate.id, resource: "owner_note", action: "edit", granted: true },
    { templateId: adminTemplate.id, resource: "owner_email", action: "full", granted: true },
    { templateId: adminTemplate.id, resource: "csv_export", action: "read", granted: true },
    { templateId: adminTemplate.id, resource: "csv_export_personal", action: "read", granted: true },
    { templateId: adminTemplate.id, resource: "import", action: "write", granted: true },
    { templateId: adminTemplate.id, resource: "user_management", action: "read", granted: true },
    { templateId: adminTemplate.id, resource: "user_management", action: "write", granted: true },
    { templateId: adminTemplate.id, resource: "audit_log", action: "read", granted: true },
  ];

  for (const entry of templateEntries) {
    await prisma.templatePermission.upsert({
      where: {
        templateId_resource_action: {
          templateId: entry.templateId,
          resource: entry.resource,
          action: entry.action,
        },
      },
      update: { granted: entry.granted },
      create: entry,
    });
  }
  console.log("  ✓ テンプレート権限エントリ");

  // ============================================================
  // 5. ユーザー
  //    - 本番 (NODE_ENV=production):
  //        ADMIN_EMAIL + ADMIN_INITIAL_PASSWORD が両方設定されている場合のみ
  //        管理者1名を mustChangePassword=true で作成。
  //        未設定の場合はスキップ（手動で INSERT すること）。
  //    - 開発 (それ以外):
  //        テスト用3ユーザーを password123 で作成。
  // ============================================================
  if (isProd) {
    const adminEmail = process.env.ADMIN_EMAIL?.trim();
    const adminInitialPassword = process.env.ADMIN_INITIAL_PASSWORD?.trim();

    if (adminEmail && adminInitialPassword) {
      if (adminInitialPassword.length < 12) {
        throw new Error(
          "ADMIN_INITIAL_PASSWORD は12文字以上にしてください。"
        );
      }
      const hash = hashSync(adminInitialPassword, 12);
      await prisma.user.upsert({
        where: { email: adminEmail },
        update: {},
        create: {
          email: adminEmail,
          name: "管理者",
          passwordHash: hash,
          role: "admin",
          mustChangePassword: true, // 初回ログイン時にパスワード変更を強制
          isActive: true,
        },
      });
      console.log(`  ✓ 管理者ユーザー作成: ${adminEmail} (mustChangePassword=true)`);
      console.log("  ⚠ 初回ログイン後、必ずパスワードを変更してください。");
    } else {
      console.log("  ℹ ADMIN_EMAIL / ADMIN_INITIAL_PASSWORD 未設定 → ユーザー作成スキップ");
      console.log("    本番管理者ユーザーは手動で作成してください。(docs/deploy.md 参照)");
    }
  } else {
    // 開発用テストユーザー
    const devPasswordHash = hashSync("password123", 10);

    const adminUser = await prisma.user.upsert({
      where: { email: "admin@example.com" },
      update: {},
      create: {
        email: "admin@example.com",
        name: "管理太郎",
        passwordHash: devPasswordHash,
        role: "admin",
        mustChangePassword: false,
        isActive: true,
      },
    });

    const officeUser = await prisma.user.upsert({
      where: { email: "office@example.com" },
      update: {},
      create: {
        email: "office@example.com",
        name: "事務花子",
        passwordHash: devPasswordHash,
        role: "office_staff",
        mustChangePassword: false,
        isActive: true,
      },
    });

    const fieldUser = await prisma.user.upsert({
      where: { email: "field@example.com" },
      update: {},
      create: {
        email: "field@example.com",
        name: "現地一郎",
        passwordHash: devPasswordHash,
        role: "field_staff",
        mustChangePassword: false,
        isActive: true,
      },
    });

    console.log("  ✓ 開発用ユーザー (admin@example.com / office@example.com / field@example.com)");
    console.log("    パスワード: password123");

    // ============================================================
    // 6. サンプル物件 ← 開発のみ
    // ============================================================
    const properties = [
      {
        propertyType: "land" as const,
        address: "東京都千代田区丸の内1-1-1",
        lotNumber: "1-1",
        realEstateNumber: "1300000001234",
        registryStatus: "obtained" as const,
        dmStatus: "send" as const,
        caseStatus: "dm_sent" as const,
        gpsLat: 35.6812,
        gpsLng: 139.7671,
        zoningDistrict: "商業地域",
        rosenkaValue: 45000000,
        rosenkaYear: 2025,
        createdBy: adminUser.id,
        assignedTo: officeUser.id,
        externalLinkKey: "PROP-001",
      },
      {
        propertyType: "building" as const,
        address: "東京都新宿区西新宿2-8-1",
        lotNumber: "2-8",
        buildingNumber: "101",
        registryStatus: "scheduled" as const,
        dmStatus: "hold" as const,
        caseStatus: "waiting_registry" as const,
        gpsLat: 35.6896,
        gpsLng: 139.6917,
        createdBy: officeUser.id,
        assignedTo: fieldUser.id,
        externalLinkKey: "PROP-002",
      },
      {
        propertyType: "land" as const,
        address: "神奈川県横浜市中区山下町1",
        lotNumber: "1",
        realEstateNumber: "1400000005678",
        registryStatus: "unconfirmed" as const,
        dmStatus: "no_send" as const,
        caseStatus: "new_case" as const,
        gpsLat: 35.4437,
        gpsLng: 139.6500,
        createdBy: fieldUser.id,
        externalLinkKey: "PROP-003",
      },
      {
        propertyType: "unknown" as const,
        address: "千葉県千葉市中央区中央1-1-1",
        registryStatus: "unconfirmed" as const,
        dmStatus: "hold" as const,
        caseStatus: "site_checked" as const,
        createdBy: fieldUser.id,
        assignedTo: fieldUser.id,
        externalLinkKey: "PROP-004",
      },
      {
        propertyType: "building" as const,
        address: "埼玉県さいたま市大宮区桜木町1-7-5",
        lotNumber: "1-7",
        buildingNumber: "201",
        realEstateNumber: "1100000009012",
        registryStatus: "obtained" as const,
        dmStatus: "send" as const,
        caseStatus: "done" as const,
        gpsLat: 35.9062,
        gpsLng: 139.6240,
        rebuildPermission: "yes" as const,
        roadType: "市道",
        roadWidth: 6.0,
        createdBy: adminUser.id,
        externalLinkKey: "PROP-005",
      },
    ];

    const createdProperties = [];
    for (const p of properties) {
      const prop = await prisma.property.create({ data: p });
      createdProperties.push(prop);
    }
    console.log("  ✓ サンプル物件 (5件)");

    // ============================================================
    // 7. サンプル所有者 ← 開発のみ
    // ============================================================
    const owners = [
      {
        name: "山田太郎",
        nameKana: "ヤマダタロウ",
        phone: "090-1234-5678",
        zip: "100-0001",
        address: "東京都千代田区千代田1-1",
        externalLinkKey: "OWN-001",
      },
      {
        name: "佐藤花子",
        nameKana: "サトウハナコ",
        phone: "080-9876-5432",
        zip: "160-0023",
        address: "東京都新宿区西新宿2-8-1-101",
        externalLinkKey: "OWN-002",
      },
      {
        name: "田中一郎",
        nameKana: "タナカイチロウ",
        phone: "03-1234-5678",
        zip: "231-0023",
        address: "神奈川県横浜市中区山下町1-2-3",
        note: "連絡は午前中希望",
        externalLinkKey: "OWN-003",
      },
    ];

    const createdOwners = [];
    for (const o of owners) {
      const owner = await prisma.owner.create({ data: o });
      createdOwners.push(owner);
    }
    console.log("  ✓ サンプル所有者 (3名)");

    // ============================================================
    // 8. 物件↔所有者の紐付け ← 開発のみ
    // ============================================================
    await prisma.propertyOwner.createMany({
      data: [
        { propertyId: createdProperties[0].id, ownerId: createdOwners[0].id, relationship: "所有者" },
        { propertyId: createdProperties[1].id, ownerId: createdOwners[1].id, relationship: "所有者" },
        { propertyId: createdProperties[2].id, ownerId: createdOwners[2].id, relationship: "所有者" },
        { propertyId: createdProperties[0].id, ownerId: createdOwners[2].id, relationship: "共有者" },
      ],
    });
    console.log("  ✓ 物件↔所有者紐付け");
  }

  console.log("\n✅ Seed completed successfully!");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
