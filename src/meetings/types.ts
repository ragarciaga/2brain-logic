import type { Redaction } from "../vault/write-note.js";

// Contract types for POST /meetings (docs/specs/05-meetings/design.md, "Interfaces and contracts").

export type CalendarEvent = {
  id: string;
  calendar_id?: string;
  title?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  status?: string;
  organizer?: { email?: string };
  attendees?: {
    email?: string;
    displayName?: string;
    self?: boolean;
    responseStatus?: string;
  }[];
};

export type FirefliesBody = {
  source: "fireflies";
  transcript: {
    id: string;
    title?: string;
    date: number;
    duration: number;
    transcript_url?: string;
    organizer_email?: string;
    participants?: string[];
    meeting_attendees?: { displayName?: string; email?: string; name?: string }[];
    sentences: { speaker_name?: string | null; text: string; start_time: number }[];
  };
  calendar_events: CalendarEvent[];
};

export type GeminiBody = {
  source: "gemini";
  conference: { name: string; startTime: string; endTime: string };
  transcript: { name: string; state: string; docsDestination?: { exportUri?: string } };
  participants: {
    name: string;
    signedinUser?: { displayName?: string };
    anonymousUser?: { displayName?: string };
    phoneUser?: { displayName?: string };
  }[];
  entries: { participant: string; text: string; startTime: string }[];
  calendar_events: CalendarEvent[];
};

export type MeetingBody = FirefliesBody | GeminiBody;

export type MeetingInput = {
  source: "fireflies" | "gemini";
  sourceId: string;
  start: Date;
  end: Date;
  sourceTitle?: string;
  sourceUrl?: string;
  people: { name?: string; email?: string }[];
  organizerEmail?: string;
  segments: { speaker: string; offsetSeconds: number; text: string }[];
  calendarEvents: CalendarEvent[];
};

export type MeetingOk =
  | { ok: true; path: string; commit: string; linked?: string; redactions?: Redaction[] }
  | { ok: true; path: string; commit: null; already_stored: true }
  | { ok: true; commit: null; skipped: "too_short" | "empty_transcript" };
