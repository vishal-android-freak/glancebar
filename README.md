# @naarang/glancebar

[![npm version](https://img.shields.io/npm/v/%40naarang%2Fglancebar)](https://www.npmjs.com/package/@naarang/glancebar)
[![license](https://img.shields.io/github/license/vishal-android-freak/glancebar)](https://github.com/vishal-android-freak/glancebar/blob/main/LICENSE)

A customizable statusline for [Claude Code](https://claude.com/product/claude-code) - display calendar events, tasks, and more at a glance.

## Features

- **Session info** - Project name, git branch, model, cost, lines changed, and context usage
- **System stats** - CPU and memory usage (optional)
- **Calendar events** - Upcoming events from multiple Google accounts
- **Meeting warnings** - Red alert when a meeting is 5 minutes away
- **Health reminders** - Water, stretch, and eye break reminders
- **Color-coded** - Everything has distinct colors for quick scanning
- **Fully configurable** via CLI
- **Cross-platform** support (Windows, macOS, Linux)

## Requirements

- [Bun](https://bun.sh/) >= 1.0.0
- Google Cloud project with Calendar API enabled

## Installation

### Using bunx (recommended)

```bash
bunx @naarang/glancebar --help
```

### Global installation

```bash
bun install -g @naarang/glancebar
```

### Using npm

```bash
npx @naarang/glancebar --help
# or
npm install -g @naarang/glancebar
```

## Quick Start

```bash
# 1. Run setup guide
glancebar setup

# 2. Add your Google account (after setting up credentials)
glancebar auth --add your-email@gmail.com

# 3. Test it
glancebar
```

## Setup

### 1. Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the **Google Calendar API**:
   - Go to "APIs & Services" > "Library"
   - Search for "Google Calendar API" and enable it

### 2. Create OAuth Credentials

1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "OAuth client ID"
3. Select "Desktop app" as application type
4. Download the JSON file
5. Rename to `credentials.json` and save to `~/.glancebar/credentials.json`

### 3. Add Redirect URI

In Google Cloud Console, edit your OAuth client and add:

```
http://localhost:3000/callback
```

### 4. Add Accounts

```bash
glancebar auth --add your-email@gmail.com
glancebar auth --add work@company.com
```

### 5. Configure Claude Code

Update `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bunx @naarang/glancebar",
    "padding": 0
  }
}
```

## Usage

### Statusline Output

```bash
glancebar
# Output: In 15m: Team Standup (work)
```

### Commands

| Command | Description |
|---------|-------------|
| `glancebar` | Display statusline output |
| `glancebar auth` | Re-authenticate all accounts |
| `glancebar auth --add <email>` | Add a new account |
| `glancebar auth --remove <email>` | Remove an account |
| `glancebar auth --list` | List all accounts |
| `glancebar config` | Show current configuration |
| `glancebar setup` | Show setup instructions |
| `glancebar --help` | Show help |

### Configuration Options

```bash
# Set lookahead hours (how far ahead to look for events)
glancebar config --lookahead 12

# Set countdown threshold (show "In Xm" instead of time)
glancebar config --countdown-threshold 30

# Set max title length
glancebar config --max-title 80

# Toggle calendar name display
glancebar config --show-calendar false

# Enable/disable health reminders
glancebar config --water-reminder true
glancebar config --stretch-reminder true
glancebar config --eye-reminder true

# Enable/disable system stats
glancebar config --cpu-usage true
glancebar config --memory-usage true

# Reset to defaults
glancebar config --reset
```

## Display Format

Example output:
```
glancebar | main* | Opus | $0.12 | +156 -23 | 9.7k/200k (5%) | In 15m: Team Standup (work)
```

### Session Info (from Claude Code)

| Field | Color | Example |
|-------|-------|---------|
| Project name | Blue | `glancebar`, `my-app` |
| Git branch | Magenta | `main`, `feature-x*` (asterisk = uncommitted changes) |
| Model name | Yellow | `Opus`, `Sonnet` |
| Cost | Green | `$0.01`, `$0.1234` |
| Lines changed | Green/Red | `+156 -23` |
| Context usage | Green/Yellow/Red | `9.7k/200k (5%)` |
| CPU usage | Green/Yellow/Red | `CPU 12%` |
| Memory usage | Green/Yellow/Red | `Mem 8.2/16.0GB` |

Context usage color changes based on percentage:
- **Green**: < 50%
- **Yellow**: 50-80%
- **Red**: > 80%

### Calendar Events

| State | Format | Example |
|-------|--------|---------|
| **Meeting warning** | Red alert when ≤5m away | `Meeting in 3m - wrap up!` |
| Upcoming (within threshold) | `In Xm: Title (account)` | `In 15m: Team Standup (work)` |
| Current | `Now: Title (account)` | `Now: Team Standup (work)` |
| Later | `HH:MM AM/PM: Title (account)` | `2:30 PM: Meeting (work)` |
| No events | `No upcoming events` | |

### Health Reminders (~30% chance)

| Type | Color | Example |
|------|-------|---------|
| Water | Cyan | `Stay hydrated! Drink some water` |
| Stretch | Green | `Time to stretch! Stand up and move` |
| Eye break | Magenta | `Eye break! Look 20ft away for 20s` |

## Configuration

All configuration is stored in `~/.glancebar/`:

```
~/.glancebar/
├── config.json        # User settings
├── credentials.json   # Google OAuth credentials (you provide this)
└── tokens/            # OAuth tokens per account
    └── <email>.json
```

### Default Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `lookaheadHours` | 8 | Hours ahead to look for events |
| `countdownThresholdMinutes` | 60 | Minutes threshold for countdown display |
| `maxTitleLength` | 120 | Maximum event title length |
| `showCalendarName` | true | Show account name after event |
| `waterReminderEnabled` | true | Enable random water break reminders |
| `stretchReminderEnabled` | true | Enable random stretch/posture reminders |
| `eyeReminderEnabled` | true | Enable random eye break reminders (20-20-20 rule) |
| `showCpuUsage` | false | Show CPU usage percentage |
| `showMemoryUsage` | false | Show memory usage |

## Building from Source

```bash
# Clone the repository
git clone https://github.com/vishal-android-freak/glancebar.git
cd glancebar

# Install dependencies
bun install

# Run locally
bun run dev

# Build binaries for all platforms
bun run build:all
```

### Build Targets

| Platform | Command |
|----------|---------|
| Linux x64 | `bun run build:linux-x64` |
| Linux ARM64 | `bun run build:linux-arm64` |
| macOS x64 | `bun run build:darwin-x64` |
| macOS ARM64 | `bun run build:darwin-arm64` |
| Windows x64 | `bun run build:win-x64` |

## Roadmap

- [ ] Task integration (Todoist, Google Tasks)
- [ ] Weather information
- [ ] System stats
- [ ] Custom modules

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Author

**Vishal Dubey** ([@vishal-android-freak](https://github.com/vishal-android-freak))

## License

[MIT](LICENSE)
