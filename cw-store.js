/*
 * CutTrack — shared data layer for the tracker and the three floor apps.
 *
 * Live:  talks to /api on the same site (Cloudflare Pages Functions + D1). No database keys in the browser.
 * Demo:  when opened as a local file, with ?demo=1, or when no /api answers — data stays in this browser
 *        (localStorage 'cw_demo'), shared between the four apps opened from the same place.
 *
 * Every app uses the same calls: Store.list / one / insert / update / updateCond / del / rpc.
 */
(function () {
  const TABLES = ['cw_parties', 'cw_cuts', 'cw_bundles', 'cw_bags', 'cw_deliveries', 'cw_delivery_items', 'cw_exceptions', 'cw_staff', 'cw_scans', 'cw_meta', 'cw_receipts', 'cw_receipt_items', 'cw_investigations', 'cw_bundle_parts'];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  const nowIso = () => new Date().toISOString();
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  const DEMO_PARTIES = [['Cutting Room', 'CUTTING'], ['Printer A', 'PRINTER'], ['Printer B', 'PRINTER'], ['Sewing Floor', 'SEWING']];
  const DEMO_STAFF = [['Sorter 1', 'SORTER', '1111'], ['Sorter 2', 'SORTER', '2222'], ['Dispatcher', 'DISPATCHER', '3333'], ['Receiver', 'RECEIVER', '4444'], ['Supervisor', 'SUPERVISOR', '9999']];

  /* demo-mode stand-ins for the server functions */
  const DemoRPC = {
    cw_list_staff: () => Store.mem.cw_staff.filter(s => s.active !== false).map(({ id, name, role, active }) => ({ id, name, role, active })),
    cw_verify_pin: ({ p_name, p_pin }) => Store.mem.cw_staff.find(x => x.name === p_name && x.active !== false && x.pin === p_pin)?.role || null,
    cw_supervisor_by_pin: ({ p_pin }) => Store.mem.cw_staff.find(x => x.role === 'SUPERVISOR' && x.active !== false && x.pin === p_pin)?.name || null,
    cw_staff_save: ({ p_admin_pin, p_name, p_role, p_pin, p_active }) => {
      const sup = Store.mem.cw_staff.filter(x => x.role === 'SUPERVISOR' && x.active !== false);
      if (sup.length && !sup.some(x => x.pin === p_admin_pin)) throw new Error('Supervisor PIN incorrect');
      if (p_pin && !/^\d{4,6}$/.test(p_pin)) throw new Error('PIN must be 4-6 digits');
      let s = Store.mem.cw_staff.find(x => x.name.toLowerCase() === String(p_name).trim().toLowerCase());
      if (!s && !p_pin) throw new Error('PIN required for new staff');
      if (!s) { s = { id: uid(), name: String(p_name).trim(), created_at: nowIso() }; Store.mem.cw_staff.push(s); }
      s.role = p_role || s.role; if (p_pin) s.pin = p_pin; s.active = p_active !== false; Store.persist(); return true;
    },
    cw_reserve_bag_numbers: ({ n }) => { let r = Store.mem.cw_meta.find(x => x.id === 'bag_seq'); if (!r) { r = { id: 'bag_seq', v: 0 }; Store.mem.cw_meta.push(r); } const first = r.v + 1; r.v += n; Store.persist(); return first; }
  };

  const Store = {
    live: false, mem: null, user: null,

    /* decide live vs demo; call once (await) before anything else */
    async init() {
      this.live = false;
      const forceDemo = location.protocol === 'file:' || /[?&]demo=1\b/.test(location.search);
      if (!forceDemo) {
        try {
          const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 6000);
          const r = await fetch('/api/health', { cache: 'no-store', redirect: 'manual', signal: ctl.signal });
          clearTimeout(tm);
          if (r.type === 'opaqueredirect') { this.live = true; this.signedOut = true; }
          else { const j = await r.json(); if (j && j.ok) { this.live = true; this.user = j.user || null; } }
        } catch (e) { this.live = lsGet('cw_api_live', false) === true; }   // offline right now: stay live if this site was live before
        if (this.live) lsSet('cw_api_live', true);
      }
      if (!this.live) this.seed();
      return this.live;
    },

    /* ---------- demo storage ---------- */
    reload() { if (!this.live) { this.mem = lsGet('cw_demo', null) || this.mem || {}; TABLES.forEach(t => this.mem[t] = this.mem[t] || []); } },
    persist() { if (!this.live) lsSet('cw_demo', this.mem); },
    seed() {
      this.reload();
      let ch = false;
      if (!this.mem.cw_parties.length) { DEMO_PARTIES.forEach(([name, kind]) => this.mem.cw_parties.push({ id: uid(), name, kind, created_at: nowIso() })); ch = true; }
      DEMO_STAFF.forEach(([name, role, pin]) => { if (!this.mem.cw_staff.some(s => s.role === role)) { this.mem.cw_staff.push({ id: uid(), name, role, pin, active: true }); ch = true; } });
      if (ch) this.persist();
    },
    match(r, f) { return Object.entries(f || {}).every(([k, v]) => Array.isArray(v) ? v.includes(r[k]) : v === null ? r[k] == null : r[k] === v); },

    /* ---------- server ---------- */
    async api(path, body) {
      let r;
      r = await fetch('/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual', cache: 'no-store' });
      if (r.type === 'opaqueredirect' || r.status === 401) throw new Error('Signed out — reload the page to sign in again');
      if (r.status >= 502 && r.status <= 504) throw new Error(`Server unreachable (network ${r.status})`);
      let j; try { j = await r.json(); } catch (e) { throw new Error(`Server error (${r.status})`); }
      if (!r.ok || j.error) throw new Error(j.error || `Server error (${r.status})`);
      return j.data;
    },

    /* ---------- the calls the apps use ---------- */
    async list(t, f = {}, o = {}) {
      const ak = Object.keys(f).find(k => Array.isArray(f[k]));
      if (ak && !f[ak].length) return [];
      if (!this.live) {
        this.reload();
        let r = this.mem[t].filter(x => this.match(x, f) && (!o.gte || (x[o.gte[0]] != null && x[o.gte[0]] >= o.gte[1])));
        if (o.order) { const k = o.order, a = o.asc ? 1 : -1; r.sort((x, y) => (x[k] > y[k] ? 1 : x[k] < y[k] ? -1 : 0) * a); }
        if (o.limit) r = r.slice(0, o.limit);
        return r.map(x => ({ ...x }));
      }
      return this.api('q', { op: 'list', table: t, filter: f, order: o.order, asc: !!o.asc, limit: o.limit, gte: o.gte });
    },
    async one(t, f) { return (await this.list(t, f, { limit: 1 }))[0] || null; },
    async insert(t, rows) {
      rows = rows.map(r => ({ id: uid(), created_at: nowIso(), ...r }));
      if (!rows.length) return [];
      if (!this.live) { this.reload(); this.mem[t].push(...rows.map(r => ({ ...r }))); this.persist(); return rows; }
      const out = [];
      for (let i = 0; i < rows.length; i += 200) out.push(...await this.api('q', { op: 'insert', table: t, rows: rows.slice(i, i + 200) }));
      return out;
    },
    /* update rows matching f; returns the rows changed (empty when nothing matched — used for "only if still unbagged" etc.) */
    async updateCond(t, f, patch) {
      const ak = Object.keys(f).find(k => Array.isArray(f[k]));
      if (ak && !f[ak].length) return [];
      if (!this.live) { this.reload(); const rows = this.mem[t].filter(r => this.match(r, f)); rows.forEach(r => Object.assign(r, patch)); this.persist(); return rows.map(r => ({ ...r })); }
      return this.api('q', { op: 'update', table: t, filter: f, patch });
    },
    async update(t, f, patch) { return this.updateCond(t, f, patch); },
    async del(t, f) {
      if (!this.live) { this.reload(); this.mem[t] = this.mem[t].filter(r => !this.match(r, f)); this.persist(); return; }
      return this.api('q', { op: 'delete', table: t, filter: f });
    },
    async rpc(fn, args = {}) {
      if (!this.live) { this.reload(); return DemoRPC[fn](args); }
      return this.api('rpc/' + fn, args);
    }
  };
  window.Store = Store;
  window.DemoRPC = DemoRPC;
})();
