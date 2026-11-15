/**
 * CutTrack API — Cloudflare Pages Function in front of the D1 database (binding name: DB).
 *
 *   GET  /api/health          → { ok, tables, user }
 *   POST /api/q               → generic table access: { op: list|insert|update|delete, table, ... }
 *   POST /api/rpc/<function>  → staff sign-in, supervisor PIN, staff admin, bag label numbers
 *
 * Safety: only known tables and columns are accepted (read from the database itself), every value is a
 * bound parameter, the staff table is never readable, the scan log can only be added to, and PIN guesses
 * are rate-limited. Put Cloudflare Access in front of the whole site; set ACCESS_REQUIRED=true to refuse
 * any request that did not come through Access.
 */
import { SCHEMA_SQL, SCHEMA_VERSION } from '../../lib/schema.js';

const TABLES = ['cw_parties', 'cw_cuts', 'cw_bundles', 'cw_bags', 'cw_deliveries', 'cw_delivery_items', 'cw_exceptions', 'cw_scans', 'cw_receipts', 'cw_bundle_parts', 'cw_receipt_items', 'cw_investigations'];
const NO_UPDATE = new Set(['cw_scans']);                 // audit log: insert + read only
const DELETABLE = new Set(['cw_parties']);              // the only table rows may be deleted from
const MAX_PARAMS = 90;                                  // D1 allows 100 bound parameters per statement
const MAX_ROWS = 50000;
const LOCK_FAILS = 8, LOCK_MIN = 15;

let READY = null;   // per isolate: schema checked + column map loaded
let COLS = null;    // table -> { column: declared type }

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

/* ---------------- schema ---------------- */
async function ensure(env) {
  if (!env.DB) throw new HttpError(500, 'No D1 database bound — add a D1 binding named DB to this Pages project');
  if (READY) return READY;
  READY = (async () => {
    let ver = 0;
    try { ver = (await env.DB.prepare("SELECT v FROM cw_meta WHERE k = 'schema_version'").first())?.v || 0; } catch (e) { ver = 0; }
    if (ver < SCHEMA_VERSION) {
      const stmts = SCHEMA_SQL.replace(/^\s*--.*$/gm, '').split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
      await env.DB.batch(stmts.map(s => env.DB.prepare(s)));
      await env.DB.prepare("INSERT INTO cw_meta (k, v) VALUES ('schema_version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(SCHEMA_VERSION).run();
    }
    const res = await env.DB.batch(TABLES.map(t => env.DB.prepare(`PRAGMA table_info(${t})`)));
    COLS = {};
    TABLES.forEach((t, i) => { COLS[t] = Object.fromEntries(res[i].results.map(c => [c.name, String(c.type || '').toUpperCase()])); });
  })().catch(e => { READY = null; throw e; });
  return READY;
}
function table(t) { if (!TABLES.includes(t)) throw new HttpError(400, `Unknown table: ${t}`); return t; }
function col(t, c) { if (typeof c !== 'string' || !(c in COLS[t])) throw new HttpError(400, `Unknown column ${t}.${c}`); return c; }
function toDb(t, c, v) {
  if (v === undefined) return null;
  const ty = COLS[t][c];
  if (ty === 'JSON_TEXT') return v == null ? null : JSON.stringify(v);
  if (ty === 'BOOL_INT') return v == null ? null : (v ? 1 : 0);
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
function fromDb(t, row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const ty = COLS[t][k];
    if (ty === 'JSON_TEXT') { try { out[k] = v == null ? null : JSON.parse(v); } catch (e) { out[k] = v; } }
    else if (ty === 'BOOL_INT') out[k] = v == null ? null : !!v;
    else out[k] = v;
  }
  return out;
}
/* WHERE clause from a filter object: {col: value | [values] | null} */
function where(t, f, gte) {
  const parts = [], args = [];
  for (const [k, v] of Object.entries(f || {})) {
    col(t, k);
    if (Array.isArray(v)) { parts.push(`${k} IN (${v.map(() => '?').join(',')})`); args.push(...v.map(x => toDb(t, k, x))); }
    else if (v === null) parts.push(`${k} IS NULL`);
    else { parts.push(`${k} = ?`); args.push(toDb(t, k, v)); }
  }
  if (gte) { col(t, gte[0]); parts.push(`${gte[0]} >= ?`); args.push(toDb(t, gte[0], gte[1])); }
  return { sql: parts.length ? ' WHERE ' + parts.join(' AND ') : '', args };
}
/* split a filter with a long IN list into several filters that each fit the parameter limit */
function chunkFilter(f, reserved = 0) {
  f = f || {};
  const ak = Object.keys(f).filter(k => Array.isArray(f[k])).sort((a, b) => f[b].length - f[a].length)[0];
  if (ak && !f[ak].length) return [];
  const count = Object.values(f).reduce((s, v) => s + (Array.isArray(v) ? v.length : v === null ? 0 : 1), 0) + reserved;
  if (!ak || count <= MAX_PARAMS) return [f];
  const room = Math.max(1, MAX_PARAMS - (count - f[ak].length));
  const out = [];
  for (let i = 0; i < f[ak].length; i += room) out.push({ ...f, [ak]: f[ak].slice(i, i + room) });
  return out;
}

/* ---------------- table operations ---------------- */
async function list(env, b) {
  const t = table(b.table);
  const order = b.order ? col(t, b.order) : null;
  const limit = Math.min(+b.limit || MAX_ROWS, MAX_ROWS);
  let rows = [];
  for (const f of chunkFilter(b.filter, b.gte ? 1 : 0)) {
    const w = where(t, f, b.gte);
    const sql = `SELECT * FROM ${t}${w.sql}${order ? ` ORDER BY ${order} ${b.asc ? 'ASC' : 'DESC'}` : ''} LIMIT ${limit}`;
    rows.push(...(await env.DB.prepare(sql).bind(...w.args).all()).results);
  }
  if (order && rows.length > 1) { const a = b.asc ? 1 : -1; rows.sort((x, y) => (x[order] > y[order] ? 1 : x[order] < y[order] ? -1 : 0) * a); }
  return rows.slice(0, limit).map(r => fromDb(t, r));
}
async function insert(env, b, user) {
  const t = table(b.table);
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) return [];
  if (rows.length > 1000) throw new HttpError(400, 'At most 1000 rows per insert');
  const stmts = rows.map(r => {
    r = { id: uuid(), created_at: nowIso(), ...r };
    if (t === 'cw_scans' && user) r.user_email = user;       // who was signed in (Cloudflare Access)
    const cols = Object.keys(r).filter(k => r[k] !== undefined);
    cols.forEach(c => col(t, c));
    return env.DB.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING *`).bind(...cols.map(c => toDb(t, c, r[c])));
  });
  const out = [];
  for (let i = 0; i < stmts.length; i += 100) (await env.DB.batch(stmts.slice(i, i + 100))).forEach(r => out.push(...r.results));
  return out.map(r => fromDb(t, r));
}
async function update(env, b) {
  const t = table(b.table);
  if (NO_UPDATE.has(t)) throw new HttpError(403, `${t} cannot be changed`);
  const patch = Object.fromEntries(Object.entries(b.patch || {}).filter(([k, v]) => v !== undefined && k !== 'id'));
  const keys = Object.keys(patch); keys.forEach(c => col(t, c));
  if (!keys.length) return [];
  if (!b.filter || !Object.keys(b.filter).length) throw new HttpError(400, 'Update needs a filter');
  const out = [];
  for (const f of chunkFilter(b.filter, keys.length)) {
    const w = where(t, f);
    const sql = `UPDATE ${t} SET ${keys.map(k => `${k} = ?`).join(', ')}${w.sql} RETURNING *`;
    out.push(...(await env.DB.prepare(sql).bind(...keys.map(k => toDb(t, k, patch[k])), ...w.args).all()).results);
  }
  return out.map(r => fromDb(t, r));
}
async function del(env, b) {
  const t = table(b.table);
  if (!DELETABLE.has(t)) throw new HttpError(403, `Rows cannot be deleted from ${t}`);
  if (!b.filter || !Object.keys(b.filter).length) throw new HttpError(400, 'Delete needs a filter');
  let n = 0;
  for (const f of chunkFilter(b.filter)) { const w = where(t, f); n += (await env.DB.prepare(`DELETE FROM ${t}${w.sql}`).bind(...w.args).run()).meta.changes || 0; }
  return { deleted: n };
}

/* ---------------- PINs ---------------- */
const hex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
async function hashPin(pin, salt) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`))); }
async function makeHash(pin) { const salt = hex(crypto.getRandomValues(new Uint8Array(16))); return `${salt}:${await hashPin(pin, salt)}`; }
async function checkPin(pin, stored) { const [salt, h] = String(stored || '').split(':'); return !!salt && (await hashPin(pin, salt)) === h; }
async function guard(env, key) {
  const since = new Date(Date.now() - LOCK_MIN * 60e3).toISOString();
  const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM cw_auth_fail WHERE ip = ? AND at >= ?').bind(key, since).first())?.n || 0;
  if (n >= LOCK_FAILS) throw new HttpError(429, `Too many wrong PINs — wait ${LOCK_MIN} minutes and try again`);
}
async function fail(env, key, name) {
  await env.DB.prepare('INSERT INTO cw_auth_fail (ip, name, at) VALUES (?, ?, ?)').bind(key, name || null, nowIso()).run();
  await env.DB.prepare('DELETE FROM cw_auth_fail WHERE at < ?').bind(new Date(Date.now() - 864e5).toISOString()).run();
}
async function supervisorByPin(env, pin) {
  const sups = (await env.DB.prepare("SELECT name, pin_hash FROM cw_staff WHERE role = 'SUPERVISOR' AND active = 1").all()).results;
  for (const s of sups) if (await checkPin(String(pin || ''), s.pin_hash)) return s.name;
  return null;
}
const RPC = {
  async cw_list_staff(env) {
    return (await env.DB.prepare("SELECT id, name, role, active FROM cw_staff WHERE active = 1 ORDER BY role DESC, name").all()).results.map(r => ({ ...r, active: !!r.active }));
  },
  async cw_verify_pin(env, a, ip) {
    const key = `${ip}:${a.p_name}`; await guard(env, key);
    const s = await env.DB.prepare('SELECT role, pin_hash FROM cw_staff WHERE name = ? AND active = 1').bind(a.p_name || '').first();
    if (s && await checkPin(String(a.p_pin || ''), s.pin_hash)) return s.role;
    await fail(env, key, a.p_name); return null;
  },
  async cw_supervisor_by_pin(env, a, ip) {
    const key = `${ip}:SUPERVISOR`; await guard(env, key);
    const name = await supervisorByPin(env, a.p_pin);
    if (!name) await fail(env, key, 'supervisor PIN');
    return name;
  },
  async cw_staff_save(env, a, ip) {
    const anySup = await env.DB.prepare("SELECT 1 AS x FROM cw_staff WHERE role = 'SUPERVISOR' AND active = 1 LIMIT 1").first();
    if (anySup) { const key = `${ip}:SUPERVISOR`; await guard(env, key); if (!(await supervisorByPin(env, a.p_admin_pin))) { await fail(env, key, 'staff admin'); throw new HttpError(403, 'Supervisor PIN incorrect'); } }
    const name = String(a.p_name || '').trim(), role = a.p_role, pin = a.p_pin == null || a.p_pin === '' ? null : String(a.p_pin);
    if (!name) throw new HttpError(400, 'Name required');
    if (!['SORTER', 'DISPATCHER', 'RECEIVER', 'SUPERVISOR'].includes(role)) throw new HttpError(400, 'Unknown role');
    if (pin !== null && !/^\d{4,6}$/.test(pin)) throw new HttpError(400, 'PIN must be 4-6 digits');
    const ex = await env.DB.prepare('SELECT id FROM cw_staff WHERE name = ?').bind(name).first();
    if (!ex && pin === null) throw new HttpError(400, 'PIN required for new staff');
    if (pin !== null && role === 'SUPERVISOR') {
      const others = (await env.DB.prepare("SELECT name, pin_hash FROM cw_staff WHERE role = 'SUPERVISOR' AND active = 1 AND name <> ?").bind(name).all()).results;
      for (const o of others) if (await checkPin(pin, o.pin_hash)) throw new HttpError(400, 'Another supervisor already uses that PIN');
    }
    const active = a.p_active === false ? 0 : 1;
    if (ex) {
      if (pin !== null) await env.DB.prepare('UPDATE cw_staff SET role = ?, active = ?, pin_hash = ? WHERE id = ?').bind(role, active, await makeHash(pin), ex.id).run();
      else await env.DB.prepare('UPDATE cw_staff SET role = ?, active = ? WHERE id = ?').bind(role, active, ex.id).run();
    } else await env.DB.prepare('INSERT INTO cw_staff (id, name, role, pin_hash, active, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(uuid(), name, role, await makeHash(pin), active, nowIso()).run();
    return true;
  },
  async cw_reserve_bag_numbers(env, a) {
    const n = parseInt(a.n);
    if (!(n >= 1 && n <= 2000)) throw new HttpError(400, 'Between 1 and 2000 labels at a time');
    const r = await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO cw_meta (k, v) VALUES ('bag_seq', 0)"),
      env.DB.prepare("UPDATE cw_meta SET v = v + ? WHERE k = 'bag_seq' RETURNING v").bind(n)
    ]);
    return r[1].results[0].v - n + 1;
  }
};

/* ---------------- entry point ---------------- */
export async function onRequest({ request, env, params }) {
  const path = (params.path || []).join('/');
  const user = request.headers.get('cf-access-authenticated-user-email');
  try {
    if (String(env.ACCESS_REQUIRED || '').toLowerCase() === 'true' && !user) throw new HttpError(401, 'Sign in through Cloudflare Access');
    await ensure(env);
    if (path === 'health') {
      const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM cw_cuts').first())?.n || 0;
      return json({ ok: true, db: 'd1', schema: SCHEMA_VERSION, jobs: n, user: user || null });
    }
    if (request.method !== 'POST') throw new HttpError(405, 'Use POST');
    const body = await request.json().catch(() => { throw new HttpError(400, 'Body must be JSON'); });
    if (path === 'q') {
      const op = body.op;
      const data = op === 'list' ? await list(env, body) : op === 'insert' ? await insert(env, body, user) : op === 'update' ? await update(env, body) : op === 'delete' ? await del(env, body) : null;
      if (data === null) throw new HttpError(400, `Unknown op: ${op}`);
      return json({ data });
    }
    if (path.startsWith('rpc/')) {
      const fn = RPC[path.slice(4)];
      if (!fn) throw new HttpError(404, 'Unknown function');
      const ip = request.headers.get('cf-connecting-ip') || 'local';
      return json({ data: await fn(env, body || {}, ip) });
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    const status = e.status || (/UNIQUE|constraint/i.test(e.message) ? 409 : 500);
    return json({ error: e.message || String(e) }, status);
  }
}
