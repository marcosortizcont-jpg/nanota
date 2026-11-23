-- NaNota: usuário master, planos e catálogo de cifras padrão
ALTER TABLE users ADD COLUMN is_master INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN plan_id TEXT NOT NULL DEFAULT 'gratuito';
ALTER TABLE users ADD COLUMN plan_expires_at INTEGER;
ALTER TABLE songs ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_songs_public ON songs(is_public);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'BRL',
  billing_interval TEXT NOT NULL DEFAULT 'none' CHECK (billing_interval IN ('none','month','year')),
  max_songs INTEGER,
  max_setlists INTEGER,
  features TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT OR IGNORE INTO plans (id, name, description, price_cents, billing_interval, active, is_default, sort)
  VALUES ('gratuito', 'Gratuito', 'Plano inicial', 0, 'none', 1, 1, 0);
