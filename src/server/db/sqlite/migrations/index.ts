import { coreV1 } from "./0001-core";
import { configurationV1 } from "./0002-configuration";
import { historyV1 } from "./0003-history";
import { retrievalChatV1 } from "./0004-retrieval-chat";
import { captureRequestsV1 } from "./0005-capture-requests";
import { agentAccessV1 } from "./0006-agent-access";
import { noteSharesV1 } from "./0007-note-shares";
import { oauthClientsV1 } from "./0008-oauth-clients";

export type SQLiteMigration = {
  readonly id: string;
  readonly statements: readonly string[];
};

/** SQLite-only history; never edit an applied entry or its versioned helpers. */
export const SQLITE_MIGRATIONS: readonly SQLiteMigration[] = [
  { id: "0001_core", statements: coreV1 },
  { id: "0002_configuration", statements: configurationV1 },
  { id: "0003_history", statements: historyV1 },
  { id: "0004_retrieval_chat", statements: retrievalChatV1 },
  { id: "0005_capture_requests", statements: captureRequestsV1 },
  { id: "0006_agent_access", statements: agentAccessV1 },
  { id: "0007_note_shares", statements: noteSharesV1 },
  { id: "0008_oauth_clients", statements: oauthClientsV1 },
];
