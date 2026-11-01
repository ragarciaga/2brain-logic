import type { CalendarEvent } from "./types.js";

// Pure picker of the calendar event a recording belongs to (docs/specs/05-meetings, R4). No I/O.

function eligibleWindow(event: CalendarEvent): { start: number; end: number } | undefined {
  if (event.start.date !== undefined) return undefined;
  const { dateTime: startText } = event.start;
  const { dateTime: endText } = event.end;
  if (startText === undefined || endText === undefined) return undefined;
  if (event.status === "cancelled") return undefined;
  if (event.attendees?.some((a) => a.self === true && a.responseStatus === "declined")) {
    return undefined;
  }
  const start = Date.parse(startText);
  const end = Date.parse(endText);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return { start, end };
}

/**
 * The timed, non-cancelled, not self-declined event with the longest overlap with the recording,
 * or undefined. Ties go to the earlier start, then the smaller id.
 */
export function pickEvent(
  events: CalendarEvent[],
  start: Date,
  end: Date,
): CalendarEvent | undefined {
  const recStart = start.getTime();
  const recEnd = end.getTime();
  let best: { event: CalendarEvent; overlap: number; start: number } | undefined;
  for (const event of events) {
    const window = eligibleWindow(event);
    if (window === undefined) continue;
    const overlap = Math.min(recEnd, window.end) - Math.max(recStart, window.start);
    if (!(overlap > 0)) continue;
    if (
      best === undefined ||
      overlap > best.overlap ||
      (overlap === best.overlap && window.start < best.start) ||
      (overlap === best.overlap && window.start === best.start && event.id < best.event.id)
    ) {
      best = { event, overlap, start: window.start };
    }
  }
  return best?.event;
}
