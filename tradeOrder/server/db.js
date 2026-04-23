import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const dbPath = path.join(dataDir, "trade-dashboard.sqlite");

fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

const readStatement = db.prepare("SELECT value FROM app_state WHERE key = ?");
const writeStatement = db.prepare(`
  INSERT INTO app_state(key, value)
  VALUES(?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
const allStatement = db.prepare("SELECT key, value FROM app_state");

export function setState(key, value) {
  writeStatement.run(key, value === null || value === undefined ? "" : String(value));
}

export function getState(key) {
  const row = readStatement.get(key);
  return row ? row.value : null;
}

export function getStates(prefix = "") {
  const rows = allStatement.all();
  const result = {};
  for (const row of rows) {
    if (!prefix || row.key.startsWith(prefix)) {
      result[row.key] = row.value;
    }
  }
  return result;
}

export function getDatabasePath() {
  return dbPath;
}
