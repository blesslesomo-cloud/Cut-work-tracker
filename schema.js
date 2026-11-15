// Generated from schema.sql — the API runs this on first use (CREATE ... IF NOT EXISTS, safe to repeat)
export const SCHEMA_VERSION = 1;
export const SCHEMA_SQL = `-- CutTrack — Cloudflare D1 (SQLite) schema
-- The API creates these tables automatically on its first request; this file is for reference,
-- or to run by hand:  npx wrangler d1 execute cuttrack --remote --file=schema.sql
-- Column types: JSON_TEXT = JSON stored as text, BOOL_INT = 0/1 boolean. Times are ISO-8601 UTC text.

CREATE TABLE IF NOT EXISTS cw_parties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CUTTING','PRINTER','SEWING')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (name, kind)
);

CREATE TABLE IF NOT EXISTS cw_cuts (
  id TEXT PRIMARY KEY,
  cut_ref TEXT NOT NULL UNIQUE,
  style TEXT NOT NULL,
  colour TEXT DEFAULT '',
  cut_no TEXT NOT NULL,
  order_no TEXT DEFAULT '',
  component TEXT DEFAULT '',
  printer TEXT DEFAULT '',
  total_bundles INTEGER DEFAULT 0,
  total_units INTEGER DEFAULT 0,
  po_no TEXT,
  job_no TEXT,
  layer_up TEXT,
  order_total INTEGER,
  parts JSON_TEXT DEFAULT '[]',
  print_parts JSON_TEXT DEFAULT '[]',
  order_sizes JSON_TEXT DEFAULT '{}',
  source TEXT DEFAULT 'manual',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cw_cuts_job_idx ON cw_cuts(job_no);

CREATE TABLE IF NOT EXISTS cw_bundles (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  cut_id TEXT NOT NULL,
  bundle_no INTEGER NOT NULL,
  size TEXT,
  qty INTEGER NOT NULL DEFAULT 0,
  component TEXT DEFAULT '',
  lay_no TEXT,
  dyelot TEXT,
  sobar_from INTEGER,
  sobar_to INTEGER,
  bag_code TEXT,
  location TEXT NOT NULL DEFAULT 'CUTTING',
  holder TEXT,
  bagged_by TEXT,
  bagged_at TEXT,
  received_at TEXT,
  received_by TEXT,
  receipt_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cw_bundles_cut_idx ON cw_bundles(cut_id);
CREATE INDEX IF NOT EXISTS cw_bundles_bag_idx ON cw_bundles(bag_code);
CREATE INDEX IF NOT EXISTS cw_bundles_loc_idx ON cw_bundles(location);

CREATE TABLE IF NOT EXISTS cw_bags (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  cut_id TEXT,
  bag_no INTEGER,
  status TEXT NOT NULL DEFAULT 'OPEN',
  dyelot TEXT,
  opened_by TEXT,
  station TEXT,
  device TEXT,
  closed_by TEXT,
  closed_at TEXT,
  bundle_count INTEGER,
  units INTEGER,
  dn_no TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cw_bags_cut_idx ON cw_bags(cut_id);
CREATE INDEX IF NOT EXISTS cw_bags_status_idx ON cw_bags(status);

CREATE TABLE IF NOT EXISTS cw_deliveries (
  id TEXT PRIMARY KEY,
  dn_no TEXT NOT NULL UNIQUE,
  leg TEXT NOT NULL CHECK (leg IN ('CUT_TO_PRINT','PRINT_TO_SEW')),
  from_party TEXT,
  to_party TEXT,
  status TEXT NOT NULL DEFAULT 'DISPATCHED' CHECK (status IN ('DISPATCHED','RECEIVED_COMPLETE','RECEIVED_SHORT','CANCELLED')),
  dispatched_by TEXT,
  dispatched_short BOOL_INT DEFAULT 0,
  short_reason TEXT,
  cut_refs TEXT,
  bundles_expected INTEGER DEFAULT 0,
  bundles_sent INTEGER DEFAULT 0,
  units_sent INTEGER DEFAULT 0,
  bags_sent INTEGER DEFAULT 0,
  received_by TEXT,
  received_at TEXT,
  receive_notes TEXT,
  bundles_received INTEGER,
  units_received INTEGER,
  bags_received INTEGER,
  bundles_missing INTEGER,
  wrong_count INTEGER DEFAULT 0,
  vehicle_reg TEXT,
  driver TEXT,
  approved_by TEXT,
  balance JSON_TEXT,
  cancelled_by TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cw_deliveries_status_idx ON cw_deliveries(status);
CREATE INDEX IF NOT EXISTS cw_deliveries_at_idx ON cw_deliveries(created_at);

CREATE TABLE IF NOT EXISTS cw_delivery_items (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('BUNDLE','BAG')),
  code TEXT NOT NULL,
  cut_id TEXT,
  cut_ref TEXT,
  style TEXT, colour TEXT, cut_no TEXT,
  bundle_no INTEGER, size TEXT, qty INTEGER, component TEXT, bag_code TEXT,
  lay_no TEXT, dyelot TEXT, sobar_from INTEGER, sobar_to INTEGER,
  dispatched BOOL_INT NOT NULL DEFAULT 1,
  received BOOL_INT NOT NULL DEFAULT 0,
  received_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cw_items_del_idx ON cw_delivery_items(delivery_id);
CREATE INDEX IF NOT EXISTS cw_items_cut_idx ON cw_delivery_items(cut_id);
CREATE INDEX IF NOT EXISTS cw_items_code_idx ON cw_delivery_items(code);

CREATE TABLE IF NOT EXISTS cw_exceptions (
  id TEXT PRIMARY KEY,
  delivery_id TEXT,
  dn_no TEXT,
  code TEXT,
  type TEXT,
  detail TEXT,
  cut_id TEXT,
  party TEXT,
  reported_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cw_ex_cut_idx ON cw_exceptions(cut_id);
CREATE INDEX IF NOT EXISTS cw_ex_del_idx ON cw_exceptions(delivery_id);

CREATE TABLE IF NOT EXISTS cw_scans (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  code TEXT,
  result TEXT NOT NULL,
  detail TEXT,
  bag_code TEXT,
  cut_id TEXT,
  bundle_no INTEGER,
  sorter TEXT,
  supervisor TEXT,
  station TEXT,
  device TEXT,
  user_email TEXT
);
CREATE INDEX IF NOT EXISTS cw_scans_at_idx ON cw_scans(created_at);
CREATE INDEX IF NOT EXISTS cw_scans_sorter_idx ON cw_scans(sorter);

-- Staff: never exposed through the table API — only through /api/rpc
CREATE TABLE IF NOT EXISTS cw_staff (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('SORTER','DISPATCHER','RECEIVER','SUPERVISOR')),
  pin_hash TEXT NOT NULL,          -- salt:sha256(salt:pin)
  active BOOL_INT NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Wrong-PIN lockout (per network address)
CREATE TABLE IF NOT EXISTS cw_auth_fail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT,
  name TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cw_auth_fail_ip_idx ON cw_auth_fail(ip, at);

-- Counters (generic bag label numbers)
CREATE TABLE IF NOT EXISTS cw_meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cw_receipts (
  id TEXT PRIMARY KEY,
  receipt_no TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'PRINTER' CHECK (source IN ('PRINTER','CUTTING')),
  printer TEXT NOT NULL,
  printer_dn TEXT,
  sewing TEXT,
  cut_id TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  outcome TEXT CHECK (outcome IN ('COMPLETE','BALANCE_TO_FOLLOW','MISSING')),
  received_by TEXT,
  bundles_received INTEGER DEFAULT 0,
  units_received INTEGER DEFAULT 0,
  flagged INTEGER DEFAULT 0,
  outstanding_bundles INTEGER,
  outstanding_units INTEGER,
  notes TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cw_receipts_cut_idx ON cw_receipts(cut_id);
CREATE INDEX IF NOT EXISTS cw_receipts_at_idx ON cw_receipts(created_at);

CREATE TABLE IF NOT EXISTS cw_bundle_parts (
  id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL,
  cut_id TEXT,
  bundle_no INTEGER,
  part_no INTEGER NOT NULL,
  part_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('RECEIVED','QUARANTINE','MISSING')),
  source TEXT,
  flag TEXT,
  receipt_id TEXT,
  receipt_no TEXT,
  received_at TEXT,
  received_by TEXT,
  released_by TEXT,
  released_at TEXT,
  inv_no TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (bundle_id, part_no)
);
CREATE INDEX IF NOT EXISTS cw_bparts_cut_idx ON cw_bundle_parts(cut_id);
CREATE INDEX IF NOT EXISTS cw_bparts_status_idx ON cw_bundle_parts(status);

CREATE TABLE IF NOT EXISTS cw_receipt_items (
  id TEXT PRIMARY KEY,
  receipt_id TEXT,
  receipt_no TEXT,
  bundle_id TEXT,
  code TEXT,
  cut_id TEXT,
  receipt_cut_id TEXT,
  bundle_no INTEGER, size TEXT, qty INTEGER,
  part_no INTEGER, part_name TEXT,
  result TEXT NOT NULL,
  manual BOOL_INT DEFAULT 0,
  quarantined BOOL_INT DEFAULT 0,
  released_by TEXT, released_at TEXT,
  dn_no TEXT,
  detail TEXT,
  scanned_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cw_ritems_receipt_idx ON cw_receipt_items(receipt_id);
CREATE INDEX IF NOT EXISTS cw_ritems_cut_idx ON cw_receipt_items(cut_id);
CREATE INDEX IF NOT EXISTS cw_ritems_rcut_idx ON cw_receipt_items(receipt_cut_id);

CREATE TABLE IF NOT EXISTS cw_investigations (
  id TEXT PRIMARY KEY,
  inv_no TEXT NOT NULL UNIQUE,
  cut_id TEXT,
  source TEXT,
  printer TEXT,
  printer_dn TEXT,
  receipt_id TEXT,
  receipt_no TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  missing_bundles INTEGER,
  missing_units INTEGER,
  missing JSON_TEXT,
  opened_by TEXT,
  outcome TEXT,
  notes TEXT,
  closed_by TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cw_inv_cut_idx ON cw_investigations(cut_id);

INSERT OR IGNORE INTO cw_parties (id, name, kind) VALUES
  ('p-cutting','Cutting Room','CUTTING'),
  ('p-printer-a','Printer A','PRINTER'),
  ('p-printer-b','Printer B','PRINTER'),
  ('p-sewing','Sewing Floor','SEWING');
`;
