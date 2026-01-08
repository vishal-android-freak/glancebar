import { getUpcomingEvents, getCurrentOrNextEvent } from "./calendar";
import { formatEvent, formatNoEvents } from "./formatter";

async function main() {
  try {
    for await (const _ of Bun.stdin.stream()) {
      break;
    }
  } catch {
    // stdin may be empty or unavailable
  }

  try {
    const events = await getUpcomingEvents();
    const event = getCurrentOrNextEvent(events);

    if (event) {
      console.log(formatEvent(event, event.accountIndex));
    } else {
      console.log(formatNoEvents());
    }
  } catch (error) {
    console.log("Calendar unavailable");
  }
}

main();
