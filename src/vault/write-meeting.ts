import { requireMeetingSetup, type VaultConfig } from "../config/vault-config.js";
import type { GitApi } from "../git/index.js";
import { normalizeSegments } from "../meetings/normalize.js";
import type { MeetingInput, MeetingOk } from "../meetings/types.js";
import type { SourceIndex } from "./source-index.js";

export interface MeetingWriterDeps {
  root: string;
  git: Pick<GitApi, "headSha">;
  sourceIndex: SourceIndex;
  log: (message: string) => void;
  /** Pull and read the vault config as it is after the pull. Runs inside the write slot. */
  syncAndLoadConfig: () => Promise<VaultConfig>;
}

/**
 * The meeting write, run inside the writer's queue slot. Order: pull and load the config, check
 * the meeting setup, skip short or empty recordings, then look the source id up. The log line of a
 * skip holds only the source and the reason, never a title, a name or transcript text.
 */
export async function writeMeetingInSlot(
  input: MeetingInput,
  deps: MeetingWriterDeps,
): Promise<MeetingOk> {
  const cfg = await deps.syncAndLoadConfig();
  requireMeetingSetup(cfg);

  const skip = (reason: "too_short" | "empty_transcript"): MeetingOk => {
    deps.log(`meeting_skipped: source=${input.source} reason=${reason}`);
    return { ok: true, commit: null, skipped: reason };
  };

  if (input.end.getTime() - input.start.getTime() <= cfg.meetings.min_minutes * 60_000) {
    return skip("too_short");
  }
  const { turns } = normalizeSegments(input.segments, cfg.meetings.unknown_speaker_label);
  if (turns === 0) return skip("empty_transcript");

  const id = `${cfg.meetings.sources[input.source].value}:${input.sourceId}`;
  const head = await deps.git.headSha(deps.root);
  const found = await deps.sourceIndex.lookup(deps.root, head, cfg.properties.source_id, id);
  if (found !== undefined) return { ok: true, path: found, commit: null, already_stored: true };

  // T10 replaces this placeholder with the real store. The message carries no input text.
  throw new Error("meeting store not implemented");
}
