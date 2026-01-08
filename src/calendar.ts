import { google, calendar_v3 } from "googleapis";
import { getAuthenticatedClient } from "./auth";
import { loadConfig } from "./config";

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  account: string;
  accountEmail: string;
  accountIndex: number;
}

export async function getUpcomingEvents(): Promise<CalendarEvent[]> {
  const config = loadConfig();
  const allEvents: CalendarEvent[] = [];

  const now = new Date();
  const timeMax = new Date(now.getTime() + config.lookaheadHours * 60 * 60 * 1000);

  const eventPromises = config.accounts.map(async (account, accountIndex) => {
    try {
      const auth = getAuthenticatedClient(account);
      if (!auth) {
        return [];
      }

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
      return events.map((event) => parseEvent(event, account, accountIndex));
    } catch (error) {
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

function parseEvent(
  event: calendar_v3.Schema$Event,
  account: string,
  accountIndex: number
): CalendarEvent {
  const isAllDay = !event.start?.dateTime;

  let start: Date;
  let end: Date;

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
}

function extractAccountName(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) return email;

  const domain = email.slice(atIndex + 1);
  if (domain === "gmail.com") {
    return email.slice(0, atIndex);
  }

  const domainParts = domain.split(".");
  return domainParts[0];
}

export function getCurrentOrNextEvent(events: CalendarEvent[]): CalendarEvent | null {
  const now = new Date();

  for (const event of events) {
    if (event.start <= now && event.end > now) {
      return event;
    }
  }

  for (const event of events) {
    if (event.start > now) {
      return event;
    }
  }

  return null;
}
