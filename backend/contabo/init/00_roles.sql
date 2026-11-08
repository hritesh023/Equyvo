-- Runs once on first container init (docker-entrypoint-initdb.d).
-- Creates least-privilege roles. Passwords are injected via env by the operator
-- (see .env.example); replace placeholders before deploy.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'equyvo_app') THEN
    CREATE ROLE equyvo_app LOGIN PASSWORD 'CHANGE_ME_APP';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'equyvo_readonly') THEN
    CREATE ROLE equyvo_readonly LOGIN PASSWORD 'CHANGE_ME_READONLY';
  END IF;
END$$;

GRANT CONNECT ON DATABASE equyvo TO equyvo_app, equyvo_readonly;
