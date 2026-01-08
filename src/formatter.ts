import { CalendarEvent } from "./calendar";
import { loadConfig, COLORS } from "./config";

// Colors auto-assigned to accounts based on their index
const ACCOUNT_COLORS = ["cyan", "magenta", "brightGreen", "orange", "brightBlue", "pink", "yellow", "purple"];

export function formatEvent(event: CalendarEvent, accountIndex: number = 0): string {
  const config = loadConfig();
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

  const title = truncateTitle(event.title, config.maxTitleLength);
  const color = getAccountColor(accountIndex);

  if (config.showCalendarName) {
    return `${color}${timeStr}: ${title} (${event.account})${COLORS.reset}`;
  } else {
    return `${color}${timeStr}: ${title}${COLORS.reset}`;
  }
}

function getAccountColor(index: number): string {
  const colorName = ACCOUNT_COLORS[index % ACCOUNT_COLORS.length];
  return COLORS[colorName] || COLORS.white;
}

function formatCountdown(minutes: number): string {
  if (minutes < 60) {
    return `In ${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (mins === 0) {
    return `In ${hours}h`;
  }

  return `In ${hours}h${mins}m`;
}

function formatTime(date: Date): string {
  const hours = date.getHours();
  const minutes = date.getMinutes();

  const isPM = hours >= 12;
  const hour12 = hours % 12 || 12;
  const minuteStr = minutes.toString().padStart(2, "0");
  const ampm = isPM ? "PM" : "AM";

  return `${hour12}:${minuteStr} ${ampm}`;
}

function truncateTitle(title: string, maxLength: number): string {
  if (title.length <= maxLength) {
    return title;
  }

  return title.slice(0, maxLength - 1) + "…";
}

export function formatNoEvents(): string {
  return "No upcoming events";
}
