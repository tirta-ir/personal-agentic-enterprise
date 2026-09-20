BEGIN;
ALTER TABLE sessions ADD COLUMN side_chat_id TEXT REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED;
DROP INDEX IF EXISTS session_context;
CREATE UNIQUE INDEX session_context ON sessions(group_id,agent_id,workspace,COALESCE(side_chat_id,'')) WHERE active=1;
-- Legacy side turns used the main native session. Retire only those mixed sessions.
UPDATE sessions SET active=0 WHERE id IN (
  SELECT json_extract(data,'$.session_id') FROM runs
  WHERE json_extract(data,'$.side_chat_id') IS NOT NULL
);
UPDATE metadata SET value='2' WHERE key='schema_version';
COMMIT;
