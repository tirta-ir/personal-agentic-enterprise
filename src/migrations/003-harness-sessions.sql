BEGIN;
ALTER TABLE sessions ADD COLUMN harness TEXT NOT NULL DEFAULT 'codex';
DROP INDEX IF EXISTS session_context;
CREATE UNIQUE INDEX session_context ON sessions(group_id,agent_id,workspace,COALESCE(side_chat_id,''),harness) WHERE active=1;
UPDATE metadata SET value='3' WHERE key='schema_version';
COMMIT;
