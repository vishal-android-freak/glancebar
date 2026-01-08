import { google } from "googleapis";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { createServer, Server } from "http";
import { createInterface } from "readline";
import { loadConfig, saveConfig, getTokensDir, getCredentialsPath } from "./config";

const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const REDIRECT_URI = "http://localhost:3000/callback";

interface Credentials {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

interface TokenData {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
}

function loadCredentials(): Credentials {
  const credPath = getCredentialsPath();
  if (!existsSync(credPath)) {
    throw new Error(
      `credentials.json not found at ${credPath}. Please download OAuth credentials from Google Cloud Console.`
    );
  }
  return JSON.parse(readFileSync(credPath, "utf-8"));
}

function getTokenPath(account: string): string {
  const safeAccount = account.replace(/[^a-zA-Z0-9@.-]/g, "_");
  return join(getTokensDir(), `${safeAccount}.json`);
}

function createOAuth2Client(credentials: Credentials) {
  const { client_id, client_secret } =
    credentials.installed || credentials.web!;
  return new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
}

export function getAuthenticatedClient(account: string) {
  const credentials = loadCredentials();
  const oauth2Client = createOAuth2Client(credentials);
  const tokenPath = getTokenPath(account);

  if (!existsSync(tokenPath)) {
    return null;
  }

  const token: TokenData = JSON.parse(readFileSync(tokenPath, "utf-8"));
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

      // Only handle the callback path
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

        // Give time for response to be sent, then close
        setTimeout(() => {
          server.close(() => {
            resolve(code);
          });
        }, 500);
      } else {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Authentication failed</h1><p>No code received.</p></body></html>");
      }
    });

    server.listen(3000, () => {
      // Open browser
      openBrowser(authUrl);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error("Port 3000 is already in use. Please close any application using it and try again."));
      } else {
        reject(err);
      }
    });

    // Timeout after 5 minutes
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

function printUsage() {
  console.log(`
Google Calendar Statusline - Authentication

Usage:
  bun run auth                     Authenticate all configured accounts
  bun run auth --add <email>       Add a new account and authenticate it
  bun run auth --remove <email>    Remove an account
  bun run auth --list              List all configured accounts

Examples:
  bun run auth --add user@gmail.com
  bun run auth --add work@company.com
  bun run auth --remove old@email.com
  bun run auth --list
`);
}

async function main() {
  const args = process.argv.slice(2);

  // Handle --help
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

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
    process.exit(0);
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
    process.exit(0);
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

    // Remove token file if exists
    const tokenPath = getTokenPath(email);
    if (existsSync(tokenPath)) {
      const { unlinkSync } = require("fs");
      unlinkSync(tokenPath);
    }

    console.log(`Removed ${email} from accounts.`);
    process.exit(0);
  }

  // Default: authenticate all accounts
  const config = loadConfig();

  if (config.accounts.length === 0) {
    console.log("No accounts configured.\n");
    console.log("Add an account using:");
    console.log("  bun run auth --add your-email@gmail.com\n");
    process.exit(0);
  }

  console.log("Google Calendar OAuth Authentication");
  console.log("====================================\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (question: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        resolve(answer);
      });
    });
  };

  for (const account of config.accounts) {
    const tokenPath = getTokenPath(account);
    if (existsSync(tokenPath)) {
      console.log(`${account}: Already authenticated`);
      const answer = await prompt(`Re-authenticate ${account}? (y/N): `);
      if (answer.toLowerCase() !== "y") {
        continue;
      }
    }

    await authenticateAccount(account);
  }

  rl.close();
  console.log("\nAll accounts authenticated!");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
