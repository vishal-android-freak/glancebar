import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface Config {
  accounts: string[];
  lookaheadHours: number;
  showCalendarName: boolean;
  countdownThresholdMinutes: number;
  maxTitleLength: number;
}

// ANSI color codes
export const COLORS: Record<string, string> = {
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

const DEFAULT_CONFIG: Config = {
  accounts: [],
  lookaheadHours: 8,
  showCalendarName: true,
  countdownThresholdMinutes: 60,
  maxTitleLength: 40,
};

const CONFIG_PATH = join(import.meta.dir, "..", "config.json");

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    const userConfig = JSON.parse(content);
    return { ...DEFAULT_CONFIG, ...userConfig };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function getProjectRoot(): string {
  return join(import.meta.dir, "..");
}

export function getTokensDir(): string {
  return join(getProjectRoot(), "tokens");
}

export function getCredentialsPath(): string {
  return join(getProjectRoot(), "credentials.json");
}
