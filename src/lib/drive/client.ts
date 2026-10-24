/**
 * Google ドライブ API(v3)の薄い包み(第2段)。REST を fetch で直接呼ぶ(npm の部品なし)。
 * ⚠ファイル名・フォルダ名は所有者名を含み得る=例外のメッセージに名前を入れない。
 */

export const FOLDER_MIME = "application/vnd.google-apps.folder";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

export class DriveApiError extends Error {
  readonly status: number;
  readonly needsReconnect: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DriveApiError";
    this.status = status;
    this.needsReconnect = status === 401;
  }
}

export type DriveFolderSummary = { id: string; name: string; ownedByMe: boolean; ownerEmail: string | null };
export type DriveFolderDetail = { id: string; name: string; parents: string[]; trashed: boolean; webViewLink: string | null };

/** Drive の検索式の文字列の中で ' と \ を逃がす。 */
export function escapeDriveQueryValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

type RawFile = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  trashed?: boolean;
  ownedByMe?: boolean;
  owners?: { emailAddress?: string }[];
  webViewLink?: string;
};

/** フォルダの中身1つ。appSource=アプリが置いた写しの目印(appProperties.pmSource)。 */
export type DriveItem = {
  id: string;
  name: string;
  mimeType: string;
  md5: string | null;
  size: number | null;
  modifiedTime: string | null;
  appSource: string | null;
  /** アプリが置いた写しの元の添付 id(appProperties.pmAttachmentId)。 */
  appAttachmentId?: string | null;
};

type RawItem = {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  size?: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
};

export class DriveClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async getJson<T>(path: string, params: Record<string, string>): Promise<T | null> {
    const u = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const res = await this.fetchFn(u.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new DriveApiError(res.status, `Google ドライブの API が ${res.status} を返しました`);
    return (await res.json()) as T;
  }

  async about(): Promise<{ emailAddress: string }> {
    const j = await this.getJson<{ user?: { emailAddress?: string } }>("/about", { fields: "user(emailAddress)" });
    return { emailAddress: j?.user?.emailAddress ?? "" };
  }

  /** フォルダの一覧。parent="root"(マイドライブ直下)|"shared"(共有されたもの)|フォルダ id。 */
  async listFolders(args: {
    parent: string;
    nameContains?: string;
    pageToken?: string;
  }): Promise<{ folders: DriveFolderSummary[]; nextPageToken: string | null }> {
    const where: string[] = [`mimeType = '${FOLDER_MIME}'`, "trashed = false"];
    if (args.parent === "shared") where.push("sharedWithMe = true");
    else where.push(`'${escapeDriveQueryValue(args.parent)}' in parents`);
    if (args.nameContains && args.nameContains.trim() !== "") {
      where.push(`name contains '${escapeDriveQueryValue(args.nameContains.trim())}'`);
    }
    const j = await this.getJson<{ files?: RawFile[]; nextPageToken?: string }>("/files", {
      q: where.join(" and "),
      fields: "nextPageToken,files(id,name,mimeType,ownedByMe,owners(emailAddress))",
      orderBy: "name",
      pageSize: "100",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      ...(args.pageToken ? { pageToken: args.pageToken } : {}),
    });
    return {
      folders: (j?.files ?? []).map((f) => ({
        id: f.id,
        name: f.name,
        ownedByMe: f.ownedByMe === true,
        ownerEmail: f.owners?.[0]?.emailAddress ?? null,
      })),
      nextPageToken: j?.nextPageToken ?? null,
    };
  }

  /** フォルダ1つ。無い/フォルダでない → null。 */
  async getFolder(id: string): Promise<DriveFolderDetail | null> {
    const f = await this.getJson<RawFile>(`/files/${encodeURIComponent(id)}`, {
      fields: "id,name,mimeType,parents,trashed,webViewLink",
      supportsAllDrives: "true",
    });
    if (!f || f.mimeType !== FOLDER_MIME) return null;
    return { id: f.id, name: f.name, parents: f.parents ?? [], trashed: f.trashed === true, webViewLink: f.webViewLink ?? null };
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const res = await this.fetchFn(url, {
      ...init,
      headers: { Authorization: `Bearer ${this.accessToken}`, ...(init.headers as Record<string, string> | undefined) },
    });
    if (!res.ok) throw new DriveApiError(res.status, `Google ドライブの API が ${res.status} を返しました`);
    return res;
  }

  /** フォルダの中身(フォルダもファイルも・ゴミ箱を除く・全ページ)。 */
  async listChildren(folderId: string): Promise<DriveItem[]> {
    const out: DriveItem[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 50; page++) {
      const j = await this.getJson<{ files?: RawItem[]; nextPageToken?: string }>("/files", {
        q: `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`,
        fields: "nextPageToken,files(id,name,mimeType,md5Checksum,size,modifiedTime,appProperties)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      });
      for (const f of j?.files ?? []) {
        out.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          md5: f.md5Checksum ?? null,
          size: f.size !== undefined && /^\d+$/.test(f.size) ? Number(f.size) : null,
          modifiedTime: f.modifiedTime ?? null,
          appSource: f.appProperties?.pmSource ?? null,
          appAttachmentId: f.appProperties?.pmAttachmentId ?? null,
        });
      }
      pageToken = j?.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  /** ファイルの中身。 */
  async download(fileId: string): Promise<Buffer> {
    const u = new URL(`${API}/files/${encodeURIComponent(fileId)}`);
    u.searchParams.set("alt", "media");
    u.searchParams.set("supportsAllDrives", "true");
    const res = await this.send(u.toString(), { method: "GET" });
    return Buffer.from(await res.arrayBuffer());
  }

  /** 親の下にフォルダを作る。 */
  async createFolder(parentId: string, name: string): Promise<string> {
    const u = new URL(`${API}/files`);
    u.searchParams.set("supportsAllDrives", "true");
    u.searchParams.set("fields", "id");
    const res = await this.send(u.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    return ((await res.json()) as { id: string }).id;
  }

  /**
   * ファイルを置く(再開型=20MB まで1回で送る)。1回目で名前・親・目印を送り、戻り先へ中身を PUT。
   * ⚠戻り先が Google の upload 口でなければ中身を送らない(トークンを他所へ出さない)。
   */
  async uploadFile(args: {
    parentId: string;
    name: string;
    mimeType: string;
    body: Buffer;
    appProperties: Record<string, string>;
  }): Promise<{ id: string; md5: string | null }> {
    const u = new URL(`${UPLOAD_API}/files`);
    u.searchParams.set("uploadType", "resumable");
    u.searchParams.set("supportsAllDrives", "true");
    u.searchParams.set("fields", "id,md5Checksum");
    const start = await this.send(u.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": args.mimeType },
      body: JSON.stringify({
        name: args.name,
        parents: [args.parentId],
        mimeType: args.mimeType,
        appProperties: args.appProperties,
      }),
    });
    const location = start.headers.get("location");
    if (!location || !location.startsWith(`${UPLOAD_API}/`)) {
      throw new DriveApiError(502, "Google ドライブの置き場所の応答が正しくありません");
    }
    const res = await this.send(location, {
      method: "PUT",
      headers: { "Content-Type": args.mimeType },
      body: new Uint8Array(args.body),
    });
    const j = (await res.json()) as { id: string; md5Checksum?: string };
    return { id: j.id, md5: j.md5Checksum ?? null };
  }

  /** 名前だけを付け直す(アプリが置いた写しにだけ使う)。 */
  async rename(fileId: string, name: string): Promise<void> {
    const u = new URL(`${API}/files/${encodeURIComponent(fileId)}`);
    u.searchParams.set("supportsAllDrives", "true");
    u.searchParams.set("fields", "id");
    await this.send(u.toString(), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  }

  /** 「親 › 子」の形の道(最大4段・マイドライブの根は含めない)。 */
  async folderPath(id: string): Promise<string> {
    const names: string[] = [];
    let cur: string | null = id;
    for (let depth = 0; cur && depth < 4; depth++) {
      const f: DriveFolderDetail | null = await this.getFolder(cur);
      if (!f) break;
      if (f.parents.length === 0) break; // 根(マイドライブ)は名前に含めない
      names.unshift(f.name);
      cur = f.parents[0] ?? null;
    }
    return names.join(" › ");
  }
}
