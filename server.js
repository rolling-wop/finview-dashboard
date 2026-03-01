const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const https = require('https');
const initSqlJs = require('sql.js');

const app = express();
const PORT = process.env.PORT || 3847;
const JWT_SECRET = process.env.JWT_SECRET || 'dylan-findb-secret-2026-!@#';
const DB_PATH = path.join(__dirname, 'data', 'dashboard.db');

let db;

// ── Database ───────────────────────────────────────────────────────────────────
async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const data = fs.readFileSync(DB_PATH);
    db = new SQL.Database(data);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      name TEXT NOT NULL, age INTEGER DEFAULT 0, gender TEXT DEFAULT '', occupation TEXT DEFAULT '',
      annual_income REAL DEFAULT 0, dependents INTEGER DEFAULT 0, email TEXT DEFAULT '', phone TEXT DEFAULT '',
      notion_page_id TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, type TEXT DEFAULT '',
      product_name TEXT DEFAULT '', insurer TEXT DEFAULT '', product_type TEXT DEFAULT '',
      coverage REAL DEFAULT 0, premium REAL DEFAULT 0, start_date TEXT DEFAULT '', end_date TEXT DEFAULT '',
      status TEXT DEFAULT 'Active', recommended REAL DEFAULT 0, notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS investments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, name TEXT DEFAULT '',
      type TEXT DEFAULT '', invested REAL DEFAULT 0, value_now REAL DEFAULT 0, target REAL DEFAULT 0,
      goal_by TEXT DEFAULT '', contribution REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, year INTEGER NOT NULL,
      snapshot_date TEXT DEFAULT '', total_coverage REAL DEFAULT 0, total_investment_value REAL DEFAULT 0,
      notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, year),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
  `);
  saveDb();
  console.log('✅ Database initialised');
}

function saveDb() {
  const data = db.export();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// sql.js helpers
function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free(); return null;
}
function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function dbRun(sql, params = []) {
  db.run(sql, params);
  const lastId = db.exec('SELECT last_insert_rowid() as id')[0];
  saveDb();
  return lastId ? lastId.values[0][0] : null;
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── Auth ───────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const client = dbGet('SELECT * FROM clients WHERE username = ?', [username]);
  if (!client || !bcrypt.compareSync(password, client.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });
  const token = jwt.sign({ id: client.id, username: client.username }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, client: { id: client.id, name: client.name, email: client.email, age: client.age, annual_income: client.annual_income, occupation: client.occupation } });
});

// ── Client ─────────────────────────────────────────────────────────────────────
app.get('/api/clients/:id', authenticate, (req, res) => {
  const c = dbGet('SELECT id,name,age,gender,occupation,annual_income,dependents,email,phone FROM clients WHERE id=?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

// ── Policies ───────────────────────────────────────────────────────────────────
app.get('/api/clients/:id/policies', authenticate, (req, res) => {
  res.json(dbAll('SELECT * FROM policies WHERE client_id=? ORDER BY type, created_at', [req.params.id]));
});
app.post('/api/clients/:id/policies', authenticate, (req, res) => {
  const { type, product_name, insurer, product_type, coverage, premium, start_date, end_date, status, recommended, notes } = req.body;
  const id = dbRun('INSERT INTO policies (client_id,type,product_name,insurer,product_type,coverage,premium,start_date,end_date,status,recommended,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [req.params.id, type||'', product_name||'', insurer||'', product_type||'', coverage||0, premium||0, start_date||'', end_date||'', status||'Active', recommended||0, notes||'']);
  res.json(dbGet('SELECT * FROM policies WHERE id=?', [id]));
});
app.put('/api/clients/:id/policies/:pid', authenticate, (req, res) => {
  const f = ['type','product_name','insurer','product_type','coverage','premium','start_date','end_date','status','recommended','notes'];
  const sets = [], vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { sets.push(`${k}=?`); vals.push(req.body[k]); } });
  if (!sets.length) return res.json(dbGet('SELECT * FROM policies WHERE id=?', [req.params.pid]));
  vals.push(req.params.pid, req.params.id);
  dbRun(`UPDATE policies SET ${sets.join(',')} WHERE id=? AND client_id=?`, vals);
  res.json(dbGet('SELECT * FROM policies WHERE id=?', [req.params.pid]));
});
app.delete('/api/clients/:id/policies/:pid', authenticate, (req, res) => {
  dbRun('DELETE FROM policies WHERE id=? AND client_id=?', [req.params.pid, req.params.id]);
  res.json({ success: true });
});

// ── Investments ────────────────────────────────────────────────────────────────
app.get('/api/clients/:id/investments', authenticate, (req, res) => {
  res.json(dbAll('SELECT * FROM investments WHERE client_id=? ORDER BY created_at', [req.params.id]));
});
app.post('/api/clients/:id/investments', authenticate, (req, res) => {
  const { name, type, invested, value_now, target, goal_by, contribution } = req.body;
  const id = dbRun('INSERT INTO investments (client_id,name,type,invested,value_now,target,goal_by,contribution) VALUES (?,?,?,?,?,?,?,?)',
    [req.params.id, name||'', type||'', invested||0, value_now||0, target||0, goal_by||'', contribution||0]);
  res.json(dbGet('SELECT * FROM investments WHERE id=?', [id]));
});
app.put('/api/clients/:id/investments/:iid', authenticate, (req, res) => {
  const f = ['name','type','invested','value_now','target','goal_by','contribution'];
  const sets = [], vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { sets.push(`${k}=?`); vals.push(req.body[k]); } });
  if (!sets.length) return res.json(dbGet('SELECT * FROM investments WHERE id=?', [req.params.iid]));
  vals.push(req.params.iid, req.params.id);
  dbRun(`UPDATE investments SET ${sets.join(',')} WHERE id=? AND client_id=?`, vals);
  res.json(dbGet('SELECT * FROM investments WHERE id=?', [req.params.iid]));
});
app.delete('/api/clients/:id/investments/:iid', authenticate, (req, res) => {
  dbRun('DELETE FROM investments WHERE id=? AND client_id=?', [req.params.iid, req.params.id]);
  res.json({ success: true });
});

// ── Snapshots ──────────────────────────────────────────────────────────────────
app.get('/api/clients/:id/snapshots', authenticate, (req, res) => {
  res.json(dbAll('SELECT * FROM snapshots WHERE client_id=? ORDER BY year', [req.params.id]));
});
app.post('/api/clients/:id/snapshots', authenticate, (req, res) => {
  const { year, snapshot_date, total_coverage, total_investment_value, notes } = req.body;
  const id = dbRun('INSERT OR REPLACE INTO snapshots (client_id,year,snapshot_date,total_coverage,total_investment_value,notes) VALUES (?,?,?,?,?,?)',
    [req.params.id, year, snapshot_date||'', total_coverage||0, total_investment_value||0, notes||'']);
  res.json(dbGet('SELECT * FROM snapshots WHERE rowid=?', [id]));
});
app.post('/api/clients/:id/snapshots/auto', authenticate, (req, res) => {
  const year = new Date().getFullYear();
  const policies = dbAll('SELECT coverage FROM policies WHERE client_id=? AND status=?', [req.params.id, 'Active']);
  const investments = dbAll('SELECT value_now FROM investments WHERE client_id=?', [req.params.id]);
  const tc = policies.reduce((s, p) => s + p.coverage, 0);
  const ti = investments.reduce((s, i) => s + i.value_now, 0);
  dbRun('INSERT OR REPLACE INTO snapshots (client_id,year,snapshot_date,total_coverage,total_investment_value,notes) VALUES (?,?,date("now"),?,?,"Auto snapshot")',
    [req.params.id, year, tc, ti]);
  res.json({ year, total_coverage: tc, total_investment_value: ti });
});

// ── Notion Sync ────────────────────────────────────────────────────────────────
const NOTION_KEY = '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';
const NOTION_CLIENTS_DB = '9b9b9db9-65ed-4da0-b833-c2ffcc96f0dc';

function notionReq(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { hostname: 'api.notion.com', path: `/v1${p}`, method, headers: { 'Authorization': `Bearer ${NOTION_KEY}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } };
    const req = https.request(opts, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve({}); } }); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

app.post('/api/sync/push/:id', authenticate, async (req, res) => {
  try {
    const client = dbGet('SELECT * FROM clients WHERE id=?', [req.params.id]);
    const policies = dbAll('SELECT * FROM policies WHERE client_id=?', [req.params.id]);
    const totalPremium = policies.reduce((s, p) => s + p.premium, 0);
    const props = {
      'Name': { title: [{ text: { content: client.name } }] },
      'Email': { email: client.email || null },
      'Phone': { phone_number: client.phone || null },
      'Total Premium (SGD)': { number: totalPremium },
      'Status': { select: { name: 'Active' } },
      'Notes': { rich_text: [{ text: { content: `Synced ${new Date().toLocaleDateString('en-SG')}` } }] }
    };
    if (client.notion_page_id) {
      await notionReq('PATCH', `/pages/${client.notion_page_id}`, { properties: props });
    } else {
      const page = await notionReq('POST', '/pages', { parent: { database_id: NOTION_CLIENTS_DB }, properties: props });
      if (page.id) dbRun('UPDATE clients SET notion_page_id=? WHERE id=?', [page.id, req.params.id]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin ──────────────────────────────────────────────────────────────────────
app.post('/api/admin/clients', (req, res) => {
  if (req.headers['x-admin-key'] !== 'dylan-admin-2026') return res.status(403).json({ error: 'Forbidden' });
  const { id, username, password, name, age, gender, occupation, annual_income, dependents, email, phone } = req.body;
  try {
    const hash = bcrypt.hashSync(password, 10);
    dbRun('INSERT INTO clients (id,username,password_hash,name,age,gender,occupation,annual_income,dependents,email,phone) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id || `C${Date.now()}`, username, hash, name, age||0, gender||'', occupation||'', annual_income||0, dependents||0, email||'', phone||'']);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/seed/:id', (req, res) => {
  if (req.headers['x-admin-key'] !== 'dylan-admin-2026') return res.status(403).json({ error: 'Forbidden' });
  const { policies, investments, snapshots } = req.body;
  try {
    (policies||[]).forEach(p => dbRun('INSERT INTO policies (client_id,type,product_name,insurer,product_type,coverage,premium,start_date,end_date,status,recommended,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [req.params.id, p.type||'', p.product_name||'', p.insurer||'', p.product_type||'', p.coverage||0, p.premium||0, p.start_date||'', p.end_date||'', p.status||'Active', p.recommended||0, p.notes||'']));
    (investments||[]).forEach(i => dbRun('INSERT INTO investments (client_id,name,type,invested,value_now,target,goal_by,contribution) VALUES (?,?,?,?,?,?,?,?)',
      [req.params.id, i.name||'', i.type||'', i.invested||0, i.value_now||0, i.target||0, i.goal_by||'', i.contribution||0]));
    (snapshots||[]).forEach(s => dbRun('INSERT OR REPLACE INTO snapshots (client_id,year,snapshot_date,total_coverage,total_investment_value,notes) VALUES (?,?,?,?,?,?)',
      [req.params.id, s.year, s.snapshot_date||'', s.total_coverage||0, s.total_investment_value||0, s.notes||'']));
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Start ──────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => console.log(`\n🚀 Financial Dashboard → http://localhost:${PORT}\n   Login: sarah.tan / secure123\n`));
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
