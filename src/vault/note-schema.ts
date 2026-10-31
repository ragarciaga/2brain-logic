import { z } from "zod";

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isSafePath(path: string): boolean {
  if (CONTROL_CHARS.test(path)) return false;
  if (path.includes("\\")) return false;
  if (path.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && !segment.startsWith("."));
}

export const NoteInput = z.object({
  path: z.string().min(1).max(255).endsWith(".md").refine(isSafePath, {
    message: "path must be relative, without dot segments or control characters",
  }),
  frontmatter: z.record(z.string(), z.unknown()),
  body: z
    .string()
    .refine((body) => !body.includes("\u0000"), { message: "body must not contain NUL" }),
});

export type NoteInput = z.infer<typeof NoteInput>;
