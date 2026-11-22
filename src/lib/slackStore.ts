import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SERVER_SLACK_COLLECTION = 'server_slack_connections';
const TOKEN_CIPHER_PREFIX = 'enc:v1:aes256gcm:';
const DEFAULT_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'your-firebase-project-id';
const DEFAULT_DATABASE_ID = '(default)';
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

export type SlackStorageBackend = 'firestore' | 'memory';

function deriveTokenEncryptionKey(): Buffer {
  const configured =
    process.env.EDGEOPS_TOKEN_ENCRYPTION_KEY?.trim() ||
    process.env.SLACK_CLIENT_SECRET?.trim() ||
    `${process.env.GOOGLE_CLOUD_PROJECT?.trim() || DEFAULT_PROJECT_ID}:edgeops-token-envelope-v1`;
  return crypto.createHash('sha256').update(configured, 'utf8').digest();
}

export function isEncryptedTokenValue(value: string): boolean {
  return value.startsWith(TOKEN_CIPHER_PREFIX);
}

/**
 * Encrypts a Slack OAuth token at rest using AES-256-GCM bound to the tenant's orgId (AAD).
 */
export function encryptTokenForOrg(orgId: string, plaintext: string): string {
  const clean = plaintext.trim();
  if (!clean) return '';
  if (isEncryptedTokenValue(clean)) return clean;

  const key = deriveTokenEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`edgeops:v1:${sanitizeOrgIdForStore(orgId)}`, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(clean, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${TOKEN_CIPHER_PREFIX}${iv.toString('base64url')}.${authTag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

/**
 * Decrypts an AES-256-GCM encrypted Slack token. Transparently supports legacy plaintext `xoxb-`
 * records on read so existing live Cloud Run deployments migrate without downtime.
 */
export function decryptTokenForOrg(orgId: string, storedValue: string): string {
  const clean = storedValue.trim();
  if (!clean) return '';
  if (!isEncryptedTokenValue(clean)) {
    return clean;
  }

  const body = clean.slice(TOKEN_CIPHER_PREFIX.length);
  const parts = body.split('.');
  if (parts.length !== 3) return '';
  const [ivB64, tagB64, cipherB64] = parts;
  try {
    const key = deriveTokenEncryptionKey();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivB64, 'base64url')
    );
    decipher.setAAD(Buffer.from(`edgeops:v1:${sanitizeOrgIdForStore(orgId)}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(cipherB64, 'base64url')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}

export interface PersistedSlackConnection {
  orgId: string;
  team: string;
  teamId?: string;
  botName: string;
  botUserId: string;
  accessToken: string;
  selectedChannelIds: string[];
  updatedAt: string;
}

export interface PublicSlackConnection {
  orgId: string;
  team: string | null;
  botName: string | null;
  botUserId: string | null;
  selectedChannelIds: string[];
  updatedAt: string | null;
}

export interface FirestoreTargetConfig {
  projectId: string;
  databaseId: string;
}

export interface SlackStoreHealth {
  ok: true;
  storage: SlackStorageBackend;
  tokenEncryption: 'aes-256-gcm';
  projectId: string;
  databaseId: string;
  collection: string;
  connectedWorkspaces: number;
  latestOrgId: string | null;
}

interface FirestoreStringValue {
  stringValue?: string;
  timestampValue?: string;
}

interface FirestoreArrayValue {
  arrayValue?: {
    values?: Array<{ stringValue?: string }>;
  };
}

export interface FirestoreRestDocument {
  name?: string;
  fields?: Record<string, FirestoreStringValue & FirestoreArrayValue>;
}

export function sanitizeOrgIdForStore(raw: unknown): string {
  if (typeof raw !== 'string') return 'org_workspace';
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
  return cleaned || 'org_workspace';
}

export function isWildcardOrgId(raw: unknown): boolean {
  if (typeof raw !== 'string') return true;
  const normalized = raw.trim().toLowerCase();
  return !normalized || normalized === 'default' || normalized === 'latest';
}

export function resolveFirestoreTarget(configPath?: string): FirestoreTargetConfig {
  const candidatePath = configPath || path.resolve(process.cwd(), 'firebase-applet-config.json');
  let projectId = '';
  let databaseId = '';

  try {
    if (fs.existsSync(candidatePath)) {
      const parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8')) as {
        projectId?: string;
        firestoreDatabaseId?: string;
      };
      if (typeof parsed.projectId === 'string' && parsed.projectId.trim()) {
        projectId = parsed.projectId.trim();
      }
      if (typeof parsed.firestoreDatabaseId === 'string' && parsed.firestoreDatabaseId.trim()) {
        databaseId = parsed.firestoreDatabaseId.trim();
      }
    }
  } catch {
    // Fall back to environment defaults below
  }

  return {
    projectId:
      projectId ||
      process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
      process.env.GCLOUD_PROJECT?.trim() ||
      DEFAULT_PROJECT_ID,
    databaseId: databaseId || process.env.FIRESTORE_DATABASE_ID?.trim() || DEFAULT_DATABASE_ID,
  };
}

export function buildFirestoreCollectionUrl(target: FirestoreTargetConfig): string {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    target.projectId
  )}/databases/${encodeURIComponent(target.databaseId)}/documents/${SERVER_SLACK_COLLECTION}`;
}

export function toFirestoreFields(
  conn: PersistedSlackConnection
): Record<string, FirestoreStringValue | FirestoreArrayValue> {
  const safeChannels = Array.isArray(conn.selectedChannelIds)
    ? conn.selectedChannelIds
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .slice(0, 100)
    : [];

  const safeOrgId = sanitizeOrgIdForStore(conn.orgId);

  return {
    orgId: { stringValue: safeOrgId },
    team: { stringValue: conn.team || 'Slack Workspace' },
    teamId: { stringValue: conn.teamId || '' },
    botName: { stringValue: conn.botName || '' },
    botUserId: { stringValue: conn.botUserId || '' },
    accessToken: { stringValue: encryptTokenForOrg(safeOrgId, conn.accessToken) },
    selectedChannelIds: {
      arrayValue: {
        values: safeChannels.map((id) => ({ stringValue: id })),
      },
    },
    updatedAt: { stringValue: conn.updatedAt || new Date().toISOString() },
  };
}

export function fromFirestoreDocument(
  doc: FirestoreRestDocument | null | undefined
): PersistedSlackConnection | null {
  if (!doc || !doc.fields) return null;
  const f = doc.fields;

  const docNameOrgId =
    typeof doc.name === 'string' ? doc.name.split('/').filter(Boolean).pop() || '' : '';
  const orgId = sanitizeOrgIdForStore(f.orgId?.stringValue || docNameOrgId);
  const rawStoredToken = (f.accessToken?.stringValue || '').trim();
  const accessToken = decryptTokenForOrg(orgId, rawStoredToken);
  if (!orgId || !accessToken) return null;

  const rawChannels = f.selectedChannelIds?.arrayValue?.values ?? [];
  const selectedChannelIds = rawChannels
    .map((v) => (typeof v?.stringValue === 'string' ? v.stringValue.trim() : ''))
    .filter(Boolean);

  const updatedAt =
    f.updatedAt?.stringValue || f.updatedAt?.timestampValue || new Date(0).toISOString();

  return {
    orgId,
    team: f.team?.stringValue || 'Slack Workspace',
    teamId: f.teamId?.stringValue || '',
    botName: f.botName?.stringValue || '',
    botUserId: f.botUserId?.stringValue || '',
    accessToken,
    selectedChannelIds,
    updatedAt,
  };
}

/**
 * Strips `accessToken` completely so no API response can ever leak a Slack bot token.
 */
export function toPublicSlackConnection(conn: PersistedSlackConnection): PublicSlackConnection {
  return {
    orgId: conn.orgId,
    team: conn.team || null,
    botName: conn.botName || null,
    botUserId: conn.botUserId || null,
    selectedChannelIds: [...(conn.selectedChannelIds || [])],
    updatedAt: conn.updatedAt || null,
  };
}

export interface SlackStoreOptions {
  target?: FirestoreTargetConfig;
  localFilePath?: string;
  fetchImpl?: typeof fetch;
  metadataTimeoutMs?: number;
  firestoreTimeoutMs?: number;
}

export class SlackConnectionStore {
  private readonly target: FirestoreTargetConfig;
  private readonly collectionUrl: string;
  private readonly localFilePath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly metadataTimeoutMs: number;
  private readonly firestoreTimeoutMs: number;

  private readonly cache = new Map<string, PersistedSlackConnection>();
  private storageMode: SlackStorageBackend = 'memory';
  private hydrated = false;
  private probedFirestore = false;

  private cachedAdcToken: { token: string; expiresAtMs: number } | null = null;
  private metadataUnavailableUntilMs = 0;

  constructor(options: SlackStoreOptions = {}) {
    this.target = options.target ?? resolveFirestoreTarget();
    this.collectionUrl = buildFirestoreCollectionUrl(this.target);
    this.localFilePath =
      options.localFilePath ?? path.resolve(process.cwd(), '.data', 'slack-connections.json');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.metadataTimeoutMs = options.metadataTimeoutMs ?? 1_500;
    this.firestoreTimeoutMs = options.firestoreTimeoutMs ?? 5_000;
  }

  private async getAdcAccessToken(): Promise<string | null> {
    const envToken = process.env.FIRESTORE_ACCESS_TOKEN?.trim();
    if (envToken) return envToken;

    const now = Date.now();
    if (this.cachedAdcToken && now < this.cachedAdcToken.expiresAtMs) {
      return this.cachedAdcToken.token;
    }
    if (now < this.metadataUnavailableUntilMs) {
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.metadataTimeoutMs);
    try {
      const res = await this.fetchImpl(METADATA_TOKEN_URL, {
        method: 'GET',
        headers: {
          'Metadata-Flavor': 'Google',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        this.metadataUnavailableUntilMs = now + 60_000;
        return null;
      }
      const data = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!data.access_token) {
        this.metadataUnavailableUntilMs = now + 60_000;
        return null;
      }
      const ttlMs = Math.max(60_000, ((data.expires_in ?? 3600) - 60) * 1000);
      this.cachedAdcToken = {
        token: data.access_token,
        expiresAtMs: now + ttlMs,
      };
      return data.access_token;
    } catch {
      this.metadataUnavailableUntilMs = now + 60_000;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchFirestore(
    url: string,
    init: RequestInit
  ): Promise<{ ok: boolean; status: number; json: unknown } | null> {
    const token = await this.getAdcAccessToken();
    if (!token) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.firestoreTimeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        ...init,
        headers: {
          ...(init.headers || {}),
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      if (res.status === 401 || res.status === 403) {
        // Clear cached token and avoid hitting denied Firestore repeatedly in preview/dev
        this.cachedAdcToken = null;
        this.metadataUnavailableUntilMs = Date.now() + 60_000;
        this.storageMode = 'memory';
        return null;
      }
      return { ok: res.ok, status: res.status, json };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private readLocalFallbackFile(): PersistedSlackConnection[] {
    try {
      if (!fs.existsSync(this.localFilePath)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.localFilePath, 'utf8')) as
        | Record<string, PersistedSlackConnection>
        | PersistedSlackConnection[];
      const items = Array.isArray(parsed) ? parsed : Object.values(parsed || {});
      return items
        .map((item) => {
          if (!item || typeof item.orgId !== 'string' || typeof item.accessToken !== 'string') {
            return null;
          }
          const safeOrgId = sanitizeOrgIdForStore(item.orgId);
          const decrypted = decryptTokenForOrg(safeOrgId, item.accessToken);
          if (!decrypted) return null;
          return {
            ...item,
            orgId: safeOrgId,
            accessToken: decrypted,
          };
        })
        .filter((item): item is PersistedSlackConnection => item !== null);
    } catch {
      return [];
    }
  }

  private writeLocalFallbackFile(): void {
    // Never write Slack tokens to local disk in production environments
    if (process.env.NODE_ENV === 'production') {
      return;
    }
    try {
      const dir = path.dirname(this.localFilePath);
      fs.mkdirSync(dir, { recursive: true });
      const payload: Record<string, PersistedSlackConnection> = {};
      for (const [orgId, conn] of this.cache.entries()) {
        payload[orgId] = {
          ...conn,
          accessToken: encryptTokenForOrg(orgId, conn.accessToken),
        };
      }
      const tempPath = `${this.localFilePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tempPath, this.localFilePath);
    } catch {
      // Non-fatal in read-only filesystems
    }
  }

  private getMostRecentConnection(): PersistedSlackConnection | null {
    let best: PersistedSlackConnection | null = null;
    let bestTs = -1;
    for (const conn of this.cache.values()) {
      if (!conn.accessToken) continue;
      const ts = Date.parse(conn.updatedAt || '') || 0;
      if (!best || ts >= bestTs) {
        best = conn;
        bestTs = ts;
      }
    }
    return best;
  }

  async saveConnection(input: {
    orgId: string;
    team?: string;
    teamId?: string;
    botName?: string;
    botUserId?: string;
    accessToken: string;
    selectedChannelIds?: string[];
    updatedAt?: string;
  }): Promise<PersistedSlackConnection> {
    const orgId = sanitizeOrgIdForStore(input.orgId);
    const existing = this.cache.get(orgId);
    const normalized: PersistedSlackConnection = {
      orgId,
      team: input.team?.trim() || existing?.team || 'Slack Workspace',
      teamId: input.teamId?.trim() || existing?.teamId || '',
      botName: input.botName?.trim() || existing?.botName || '',
      botUserId: input.botUserId?.trim() || existing?.botUserId || '',
      accessToken: input.accessToken.trim(),
      selectedChannelIds: Array.isArray(input.selectedChannelIds)
        ? input.selectedChannelIds
        : existing?.selectedChannelIds || [],
      updatedAt: input.updatedAt || new Date().toISOString(),
    };

    this.cache.set(orgId, normalized);
    this.hydrated = true;

    const docUrl = `${this.collectionUrl}/${encodeURIComponent(orgId)}`;
    const result = await this.fetchFirestore(docUrl, {
      method: 'PATCH',
      body: JSON.stringify({ fields: toFirestoreFields(normalized) }),
    });

    if (result && result.ok) {
      this.storageMode = 'firestore';
      this.probedFirestore = true;
    } else {
      this.storageMode = 'memory';
      this.probedFirestore = true;
      this.writeLocalFallbackFile();
    }

    return normalized;
  }

  async updateSelectedChannels(
    orgId: string,
    selectedChannelIds: string[]
  ): Promise<PersistedSlackConnection | null> {
    const existing = await this.getConnection(orgId);
    if (!existing) return null;
    return this.saveConnection({
      ...existing,
      selectedChannelIds,
      updatedAt: new Date().toISOString(),
    });
  }

  async getConnection(orgId: string): Promise<PersistedSlackConnection | null> {
    const sanitized = sanitizeOrgIdForStore(orgId);
    const cached = this.cache.get(sanitized);
    if (cached && cached.accessToken) {
      return cached;
    }

    const docUrl = `${this.collectionUrl}/${encodeURIComponent(sanitized)}`;
    const result = await this.fetchFirestore(docUrl, { method: 'GET' });
    if (result) {
      this.probedFirestore = true;
      if (result.ok) {
        this.storageMode = 'firestore';
        const parsed = fromFirestoreDocument(result.json as FirestoreRestDocument);
        if (parsed) {
          this.cache.set(parsed.orgId, parsed);
          return parsed;
        }
        return null;
      }
      if (result.status === 404) {
        this.storageMode = 'firestore';
        return null;
      }
    }

    // Local dev file fallback when Firestore ADC isn't available
    this.storageMode = 'memory';
    const localItems = this.readLocalFallbackFile();
    for (const item of localItems) {
      if (!this.cache.has(item.orgId)) {
        this.cache.set(item.orgId, item);
      }
    }
    return this.cache.get(sanitized) || null;
  }

  async hydrateAll(forceRefresh = false): Promise<PersistedSlackConnection[]> {
    if (this.hydrated && !forceRefresh && this.cache.size > 0) {
      return Array.from(this.cache.values());
    }

    const listUrl = `${this.collectionUrl}?pageSize=100`;
    const result = await this.fetchFirestore(listUrl, { method: 'GET' });
    if (result && result.ok) {
      this.storageMode = 'firestore';
      this.probedFirestore = true;
      this.hydrated = true;
      const payload = (result.json || {}) as { documents?: FirestoreRestDocument[] };
      const docs = Array.isArray(payload.documents) ? payload.documents : [];
      for (const doc of docs) {
        const parsed = fromFirestoreDocument(doc);
        if (parsed) {
          const existing = this.cache.get(parsed.orgId);
          const existingTs = existing ? Date.parse(existing.updatedAt || '') || 0 : -1;
          const remoteTs = Date.parse(parsed.updatedAt || '') || 0;
          if (!existing || remoteTs >= existingTs) {
            this.cache.set(parsed.orgId, parsed);
          }
        }
      }
      return Array.from(this.cache.values());
    }

    // Local dev file fallback
    this.storageMode = 'memory';
    this.probedFirestore = true;
    this.hydrated = true;
    const localItems = this.readLocalFallbackFile();
    for (const item of localItems) {
      if (!this.cache.has(item.orgId)) {
        this.cache.set(item.orgId, item);
      }
    }
    return Array.from(this.cache.values());
  }

  /**
   * Resolves a Slack connection for the requested orgId, auto-hydrating from Firestore
   * on Cloud Run cold start. Falls back to the most recently updated connected workspace
   * (or SLACK_BOT_TOKEN env var) when orgId is omitted/wildcard or not yet matched.
   */
  async resolveConnection(requestedOrgId?: string): Promise<PersistedSlackConnection | null> {
    if (!isWildcardOrgId(requestedOrgId)) {
      const sanitized = sanitizeOrgIdForStore(requestedOrgId);
      const exact = await this.getConnection(sanitized);
      if (exact) return exact;
    }

    if (!this.hydrated || this.cache.size === 0) {
      await this.hydrateAll(false);
    }

    const recent = this.getMostRecentConnection();
    if (recent) return recent;

    const envFallback = process.env.SLACK_BOT_TOKEN?.trim() || '';
    if (envFallback.startsWith('xoxb-')) {
      return {
        orgId: !isWildcardOrgId(requestedOrgId)
          ? sanitizeOrgIdForStore(requestedOrgId)
          : 'org_workspace',
        team: process.env.SLACK_TEAM_NAME?.trim() || 'Slack Workspace',
        botName: process.env.SLACK_BOT_NAME?.trim() || '',
        botUserId: '',
        accessToken: envFallback,
        selectedChannelIds: [],
        updatedAt: new Date().toISOString(),
      };
    }

    return null;
  }

  async getHealth(): Promise<SlackStoreHealth> {
    if (!this.probedFirestore) {
      await this.hydrateAll(true);
    }
    const latest = this.getMostRecentConnection();
    return {
      ok: true,
      storage: this.storageMode,
      tokenEncryption: 'aes-256-gcm',
      projectId: this.target.projectId,
      databaseId: this.target.databaseId,
      collection: SERVER_SLACK_COLLECTION,
      connectedWorkspaces: this.cache.size,
      latestOrgId: latest?.orgId ?? null,
    };
  }

  /** Test helper to simulate a Cloud Run cold start wiping in-memory state. */
  clearMemoryCacheForTest(): void {
    this.cache.clear();
    this.hydrated = false;
  }
}

export function createSlackConnectionStore(options?: SlackStoreOptions): SlackConnectionStore {
  return new SlackConnectionStore(options);
}
