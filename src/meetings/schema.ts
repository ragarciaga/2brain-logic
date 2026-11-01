import { z } from "zod";
import type { CalendarEvent, FirefliesBody, GeminiBody, MeetingBody } from "./types.js";

// Boundary validation for POST /meetings. Pure: no I/O, no config, no LLM.
// Every message below is a fixed string; none interpolates received input, so a ZodError
// carries paths and messages only (R1.3).

export const MAX_SEGMENTS = 50_000;
export const MAX_PARTICIPANTS = 500;
export const MAX_CALENDAR_EVENTS = 50;
export const MAX_DURATION_MINUTES = 12 * 60;

/** Meet transcript state that means the transcript file exists (resolved decision, F5 T2). */
export const GEMINI_FINISHED_STATE = "FILE_GENERATED";

/** Thrown when a Gemini transcript is not finished yet (maps to 409 transcript_not_ready). */
export class TranscriptNotReadyError extends Error {
  constructor() {
    super("transcript is not finished yet");
    this.name = "TranscriptNotReadyError";
  }
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|z|[+-]\d{2}:\d{2})$/;

/** Parses an RFC 3339 timestamp (nanosecond fractions allowed) to epoch ms, or undefined. */
export function parseRfc3339(value: string): number | undefined {
  if (!RFC3339.test(value)) return undefined;
  const cut = value.replace(/\.(\d+)/, (_m, frac: string) => `.${frac.slice(0, 3).padEnd(3, "0")}`);
  const ms = Date.parse(cut);
  return Number.isFinite(ms) ? ms : undefined;
}

const rfc3339 = z
  .string()
  .refine((v) => parseRfc3339(v) !== undefined, { error: "must be an RFC 3339 timestamp" });

const optionalString = z.string().optional();

const calendarEvent = z.object({
  id: z.string(),
  calendar_id: optionalString,
  title: optionalString,
  start: z.object({ dateTime: optionalString, date: optionalString }),
  end: z.object({ dateTime: optionalString, date: optionalString }),
  status: optionalString,
  organizer: z.object({ email: optionalString }).optional(),
  attendees: z
    .array(
      z.object({
        email: optionalString,
        displayName: optionalString,
        self: z.boolean().optional(),
        responseStatus: optionalString,
      }),
    )
    .optional(),
});

const calendarEvents = z
  .array(calendarEvent)
  .max(MAX_CALENDAR_EVENTS, { error: "too many calendar events" });

const firefliesSchema = z.object({
  source: z.literal("fireflies"),
  transcript: z.object({
    id: z.string(),
    title: optionalString,
    date: z.number().int().min(0).max(8_000_000_000_000_000),
    duration: z.number().gt(0).max(MAX_DURATION_MINUTES, { error: "recording is too long" }),
    transcript_url: optionalString,
    organizer_email: optionalString,
    participants: z
      .array(z.string())
      .max(MAX_PARTICIPANTS, { error: "too many participants" })
      .optional(),
    meeting_attendees: z
      .array(
        z.object({
          displayName: optionalString,
          email: optionalString,
          name: optionalString,
        }),
      )
      .max(MAX_PARTICIPANTS, { error: "too many participants" })
      .optional(),
    sentences: z
      .array(
        z.object({
          speaker_name: z.string().nullable().optional(),
          text: z.string(),
          start_time: z.number().finite(),
        }),
      )
      .max(MAX_SEGMENTS, { error: "too many segments" }),
  }),
  calendar_events: calendarEvents,
});

const geminiUser = z.object({ displayName: optionalString }).optional();

const geminiSchema = z.object({
  source: z.literal("gemini"),
  conference: z
    .object({ name: z.string(), startTime: rfc3339, endTime: rfc3339 })
    .superRefine((c, ctx) => {
      const start = parseRfc3339(c.startTime);
      const end = parseRfc3339(c.endTime);
      if (start === undefined || end === undefined) return;
      if (end <= start) {
        ctx.addIssue({ code: "custom", path: ["endTime"], message: "end must be after start" });
      } else if (end - start > MAX_DURATION_MINUTES * 60_000) {
        ctx.addIssue({ code: "custom", path: ["endTime"], message: "recording is too long" });
      }
    }),
  transcript: z.object({
    name: z.string(),
    state: z.string(),
    docsDestination: z.object({ exportUri: optionalString }).optional(),
  }),
  participants: z
    .array(
      z.object({
        name: z.string(),
        signedinUser: geminiUser,
        anonymousUser: geminiUser,
        phoneUser: geminiUser,
      }),
    )
    .max(MAX_PARTICIPANTS, { error: "too many participants" }),
  entries: z
    .array(z.object({ participant: z.string(), text: z.string(), startTime: rfc3339 }))
    .max(MAX_SEGMENTS, { error: "too many segments" }),
  calendar_events: calendarEvents,
});

export const meetingBodySchema = z.discriminatedUnion("source", [firefliesSchema, geminiSchema]);

// Compile-time check: the schemas produce the contract types.
type Assignable<T, _U extends T> = true;
export type _SchemaMatchesTypes = [
  Assignable<FirefliesBody, z.infer<typeof firefliesSchema>>,
  Assignable<GeminiBody, z.infer<typeof geminiSchema>>,
  Assignable<CalendarEvent, z.infer<typeof calendarEvent>>,
];

/**
 * Validates a POST /meetings body. Throws ZodError (paths and messages only) or
 * TranscriptNotReadyError for an unfinished Gemini transcript.
 */
export function parseMeetingBody(json: unknown): MeetingBody {
  const body = meetingBodySchema.parse(json);
  if (body.source === "gemini" && body.transcript.state !== GEMINI_FINISHED_STATE) {
    throw new TranscriptNotReadyError();
  }
  return body;
}

/** Returns the URL only when it parses as an absolute https URL (R1.7). */
export function httpsUrl(value?: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}
