import { z } from "zod";

export const AgentScopeSchema = z.enum(["read", "capture", "propose-write"]);
export type AgentScope = z.infer<typeof AgentScopeSchema>;
export const AgentIdSchema = z.string().uuid().transform((id) => id.toLowerCase());
export const CreateAgentTokenSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(AgentScopeSchema).min(1).max(3).default(["read"]),
  allowedNoteIds: z.array(AgentIdSchema).max(100).default([]),
}).strict().superRefine((value, context) => {
  if (new Set(value.scopes).size !== value.scopes.length ||
      new Set(value.allowedNoteIds).size !== value.allowedNoteIds.length) {
    context.addIssue({ code: "custom", message: "Duplicate scopes or note IDs" });
  }
  if (value.scopes.includes("propose-write") !== (value.allowedNoteIds.length > 0)) {
    context.addIssue({ code: "custom", message: "Propose-write requires explicit allowed note IDs" });
  }
});
export type CreateAgentTokenInput = z.infer<typeof CreateAgentTokenSchema>;
export type AgentTokenDto = {
  readonly id: string; readonly name: string; readonly prefix: string;
  readonly scopes: AgentScope[]; readonly allowedNoteIds: string[];
  readonly createdAt: string; readonly revokedAt: string | null;
};
export type AgentActivityDto = {
  readonly id: string; readonly tokenId: string; readonly tool: string;
  readonly status: "ok" | "denied" | "error"; readonly targetId: string | null; readonly createdAt: string;
};
export const AgentPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().max(64000).optional(),
}).strict().refine((patch) => patch.title !== undefined || patch.body !== undefined, "Patch is empty");
export type AgentPatch = z.infer<typeof AgentPatchSchema>;
export type AgentProposalDto = {
  readonly id: string; readonly tokenId: string; readonly noteId: string;
  readonly expectedVersion: string; readonly patch: AgentPatch;
  readonly status: "pending" | "approved" | "rejected";
  readonly createdAt: string; readonly reviewedAt: string | null;
};
export const AgentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export const AgentProposalQuerySchema = AgentListQuerySchema.extend({
  status: z.enum(["pending", "approved", "rejected"]).default("pending"),
});
export const AgentToolSchemas = {
  search_notes: z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(20).default(10) }).strict(),
  get_note: z.object({
    noteId: AgentIdSchema, offset: z.number().int().min(0).max(10000000).default(0),
    limit: z.number().int().min(1).max(16000).default(16000),
  }).strict(),
  capture_inbox: z.object({
    requestId: AgentIdSchema, text: z.string().min(1).max(32000),
    title: z.string().trim().min(1).max(200).optional(),
  }).strict(),
  propose_note_update: z.object({
    requestId: AgentIdSchema, noteId: AgentIdSchema,
    expectedVersion: z.string().regex(/^[0-9a-f]{64}$/), patch: AgentPatchSchema,
  }).strict(),
} as const;
export type AgentToolName = keyof typeof AgentToolSchemas;
export const AgentToolCallSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("search_notes"), arguments: AgentToolSchemas.search_notes }).strict(),
  z.object({ name: z.literal("get_note"), arguments: AgentToolSchemas.get_note }).strict(),
  z.object({ name: z.literal("capture_inbox"), arguments: AgentToolSchemas.capture_inbox }).strict(),
  z.object({ name: z.literal("propose_note_update"), arguments: AgentToolSchemas.propose_note_update }).strict(),
]);
export type AgentToolCall = z.infer<typeof AgentToolCallSchema>;
