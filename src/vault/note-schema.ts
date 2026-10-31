import { z } from "zod";

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Characters Windows cannot have in a file name (`/` and `\` are separators, rejected too). */
const WINDOWS_UNSAFE_CHARS = /[<>:"|?*/\\]/;

/** Reserved device names, matched against the part of a segment before its first dot. */
const RESERVED_DEVICE_STEM = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³])$/i;

/**
 * One path segment that is safe to create on Windows, macOS and Linux and cannot be read as
 * hidden or as git pathspec magic: non-empty, no leading dot, no separators, control characters
 * or any of `<>:"|?*`, no trailing dot or space, and not a reserved device name (CON, PRN, AUX,
 * NUL, CONIN$, CONOUT$, COM0-9, LPT0-9 and their superscript forms) in any case, with or without
 * an extension. Meant to be shared with the config folder rules.
 */
export function isSafePathSegment(segment: string): boolean {
  if (segment === "" || segment.startsWith(".")) return false;
  if (CONTROL_CHARS.test(segment) || WINDOWS_UNSAFE_CHARS.test(segment)) return false;
  if (segment.endsWith(".") || segment.endsWith(" ")) return false;
  const stem = (segment.split(".")[0] ?? "").replace(/ +$/, "");
  return !RESERVED_DEVICE_STEM.test(stem);
}

function isSafePath(path: string): boolean {
  if (path.startsWith(":")) return false;
  if (CONTROL_CHARS.test(path)) return false;
  if (path.includes("\\")) return false;
  if (path.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every(isSafePathSegment);
}

export const NoteInput = z.object({
  path: z.string().min(1).max(255).endsWith(".md").refine(isSafePath, {
    message:
      'path must be relative, without dot segments, control characters, Windows-unsafe characters (<>:"|?*), segments ending in a dot or space, or reserved device names',
  }),
  frontmatter: z.record(z.string(), z.unknown()),
  body: z
    .string()
    .refine((body) => !body.includes("\u0000"), { message: "body must not contain NUL" }),
});

export type NoteInput = z.infer<typeof NoteInput>;
