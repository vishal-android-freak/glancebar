#!/usr/bin/env bun
import { google } from "googleapis";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { createServer, Server } from "http";
import { createInterface } from "readline";

// ============================================================================
// Configuration
// ============================================================================

interface Config {
  accounts: string[];
  lookaheadHours: number;
  showCalendarName: boolean;
  countdownThresholdMinutes: number;
  maxTitleLength: number;
  waterReminderEnabled: boolean;
  waterReminderIntervalMinutes: number;
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
  accounts: [],
  lookaheadHours: 8,
  showCalendarName: true,
  countdownThresholdMinutes: 60,
  maxTitleLength: 120,
  waterReminderEnabled: true,
  waterReminderIntervalMinutes: 30,
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
    return { ...DEFAULT_CONFIG, ...userConfig };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// ============================================================================
// OAuth Authentication
// ============================================================================

const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const REDIRECT_URI = "http://localhost:3000/callback";

interface Credentials {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
}

function getCredentialsPath(): string {
  return join(getConfigDir(), "credentials.json");
}

function loadCredentials(): Credentials {
  const credPath = getCredentialsPath();
  if (!existsSync(credPath)) {
    throw new Error(
      `credentials.json not found at ${credPath}\n\nPlease download OAuth credentials from Google Cloud Console and save to:\n${credPath}\n\nRun 'glancebar setup' for detailed instructions.`
    );
  }
  return JSON.parse(readFileSync(credPath, "utf-8"));
}

function getTokenPath(account: string): string {
  const safeAccount = account.replace(/[^a-zA-Z0-9@.-]/g, "_");
  return join(getTokensDir(), `${safeAccount}.json`);
}

function createOAuth2Client(credentials: Credentials) {
  const { client_id, client_secret } = credentials.installed || credentials.web!;
  return new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
}

function getAuthenticatedClient(account: string) {
  const credentials = loadCredentials();
  const oauth2Client = createOAuth2Client(credentials);
  const tokenPath = getTokenPath(account);

  if (!existsSync(tokenPath)) {
    return null;
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

async function authenticateAccount(account: string): Promise<void> {
  const credentials = loadCredentials();
  const oauth2Client = createOAuth2Client(credentials);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
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

  const tokenPath = getTokenPath(account);
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(`Token saved for ${account}`);
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
}

async function getUpcomingEvents(config: Config): Promise<CalendarEvent[]> {
  const allEvents: CalendarEvent[] = [];
  const now = new Date();
  const timeMax = new Date(now.getTime() + config.lookaheadHours * 60 * 60 * 1000);

  const eventPromises = config.accounts.map(async (account, accountIndex) => {
    try {
      const auth = getAuthenticatedClient(account);
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
        };
      });
    } catch {
      return [];
    }
  });

  const results = await Promise.all(eventPromises);
  for (const events of results) {
    allEvents.push(...events);
  }

  allEvents.sort((a, b) => a.start.getTime() - b.start.getTime());
  return allEvents;
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
  glancebar auth --add <email>       Add and authenticate a new account
  glancebar auth --remove <email>    Remove an account
  glancebar auth --list              List configured accounts
  glancebar config                   Show current configuration
  glancebar config --lookahead <hours>           Set lookahead hours (default: 8)
  glancebar config --countdown-threshold <mins>  Set countdown threshold in minutes (default: 60)
  glancebar config --max-title <length>          Set max title length (default: 120)
  glancebar config --show-calendar <true|false>  Show calendar name (default: true)
  glancebar config --water-reminder <true|false> Enable/disable water reminders (default: true)
  glancebar config --water-interval <mins>       Set water reminder interval (default: 30)
  glancebar config --reset           Reset to default configuration
  glancebar setup                    Show setup instructions

Examples:
  glancebar auth --add user@gmail.com
  glancebar config --lookahead 12
  glancebar config --water-interval 45

Config location: ${getConfigDir()}
`);
}

function printSetup() {
  console.log(`
Glancebar - Setup Instructions
==============================

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
   - Save it to: ${getCredentialsPath()}

Step 5: Add redirect URI
   - In Google Cloud Console, edit your OAuth client
   - Add redirect URI: http://localhost:3000/callback

Step 6: Add your Google accounts
   glancebar auth --add your-email@gmail.com
   glancebar auth --add work@company.com

Step 7: Configure Claude Code statusline
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
  // Handle --list
  if (args.includes("--list")) {
    const config = loadConfig();
    if (config.accounts.length === 0) {
      console.log("No accounts configured.");
    } else {
      console.log("Configured accounts:");
      config.accounts.forEach((acc, i) => {
        const tokenPath = getTokenPath(acc);
        const status = existsSync(tokenPath) ? "authenticated" : "not authenticated";
        console.log(`  ${i + 1}. ${acc} (${status})`);
      });
    }
    return;
  }

  // Handle --add
  const addIndex = args.indexOf("--add");
  if (addIndex !== -1) {
    const email = args[addIndex + 1];
    if (!email || email.startsWith("--")) {
      console.error("Error: Please provide an email address after --add");
      process.exit(1);
    }

    if (!email.includes("@")) {
      console.error("Error: Invalid email address");
      process.exit(1);
    }

    const config = loadConfig();
    if (config.accounts.includes(email)) {
      console.log(`Account ${email} already exists. Re-authenticating...`);
    } else {
      config.accounts.push(email);
      saveConfig(config);
      console.log(`Added ${email} to accounts.`);
    }

    await authenticateAccount(email);
    console.log("\nDone!");
    return;
  }

  // Handle --remove
  const removeIndex = args.indexOf("--remove");
  if (removeIndex !== -1) {
    const email = args[removeIndex + 1];
    if (!email || email.startsWith("--")) {
      console.error("Error: Please provide an email address after --remove");
      process.exit(1);
    }

    const config = loadConfig();
    const idx = config.accounts.indexOf(email);
    if (idx === -1) {
      console.error(`Error: Account ${email} not found.`);
      process.exit(1);
    }

    config.accounts.splice(idx, 1);
    saveConfig(config);

    const tokenPath = getTokenPath(email);
    if (existsSync(tokenPath)) {
      unlinkSync(tokenPath);
    }

    console.log(`Removed ${email} from accounts.`);
    return;
  }

  // Default: authenticate all accounts
  const config = loadConfig();

  if (config.accounts.length === 0) {
    console.log("No accounts configured.\n");
    console.log("Add an account using:");
    console.log("  glancebar auth --add your-email@gmail.com\n");
    return;
  }

  console.log("Glancebar - Google Calendar Authentication");
  console.log("==========================================\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));

  for (const account of config.accounts) {
    const tokenPath = getTokenPath(account);
    if (existsSync(tokenPath)) {
      console.log(`${account}: Already authenticated`);
      const answer = await prompt(`Re-authenticate ${account}? (y/N): `);
      if (answer.toLowerCase() !== "y") continue;
    }
    await authenticateAccount(account);
  }

  rl.close();
  console.log("\nAll accounts authenticated!");
}

function handleConfig(args: string[]) {
  const config = loadConfig();

  // Handle --reset
  if (args.includes("--reset")) {
    const accounts = config.accounts; // Preserve accounts
    saveConfig({ ...DEFAULT_CONFIG, accounts });
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

  // Handle --water-interval
  const waterIntervalIndex = args.indexOf("--water-interval");
  if (waterIntervalIndex !== -1) {
    const value = parseInt(args[waterIntervalIndex + 1], 10);
    if (isNaN(value) || value < 5 || value > 120) {
      console.error("Error: water-interval must be between 5 and 120 minutes");
      process.exit(1);
    }
    config.waterReminderIntervalMinutes = value;
    saveConfig(config);
    console.log(`Water reminder interval set to ${value} minutes`);
    return;
  }

  // Show current config
  console.log(`
Glancebar Configuration
=======================
Config directory:    ${getConfigDir()}
Accounts:            ${config.accounts.length > 0 ? config.accounts.join(", ") : "(none)"}

Calendar Settings:
  Lookahead hours:     ${config.lookaheadHours}
  Countdown threshold: ${config.countdownThresholdMinutes} minutes
  Max title length:    ${config.maxTitleLength}
  Show calendar name:  ${config.showCalendarName}

Reminders:
  Water reminder:      ${config.waterReminderEnabled ? "enabled" : "disabled"}
  Water interval:      ${config.waterReminderIntervalMinutes} minutes
`);
}

function shouldShowWaterReminder(config: Config): boolean {
  if (!config.waterReminderEnabled) return false;

  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();

  // Show water reminder if current minute falls on the interval
  return minutes % config.waterReminderIntervalMinutes === 0;
}

function getWaterReminder(): string {
  const reminder = WATER_REMINDERS[Math.floor(Math.random() * WATER_REMINDERS.length)];
  return `${COLORS.brightCyan}${reminder}${COLORS.reset}`;
}

async function outputStatusline() {
  // Consume stdin (Claude Code sends JSON)
  try {
    for await (const _ of Bun.stdin.stream()) break;
  } catch {}

  try {
    const config = loadConfig();
    const parts: string[] = [];

    // Check for water reminder first
    if (shouldShowWaterReminder(config)) {
      parts.push(getWaterReminder());
    }

    // Get calendar events
    if (config.accounts.length > 0) {
      const events = await getUpcomingEvents(config);
      const event = getCurrentOrNextEvent(events);

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
