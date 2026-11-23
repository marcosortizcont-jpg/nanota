-- NaNota: repertórios em grupo, histórico de alterações e módulo financeiro
ALTER TABLE setlists ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS setlist_members (
  setlist_id TEXT NOT NULL REFERENCES setlists(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_edit_list INTEGER NOT NULL DEFAULT 0,
  can_transpose INTEGER NOT NULL DEFAULT 0,
  can_edit_songs INTEGER NOT NULL DEFAULT 0,
  can_manage INTEGER NOT NULL DEFAULT 0,
  added_by TEXT,
  added_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (setlist_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON setlist_members(user_id);

CREATE TABLE IF NOT EXISTS setlist_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  setlist_id TEXT NOT NULL,
  user_id TEXT,
  user_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_logs_set ON setlist_logs(setlist_id, created_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','suspensa','cancelada')),
  price_cents INTEGER NOT NULL DEFAULT 0,
  billing_interval TEXT NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month','year','none')),
  due_day INTEGER NOT NULL DEFAULT 10,
  next_due_date TEXT,
  started_at TEXT NOT NULL,
  canceled_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id, status);

CREATE TABLE IF NOT EXISTS charges (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  subscription_id TEXT,
  plan_id TEXT,
  description TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','pago','cancelado')),
  paid_at TEXT,
  paid_cents INTEGER,
  method TEXT,
  notes TEXT NOT NULL DEFAULT '',
  txid TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_charges_status ON charges(status, due_date);
CREATE INDEX IF NOT EXISTS idx_charges_user ON charges(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
