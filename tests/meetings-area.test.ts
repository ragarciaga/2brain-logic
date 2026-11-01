import { describe, expect, it } from "vitest";
import { DEFAULT_VAULT_CONFIG } from "../src/config/defaults.js";
import type { VaultConfig } from "../src/config/vault-config.js";
import { routeArea } from "../src/meetings/area.js";
import type { CalendarEvent, MeetingInput } from "../src/meetings/types.js";

function cfgWith(
  rules: { area: string; domain?: string; calendar?: string }[],
  defaultArea: string | null = null,
): VaultConfig {
  const cfg = structuredClone(DEFAULT_VAULT_CONFIG);
  cfg.areas = ["personal", "work"];
  cfg.meetings.area_rules = rules;
  cfg.meetings.default_area = defaultArea;
  return cfg;
}

function input(extra: Partial<MeetingInput> = {}): MeetingInput {
  return {
    source: "fireflies",
    sourceId: "s1",
    start: new Date("2026-03-10T10:00:00Z"),
    end: new Date("2026-03-10T11:00:00Z"),
    people: [],
    segments: [],
    calendarEvents: [],
    ...extra,
  };
}

const event = (extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "e1",
  start: { dateTime: "2026-03-10T10:00:00Z" },
  end: { dateTime: "2026-03-10T11:00:00Z" },
  ...extra,
});

describe("routeArea", () => {
  it("calendar id rule", () => {
    const cfg = cfgWith([{ area: "work", calendar: "cal-1" }], "personal");
    expect(routeArea(event({ calendar_id: "cal-1" }), input(), cfg)).toBe("work");
    expect(routeArea(event({ calendar_id: "cal-2" }), input(), cfg)).toBe("personal");
  });

  it("domain of input organizer", () => {
    const cfg = cfgWith([{ area: "work", domain: "example.com" }], "personal");
    expect(routeArea(event(), input({ organizerEmail: "ana@example.com" }), cfg)).toBe("work");
  });

  it("domain of event organizer", () => {
    const cfg = cfgWith([{ area: "work", domain: "example.com" }], "personal");
    expect(routeArea(event({ organizer: { email: "bo@example.com" } }), input(), cfg)).toBe("work");
  });

  it("domain of a participant", () => {
    const cfg = cfgWith([{ area: "work", domain: "example.com" }], "personal");
    const i = input({ people: [{ name: "Cy" }, { email: "cy@example.com" }] });
    expect(routeArea(event(), i, cfg)).toBe("work");
  });

  it("domain case-insensitive", () => {
    const cfg = cfgWith([{ area: "work", domain: "example.com" }], "personal");
    expect(routeArea(event(), input({ organizerEmail: "Ana@Example.COM" }), cfg)).toBe("work");
    const upper = cfgWith([{ area: "work", domain: " Example.COM " }], "personal");
    expect(routeArea(event(), input({ organizerEmail: "ana@example.com" }), upper)).toBe("work");
  });

  it("first rule wins", () => {
    const i = input({ organizerEmail: "ana@example.com" });
    const e = event({ calendar_id: "cal-1" });
    const a = cfgWith([
      { area: "work", domain: "example.com" },
      { area: "personal", calendar: "cal-1" },
    ]);
    expect(routeArea(e, i, a)).toBe("work");
    const b = cfgWith([
      { area: "personal", calendar: "cal-1" },
      { area: "work", domain: "example.com" },
    ]);
    expect(routeArea(e, i, b)).toBe("personal");
  });

  it("no event: domain rules apply and calendar rules do not", () => {
    const cfg = cfgWith(
      [
        { area: "work", calendar: "cal-1" },
        { area: "personal", domain: "example.com" },
      ],
      "work",
    );
    expect(routeArea(undefined, input({ organizerEmail: "ana@example.com" }), cfg)).toBe(
      "personal",
    );
    expect(routeArea(undefined, input(), cfg)).toBe("work");
  });

  it("no match gives default_area", () => {
    const cfg = cfgWith([{ area: "personal", domain: "example.com" }], "work");
    expect(routeArea(event(), input({ organizerEmail: "ana@example.org" }), cfg)).toBe("work");
  });

  it("null default gives first area", () => {
    const cfg = cfgWith([{ area: "work", domain: "example.com" }], null);
    expect(routeArea(event(), input(), cfg)).toBe("personal");
  });

  it("subdomain does not match", () => {
    const cfg = cfgWith([{ area: "work", domain: "example.com" }], "personal");
    expect(routeArea(event(), input({ organizerEmail: "ana@mail.example.com" }), cfg)).toBe(
      "personal",
    );
  });

  it("values without a usable domain are ignored", () => {
    const cfg = cfgWith([{ area: "work", domain: "example.com" }], "personal");
    const i = input({ organizerEmail: "example.com", people: [{ email: "ana@" }] });
    expect(routeArea(event(), i, cfg)).toBe("personal");
  });
});
