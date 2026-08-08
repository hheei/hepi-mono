import { RAW_LATEST_SCHEMA_SQL } from "./latest-schema";

export const LATEST_SCHEMA_SQL = RAW_LATEST_SCHEMA_SQL.replace(
    /CREATE TABLE IF NOT EXISTS ['"](?:primers|memories|message_history|git_commits)_fts_(?:data|idx|docsize|config|content)['"][\s\S]*?;\n/g,
    "",
);
