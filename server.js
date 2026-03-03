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
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      name TEXT NOT NULL, age INTEGER DEFAULT 0, gender TEXT DEFAULT '', occupation TEXT DEFAULT '',
      annual_income REAL DEFAULT 0, dependents INTEGER DEFAULT 0, email TEXT DEFAULT '',
      phone TEXT DEFAULT '', role TEXT DEFAULT 'client', notion_page_id TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, type TEXT DEFAULT '',
      product_name TEXT DEFAULT '', policy_number TEXT DEFAULT '', insurer TEXT DEFAULT '',
      product_type TEXT DEFAULT '', coverage REAL DEFAULT 0, premium REAL DEFAULT 0,
      start_date TEXT DEFAULT '', end_date TEXT DEFAULT '', status TEXT DEFAULT 'Active',
      recommended REAL DEFAULT 0, notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS investments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, name TEXT DEFAULT '',
      type TEXT DEFAULT '', invested REAL DEFAULT 0, value_now REAL DEFAULT 0,
      target REAL DEFAULT 0, goal_by TEXT DEFAULT '', contribution REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, year INTEGER NOT NULL,
      snapshot_date TEXT DEFAULT '', total_coverage REAL DEFAULT 0,
      total_investment_value REAL DEFAULT 0, notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, year),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
  `);

  // Migrations for existing DBs
  try { db.run(`ALTER TABLE clients ADD COLUMN role TEXT DEFAULT 'client'`); } catch {}
  try { db.run(`ALTER TABLE policies ADD COLUMN policy_number TEXT DEFAULT ''`); } catch {}

  // Auto-seed admin if not exists
  const adminExists = dbGet(`SELECT id FROM clients WHERE role='admin'`);
  if (!adminExists) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin2026', 10);
    db.run(`INSERT INTO clients (id,username,password_hash,name,role) VALUES ('ADMIN001','admin',?,'Dylan Ho','admin')`, [hash]);
    console.log('✅ Admin user seeded');
  }

  saveDb();
  console.log('✅ Database ready');
}

function saveDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function dbGet(sql, params = []) {
  const s = db.prepare(sql); s.bind(params);
  if (s.step()) { const r = s.getAsObject(); s.free(); return r; }
  s.free(); return null;
}
function dbAll(sql, params = []) {
  const s = db.prepare(sql); s.bind(params);
  const rows = [];
  while (s.step()) rows.push(s.getAsObject());
  s.free(); return rows;
}
function dbRun(sql, params = []) {
  db.run(sql, params);
  const r = db.exec('SELECT last_insert_rowid() as id');
  saveDb();
  return r.length ? r[0].values[0][0] : null;
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

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ── Auth ───────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const client = dbGet('SELECT * FROM clients WHERE username = ?', [username]);
  if (!client || !bcrypt.compareSync(password, client.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });
  const token = jwt.sign({ id: client.id, username: client.username, role: client.role }, JWT_SECRET, { expiresIn: '8h' });
  res.json({
    token,
    role: client.role,
    client: { id: client.id, name: client.name, email: client.email, age: client.age, annual_income: client.annual_income, occupation: client.occupation, role: client.role }
  });
});

// ── Admin: List all clients ────────────────────────────────────────────────────
app.get('/api/admin/clients', authenticate, requireAdmin, (req, res) => {
  const clients = dbAll(`SELECT id, username, name, age, gender, occupation, annual_income, email, phone, role, created_at FROM clients WHERE role != 'admin' ORDER BY name`);
  // Enrich with policy/investment counts
  const enriched = clients.map(c => {
    const policyCount = dbGet('SELECT COUNT(*) as cnt FROM policies WHERE client_id=?', [c.id])?.cnt || 0;
    const totalCoverage = dbGet('SELECT SUM(coverage) as total FROM policies WHERE client_id=? AND status=?', [c.id, 'Active'])?.total || 0;
    const totalPremium = dbGet('SELECT SUM(premium) as total FROM policies WHERE client_id=?', [c.id])?.total || 0;
    const totalInvestments = dbGet('SELECT SUM(value_now) as total FROM investments WHERE client_id=?', [c.id])?.total || 0;
    return { ...c, policyCount, totalCoverage, totalPremium, totalInvestments };
  });
  res.json(enriched);
});

// ── Admin: Create client ───────────────────────────────────────────────────────
app.post('/api/admin/clients', authenticate, requireAdmin, (req, res) => {
  const { username, password, name, age, gender, occupation, annual_income, dependents, email, phone } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'username, password and name required' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const id = `C${Date.now()}`;
    dbRun('INSERT INTO clients (id,username,password_hash,name,age,gender,occupation,annual_income,dependents,email,phone,role) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, username, hash, name, age||0, gender||'', occupation||'', annual_income||0, dependents||0, email||'', phone||'', 'client']);
    const newClient = dbGet('SELECT id,username,name,age,gender,occupation,annual_income,email,phone,role FROM clients WHERE id=?', [id]);
    // Auto-push to Notion
    notionPushClient(newClient).catch(() => {});
    res.json(newClient);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Admin: Update client ───────────────────────────────────────────────────────
app.put('/api/admin/clients/:id', authenticate, requireAdmin, (req, res) => {
  const { name, age, gender, occupation, annual_income, dependents, email, phone, password } = req.body;
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    dbRun(`UPDATE clients SET password_hash=?, updated_at=datetime('now') WHERE id=?`, [hash, req.params.id]);
  }
  dbRun(`UPDATE clients SET name=?,age=?,gender=?,occupation=?,annual_income=?,dependents=?,email=?,phone=?,updated_at=datetime('now') WHERE id=?`,
    [name, age||0, gender||'', occupation||'', annual_income||0, dependents||0, email||'', phone||'', req.params.id]);
  res.json({ success: true });
});

// ── Admin: Delete client ───────────────────────────────────────────────────────
app.delete('/api/admin/clients/:id', authenticate, requireAdmin, (req, res) => {
  dbRun('DELETE FROM clients WHERE id=? AND role!=?', [req.params.id, 'admin']);
  res.json({ success: true });
});

// ── Admin: Stats overview ──────────────────────────────────────────────────────
app.get('/api/admin/stats', authenticate, requireAdmin, (req, res) => {
  const totalClients = dbGet(`SELECT COUNT(*) as cnt FROM clients WHERE role='client'`)?.cnt || 0;
  const totalPolicies = dbGet('SELECT COUNT(*) as cnt FROM policies')?.cnt || 0;
  const totalCoverage = dbGet(`SELECT SUM(p.coverage) as total FROM policies p JOIN clients c ON p.client_id=c.id WHERE c.role='client' AND p.status='Active'`)?.total || 0;
  const totalPremium = dbGet(`SELECT SUM(p.premium) as total FROM policies p JOIN clients c ON p.client_id=c.id WHERE c.role='client'`)?.total || 0;
  const totalInvestments = dbGet(`SELECT SUM(i.value_now) as total FROM investments i JOIN clients c ON i.client_id=c.id WHERE c.role='client'`)?.total || 0;
  res.json({ totalClients, totalPolicies, totalCoverage, totalPremium, totalInvestments });
});

// ── Client: Get profile ────────────────────────────────────────────────────────
app.get('/api/clients/:id', authenticate, (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  const c = dbGet('SELECT id,name,age,gender,occupation,annual_income,dependents,email,phone,role FROM clients WHERE id=?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

app.put('/api/clients/:id', authenticate, (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  const { name, age, gender, occupation, annual_income, dependents, email, phone } = req.body;
  dbRun(`UPDATE clients SET name=?,age=?,gender=?,occupation=?,annual_income=?,dependents=?,email=?,phone=?,updated_at=datetime('now') WHERE id=?`,
    [name, age||0, gender||'', occupation||'', annual_income||0, dependents||0, email||'', phone||'', req.params.id]);
  res.json({ success: true });
});

// ── Policies ───────────────────────────────────────────────────────────────────
function guardClient(req, res) {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) { res.status(403).json({ error: 'Forbidden' }); return false; }
  return true;
}

app.get('/api/clients/:id/policies', authenticate, (req, res) => {
  if (!guardClient(req, res)) return;
  res.json(dbAll('SELECT * FROM policies WHERE client_id=? ORDER BY type, created_at', [req.params.id]));
});

app.post('/api/clients/:id/policies', authenticate, (req, res) => {
  if (!guardClient(req, res)) return;
  const { type, product_name, policy_number, insurer, product_type, coverage, premium, start_date, end_date, status, recommended, notes } = req.body;
  const id = dbRun('INSERT INTO policies (client_id,type,product_name,policy_number,insurer,product_type,coverage,premium,start_date,end_date,status,recommended,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [req.params.id, type||'', product_name||'', policy_number||'', insurer||'', product_type||'', coverage||0, premium||0, start_date||'', end_date||'', status||'Active', recommended||0, notes||'']);
  res.json(dbGet('SELECT * FROM policies WHERE id=?', [id]));
});

app.put('/api/clients/:id/policies/:pid', authenticate, (req, res) => {
  if (!guardClient(req, res)) return;
  const f = ['type','product_name','policy_number','insurer','product_type','coverage','premium','start_date','end_date','status','recommended','notes'];
  const sets = [], vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { sets.push(`${k}=?`); vals.push(req.body[k]); } });
  if (sets.length) { vals.push(req.params.pid, req.params.id); dbRun(`UPDATE policies SET ${sets.join(',')} WHERE id=? AND client_id=?`, vals); }
  res.json(dbGet('SELECT * FROM policies WHERE id=?', [req.params.pid]));
});

app.delete('/api/clients/:id/policies/:pid', authenticate, (req, res) => {
  if (!guardClient(req, res)) return;
  dbRun('DELETE FROM policies WHERE id=? AND client_id=?', [req.params.pid, req.params.id]);
  res.json({ success: true });
});

// ── Investments ────────────────────────────────────────────────────────────────
app.get('/api/clients/:id/investments', authenticate, (req, res) => {
  if (!guardClient(req, res)) return;
  res.json(dbAll('SELECT * FROM investments WHERE client_id=? ORDER BY created_at', [req.params.id]));
});

app.post('/api/clients/:id/investments', authenticate, (req, res) => {
  if (!guardClient(req, res)) return;
  const { name, type, invested, value_now, target, goal_by, contribution } = req.body;
  const id = dbRun('INSERT INTO investments (client_id,name,type,invested,value_now,target,goal_by,contribution) VALUES (?,?,?,?,?,?,?,?)',
    [req.params.id, name||'', type||'', invested||0, value_now||0, target||0, goal_by||'', contribution||0]);
  res.json(dbGet('SELECT * FROM investments WHERE id=?', [id]));
});

app.put('/api/clients/:id/investments/:iid', authenticate, (req, res) => {
  if (!guardClient(req, res)) return;
  const f = ['name','type','invested','value_now','target','goal_by','contribution'];
  const sets = [], vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { sets.push(`${k}=?`); vals.push(req.body[k]); } });
  if (sets.length) { vals.push(req.params.iid, req.params.id); dbRun(`UPDATE investments SET ${sets.join(',')} WHERE id=? AND client_id=?`, vals); }
  res.json(dbGet('SELECT * FROM investments WHERE id=?', [req.params.iid]));
});

app.delete('/api/clients/:id/investments/:iid', authenticate, (req, res) => {
  if (!guardClient(req, res)) return;
  dbRun('DELETE FROM investments WHERE id=? AND client_id=?', [req.params.iid, req.params.id]);
  res.json({ success: true });
});

// ── Snapshots ──────────────────────────────────────────────────────────────────
app.get('/api/clients/:id/snapshots', authenticate, (req, res) => {
  if (!guardClient(req, res)) return;
  res.json(dbAll('SELECT * FROM snapshots WHERE client_id=? ORDER BY year', [req.params.id]));
});

app.post('/api/clients/:id/snapshots', authenticate, (req, res) => {
  if (!guardClient(req, res)) return;
  const { year, snapshot_date, total_coverage, total_investment_value, notes } = req.body;
  const id = dbRun('INSERT OR REPLACE INTO snapshots (client_id,year,snapshot_date,total_coverage,total_investment_value,notes) VALUES (?,?,?,?,?,?)',
    [req.params.id, year, snapshot_date||'', total_coverage||0, total_investment_value||0, notes||'']);
  res.json({ id, year, total_coverage, total_investment_value });
});

app.post('/api/clients/:id/snapshots/auto', authenticate, (req, res) => {
  if (!guardClient(req, res)) return;
  const year = new Date().getFullYear();
  const policies = dbAll('SELECT coverage FROM policies WHERE client_id=? AND status=?', [req.params.id, 'Active']);
  const investments = dbAll('SELECT value_now FROM investments WHERE client_id=?', [req.params.id]);
  const tc = policies.reduce((s, p) => s + (p.coverage || 0), 0);
  const ti = investments.reduce((s, i) => s + (i.value_now || 0), 0);
  dbRun(`INSERT OR REPLACE INTO snapshots (client_id,year,snapshot_date,total_coverage,total_investment_value,notes) VALUES (?,?,date('now'),?,?,'Auto snapshot')`,
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

async function notionPushClient(client) {
  const policies = dbAll('SELECT * FROM policies WHERE client_id=?', [client.id]);
  const totalPremium = policies.reduce((s, p) => s + (p.premium || 0), 0);
  const props = {
    'Name': { title: [{ text: { content: client.name } }] },
    'Email': { email: client.email || null },
    'Phone': { phone_number: client.phone || null },
    'Total Premium (SGD)': { number: totalPremium },
    'Status': { select: { name: 'Active' } },
    'Notes': { rich_text: [{ text: { content: `Synced ${new Date().toLocaleDateString('en-SG')}` } }] }
  };
  const existingClient = dbGet('SELECT notion_page_id FROM clients WHERE id=?', [client.id]);
  if (existingClient?.notion_page_id) {
    await notionReq('PATCH', `/pages/${existingClient.notion_page_id}`, { properties: props });
  } else {
    const page = await notionReq('POST', '/pages', { parent: { database_id: NOTION_CLIENTS_DB }, properties: props });
    if (page.id) dbRun(`UPDATE clients SET notion_page_id=? WHERE id=?`, [page.id, client.id]);
  }
}

app.post('/api/sync/push/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  try {
    const client = dbGet('SELECT * FROM clients WHERE id=?', [req.params.id]);
    await notionPushClient(client);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sync/push-all', authenticate, requireAdmin, async (req, res) => {
  try {
    const clients = dbAll(`SELECT * FROM clients WHERE role='client'`);
    let synced = 0;
    for (const c of clients) { try { await notionPushClient(c); synced++; } catch {} }
    res.json({ success: true, synced });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Expiry Alerts ───────────────────────────────────────────────
app.get('/api/admin/expiry-alerts', authenticate, requireAdmin, (req, res) => {
  const days = parseInt(req.query.days) || 90;
  const today = new Date();
  const cutoff = new Date(today); cutoff.setDate(today.getDate() + days);
  const todayStr = today.toISOString().split('T')[0];
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const policies = dbAll(`
    SELECT p.*, c.name as client_name, c.email as client_email, c.phone as client_phone
    FROM policies p
    JOIN clients c ON p.client_id = c.id
    WHERE c.role != 'admin'
      AND p.end_date != ''
      AND p.end_date >= ?
      AND p.end_date <= ?
      AND p.status = 'Active'
    ORDER BY p.end_date ASC
  `, [todayStr, cutoffStr]);

  const tagged = policies.map(p => {
    const daysLeft = Math.ceil((new Date(p.end_date) - today) / (1000 * 60 * 60 * 24));
    const urgency = daysLeft <= 14 ? 'critical' : daysLeft <= 30 ? 'high' : daysLeft <= 60 ? 'medium' : 'low';
    return { ...p, days_left: daysLeft, urgency };
  });

  res.json({
    generated_at: new Date().toISOString(),
    window_days: days,
    total: tagged.length,
    alerts: tagged
  });
});

// ── Bootstrap admin ────────────────────────────────────────────────────────────
app.post('/api/bootstrap', (req, res) => {
  const { adminPassword } = req.body || {};
  const existing = dbGet(`SELECT id FROM clients WHERE role='admin'`);
  if (existing) return res.status(400).json({ error: 'Admin already exists' });
  const hash = bcrypt.hashSync(adminPassword || 'admin2026', 10);
  dbRun('INSERT INTO clients (id,username,password_hash,name,role) VALUES (?,?,?,?,?)',
    ['ADMIN001', 'admin', hash, 'Dylan Ho', 'admin']);
  res.json({ success: true, username: 'admin' });
});

// ── Start ──────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 FinView Dashboard → http://localhost:${PORT}`);
    console.log(`   Admin: admin / admin2026`);
    console.log(`   Client demo: sarah.tan / secure123\n`);
  });
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
