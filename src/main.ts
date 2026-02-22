import {
  App,
  Notice,
  normalizePath,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
} from "obsidian";

const TICKTICK_OAUTH_AUTHORIZE_URL = "https://ticktick.com/oauth/authorize";
const TICKTICK_OAUTH_TOKEN_URL = "https://ticktick.com/oauth/token";
const TICKTICK_OPEN_API_BASE = "https://api.ticktick.com/open/v1";
const DEFAULT_SYNC_INTERVAL_MINUTES = 15;
const DEFAULT_OAUTH_SCOPE = "tasks:read";

interface TickTickSimpleSyncSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  oauthScope: string;
  oauthState: string;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  tokenExpiresAt: number;
  taskNotesFolder: string;
  customTag: string;
  syncIntervalMinutes: number;
}

const DEFAULT_SETTINGS: TickTickSimpleSyncSettings = {
  clientId: "",
  clientSecret: "",
  redirectUri: "",
  oauthScope: DEFAULT_OAUTH_SCOPE,
  oauthState: "",
  accessToken: "",
  refreshToken: "",
  tokenType: "Bearer",
  tokenExpiresAt: 0,
  taskNotesFolder: "/",
  customTag: "",
  syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,
};

interface TickTickTask {
  id: string;
  title: string;
  content?: string;
  startDate?: string;
  projectId?: string;
  status?: number;
}

interface TickTickProject {
  id: string;
  name: string;
  closed?: boolean;
}

interface TickTickProjectData {
  tasks?: unknown[];
}

interface OAuthTokenResponse {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
}

interface AuthorizationInput {
  code: string;
  state?: string;
}

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HttpError";
  }
}

class TickTickOAuthClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly scope: string,
  ) {}

  buildAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      scope: this.scope,
      state,
      redirect_uri: this.redirectUri,
      response_type: "code",
    });

    return `${TICKTICK_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      scope: this.scope,
      redirect_uri: this.redirectUri,
    });

    return this.requestToken(body);
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: this.scope,
      redirect_uri: this.redirectUri,
    });

    return this.requestToken(body);
  }

  private async requestToken(body: URLSearchParams): Promise<OAuthTokenResponse> {
    const basicAuth = toBasicAuth(this.clientId, this.clientSecret);
    const response = await requestUrl({
      url: TICKTICK_OAUTH_TOKEN_URL,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body: body.toString(),
    });

    if (response.status !== 200) {
      throw new HttpError(`Token request failed with status ${response.status}.`, response.status);
    }

    const parsed = response.json as unknown;
    if (!isTokenResponse(parsed)) {
      throw new Error("Token response format is invalid.");
    }

    return parsed;
  }
}

class TickTickOpenApiClient {
  constructor(private readonly accessToken: string) {}

  async getProjects(): Promise<TickTickProject[]> {
    const response = await this.requestJson("project");
    if (!Array.isArray(response)) {
      return [];
    }

    return response.filter((entry): entry is TickTickProject => isProject(entry));
  }

  async getProjectData(projectId: string): Promise<TickTickProjectData> {
    const response = await this.requestJson(`project/${encodeURIComponent(projectId)}/data`);
    if (!isObjectRecord(response)) {
      return {};
    }

    return response;
  }

  private async requestJson(path: string): Promise<unknown> {
    const response = await requestUrl({
      url: `${TICKTICK_OPEN_API_BASE}/${path}`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (response.status !== 200) {
      throw new HttpError(`Open API request failed with status ${response.status}.`, response.status);
    }

    return response.json;
  }
}

export default class TickTickSimpleSyncPlugin extends Plugin {
  settings: TickTickSimpleSyncSettings = DEFAULT_SETTINGS;

  private syncIntervalId: number | null = null;
  private syncInProgress = false;
  private authResponseInput = "";

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new TickTickSimpleSyncSettingTab(this.app, this));

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        void this.syncNow(true);
      },
    });

    this.restartSyncInterval();
    await this.syncNow(false);
  }

  onunload(): void {
    this.clearSyncInterval();
  }

  async beginOauthFlow(): Promise<void> {
    const oauthClient = this.createOauthClient();
    if (!oauthClient) {
      new Notice("Set client ID, client secret, and redirect URL first.");
      return;
    }

    const state = createOauthState();
    this.settings.oauthState = state;
    await this.saveSettings();

    const url = oauthClient.buildAuthorizationUrl(state);
    window.open(url, "_blank");
    new Notice("Authorize in browser, then paste the redirected URL below.");
  }

  async exchangeAuthInput(): Promise<void> {
    const oauthClient = this.createOauthClient();
    if (!oauthClient) {
      new Notice("Set client ID, client secret, and redirect URL first.");
      return;
    }

    const parsed = parseAuthorizationInput(this.authResponseInput);
    if (!parsed) {
      new Notice("Paste a full redirected URL or an authorization code.");
      return;
    }

    if (this.settings.oauthState && parsed.state && parsed.state !== this.settings.oauthState) {
      new Notice("State does not match. Start authorization again.");
      return;
    }

    try {
      const response = await oauthClient.exchangeCode(parsed.code);
      this.applyTokenResponse(response);
      this.settings.oauthState = "";
      this.authResponseInput = "";
      await this.saveSettings();

      new Notice("Connected.");
      await this.syncNow(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      new Notice(`Connection failed: ${message}`);
    }
  }

  async disconnectOauth(): Promise<void> {
    this.settings.accessToken = "";
    this.settings.refreshToken = "";
    this.settings.tokenType = "Bearer";
    this.settings.tokenExpiresAt = 0;
    this.settings.oauthState = "";
    this.authResponseInput = "";
    await this.saveSettings();
    new Notice("Disconnected.");
  }

  getAuthResponseInput(): string {
    return this.authResponseInput;
  }

  setAuthResponseInput(value: string): void {
    this.authResponseInput = value;
  }

  getConnectionStatusText(): string {
    if (!this.settings.accessToken) {
      return "Not connected";
    }

    if (this.settings.tokenExpiresAt <= 0) {
      return "Connected";
    }

    const secondsLeft = Math.max(0, Math.floor((this.settings.tokenExpiresAt - Date.now()) / 1000));
    if (secondsLeft === 0) {
      return "Connected, token expired";
    }

    const minutesLeft = Math.floor(secondsLeft / 60);
    return `Connected, token expires in ${minutesLeft} minute(s)`;
  }

  async syncNow(isManual: boolean): Promise<void> {
    if (this.syncInProgress) {
      return;
    }

    this.syncInProgress = true;

    try {
      const accessToken = await this.getValidAccessToken();
      if (!accessToken) {
        if (isManual) {
          new Notice("Connect first in plugin settings.");
        }
        return;
      }

      await this.importNewTasks(accessToken, isManual);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        const refreshed = await this.tryRefreshAccessToken();
        if (refreshed) {
          const refreshedToken = this.settings.accessToken;
          if (refreshedToken) {
            await this.importNewTasks(refreshedToken, isManual);
            this.syncInProgress = false;
            return;
          }
        }
      }

      const message = error instanceof Error ? error.message : "Unknown error";
      new Notice(`Sync failed: ${message}`);
    } finally {
      this.syncInProgress = false;
    }
  }

  async restartAfterIntervalChange(): Promise<void> {
    await this.saveSettings();
    this.restartSyncInterval();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async loadSettings(): Promise<void> {
    const loaded: unknown = await this.loadData();
    const parsed = parseSettings(loaded);
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
    };
  }

  private async importNewTasks(accessToken: string, isManual: boolean): Promise<void> {
    const client = new TickTickOpenApiClient(accessToken);
    const projects = await client.getProjects();

    const projectNameById = new Map<string, string>();
    const tasksById = new Map<string, TickTickTask>();

    for (const project of projects) {
      if (project.closed) {
        continue;
      }

      projectNameById.set(project.id, project.name);

      const projectData = await client.getProjectData(project.id);
      const tasks = Array.isArray(projectData.tasks)
        ? projectData.tasks.filter((entry): entry is TickTickTask => isTask(entry))
        : [];

      for (const task of tasks) {
        if (task.status !== 0) {
          continue;
        }

        if (!tasksById.has(task.id)) {
          tasksById.set(task.id, task);
        }
      }
    }

    const folderPath = normalizeFolderPath(this.settings.taskNotesFolder);
    await this.ensureFolderExists(folderPath);
    const customTag = normalizeCustomTag(this.settings.customTag);

    const existingBaseNames = new Set(
      this.app.vault
        .getMarkdownFiles()
        .map((file) => file.basename.toLowerCase()),
    );

    let importedCount = 0;
    for (const task of tasksById.values()) {
      const noteName = toNoteName(task.title, task.id);
      const normalizedName = noteName.toLowerCase();

      if (existingBaseNames.has(normalizedName)) {
        continue;
      }

      const notePath = normalizePath(
        folderPath ? `${folderPath}/${noteName}.md` : `${noteName}.md`,
      );

      if (this.app.vault.getAbstractFileByPath(notePath)) {
        existingBaseNames.add(normalizedName);
        continue;
      }

      const date = toDateString(task.startDate);
      const projectName = projectNameById.get(task.projectId ?? "") ?? "ticktick";
      const projectTag = toTag(projectName);
      const noteTags = buildTagList(projectTag, customTag);
      const noteBody = buildTaskNoteBody(task.content ?? "", date, noteTags);

      try {
        await this.app.vault.create(notePath, noteBody);
      } catch (error) {
        if (isAlreadyExistsError(error)) {
          existingBaseNames.add(normalizedName);
          continue;
        }

        throw error;
      }

      existingBaseNames.add(normalizedName);

      await this.appendLinkToDailyNote(date, noteName);
      importedCount += 1;
    }

    if (isManual || importedCount > 0) {
      const suffix = importedCount === 1 ? "" : "s";
      new Notice(`Sync complete. Imported ${importedCount} new task${suffix}.`);
    }
  }

  private async getValidAccessToken(): Promise<string | null> {
    if (!this.settings.accessToken) {
      return null;
    }

    if (!isTokenExpired(this.settings.tokenExpiresAt)) {
      return this.settings.accessToken;
    }

    const refreshed = await this.tryRefreshAccessToken();
    if (!refreshed) {
      return null;
    }

    return this.settings.accessToken || null;
  }

  private async tryRefreshAccessToken(): Promise<boolean> {
    if (!this.settings.refreshToken) {
      return false;
    }

    const oauthClient = this.createOauthClient();
    if (!oauthClient) {
      return false;
    }

    try {
      const response = await oauthClient.refreshAccessToken(this.settings.refreshToken);
      this.applyTokenResponse(response);
      await this.saveSettings();
      return true;
    } catch {
      return false;
    }
  }

  private applyTokenResponse(response: OAuthTokenResponse): void {
    this.settings.accessToken = response.access_token;
    this.settings.tokenType = response.token_type ?? "Bearer";

    if (typeof response.refresh_token === "string") {
      this.settings.refreshToken = response.refresh_token;
    }

    if (typeof response.expires_in === "number" && Number.isFinite(response.expires_in)) {
      this.settings.tokenExpiresAt = Date.now() + Math.max(0, response.expires_in) * 1000;
    } else {
      this.settings.tokenExpiresAt = 0;
    }
  }

  private createOauthClient(): TickTickOAuthClient | null {
    const clientId = this.settings.clientId.trim();
    const clientSecret = this.settings.clientSecret.trim();
    const redirectUri = this.settings.redirectUri.trim();
    const scope = this.settings.oauthScope.trim() || DEFAULT_OAUTH_SCOPE;

    if (!clientId || !clientSecret || !redirectUri) {
      return null;
    }

    return new TickTickOAuthClient(clientId, clientSecret, redirectUri, scope);
  }

  private restartSyncInterval(): void {
    this.clearSyncInterval();

    const intervalMinutes = Number(this.settings.syncIntervalMinutes);
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
      return;
    }

    const intervalMs = intervalMinutes * 60 * 1000;
    this.syncIntervalId = window.setInterval(() => {
      void this.syncNow(false);
    }, intervalMs);

    this.registerInterval(this.syncIntervalId);
  }

  private clearSyncInterval(): void {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    if (!folderPath) {
      return;
    }

    const parts = folderPath.split("/").filter((part) => part.length > 0);
    let currentPath = "";

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(currentPath);
      if (!existing) {
        await this.app.vault.createFolder(currentPath);
      }
    }
  }

  private async appendLinkToDailyNote(date: string, noteName: string): Promise<void> {
    const dailyNotePath = normalizePath(`${date}.md`);
    const line = `- [[${noteName}]]`;
    const existing = this.app.vault.getFileByPath(dailyNotePath);

    if (existing) {
      await this.app.vault.process(existing, (content) => {
        const alreadyIncluded = content
          .split(/\r?\n/)
          .some((entry) => entry.trim() === line);
        if (alreadyIncluded) {
          return content;
        }

        const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
        return `${content}${separator}${line}\n`;
      });
      return;
    }

    await this.app.vault.create(dailyNotePath, `${line}\n`);
  }
}

class TickTickSimpleSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: TickTickSimpleSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Authorization").setHeading();

    new Setting(containerEl)
      .setName("Client ID")
      .setDesc("Client ID from developer settings")
      .addText((text) => {
        text
          .setPlaceholder("Enter client ID")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Client secret")
      .setDesc("Client secret from developer settings")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter client secret")
          .setValue(this.plugin.settings.clientSecret)
          .onChange(async (value) => {
            this.plugin.settings.clientSecret = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Redirect URL")
      .setDesc("Must match the redirect URL in developer settings")
      .addText((text) => {
        text
          .setPlaceholder("https://example.com/callback")
          .setValue(this.plugin.settings.redirectUri)
          .onChange(async (value) => {
            this.plugin.settings.redirectUri = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Open authorization page")
      .setDesc("Start authorization in your browser")
      .addButton((button) => {
        button.setButtonText("Open").onClick(() => {
          void this.plugin.beginOauthFlow();
        });
      });

    new Setting(containerEl)
      .setName("Authorization response")
      .setDesc("Paste redirected URL or code")
      .addText((text) => {
        text
          .setPlaceholder("Paste redirected URL here")
          .setValue(this.plugin.getAuthResponseInput())
          .onChange((value) => {
            this.plugin.setAuthResponseInput(value);
          });
      });

    new Setting(containerEl)
      .setName("Connect")
      .setDesc("Exchange code for access token")
      .addButton((button) => {
        button.setButtonText("Connect").onClick(() => {
          void this.plugin.exchangeAuthInput();
        });
      });

    new Setting(containerEl)
      .setName("Connection")
      .setDesc(this.plugin.getConnectionStatusText())
      .addButton((button) => {
        button.setButtonText("Disconnect").onClick(() => {
          void this.plugin.disconnectOauth();
        });
      });

    new Setting(containerEl).setName("Import").setHeading();

    new Setting(containerEl)
      .setName("Task notes folder")
      .setDesc("Folder for imported task notes. Use / for vault root.")
      .addText((text) => {
        text
          .setPlaceholder("/")
          .setValue(this.plugin.settings.taskNotesFolder)
          .onChange(async (value) => {
            this.plugin.settings.taskNotesFolder = value.trim() || "/";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Custom tag")
      .setDesc("Optional tag added to every imported task note")
      .addText((text) => {
        text
          .setPlaceholder("Enter custom tag")
          .setValue(this.plugin.settings.customTag)
          .onChange(async (value) => {
            this.plugin.settings.customTag = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Sync interval (minutes)")
      .setDesc("Set 0 to disable periodic sync")
      .addText((text) => {
        text
          .setPlaceholder(String(DEFAULT_SYNC_INTERVAL_MINUTES))
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.syncIntervalMinutes = Number.isNaN(parsed)
              ? DEFAULT_SYNC_INTERVAL_MINUTES
              : Math.max(parsed, 0);
            await this.plugin.restartAfterIntervalChange();
          });
      });

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Run one immediate import cycle")
      .addButton((button) => {
        button.setButtonText("Run").onClick(() => {
          void this.plugin.syncNow(true);
        });
      });
  }
}

function parseSettings(loaded: unknown): Partial<TickTickSimpleSyncSettings> {
  if (!isObjectRecord(loaded)) {
    return {};
  }

  const parsed: Partial<TickTickSimpleSyncSettings> = {};

  if (typeof loaded.clientId === "string") {
    parsed.clientId = loaded.clientId;
  }

  if (typeof loaded.clientSecret === "string") {
    parsed.clientSecret = loaded.clientSecret;
  }

  if (typeof loaded.redirectUri === "string") {
    parsed.redirectUri = loaded.redirectUri;
  }

  if (typeof loaded.oauthScope === "string") {
    parsed.oauthScope = loaded.oauthScope;
  }

  if (typeof loaded.oauthState === "string") {
    parsed.oauthState = loaded.oauthState;
  }

  if (typeof loaded.accessToken === "string") {
    parsed.accessToken = loaded.accessToken;
  }

  if (typeof loaded.refreshToken === "string") {
    parsed.refreshToken = loaded.refreshToken;
  }

  if (typeof loaded.tokenType === "string") {
    parsed.tokenType = loaded.tokenType;
  }

  if (typeof loaded.taskNotesFolder === "string") {
    parsed.taskNotesFolder = loaded.taskNotesFolder;
  }

  if (typeof loaded.customTag === "string") {
    parsed.customTag = loaded.customTag;
  }

  if (typeof loaded.syncIntervalMinutes === "number" && Number.isFinite(loaded.syncIntervalMinutes)) {
    parsed.syncIntervalMinutes = Math.max(0, Math.floor(loaded.syncIntervalMinutes));
  }

  if (typeof loaded.tokenExpiresAt === "number" && Number.isFinite(loaded.tokenExpiresAt)) {
    parsed.tokenExpiresAt = Math.max(0, Math.floor(loaded.tokenExpiresAt));
  }

  return parsed;
}

function normalizeFolderPath(folderPath: string): string {
  const trimmed = folderPath.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  const normalized = normalizePath(trimmed);
  return normalized === "." ? "" : normalized;
}

function parseAuthorizationInput(input: string): AuthorizationInput | null {
  const value = input.trim();
  if (!value) {
    return null;
  }

  const parsedFromParams = parseCodeAndStateFromParams(value);
  if (parsedFromParams) {
    return parsedFromParams;
  }

  try {
    const url = new URL(value);
    const code = url.searchParams.get("code");
    if (!code) {
      return null;
    }

    const state = url.searchParams.get("state") ?? undefined;
    return { code, state };
  } catch {
    return { code: value };
  }
}

function parseCodeAndStateFromParams(input: string): AuthorizationInput | null {
  const normalized = input.startsWith("?") ? input.slice(1) : input;
  const params = new URLSearchParams(normalized);
  const code = params.get("code");
  if (!code) {
    return null;
  }

  const state = params.get("state") ?? undefined;
  return { code, state };
}

function toBasicAuth(clientId: string, clientSecret: string): string {
  return btoa(`${clientId}:${clientSecret}`);
}

function createOauthState(): string {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${randomPart}`;
}

function isTokenExpired(expiresAt: number): boolean {
  if (expiresAt <= 0) {
    return false;
  }

  return Date.now() >= expiresAt - 30_000;
}

function isUnauthorizedError(error: unknown): boolean {
  return error instanceof HttpError && error.status === 401;
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.toLowerCase().includes("already exists");
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isTokenResponse(value: unknown): value is OAuthTokenResponse {
  if (!isObjectRecord(value)) {
    return false;
  }

  return typeof value.access_token === "string";
}

function isProject(value: unknown): value is TickTickProject {
  if (!isObjectRecord(value)) {
    return false;
  }

  return typeof value.id === "string" && typeof value.name === "string";
}

function isTask(value: unknown): value is TickTickTask {
  if (!isObjectRecord(value)) {
    return false;
  }

  return typeof value.id === "string" && typeof value.title === "string";
}

function toNoteName(title: string, taskId: string): string {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.length > 0 ? cleaned : `ticktick-task-${taskId}`;
}

function toDateString(startDate?: string): string {
  if (startDate && startDate.trim().length > 0) {
    const directMatch = startDate.match(/\d{4}-\d{2}-\d{2}/);
    if (directMatch) {
      return directMatch[0];
    }

    const parsed = new Date(startDate);
    if (!Number.isNaN(parsed.getTime())) {
      return formatDate(parsed);
    }
  }

  return formatDate(new Date());
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toTag(projectName: string): string {
  const cleaned = projectName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9/_-]/g, "");

  return cleaned.length > 0 ? cleaned : "ticktick";
}

function normalizeCustomTag(rawTag: string): string {
  const stripped = rawTag.trim().replace(/^#+/, "");
  if (!stripped) {
    return "";
  }

  return toTag(stripped);
}

function buildTagList(projectTag: string, customTag: string): string[] {
  if (!customTag || customTag === projectTag) {
    return [projectTag];
  }

  return [projectTag, customTag];
}

function buildTaskNoteBody(content: string, date: string, tags: string[]): string {
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const tagLines = tags.map((tag) => `  - ${tag}`);
  const lines = ["---", `date: ${date}`, "tags:", ...tagLines, "---", ""];

  if (normalizedContent.length > 0) {
    lines.push(normalizedContent);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
