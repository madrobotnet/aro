export type SQLiteFoundationErrorCode =
  | "configuration"
  | "foreign_database"
  | "migration_history"
  | "migration_statement"
  | "executor_statement"
  | "transaction_scope"
  | "async_transaction"
  | "representation";

export class SQLiteFoundationError extends Error {
  constructor(readonly code: SQLiteFoundationErrorCode, message: string) {
    super(message);
    this.name = "SQLiteFoundationError";
  }
}
