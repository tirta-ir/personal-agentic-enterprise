PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
BEGIN;
CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE IF NOT EXISTS workstations(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(json_extract(data,'$.enabled'),json_extract(data,'$.next_run_at'));
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE IF NOT EXISTS terminal_runs(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX IF NOT EXISTS terminal_agent ON terminal_runs(json_extract(data,'$.agent_id'));
CREATE INDEX IF NOT EXISTS terminal_status ON terminal_runs(json_extract(data,'$.status'));
CREATE TABLE IF NOT EXISTS handoffs(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE UNIQUE INDEX IF NOT EXISTS question_request ON questions(json_extract(data,'$.run_id'),json_extract(data,'$.request_id'));
CREATE INDEX IF NOT EXISTS question_status ON questions(json_extract(data,'$.status'));
CREATE TABLE IF NOT EXISTS tool_receipts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_items(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
-- Keep retired Work-feature records intact; their schema and ownership differ.
CREATE TABLE IF NOT EXISTS action_items(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
-- Import only fully shaped actions from the initial collaboration preview build.
INSERT OR IGNORE INTO action_items(id,data) SELECT id,data FROM work_items
 WHERE json_type(data,'$.body')='text' AND json_type(data,'$.assignee_id')='text'
 AND json_type(data,'$.revision')='integer' AND json_type(data,'$.created_by')='text';
CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE IF NOT EXISTS revisions(agent_id TEXT NOT NULL REFERENCES agents(id), revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(agent_id,revision));
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), agent_id TEXT NOT NULL REFERENCES agents(id), workspace TEXT NOT NULL, native_id TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_group ON messages(json_extract(data,'$.group_id'),json_extract(data,'$.created_at'));
CREATE INDEX IF NOT EXISTS runs_status ON runs(json_extract(data,'$.status'));
CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT OR IGNORE INTO metadata VALUES('schema_version','1');
COMMIT;
