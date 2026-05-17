-- Optional: create role + database matching apps/api/.env.example (sarva / sarva_dev @ sarva).
-- Run once as a PostgreSQL superuser, from repo root, for example:
--   psql -h localhost -U postgres -f scripts/postgres/bootstrap-dev.sql
--   psql postgres   # macOS Homebrew default superuser is often your login name
--
-- If role or database already exists, you will see errors — safe to ignore or adjust manually.

CREATE ROLE sarva LOGIN PASSWORD 'sarva_dev';
CREATE DATABASE sarva OWNER sarva;
