// Part of the immutable v1 migration definitions. Changes require a new migration.
export const NOW_V1 = "(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z')";
const UUID_V1 = `(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) ||
  '-4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) ||
  '-' || lower(hex(randomblob(6))))`;

export function uuidV1(column: string): string {
  return `CHECK (length(${column}) = 36 AND
    substr(${column},9,1) = '-' AND substr(${column},14,1) = '-' AND
    substr(${column},19,1) = '-' AND substr(${column},24,1) = '-' AND
    length(replace(${column},'-','')) = 32 AND
    replace(${column},'-','') NOT GLOB '*[^0-9a-f]*')`;
}

export const ID_V1 = `id TEXT PRIMARY KEY NOT NULL DEFAULT ${UUID_V1} ${uuidV1("id")}`;

export function timeV1(column: string): string {
  return `CHECK (${column} IS NULL OR (
    length(${column}) = 27 AND
    ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9][0-9][0-9][0-9]Z' AND
    strftime('%Y-%m-%dT%H:%M:%S', substr(${column},1,19), '+0 seconds')
      IS substr(${column},1,19)))`;
}

export function createdV1(column = "created_at"): string {
  return `${column} TEXT NOT NULL DEFAULT ${NOW_V1} ${timeV1(column)}`;
}

export function optionalTimeV1(column: string): string {
  return `${column} TEXT ${timeV1(column)}`;
}

/** SQLite CHECK cannot contain subqueries; triggers validate every array element. */
export function arrayV1(table: string, column: string, dimension?: number): readonly string[] {
  const validElement = dimension === undefined
    ? "type = 'text'"
    : "type IN ('integer','real') AND abs(value) <= 3.4028234663852886e38";
  return ["INSERT", "UPDATE"].map((event) => `
    CREATE TRIGGER ${table}_${column}_${event.toLowerCase()} BEFORE ${event} ON ${table}
    WHEN NEW.${column} IS NOT NULL
    BEGIN
      SELECT CASE WHEN NOT json_valid(NEW.${column}) THEN RAISE(ABORT, 'invalid JSON array') END;
      SELECT CASE WHEN json_type(NEW.${column}) <> 'array'
        ${dimension === undefined ? "" : `OR json_array_length(NEW.${column}) <> ${dimension}`}
        THEN RAISE(ABORT, 'invalid JSON array shape') END;
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.${column}) WHERE NOT (${validElement})
      ) THEN RAISE(ABORT, 'invalid JSON array element') END;
    END`);
}
