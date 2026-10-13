import { z } from "zod";
import { DesktopBackupError } from "./desktop-backup-files";

export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MAX_ENTRIES = 100_000;
export const safePath = z.string().min(1).max(4096).refine((path) =>
  !path.includes("\0") && !path.startsWith("/") &&
  (process.platform !== "win32" || !/[\\:]/.test(path)) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
  (path === "aro.sqlite" || path === "attachments" || path.startsWith("attachments/")));
const mode = z.number().int().min(0).max(0o777);
const file = {
  kind: z.literal("file"), path: safePath,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
};
const v1Entry = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("directory"), path: safePath, mode }),
  z.strictObject({ ...file, mode }),
]);
const v2Entry = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("directory"), path: safePath }),
  z.strictObject(file),
]);
const common = {
  format: z.literal("aro-desktop-backup"), createdAt: z.iso.datetime(),
  sqliteSnapshot: z.literal("vacuum-into"),
};
const v1 = z.strictObject({
  ...common, version: z.literal(1),
  dataDirectoryMode: mode.refine((value) => (value & 0o077) === 0 && (value & 0o500) === 0o500),
  entries: z.array(v1Entry).min(1).max(MAX_ENTRIES),
});
const v2 = z.strictObject({
  ...common, version: z.literal(2), platform: z.literal("win32"),
  permissionModel: z.literal("windows-acl"),
  entries: z.array(v2Entry).min(1).max(MAX_ENTRIES),
});
export type Entry = z.infer<typeof v1Entry> | z.infer<typeof v2Entry>;
export type Manifest = z.infer<typeof v1> | z.infer<typeof v2>;
export const manifestSchema = process.platform === "win32" ? v2 : v1;

export function parseDesktopManifest(input: unknown): Manifest {
  if (input && typeof input === "object" && "version" in input &&
      input.version === (process.platform === "win32" ? 1 : 2)) {
    throw new DesktopBackupError("Backup is from another platform family; move notes with Markdown/ZIP export and import", "platform-mismatch");
  }
  return manifestSchema.parse(input);
}
