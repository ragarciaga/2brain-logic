import { describe, expect, it } from "vitest";
import { pickEvent } from "../src/meetings/calendar.js";
import type { CalendarEvent } from "../src/meetings/types.js";

const day = "2026-03-10";
const at = (hm: string) => new Date(`${day}T${hm}:00Z`);

function ev(
  id: string,
  from: string,
  to: string,
  extra: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id,
    start: { dateTime: `${day}T${from}:00Z` },
    end: { dateTime: `${day}T${to}:00Z` },
    ...extra,
  };
}

describe("pickEvent", () => {
  const start = at("10:00");
  const end = at("11:00");

  it("longest overlap wins", () => {
    const events = [
      ev("a", "09:00", "10:10"),
      ev("b", "10:00", "10:50"),
      ev("c", "10:40", "12:00"),
    ];
    expect(pickEvent(events, start, end)?.id).toBe("b");
  });

  it("tie earlier start", () => {
    const events = [ev("a", "10:15", "10:45"), ev("b", "09:15", "10:30")];
    expect(pickEvent(events, start, end)?.id).toBe("b");
  });

  it("tie smaller id", () => {
    const events = [ev("b", "10:00", "10:30"), ev("a", "10:00", "10:30")];
    expect(pickEvent(events, start, end)?.id).toBe("a");
  });

  it("all-day ignored", () => {
    const allDay: CalendarEvent = {
      id: "allday",
      start: { date: day },
      end: { date: "2026-03-11" },
    };
    const timed = ev("timed", "10:00", "10:10");
    expect(pickEvent([allDay, timed], start, end)?.id).toBe("timed");
  });

  it("start.date wins over a dateTime", () => {
    const mixed = ev("mixed", "10:00", "11:00");
    mixed.start = { date: day, dateTime: `${day}T10:00:00Z` };
    expect(pickEvent([mixed, ev("timed", "10:00", "10:10")], start, end)?.id).toBe("timed");
  });

  it("cancelled ignored", () => {
    const events = [ev("x", "10:00", "11:00", { status: "cancelled" }), ev("y", "10:00", "10:20")];
    expect(pickEvent(events, start, end)?.id).toBe("y");
  });

  it("self declined ignored", () => {
    const declined = ev("x", "10:00", "11:00", {
      attendees: [{ email: "ana@example.com", self: true, responseStatus: "declined" }],
    });
    expect(pickEvent([declined, ev("y", "10:00", "10:20")], start, end)?.id).toBe("y");
  });

  it("other attendee declined still chosen", () => {
    const e = ev("x", "10:00", "11:00", {
      attendees: [
        { email: "bo@example.com", responseStatus: "declined" },
        { email: "ana@example.com", self: true, responseStatus: "accepted" },
      ],
    });
    expect(pickEvent([e, ev("y", "10:00", "10:20")], start, end)?.id).toBe("x");
  });

  it("no overlap gives undefined", () => {
    const events = [ev("touch", "09:00", "10:00"), ev("after", "11:30", "12:00")];
    expect(pickEvent(events, start, end)).toBeUndefined();
  });

  it("invalid date times are ignored", () => {
    const bad = ev("bad", "10:00", "11:00");
    bad.start = { dateTime: "not a date" };
    expect(pickEvent([bad], start, end)).toBeUndefined();
  });

  it("empty list gives undefined", () => {
    expect(pickEvent([], start, end)).toBeUndefined();
  });

  it("one event chosen", () => {
    expect(pickEvent([ev("only", "10:30", "10:45")], start, end)?.id).toBe("only");
  });
});
