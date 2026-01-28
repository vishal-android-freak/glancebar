#!/usr/bin/env bun
import { google } from "googleapis";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { createServer, Server } from "http";
import { createInterface } from "readline";
import { fileURLToPath } from "url";

// Get package version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
const VERSION = packageJson.version;

// ============================================================================
// Configuration
// ============================================================================

interface Config {
  accounts: string[]; // Legacy - for backwards compatibility
  gmailAccounts: string[]; // Google accounts
  zohoAccounts: ZohoAccount[]; // Zoho accounts
  lookaheadHours: number;
  showCalendarName: boolean;
  countdownThresholdMinutes: number;
  maxTitleLength: number;
  waterReminderEnabled: boolean;
  stretchReminderEnabled: boolean;
  eyeReminderEnabled: boolean;
  showCpuUsage: boolean;
  showMemoryUsage: boolean;
  showZohoTasks: boolean;
  maxTasksToShow: number;
  showUsageLimits: boolean;
  show5HourLimit: boolean;
  show7DayLimit: boolean;
  usageLimitsCacheTTL: number;  // In seconds, default 300 (5 min)
}

interface ZohoAccount {
  email: string;
  datacenter: string; // com, eu, in, com.au, com.cn, jp, zohocloud.ca
}

interface ClaudeCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType: string;
    rateLimitTier: string;
  };
}

interface UsageLimits {
  five_hour: {
    utilization: number;      // Percentage (0-100)
    resets_at: string;        // ISO timestamp
  };
  seven_day: {
    utilization: number;      // Percentage (0-100)
    resets_at: string;        // ISO timestamp
  };
}

interface UsageLimitsCache {
  data: UsageLimits | null;
  fetchedAt: number;          // Unix timestamp
  ttl: number;                // Cache TTL in milliseconds (default: 5 minutes)
}

const COLORS: Record<string, string> = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  orange: "\x1b[38;5;208m",
  pink: "\x1b[38;5;213m",
  purple: "\x1b[38;5;141m",
};

const ACCOUNT_COLORS = ["cyan", "magenta", "brightGreen", "orange", "brightBlue", "pink", "yellow", "purple"];

const DEFAULT_CONFIG: Config = {
  accounts: [], // Legacy
  gmailAccounts: [],
  zohoAccounts: [],
  lookaheadHours: 8,
  showCalendarName: true,
  countdownThresholdMinutes: 60,
  maxTitleLength: 120,
  waterReminderEnabled: true,
  stretchReminderEnabled: true,
  eyeReminderEnabled: true,
  showCpuUsage: false,
  showMemoryUsage: false,
  showZohoTasks: true,
  maxTasksToShow: 3,
  showUsageLimits: true,
  show5HourLimit: true,
  show7DayLimit: true,
  usageLimitsCacheTTL: 120,  // 2 minutes
};

const WATER_REMINDERS = [
  "Stay hydrated! Drink some water",
  "Time for a water break!",
  "Hydration check! Grab some water",
  "Your body needs water. Drink up!",
  "Water break! Stay refreshed",
  "Don't forget to drink water!",
  "Hydrate yourself! Take a sip",
  "Quick reminder: Drink water!",
];

const STRETCH_REMINDERS = [
  "Time to stretch! Stand up and move",
  "Stretch break! Roll your shoulders",
  "Stand up and stretch your legs",
  "Posture check! Sit up straight",
  "Take a quick stretch break",
  "Move your body! Quick stretch",
  "Stretch your neck and shoulders",
  "Stand up! Your body will thank you",
];

const EYE_REMINDERS = [
  "Eye break! Look 20ft away for 20s",
  "Rest your eyes - look at something distant",
  "20-20-20: Look away from screen",
  "Give your eyes a break!",
  "Look away from the screen for a moment",
  "Eye rest time! Focus on something far",
];

function getConfigDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return join(home, ".glancebar");
}

function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

function getTokensDir(): string {
  return join(getConfigDir(), "tokens");
}

// ============================================================================
// Claude Usage Limits
// ============================================================================

function getClaudeCredentialsPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return join(home, ".claude", ".credentials.json");
}

function loadClaudeCredentials(): ClaudeCredentials | null {
  try {
    const credPath = getClaudeCredentialsPath();
    if (!existsSync(credPath)) return null;
    const content = readFileSync(credPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function getUsageLimitsCachePath(): string {
  return join(getConfigDir(), "usage_limits_cache.json");
}

function loadUsageLimitsCache(): UsageLimitsCache {
  try {
    const cachePath = getUsageLimitsCachePath();
    if (!existsSync(cachePath)) {
      return { data: null, fetchedAt: 0, ttl: 120000 };
    }
    const content = readFileSync(cachePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return { data: null, fetchedAt: 0, ttl: 120000 };
  }
}

function saveUsageLimitsCache(cache: UsageLimitsCache): void {
  try {
    ensureConfigDir();
    const cachePath = getUsageLimitsCachePath();
    writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch {
    // Silently fail if we can't save cache
  }
}

async function fetchUsageLimitsFromAPI(): Promise<UsageLimits | null> {
  try {
    const creds = loadClaudeCredentials();
    if (!creds?.claudeAiOauth?.accessToken) return null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${creds.claudeAiOauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (!data.five_hour || !data.seven_day) {
      return null;
    }

    return {
      five_hour: {
        utilization: data.five_hour.utilization || 0,
        resets_at: data.five_hour.resets_at || "",
      },
      seven_day: {
        utilization: data.seven_day.utilization || 0,
        resets_at: data.seven_day.resets_at || "",
      },
    };
  } catch {
    return null;
  }
}

async function getUsageLimits(config: Config): Promise<UsageLimits | null> {
  const cache = loadUsageLimitsCache();
  const now = Date.now();
  const ttlMs = config.usageLimitsCacheTTL * 1000;

  // Return cached data if fresh
  if (cache.data && (now - cache.fetchedAt) < ttlMs) {
    return cache.data;
  }

  // Cache is stale or missing, fetch from API
  const freshData = await fetchUsageLimitsFromAPI();

  // Update cache if fetch succeeded
  if (freshData) {
    saveUsageLimitsCache({
      data: freshData,
      fetchedAt: now,
      ttl: ttlMs,
    });
    return freshData;
  }

  // Fetch failed - return stale cache if available
  return cache.data || null;
}

function formatUsageLimits(usageLimits: UsageLimits, config: Config): string | null {
  const parts: string[] = [];

  if (config.show5HourLimit) {
    const util = usageLimits.five_hour.utilization;
    let color = COLORS.green;
    if (util >= 80) color = COLORS.red;
    else if (util >= 50) color = COLORS.yellow;
    parts.push(`${color}5h: ${util.toFixed(0)}%${COLORS.reset}`);
  }

  if (config.show7DayLimit) {
    const util = usageLimits.seven_day.utilization;
    let color = COLORS.green;
    if (util >= 80) color = COLORS.red;
    else if (util >= 50) color = COLORS.yellow;
    parts.push(`${color}7d: ${util.toFixed(0)}%${COLORS.reset}`);
  }

  return parts.length > 0 ? parts.join(" | ") : null;
}

function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadConfig(): Config {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const userConfig = JSON.parse(content);
    const config = { ...DEFAULT_CONFIG, ...userConfig };

    // Migrate legacy accounts to gmailAccounts
    if (config.accounts && config.accounts.length > 0 && (!config.gmailAccounts || config.gmailAccounts.length === 0)) {
      config.gmailAccounts = [...config.accounts];
    }

    return config;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// ============================================================================
// Google OAuth Authentication
// ============================================================================

const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const REDIRECT_URI = "http://localhost:3000/callback";

interface GoogleCredentials {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
}

// ============================================================================
// Zoho OAuth Authentication
// ============================================================================

const ZOHO_SCOPES = [
  "ZohoCalendar.calendar.READ",
  "ZohoCalendar.event.READ",
  "ZohoMail.tasks.READ",
];
const ZOHO_REDIRECT_URI = "http://localhost:3000/callback";

// Zoho datacenter mappings
const ZOHO_DATACENTERS: Record<string, { accounts: string; calendar: string; mail: string }> = {
  "com": { accounts: "https://accounts.zoho.com", calendar: "https://calendar.zoho.com", mail: "https://mail.zoho.com" },
  "eu": { accounts: "https://accounts.zoho.eu", calendar: "https://calendar.zoho.eu", mail: "https://mail.zoho.eu" },
  "in": { accounts: "https://accounts.zoho.in", calendar: "https://calendar.zoho.in", mail: "https://mail.zoho.in" },
  "com.au": { accounts: "https://accounts.zoho.com.au", calendar: "https://calendar.zoho.com.au", mail: "https://mail.zoho.com.au" },
  "com.cn": { accounts: "https://accounts.zoho.com.cn", calendar: "https://calendar.zoho.com.cn", mail: "https://mail.zoho.com.cn" },
  "jp": { accounts: "https://accounts.zoho.jp", calendar: "https://calendar.zoho.jp", mail: "https://mail.zoho.jp" },
  "zohocloud.ca": { accounts: "https://accounts.zohocloud.ca", calendar: "https://calendar.zohocloud.ca", mail: "https://mail.zohocloud.ca" },
};

interface ZohoCredentials {
  client_id: string;
  client_secret: string;
}

interface ZohoToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  api_domain?: string;
}

// Google credentials
function getGoogleCredentialsPath(): string {
  return join(getConfigDir(), "credentials.json");
}

function loadGoogleCredentials(): GoogleCredentials {
  const credPath = getGoogleCredentialsPath();
  if (!existsSync(credPath)) {
    throw new Error(
      `credentials.json not found at ${credPath}\n\nPlease download OAuth credentials from Google Cloud Console and save to:\n${credPath}\n\nRun 'glancebar setup' for detailed instructions.`
    );
  }
  return JSON.parse(readFileSync(credPath, "utf-8"));
}

function getGoogleTokenPath(account: string): string {
  const safeAccount = account.replace(/[^a-zA-Z0-9@.-]/g, "_");
  return join(getTokensDir(), `google_${safeAccount}.json`);
}

// Legacy token path (for migration)
function getLegacyTokenPath(account: string): string {
  const safeAccount = account.replace(/[^a-zA-Z0-9@.-]/g, "_");
  return join(getTokensDir(), `${safeAccount}.json`);
}

// Zoho credentials
function getZohoCredentialsPath(): string {
  return join(getConfigDir(), "zoho_credentials.json");
}

function loadZohoCredentials(): ZohoCredentials {
  const credPath = getZohoCredentialsPath();
  if (!existsSync(credPath)) {
    throw new Error(
      `zoho_credentials.json not found at ${credPath}\n\nPlease create OAuth credentials in Zoho API Console and save to:\n${credPath}\n\nRun 'glancebar setup' for detailed instructions.`
    );
  }
  return JSON.parse(readFileSync(credPath, "utf-8"));
}

function getZohoTokenPath(account: string): string {
  const safeAccount = account.replace(/[^a-zA-Z0-9@.-]/g, "_");
  return join(getTokensDir(), `zoho_${safeAccount}.json`);
}

function createGoogleOAuth2Client(credentials: GoogleCredentials) {
  const { client_id, client_secret } = credentials.installed || credentials.web!;
  return new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
}

function getGoogleAuthenticatedClient(account: string) {
  const credentials = loadGoogleCredentials();
  const oauth2Client = createGoogleOAuth2Client(credentials);

  // Try new path first, then legacy path
  let tokenPath = getGoogleTokenPath(account);
  if (!existsSync(tokenPath)) {
    const legacyPath = getLegacyTokenPath(account);
    if (existsSync(legacyPath)) {
      tokenPath = legacyPath;
    } else {
      return null;
    }
  }

  const token = JSON.parse(readFileSync(tokenPath, "utf-8"));
  oauth2Client.setCredentials(token);

  oauth2Client.on("tokens", (tokens) => {
    const currentToken = JSON.parse(readFileSync(tokenPath, "utf-8"));
    const updatedToken = { ...currentToken, ...tokens };
    writeFileSync(tokenPath, JSON.stringify(updatedToken, null, 2));
  });

  return oauth2Client;
}

async function authenticateGoogleAccount(account: string): Promise<void> {
  const credentials = loadGoogleCredentials();
  const oauth2Client = createGoogleOAuth2Client(credentials);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: GOOGLE_SCOPES,
    prompt: "consent",
    login_hint: account,
  });

  console.log(`\nAuthenticating: ${account}`);
  console.log(`Opening browser...`);

  const code = await startServerAndGetCode(authUrl);

  console.log(`Exchanging code for tokens...`);

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const tokensDir = getTokensDir();
  if (!existsSync(tokensDir)) {
    mkdirSync(tokensDir, { recursive: true });
  }

  const tokenPath = getGoogleTokenPath(account);
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(`Token saved for ${account}`);
}

// ============================================================================
// Zoho OAuth Flow
// ============================================================================

async function authenticateZohoAccount(account: ZohoAccount): Promise<void> {
  const credentials = loadZohoCredentials();
  const dc = ZOHO_DATACENTERS[account.datacenter];

  if (!dc) {
    throw new Error(`Invalid datacenter: ${account.datacenter}. Valid options: ${Object.keys(ZOHO_DATACENTERS).join(", ")}`);
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: credentials.client_id,
    scope: ZOHO_SCOPES.join(","),
    redirect_uri: ZOHO_REDIRECT_URI,
    access_type: "offline",
    prompt: "consent",
  });

  const authUrl = `${dc.accounts}/oauth/v2/auth?${params.toString()}`;

  console.log(`\nAuthenticating Zoho: ${account.email}`);
  console.log(`Datacenter: ${account.datacenter}`);
  console.log(`Opening browser...`);

  const code = await startServerAndGetCode(authUrl);

  console.log(`Exchanging code for tokens...`);

  // Exchange code for tokens
  const tokenParams = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
    redirect_uri: ZOHO_REDIRECT_URI,
    code: code,
  });

  const tokenResponse = await fetch(`${dc.accounts}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams.toString(),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    throw new Error(`Failed to get Zoho tokens: ${errorText}`);
  }

  const tokenData = await tokenResponse.json();

  const token: ZohoToken = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Date.now() + (tokenData.expires_in * 1000),
    api_domain: tokenData.api_domain || dc.calendar,
  };

  const tokensDir = getTokensDir();
  if (!existsSync(tokensDir)) {
    mkdirSync(tokensDir, { recursive: true });
  }

  const tokenPath = getZohoTokenPath(account.email);
  writeFileSync(tokenPath, JSON.stringify(token, null, 2));
  console.log(`Token saved for ${account.email}`);
}

async function refreshZohoToken(account: ZohoAccount): Promise<ZohoToken | null> {
  const tokenPath = getZohoTokenPath(account.email);
  if (!existsSync(tokenPath)) return null;

  const token: ZohoToken = JSON.parse(readFileSync(tokenPath, "utf-8"));

  // Check if token is still valid (with 5 minute buffer)
  if (token.expires_at > Date.now() + 300000) {
    return token;
  }

  // Refresh the token
  try {
    const credentials = loadZohoCredentials();
    const dc = ZOHO_DATACENTERS[account.datacenter];

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: token.refresh_token,
    });

    const response = await fetch(`${dc.accounts}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const updatedToken: ZohoToken = {
      ...token,
      access_token: data.access_token,
      expires_at: Date.now() + (data.expires_in * 1000),
    };

    writeFileSync(tokenPath, JSON.stringify(updatedToken, null, 2));
    return updatedToken;
  } catch {
    return null;
  }
}

function getZohoAuthenticatedToken(account: ZohoAccount): ZohoToken | null {
  const tokenPath = getZohoTokenPath(account.email);
  if (!existsSync(tokenPath)) return null;
  return JSON.parse(readFileSync(tokenPath, "utf-8"));
}

function startServerAndGetCode(authUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let server: Server;

    server = createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:3000`);

      if (!url.pathname.startsWith("/callback")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body><h1>Authentication failed</h1><p>Error: ${error}</p></body></html>`);
        server.close();
        reject(new Error(error));
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html>
            <body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee;">
              <div style="text-align: center;">
                <h1 style="color: #4ade80;">Authentication Successful!</h1>
                <p>You can close this window and return to the terminal.</p>
              </div>
            </body>
          </html>
        `);

        setTimeout(() => {
          server.close(() => resolve(code));
        }, 500);
      } else {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Authentication failed</h1><p>No code received.</p></body></html>");
      }
    });

    server.listen(3000, () => openBrowser(authUrl));

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error("Port 3000 is already in use. Please close any application using it and try again."));
      } else {
        reject(err);
      }
    });

    setTimeout(() => {
      server.close();
      reject(new Error("Authentication timeout (5 minutes)"));
    }, 300000);
  });
}

function openBrowser(url: string) {
  const { exec } = require("child_process");
  const platform = process.platform;

  let command: string;
  if (platform === "win32") {
    command = `start "" "${url}"`;
  } else if (platform === "darwin") {
    command = `open "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (err: Error | null) => {
    if (err) {
      console.log(`\nCould not open browser automatically.`);
      console.log(`Please open this URL manually:\n${url}\n`);
    }
  });
}

// ============================================================================
// Calendar
// ============================================================================

interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  account: string;
  accountEmail: string;
  accountIndex: number;
  provider: "google" | "zoho";
}

// Get all accounts combined for indexing
function getAllAccounts(config: Config): string[] {
  const gmailAccounts = config.gmailAccounts.length > 0 ? config.gmailAccounts : config.accounts;
  const zohoEmails = config.zohoAccounts.map(z => z.email);
  return [...gmailAccounts, ...zohoEmails];
}

async function getGoogleEvents(config: Config, now: Date, timeMax: Date): Promise<CalendarEvent[]> {
  const gmailAccounts = config.gmailAccounts.length > 0 ? config.gmailAccounts : config.accounts;
  const allAccounts = getAllAccounts(config);

  const eventPromises = gmailAccounts.map(async (account) => {
    const accountIndex = allAccounts.indexOf(account);
    try {
      const auth = getGoogleAuthenticatedClient(account);
      if (!auth) return [];

      const calendar = google.calendar({ version: "v3", auth });

      const response = await calendar.events.list({
        calendarId: "primary",
        timeMin: now.toISOString(),
        timeMax: timeMax.toISOString(),
        maxResults: 10,
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = response.data.items || [];
      return events.map((event) => {
        const isAllDay = !event.start?.dateTime;
        let start: Date, end: Date;

        if (isAllDay) {
          start = new Date(event.start?.date + "T00:00:00");
          end = new Date(event.end?.date + "T00:00:00");
        } else {
          start = new Date(event.start?.dateTime!);
          end = new Date(event.end?.dateTime!);
        }

        return {
          id: event.id || "",
          title: event.summary || "(No title)",
          start,
          end,
          isAllDay,
          account: extractAccountName(account),
          accountEmail: account,
          accountIndex,
          provider: "google" as const,
        };
      });
    } catch {
      return [];
    }
  });

  const results = await Promise.all(eventPromises);
  return results.flat();
}

async function getZohoEvents(config: Config, now: Date, timeMax: Date): Promise<CalendarEvent[]> {
  if (!config.zohoAccounts || config.zohoAccounts.length === 0) return [];

  const allAccounts = getAllAccounts(config);
  const gmailCount = (config.gmailAccounts.length > 0 ? config.gmailAccounts : config.accounts).length;

  const eventPromises = config.zohoAccounts.map(async (account, idx) => {
    const accountIndex = gmailCount + idx;
    try {
      const token = await refreshZohoToken(account);
      if (!token) return [];

      const dc = ZOHO_DATACENTERS[account.datacenter];
      // Always use the calendar-specific API domain, not the generic api_domain
      const apiBase = dc.calendar;

      // First get list of calendars
      const calendarsResponse = await fetch(`${apiBase}/api/v1/calendars?category=own`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token.access_token}`,
        },
      });

      if (!calendarsResponse.ok) return [];

      const calendarsData = await calendarsResponse.json();
      const calendars = calendarsData.calendars || [];

      if (calendars.length === 0) return [];

      // Use the first (primary) calendar
      const primaryCalendar = calendars.find((c: any) => c.isdefault) || calendars[0];
      const calendarUid = primaryCalendar.uid;

      // Format dates for Zoho API (yyyyMMdd'T'HHmmss'Z')
      const formatZohoDate = (date: Date): string => {
        return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      };

      const range = JSON.stringify({
        start: formatZohoDate(now),
        end: formatZohoDate(timeMax),
      });

      const eventsResponse = await fetch(
        `${apiBase}/api/v1/calendars/${encodeURIComponent(calendarUid)}/events?range=${encodeURIComponent(range)}`,
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${token.access_token}`,
          },
        }
      );

      if (!eventsResponse.ok) return [];

      const eventsData = await eventsResponse.json();
      const events = eventsData.events || [];

      return events.map((event: any) => {
        const isAllDay = event.isallday === true;
        let start: Date, end: Date;

        // Parse Zoho date format: "20260109T163000+0530" or "20260109T163000Z"
        const parseZohoDate = (dateStr: string): Date => {
          // Format: YYYYMMDDTHHmmss+HHMM or YYYYMMDDTHHmmssZ
          const match = dateStr.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})([Z]|([+-])(\d{2})(\d{2}))?$/);
          if (match) {
            const [, year, month, day, hour, min, sec, tz, sign, tzHour, tzMin] = match;
            if (tz === "Z") {
              return new Date(Date.UTC(+year, +month - 1, +day, +hour, +min, +sec));
            } else if (sign && tzHour && tzMin) {
              const offsetMinutes = (+tzHour * 60 + +tzMin) * (sign === "+" ? -1 : 1);
              const utc = Date.UTC(+year, +month - 1, +day, +hour, +min, +sec);
              return new Date(utc + offsetMinutes * 60000);
            }
            // No timezone, assume local
            return new Date(+year, +month - 1, +day, +hour, +min, +sec);
          }
          // Fallback to standard parsing
          return new Date(dateStr);
        };

        if (event.dateandtime) {
          start = parseZohoDate(event.dateandtime.start);
          end = parseZohoDate(event.dateandtime.end);
        } else {
          start = parseZohoDate(event.start);
          end = parseZohoDate(event.end);
        }

        return {
          id: event.uid || "",
          title: event.title || "(No title)",
          start,
          end,
          isAllDay,
          account: extractAccountName(account.email),
          accountEmail: account.email,
          accountIndex,
          provider: "zoho" as const,
        };
      });
    } catch {
      return [];
    }
  });

  const results = await Promise.all(eventPromises);
  return results.flat();
}

async function getUpcomingEvents(config: Config): Promise<CalendarEvent[]> {
  const now = new Date();
  const timeMax = new Date(now.getTime() + config.lookaheadHours * 60 * 60 * 1000);

  // Fetch from both providers in parallel
  const [googleEvents, zohoEvents] = await Promise.all([
    getGoogleEvents(config, now, timeMax),
    getZohoEvents(config, now, timeMax),
  ]);

  const allEvents = [...googleEvents, ...zohoEvents];
  allEvents.sort((a, b) => a.start.getTime() - b.start.getTime());
  return allEvents;
}

// ============================================================================
// Zoho Tasks
// ============================================================================

interface ZohoTask {
  id: string;
  title: string;
  description: string;
  dueDate: Date | null;
  priority: "High" | "Normal" | "Low";
  status: string;
  isOverdue: boolean;
}

async function getZohoTasks(config: Config): Promise<ZohoTask[]> {
  if (!config.zohoAccounts || config.zohoAccounts.length === 0) return [];
  if (!config.showZohoTasks) return [];

  const allTasks: ZohoTask[] = [];

  for (const account of config.zohoAccounts) {
    try {
      const token = await refreshZohoToken(account);
      if (!token) continue;

      const dc = ZOHO_DATACENTERS[account.datacenter];
      const mailBase = dc.mail;

      // Fetch tasks assigned to user
      const response = await fetch(
        `${mailBase}/api/tasks/?view=assignedtome&action=view&limit=10&from=0`,
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${token.access_token}`,
            Accept: "application/json",
          },
        }
      );

      if (!response.ok) continue;

      const data = await response.json();
      const tasks = data.data?.tasks || [];

      const now = new Date();

      for (const task of tasks) {
        // Skip completed tasks
        if (task.status === "Completed" || task.status === "completed") continue;

        let dueDate: Date | null = null;
        let isOverdue = false;

        if (task.dueDate) {
          // Parse DD/MM/YYYY format
          const parts = task.dueDate.split("/");
          if (parts.length === 3) {
            dueDate = new Date(+parts[2], +parts[1] - 1, +parts[0]);
            isOverdue = dueDate < now;
          }
        }

        allTasks.push({
          id: task.id || "",
          title: task.title || "(No title)",
          description: task.description || "",
          dueDate,
          priority: task.priority || "Normal",
          status: task.status || "Open",
          isOverdue,
        });
      }
    } catch {
      // Silently continue on error
    }
  }

  // Sort: overdue first, then by due date (soonest first), then by priority
  allTasks.sort((a, b) => {
    // Overdue tasks first
    if (a.isOverdue && !b.isOverdue) return -1;
    if (!a.isOverdue && b.isOverdue) return 1;

    // Then by due date (null dates go last)
    if (a.dueDate && b.dueDate) {
      return a.dueDate.getTime() - b.dueDate.getTime();
    }
    if (a.dueDate && !b.dueDate) return -1;
    if (!a.dueDate && b.dueDate) return 1;

    // Then by priority
    const priorityOrder = { High: 0, Normal: 1, Low: 2 };
    return (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1);
  });

  return allTasks.slice(0, config.maxTasksToShow);
}

function formatTasks(tasks: ZohoTask[]): string | null {
  if (tasks.length === 0) return null;

  const formatted = tasks.map((task) => {
    const title = task.title.length > 25 ? task.title.slice(0, 24) + "…" : task.title;

    if (task.isOverdue) {
      return `${COLORS.red}${title}${COLORS.reset}`;
    } else if (task.priority === "High") {
      return `${COLORS.yellow}${title}${COLORS.reset}`;
    } else {
      return `${COLORS.white}${title}${COLORS.reset}`;
    }
  });

  return `${COLORS.cyan}Tasks:${COLORS.reset} ${formatted.join(", ")}`;
}

function extractAccountName(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) return email;

  const domain = email.slice(atIndex + 1);
  if (domain === "gmail.com") {
    return email.slice(0, atIndex);
  }

  return domain.split(".")[0];
}

function getCurrentOrNextEvent(events: CalendarEvent[]): CalendarEvent | null {
  const now = new Date();

  for (const event of events) {
    if (event.start <= now && event.end > now) return event;
  }

  for (const event of events) {
    if (event.start > now) return event;
  }

  return null;
}

// ============================================================================
// Formatter
// ============================================================================

function formatEvent(event: CalendarEvent, config: Config): string {
  const now = new Date();
  const isHappening = event.start <= now && event.end > now;
  const minutesUntil = Math.round((event.start.getTime() - now.getTime()) / 60000);

  let timeStr: string;
  if (isHappening) {
    timeStr = "Now";
  } else if (minutesUntil <= config.countdownThresholdMinutes && minutesUntil > 0) {
    timeStr = formatCountdown(minutesUntil);
  } else {
    timeStr = formatTime(event.start);
  }

  const title = event.title.length > config.maxTitleLength
    ? event.title.slice(0, config.maxTitleLength - 1) + "…"
    : event.title;

  const colorName = ACCOUNT_COLORS[event.accountIndex % ACCOUNT_COLORS.length];
  const color = COLORS[colorName] || COLORS.white;

  if (config.showCalendarName) {
    return `${color}${timeStr}: ${title} (${event.account})${COLORS.reset}`;
  }
  return `${color}${timeStr}: ${title}${COLORS.reset}`;
}

function formatCountdown(minutes: number): string {
  if (minutes < 60) return `In ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins === 0 ? `In ${hours}h` : `In ${hours}h${mins}m`;
}

function getMeetingWarning(event: CalendarEvent | null): string | null {
  if (!event) return null;

  const now = new Date();
  const minutesUntil = Math.round((event.start.getTime() - now.getTime()) / 60000);

  // Warning when meeting is 5 minutes or less away
  if (minutesUntil > 0 && minutesUntil <= 5) {
    return `${COLORS.brightRed}Meeting in ${minutesUntil}m - wrap up!${COLORS.reset}`;
  }

  return null;
}

// ============================================================================
// System Stats
// ============================================================================

function getCpuUsage(): string | null {
  try {
    const os = require("os");
    const cpus = os.cpus();

    let totalIdle = 0;
    let totalTick = 0;

    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    }

    const usage = Math.round(100 - (totalIdle / totalTick) * 100);

    // Color based on usage
    let color = COLORS.green;
    if (usage >= 80) color = COLORS.red;
    else if (usage >= 50) color = COLORS.yellow;

    return `${color}CPU ${usage}%${COLORS.reset}`;
  } catch {
    return null;
  }
}

function getMemoryUsage(): string | null {
  try {
    const os = require("os");
    const totalMem = os.totalmem();

    // Read MemAvailable from /proc/meminfo (Linux only)
    // MemAvailable accounts for reclaimable cache/buffers
    let availableMem = os.freemem(); // fallback for non-Linux

    if (process.platform === "linux") {
      try {
        const meminfo = readFileSync("/proc/meminfo", "utf-8");
        const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
        if (match) {
          availableMem = parseInt(match[1], 10) * 1024; // Convert kB to bytes
        }
      } catch {
        // Fall back to freemem if /proc/meminfo is unavailable
      }
    }

    const usedMem = totalMem - availableMem;
    const usagePercent = Math.round((usedMem / totalMem) * 100);

    // Format used memory
    const usedGB = (usedMem / (1024 * 1024 * 1024)).toFixed(1);
    const totalGB = (totalMem / (1024 * 1024 * 1024)).toFixed(1);

    // Color based on usage
    let color = COLORS.green;
    if (usagePercent >= 80) color = COLORS.red;
    else if (usagePercent >= 50) color = COLORS.yellow;

    return `${color}Mem ${usedGB}/${totalGB}GB${COLORS.reset}`;
  } catch {
    return null;
  }
}

function formatTime(date: Date): string {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const isPM = hours >= 12;
  const hour12 = hours % 12 || 12;
  return `${hour12}:${minutes.toString().padStart(2, "0")} ${isPM ? "PM" : "AM"}`;
}

// ============================================================================
// CLI Commands
// ============================================================================

function printHelp() {
  console.log(`
glancebar - A customizable statusline for Claude Code

Display calendar events, tasks, and more at a glance.

Usage:
  glancebar                          Output statusline (for Claude Code)
  glancebar auth                     Authenticate all configured accounts
  glancebar auth --add <email>       Add and authenticate a new account (prompts for provider)
  glancebar auth --remove <email>    Remove an account
  glancebar auth --list              List all configured accounts
  glancebar config                   Show current configuration
  glancebar config --lookahead <hours>           Set lookahead hours (default: 8)
  glancebar config --countdown-threshold <mins>  Set countdown threshold in minutes (default: 60)
  glancebar config --max-title <length>          Set max title length (default: 120)
  glancebar config --show-calendar <true|false>  Show calendar name (default: true)
  glancebar config --water-reminder <true|false> Enable/disable water reminders (default: true)
  glancebar config --stretch-reminder <true|false> Enable/disable stretch reminders (default: true)
  glancebar config --eye-reminder <true|false>   Enable/disable eye break reminders (default: true)
  glancebar config --cpu-usage <true|false>      Show CPU usage (default: false)
  glancebar config --memory-usage <true|false>   Show memory usage (default: false)
  glancebar config --zoho-tasks <true|false>     Show Zoho tasks (default: true)
  glancebar config --max-tasks <number>          Max tasks to show (default: 3)
  glancebar config --show-usage-limits <true|false>  Show usage limits from API (default: true)
  glancebar config --show-5hour-limit <true|false>   Show 5-hour window utilization (default: true)
  glancebar config --show-7day-limit <true|false>    Show 7-day window utilization (default: true)
  glancebar config --usage-cache-ttl <seconds>       API cache TTL in seconds (default: 120)
  glancebar config --reset           Reset to default configuration
  glancebar setup                    Show setup instructions
  glancebar --version                Show version

Examples:
  glancebar auth --add user@gmail.com     # Will prompt for Google or Zoho
  glancebar auth --add user@zoho.com      # Will prompt for Google or Zoho
  glancebar config --lookahead 12
  glancebar config --stretch-reminder false

Config location: ${getConfigDir()}
`);
}

function printSetup() {
  console.log(`
Glancebar - Setup Instructions
==============================

GOOGLE CALENDAR SETUP
---------------------

Step 1: Create Google Cloud Project
   - Go to https://console.cloud.google.com/
   - Create a new project or select existing one

Step 2: Enable Google Calendar API
   - Go to "APIs & Services" > "Library"
   - Search for "Google Calendar API" and enable it

Step 3: Create OAuth Credentials
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "OAuth client ID"
   - Select "Desktop app" as application type
   - Download the JSON file

Step 4: Save credentials
   - Rename downloaded file to "credentials.json"
   - Save it to: ${getGoogleCredentialsPath()}

Step 5: Add redirect URI
   - Edit credentials.json and ensure redirect_uris contains:
     "redirect_uris": ["http://localhost:3000/callback"]

ZOHO CALENDAR SETUP
-------------------

Step 1: Register Application
   - Go to https://api-console.zoho.com/
   - Click "Add Client" > "Server-based Applications"

Step 2: Configure Client
   - Set Authorized Redirect URI: http://localhost:3000/callback
   - Note your Client ID and Client Secret

Step 3: Save credentials
   - Create file: ${getZohoCredentialsPath()}
   - Add content:
     {
       "client_id": "YOUR_CLIENT_ID",
       "client_secret": "YOUR_CLIENT_SECRET"
     }

ADDING ACCOUNTS
---------------

   glancebar auth --add your-email@gmail.com
   # Select "Google" or "Zoho" when prompted
   # For Zoho, select your datacenter region

CONFIGURE CLAUDE CODE
---------------------

   Update ~/.claude/settings.json:
   {
     "statusLine": {
       "type": "command",
       "command": "bunx @naarang/glancebar",
       "padding": 0
     }
   }

For more info: https://github.com/vishal-android-freak/glancebar
`);
}

async function handleAuth(args: string[]) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));

  // Handle --list
  if (args.includes("--list")) {
    const config = loadConfig();
    const gmailAccounts = config.gmailAccounts.length > 0 ? config.gmailAccounts : config.accounts;
    const hasAny = gmailAccounts.length > 0 || config.zohoAccounts.length > 0;

    if (!hasAny) {
      console.log("No accounts configured.");
    } else {
      if (gmailAccounts.length > 0) {
        console.log("\nGoogle Calendar accounts:");
        gmailAccounts.forEach((acc, i) => {
          let tokenPath = getGoogleTokenPath(acc);
          if (!existsSync(tokenPath)) {
            tokenPath = getLegacyTokenPath(acc);
          }
          const status = existsSync(tokenPath) ? "authenticated" : "not authenticated";
          console.log(`  ${i + 1}. ${acc} (${status})`);
        });
      }

      if (config.zohoAccounts.length > 0) {
        console.log("\nZoho Calendar accounts:");
        config.zohoAccounts.forEach((acc, i) => {
          const tokenPath = getZohoTokenPath(acc.email);
          const status = existsSync(tokenPath) ? "authenticated" : "not authenticated";
          console.log(`  ${i + 1}. ${acc.email} [${acc.datacenter}] (${status})`);
        });
      }
    }
    rl.close();
    return;
  }

  // Handle --add
  const addIndex = args.indexOf("--add");
  if (addIndex !== -1) {
    const email = args[addIndex + 1];
    if (!email || email.startsWith("--")) {
      console.error("Error: Please provide an email address after --add");
      rl.close();
      process.exit(1);
    }

    if (!email.includes("@")) {
      console.error("Error: Invalid email address");
      rl.close();
      process.exit(1);
    }

    // Prompt for provider
    console.log("\nSelect calendar provider:");
    console.log("  1. Google Calendar");
    console.log("  2. Zoho Calendar");
    const providerChoice = await prompt("\nEnter choice (1 or 2): ");

    const config = loadConfig();

    if (providerChoice === "1") {
      // Google Calendar
      const gmailAccounts = config.gmailAccounts.length > 0 ? config.gmailAccounts : config.accounts;
      if (gmailAccounts.includes(email)) {
        console.log(`\nGoogle account ${email} already exists. Re-authenticating...`);
      } else {
        if (config.gmailAccounts.length === 0 && config.accounts.length > 0) {
          config.gmailAccounts = [...config.accounts];
        }
        config.gmailAccounts.push(email);
        saveConfig(config);
        console.log(`\nAdded ${email} to Google accounts.`);
      }

      await authenticateGoogleAccount(email);
      console.log("\nDone!");
    } else if (providerChoice === "2") {
      // Zoho Calendar
      console.log("\nSelect Zoho datacenter:");
      console.log("  1. com     - United States");
      console.log("  2. eu      - Europe");
      console.log("  3. in      - India");
      console.log("  4. com.au  - Australia");
      console.log("  5. com.cn  - China");
      console.log("  6. jp      - Japan");
      console.log("  7. zohocloud.ca - Canada");

      const dcChoice = await prompt("\nEnter choice (1-7): ");
      const dcMap: Record<string, string> = {
        "1": "com",
        "2": "eu",
        "3": "in",
        "4": "com.au",
        "5": "com.cn",
        "6": "jp",
        "7": "zohocloud.ca",
      };

      const datacenter = dcMap[dcChoice];
      if (!datacenter) {
        console.error("Error: Invalid datacenter choice");
        rl.close();
        process.exit(1);
      }

      const existingZoho = config.zohoAccounts.find((z) => z.email === email);
      if (existingZoho) {
        console.log(`\nZoho account ${email} already exists. Re-authenticating...`);
        existingZoho.datacenter = datacenter;
        saveConfig(config);
      } else {
        config.zohoAccounts.push({ email, datacenter });
        saveConfig(config);
        console.log(`\nAdded ${email} to Zoho accounts.`);
      }

      await authenticateZohoAccount({ email, datacenter });
      console.log("\nDone!");
    } else {
      console.error("Error: Invalid choice. Please enter 1 or 2.");
      rl.close();
      process.exit(1);
    }

    rl.close();
    return;
  }

  // Handle --remove
  const removeIndex = args.indexOf("--remove");
  if (removeIndex !== -1) {
    const email = args[removeIndex + 1];
    if (!email || email.startsWith("--")) {
      console.error("Error: Please provide an email address after --remove");
      rl.close();
      process.exit(1);
    }

    const config = loadConfig();
    const gmailAccounts = config.gmailAccounts.length > 0 ? config.gmailAccounts : config.accounts;

    // Check Google accounts
    const googleIdx = gmailAccounts.indexOf(email);
    if (googleIdx !== -1) {
      if (config.gmailAccounts.length > 0) {
        config.gmailAccounts.splice(googleIdx, 1);
      } else {
        config.accounts.splice(googleIdx, 1);
      }
      saveConfig(config);

      // Remove token files
      const tokenPath = getGoogleTokenPath(email);
      const legacyPath = getLegacyTokenPath(email);
      if (existsSync(tokenPath)) unlinkSync(tokenPath);
      if (existsSync(legacyPath)) unlinkSync(legacyPath);

      console.log(`Removed Google account ${email}.`);
      rl.close();
      return;
    }

    // Check Zoho accounts
    const zohoIdx = config.zohoAccounts.findIndex((z) => z.email === email);
    if (zohoIdx !== -1) {
      config.zohoAccounts.splice(zohoIdx, 1);
      saveConfig(config);

      const tokenPath = getZohoTokenPath(email);
      if (existsSync(tokenPath)) unlinkSync(tokenPath);

      console.log(`Removed Zoho account ${email}.`);
      rl.close();
      return;
    }

    console.error(`Error: Account ${email} not found.`);
    rl.close();
    process.exit(1);
  }

  // Default: authenticate all accounts
  const config = loadConfig();
  const gmailAccounts = config.gmailAccounts.length > 0 ? config.gmailAccounts : config.accounts;
  const hasAny = gmailAccounts.length > 0 || config.zohoAccounts.length > 0;

  if (!hasAny) {
    console.log("No accounts configured.\n");
    console.log("Add an account using:");
    console.log("  glancebar auth --add your-email@gmail.com\n");
    rl.close();
    return;
  }

  console.log("Glancebar - Calendar Authentication");
  console.log("====================================\n");

  // Authenticate Google accounts
  for (const account of gmailAccounts) {
    let tokenPath = getGoogleTokenPath(account);
    if (!existsSync(tokenPath)) {
      tokenPath = getLegacyTokenPath(account);
    }
    if (existsSync(tokenPath)) {
      console.log(`Google: ${account} - Already authenticated`);
      const answer = await prompt(`Re-authenticate? (y/N): `);
      if (answer.toLowerCase() !== "y") continue;
    }
    await authenticateGoogleAccount(account);
  }

  // Authenticate Zoho accounts
  for (const account of config.zohoAccounts) {
    const tokenPath = getZohoTokenPath(account.email);
    if (existsSync(tokenPath)) {
      console.log(`Zoho: ${account.email} [${account.datacenter}] - Already authenticated`);
      const answer = await prompt(`Re-authenticate? (y/N): `);
      if (answer.toLowerCase() !== "y") continue;
    }
    await authenticateZohoAccount(account);
  }

  rl.close();
  console.log("\nAll accounts authenticated!");
}

function handleConfig(args: string[]) {
  const config = loadConfig();

  // Handle --reset
  if (args.includes("--reset")) {
    // Preserve all account types
    const { accounts, gmailAccounts, zohoAccounts } = config;
    saveConfig({ ...DEFAULT_CONFIG, accounts, gmailAccounts, zohoAccounts });
    console.log("Configuration reset to defaults (accounts preserved).");
    return;
  }

  // Handle --lookahead
  const lookaheadIndex = args.indexOf("--lookahead");
  if (lookaheadIndex !== -1) {
    const value = parseInt(args[lookaheadIndex + 1], 10);
    if (isNaN(value) || value < 1 || value > 168) {
      console.error("Error: lookahead must be between 1 and 168 hours");
      process.exit(1);
    }
    config.lookaheadHours = value;
    saveConfig(config);
    console.log(`Lookahead hours set to ${value}`);
    return;
  }

  // Handle --countdown-threshold
  const countdownIndex = args.indexOf("--countdown-threshold");
  if (countdownIndex !== -1) {
    const value = parseInt(args[countdownIndex + 1], 10);
    if (isNaN(value) || value < 0 || value > 1440) {
      console.error("Error: countdown-threshold must be between 0 and 1440 minutes");
      process.exit(1);
    }
    config.countdownThresholdMinutes = value;
    saveConfig(config);
    console.log(`Countdown threshold set to ${value} minutes`);
    return;
  }

  // Handle --max-title
  const maxTitleIndex = args.indexOf("--max-title");
  if (maxTitleIndex !== -1) {
    const value = parseInt(args[maxTitleIndex + 1], 10);
    if (isNaN(value) || value < 10 || value > 500) {
      console.error("Error: max-title must be between 10 and 500");
      process.exit(1);
    }
    config.maxTitleLength = value;
    saveConfig(config);
    console.log(`Max title length set to ${value}`);
    return;
  }

  // Handle --show-calendar
  const showCalIndex = args.indexOf("--show-calendar");
  if (showCalIndex !== -1) {
    const value = args[showCalIndex + 1]?.toLowerCase();
    if (value !== "true" && value !== "false") {
      console.error("Error: --show-calendar must be 'true' or 'false'");
      process.exit(1);
    }
    config.showCalendarName = value === "true";
    saveConfig(config);
    console.log(`Show calendar name set to ${value}`);
    return;
  }

  // Handle --water-reminder
  const waterReminderIndex = args.indexOf("--water-reminder");
  if (waterReminderIndex !== -1) {
    const value = args[waterReminderIndex + 1]?.toLowerCase();
    if (value !== "true" && value !== "false") {
      console.error("Error: --water-reminder must be 'true' or 'false'");
      process.exit(1);
    }
    config.waterReminderEnabled = value === "true";
    saveConfig(config);
    console.log(`Water reminder ${value === "true" ? "enabled" : "disabled"}`);
    return;
  }

  // Handle --stretch-reminder
  const stretchReminderIndex = args.indexOf("--stretch-reminder");
  if (stretchReminderIndex !== -1) {
    const value = args[stretchReminderIndex + 1]?.toLowerCase();
    if (value !== "true" && value !== "false") {
      console.error("Error: --stretch-reminder must be 'true' or 'false'");
      process.exit(1);
    }
    config.stretchReminderEnabled = value === "true";
    saveConfig(config);
    console.log(`Stretch reminder ${value === "true" ? "enabled" : "disabled"}`);
    return;
  }

  // Handle --eye-reminder
  const eyeReminderIndex = args.indexOf("--eye-reminder");
  if (eyeReminderIndex !== -1) {
    const value = args[eyeReminderIndex + 1]?.toLowerCase();
    if (value !== "true" && value !== "false") {
      console.error("Error: --eye-reminder must be 'true' or 'false'");
      process.exit(1);
    }
    config.eyeReminderEnabled = value === "true";
    saveConfig(config);
    console.log(`Eye break reminder ${value === "true" ? "enabled" : "disabled"}`);
    return;
  }

  // Handle --cpu-usage
  const cpuUsageIndex = args.indexOf("--cpu-usage");
  if (cpuUsageIndex !== -1) {
    const value = args[cpuUsageIndex + 1]?.toLowerCase();
    if (value !== "true" && value !== "false") {
      console.error("Error: --cpu-usage must be 'true' or 'false'");
      process.exit(1);
    }
    config.showCpuUsage = value === "true";
    saveConfig(config);
    console.log(`CPU usage display ${value === "true" ? "enabled" : "disabled"}`);
    return;
  }

  // Handle --memory-usage
  const memoryUsageIndex = args.indexOf("--memory-usage");
  if (memoryUsageIndex !== -1) {
    const value = args[memoryUsageIndex + 1]?.toLowerCase();
    if (value !== "true" && value !== "false") {
      console.error("Error: --memory-usage must be 'true' or 'false'");
      process.exit(1);
    }
    config.showMemoryUsage = value === "true";
    saveConfig(config);
    console.log(`Memory usage display ${value === "true" ? "enabled" : "disabled"}`);
    return;
  }

  // Handle --zoho-tasks
  const zohoTasksIndex = args.indexOf("--zoho-tasks");
  if (zohoTasksIndex !== -1) {
    const value = args[zohoTasksIndex + 1]?.toLowerCase();
    if (value !== "true" && value !== "false") {
      console.error("Error: --zoho-tasks must be 'true' or 'false'");
      process.exit(1);
    }
    config.showZohoTasks = value === "true";
    saveConfig(config);
    console.log(`Zoho tasks display ${value === "true" ? "enabled" : "disabled"}`);
    return;
  }

  // Handle --max-tasks
  const maxTasksIndex = args.indexOf("--max-tasks");
  if (maxTasksIndex !== -1) {
    const value = parseInt(args[maxTasksIndex + 1], 10);
    if (isNaN(value) || value < 1 || value > 10) {
      console.error("Error: --max-tasks must be between 1 and 10");
      process.exit(1);
    }
    config.maxTasksToShow = value;
    saveConfig(config);
    console.log(`Max tasks to show set to ${value}`);
    return;
  }

  // Handle --show-usage-limits
  const showUsageLimitsIndex = args.indexOf("--show-usage-limits");
  if (showUsageLimitsIndex !== -1) {
    const value = args[showUsageLimitsIndex + 1]?.toLowerCase();
    if (value !== "true" && value !== "false") {
      console.error("Error: --show-usage-limits must be 'true' or 'false'");
      process.exit(1);
    }
    config.showUsageLimits = value === "true";
    saveConfig(config);
    console.log(`Usage limits display ${value === "true" ? "enabled" : "disabled"}`);
    return;
  }

  // Handle --show-5hour-limit
  const show5HourIndex = args.indexOf("--show-5hour-limit");
  if (show5HourIndex !== -1) {
    const value = args[show5HourIndex + 1]?.toLowerCase();
    if (value !== "true" && value !== "false") {
      console.error("Error: --show-5hour-limit must be 'true' or 'false'");
      process.exit(1);
    }
    config.show5HourLimit = value === "true";
    saveConfig(config);
    console.log(`5-hour limit display ${value === "true" ? "enabled" : "disabled"}`);
    return;
  }

  // Handle --show-7day-limit
  const show7DayIndex = args.indexOf("--show-7day-limit");
  if (show7DayIndex !== -1) {
    const value = args[show7DayIndex + 1]?.toLowerCase();
    if (value !== "true" && value !== "false") {
      console.error("Error: --show-7day-limit must be 'true' or 'false'");
      process.exit(1);
    }
    config.show7DayLimit = value === "true";
    saveConfig(config);
    console.log(`7-day limit display ${value === "true" ? "enabled" : "disabled"}`);
    return;
  }

  // Handle --usage-cache-ttl
  const cacheTTLIndex = args.indexOf("--usage-cache-ttl");
  if (cacheTTLIndex !== -1) {
    const value = parseInt(args[cacheTTLIndex + 1], 10);
    if (isNaN(value) || value < 60 || value > 3600) {
      console.error("Error: --usage-cache-ttl must be between 60 and 3600 seconds");
      process.exit(1);
    }
    config.usageLimitsCacheTTL = value;
    saveConfig(config);
    console.log(`API cache TTL set to ${value} seconds`);
    return;
  }

  // Show current config
  const gmailAccounts = config.gmailAccounts.length > 0 ? config.gmailAccounts : config.accounts;
  const googleStr = gmailAccounts.length > 0 ? gmailAccounts.join(", ") : "(none)";
  const zohoStr = config.zohoAccounts.length > 0
    ? config.zohoAccounts.map((z) => `${z.email} [${z.datacenter}]`).join(", ")
    : "(none)";

  console.log(`
Glancebar Configuration
=======================
Config directory:    ${getConfigDir()}

Accounts:
  Google Calendar:   ${googleStr}
  Zoho Calendar:     ${zohoStr}

Calendar Settings:
  Lookahead hours:     ${config.lookaheadHours}
  Countdown threshold: ${config.countdownThresholdMinutes} minutes
  Max title length:    ${config.maxTitleLength}
  Show calendar name:  ${config.showCalendarName}

Reminders:
  Water reminder:      ${config.waterReminderEnabled ? "enabled" : "disabled"}
  Stretch reminder:    ${config.stretchReminderEnabled ? "enabled" : "disabled"}
  Eye break reminder:  ${config.eyeReminderEnabled ? "enabled" : "disabled"}

System Stats:
  CPU usage:           ${config.showCpuUsage ? "enabled" : "disabled"}
  Memory usage:        ${config.showMemoryUsage ? "enabled" : "disabled"}

Zoho Tasks:
  Show tasks:          ${config.showZohoTasks ? "enabled" : "disabled"}
  Max tasks to show:   ${config.maxTasksToShow}

Usage Limits:
  Show usage limits:   ${config.showUsageLimits ? "enabled" : "disabled"}
  Show 5-hour limit:   ${config.show5HourLimit ? "enabled" : "disabled"}
  Show 7-day limit:    ${config.show7DayLimit ? "enabled" : "disabled"}
  Cache TTL:           ${config.usageLimitsCacheTTL} seconds
`);
}

function getRandomReminder(config: Config): string | null {
  const enabledReminders: Array<() => string> = [];

  if (config.waterReminderEnabled) {
    enabledReminders.push(() => {
      const reminder = WATER_REMINDERS[Math.floor(Math.random() * WATER_REMINDERS.length)];
      return `${COLORS.brightCyan}${reminder}${COLORS.reset}`;
    });
  }

  if (config.stretchReminderEnabled) {
    enabledReminders.push(() => {
      const reminder = STRETCH_REMINDERS[Math.floor(Math.random() * STRETCH_REMINDERS.length)];
      return `${COLORS.brightGreen}${reminder}${COLORS.reset}`;
    });
  }

  if (config.eyeReminderEnabled) {
    enabledReminders.push(() => {
      const reminder = EYE_REMINDERS[Math.floor(Math.random() * EYE_REMINDERS.length)];
      return `${COLORS.brightMagenta}${reminder}${COLORS.reset}`;
    });
  }

  if (enabledReminders.length === 0) return null;

  // ~5% chance to show any reminder (reduced from 30% to be less intrusive)
  if (Math.random() >= 0.05) return null;

  // Pick a random reminder type from enabled ones
  const randomPicker = enabledReminders[Math.floor(Math.random() * enabledReminders.length)];
  return randomPicker();
}

interface ClaudeCodeStatus {
  model?: { display_name?: string };
  cost?: {
    total_cost_usd?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  cwd?: string;
  workspace?: {
    project_dir?: string;
  };
  context_window?: {
    context_window_size?: number;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

function getGitBranch(cwd?: string): string | null {
  try {
    const { execSync } = require("child_process");
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: cwd || process.cwd(),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // Check if there are uncommitted changes
    let isDirty = false;
    try {
      const status = execSync("git status --porcelain", {
        cwd: cwd || process.cwd(),
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      isDirty = status.length > 0;
    } catch {}

    return isDirty ? `${branch}*` : branch;
  } catch {
    return null;
  }
}

function getProjectName(projectDir?: string): string | null {
  if (!projectDir) return null;
  // Extract the last part of the path as project name
  const parts = projectDir.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

async function readStdinJson(): Promise<ClaudeCodeStatus | null> {
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(chunk);
    }
    if (chunks.length === 0) return null;
    const text = Buffer.concat(chunks).toString("utf-8").trim();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatSessionInfo(status: ClaudeCodeStatus): string {
  const parts: string[] = [];

  // Project name
  const projectName = getProjectName(status.workspace?.project_dir);
  if (projectName) {
    parts.push(`${COLORS.brightBlue}${projectName}${COLORS.reset}`);
  }

  // Git branch
  const gitBranch = getGitBranch(status.cwd || status.workspace?.project_dir);
  if (gitBranch) {
    parts.push(`${COLORS.magenta}${gitBranch}${COLORS.reset}`);
  }

  // Model name
  if (status.model?.display_name) {
    parts.push(`${COLORS.brightYellow}${status.model.display_name}${COLORS.reset}`);
  }

  // Cost
  if (status.cost?.total_cost_usd !== undefined) {
    const cost = status.cost.total_cost_usd;
    const costStr = cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
    parts.push(`${COLORS.green}${costStr}${COLORS.reset}`);
  }

  // Lines changed
  const linesAdded = status.cost?.total_lines_added || 0;
  const linesRemoved = status.cost?.total_lines_removed || 0;
  if (linesAdded > 0 || linesRemoved > 0) {
    const linesStr = `${COLORS.green}+${linesAdded}${COLORS.reset} ${COLORS.red}-${linesRemoved}${COLORS.reset}`;
    parts.push(linesStr);
  }

  // Context usage (using current_usage for accurate context window state)
  if (status.context_window?.current_usage && status.context_window?.context_window_size) {
    const usage = status.context_window.current_usage;
    // Sum all token types for total context usage
    const totalUsed =
      (usage.input_tokens || 0) +
      (usage.output_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.cache_read_input_tokens || 0);
    const windowSize = status.context_window.context_window_size;
    const percentage = Math.round((totalUsed / windowSize) * 100);
    const usedK = (totalUsed / 1000).toFixed(1);
    const windowK = Math.round(windowSize / 1000);

    // Color based on usage: green < 50%, yellow 50-80%, red > 80%
    let color = COLORS.green;
    if (percentage >= 80) color = COLORS.red;
    else if (percentage >= 50) color = COLORS.yellow;

    parts.push(`${color}${usedK}k/${windowK}k (${percentage}%)${COLORS.reset}`);
  }

  return parts.join(" | ");
}

async function outputStatusline() {
  try {
    const config = loadConfig();

    // Read and parse stdin from Claude Code
    const status = await readStdinJson();
    const parts: string[] = [];

    // Add session info from Claude Code
    if (status) {
      const sessionInfo = formatSessionInfo(status);
      if (sessionInfo) {
        parts.push(sessionInfo);
      }
    }

    // Fetch and display usage limits
    if (config.showUsageLimits) {
      const usageLimits = await getUsageLimits(config);
      if (usageLimits) {
        const limitsStr = formatUsageLimits(usageLimits, config);
        if (limitsStr) {
          parts.push(limitsStr);
        }
      }
    }

    // Add system stats if enabled
    if (config.showCpuUsage) {
      const cpu = getCpuUsage();
      if (cpu) parts.push(cpu);
    }
    if (config.showMemoryUsage) {
      const mem = getMemoryUsage();
      if (mem) parts.push(mem);
    }

    // Check for health reminder (water, stretch, eye break)
    const reminder = getRandomReminder(config);
    if (reminder) {
      parts.push(reminder);
    }

    // Get calendar events and tasks in parallel
    const gmailAccounts = config.gmailAccounts.length > 0 ? config.gmailAccounts : config.accounts;
    const hasAccounts = gmailAccounts.length > 0 || config.zohoAccounts.length > 0;

    if (hasAccounts) {
      const [events, tasks] = await Promise.all([
        getUpcomingEvents(config),
        getZohoTasks(config),
      ]);

      const event = getCurrentOrNextEvent(events);

      // Check for meeting warning (within 5 minutes)
      const meetingWarning = getMeetingWarning(event);
      if (meetingWarning) {
        parts.push(meetingWarning);
      }

      // Add tasks if available
      const tasksStr = formatTasks(tasks);
      if (tasksStr) {
        parts.push(tasksStr);
      }

      if (event) {
        parts.push(formatEvent(event, config));
      } else if (parts.length === 0) {
        parts.push("No upcoming events");
      }
    } else if (parts.length === 0) {
      parts.push("No accounts configured");
    }

    console.log(parts.join(" | "));
  } catch {
    console.log("Calendar unavailable");
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    // Default: output statusline
    await outputStatusline();
    return;
  }

  switch (command) {
    case "version":
    case "--version":
    case "-v":
      console.log(`@naarang/glancebar v${VERSION}`);
      break;

    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;

    case "setup":
      printSetup();
      break;

    case "auth":
      await handleAuth(args.slice(1));
      break;

    case "config":
      handleConfig(args.slice(1));
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run 'glancebar --help' for usage.");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
