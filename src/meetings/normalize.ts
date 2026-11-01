import type { MeetingInput } from "./types.js";

type Kept = { speaker: string; offset: number; text: string; index: number };

function cleanText(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n")
    .trim();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function timestamp(offsetSeconds: number): string {
  const total = Math.max(0, Math.floor(offsetSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Deterministic speaker-turn body for a meeting transcript. Pure: no I/O, no config.
 */
export function normalizeSegments(
  segments: MeetingInput["segments"],
  unknownLabel: string,
): { body: string; turns: number } {
  const kept: Kept[] = [];
  segments.forEach((seg, index) => {
    const text = cleanText(seg.text);
    if (text === "") return;
    const speaker = seg.speaker.normalize("NFC").trim() || unknownLabel;
    kept.push({ speaker, offset: seg.offsetSeconds, text, index });
  });
  kept.sort((a, b) => a.offset - b.offset || a.index - b.index);

  const turns: { speaker: string; offset: number; text: string }[] = [];
  for (const seg of kept) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === seg.speaker) {
      last.text = `${last.text} ${seg.text}`;
    } else {
      turns.push({ speaker: seg.speaker, offset: seg.offset, text: seg.text });
    }
  }

  if (turns.length === 0) return { body: "", turns: 0 };
  const blocks = turns.map((t) => `**${t.speaker}** [${timestamp(t.offset)}]\n${t.text}`);
  return { body: `${blocks.join("\n\n")}\n`, turns: turns.length };
}
