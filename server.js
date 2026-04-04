const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
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
    CREATE TABLE IF NOT EXISTS invite_tokens (
      token TEXT PRIMARY KEY, client_id TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT, used INTEGER DEFAULT 0,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
  `);

  // Migration: add coverage_items column to policies
  try { db.run(`ALTER TABLE policies ADD COLUMN coverage_items TEXT DEFAULT '[]'`); } catch {}
  // Migration: client notes + deal pipeline
  try { db.run(`ALTER TABLE clients ADD COLUMN notes TEXT DEFAULT ''`); } catch {}
  try { db.run(`ALTER TABLE clients ADD COLUMN deal_stage TEXT DEFAULT 'Prospect'`); } catch {}
  try { db.run(`ALTER TABLE clients ADD COLUMN last_contact TEXT DEFAULT ''`); } catch {}
  try { db.run(`ALTER TABLE clients ADD COLUMN next_action TEXT DEFAULT ''`); } catch {}

  // Migrations
  try { db.run(`ALTER TABLE clients ADD COLUMN role TEXT DEFAULT 'client'`); } catch {}
  try { db.run(`ALTER TABLE policies ADD COLUMN policy_number TEXT DEFAULT ''`); } catch {}
  try { db.run(`ALTER TABLE policies ADD COLUMN coverage_items TEXT DEFAULT '[]'`); } catch {}
  try { db.run(`CREATE TABLE IF NOT EXISTS invite_tokens (token TEXT PRIMARY KEY, client_id TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), expires_at TEXT, used INTEGER DEFAULT 0, FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE)`); } catch {}

  // Auto-seed admin
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

// Version / health ping — update this to confirm new deploys
app.get('/api/ping', (req, res) => res.json({ ok: true, version: 'v5-2026-03-09', routes: ['expiry-alerts','coverage-gaps','invite','gaps-per-client','coverage-items'] }));

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
    token, role: client.role,
    client: { id: client.id, name: client.name, email: client.email, age: client.age, annual_income: client.annual_income, occupation: client.occupation, role: client.role }
  });
});

// ── Admin: List all clients ────────────────────────────────────────────────────
app.get('/api/admin/clients', authenticate, requireAdmin, (req, res) => {
  const clients = dbAll(`SELECT id, username, name, age, gender, occupation, annual_income, email, phone, role, created_at FROM clients WHERE role != 'admin' ORDER BY name`);
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

// ── Admin: Expiry alerts across all clients ────────────────────────────────────
app.get('/api/admin/expiry-alerts', authenticate, requireAdmin, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 90, 1), 365);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];
  const policies = dbAll(`
    SELECT p.*, c.name as client_name, c.id as client_id, c.email as client_email
    FROM policies p JOIN clients c ON p.client_id = c.id
    WHERE p.end_date != '' AND p.end_date >= ? AND p.end_date <= ? AND p.status = 'Active'
    ORDER BY p.end_date ASC
  `, [today, cutoffStr]);
  res.json(policies);
});

// ── Admin: Coverage gaps across all clients ────────────────────────────────────
app.get('/api/admin/coverage-gaps', authenticate, requireAdmin, (req, res) => {
  const clients = dbAll(`SELECT id, name, age, annual_income, dependents, occupation FROM clients WHERE role='client'`);
  const result = clients.map(c => {
    const income = c.annual_income || 0;
    const age = c.age || 30;
    const deps = c.dependents || 0;
    const policies = dbAll(`SELECT type, SUM(coverage) as total FROM policies WHERE client_id=? AND status='Active' GROUP BY type`, [c.id]);
    const covByType = {};
    policies.forEach(p => { covByType[p.type] = p.total || 0; });

    // Recommended benchmarks (Singapore standard practice)
    const yearsToRetire = Math.max(0, 65 - age);
    const rec = {
      'Death / Life': income * Math.max(5, yearsToRetire * 0.7),
      'Early Critical Illness': income * 3,
      'Late Stage Critical Illness': income * 5,
      'TPD': income * Math.max(5, yearsToRetire * 0.7),
      'Hospitalization': 150000,
    };
    if (deps > 0) rec['Death / Life'] = income * Math.max(8, yearsToRetire * 1.0);

    const gaps = Object.entries(rec).map(([type, recommended]) => {
      const current = covByType[type] || 0;
      const gap = Math.max(0, recommended - current);
      const pct = recommended > 0 ? Math.min(100, Math.round(current / recommended * 100)) : 100;
      const status = pct >= 100 ? 'adequate' : pct >= 40 ? 'partial' : 'critical';
      return { type, current, recommended, gap, pct, status };
    }).filter(g => g.gap > 0);

    const totalGap = gaps.reduce((s, g) => s + g.gap, 0);
    return { ...c, gaps, totalGap };
  }).filter(c => c.totalGap > 0).sort((a, b) => b.totalGap - a.totalGap);
  res.json(result);
});

// ── Client: Get profile ────────────────────────────────────────────────────────
app.get('/api/clients/:id', authenticate, (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  const c = dbGet('SELECT id,name,age,gender,occupation,annual_income,dependents,email,phone,role,deal_stage,last_contact,next_action,notes FROM clients WHERE id=?', [req.params.id]);
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

// ── Client: Coverage gap analysis ─────────────────────────────────────────────
app.get('/api/clients/:id/coverage-gaps', authenticate, (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  const c = dbGet('SELECT * FROM clients WHERE id=?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Not found' });

  const income = c.annual_income || 0;
  const age = c.age || 30;
  const deps = c.dependents || 0;
  const yearsToRetire = Math.max(0, 65 - age);

  const policies = dbAll(`SELECT type, coverage, coverage_items FROM policies WHERE client_id=? AND status='Active'`, [c.id]);
  const covByType = {};
  policies.forEach(p => {
    // First try coverage_items (granular breakdown)
    let items = [];
    try { items = JSON.parse(p.coverage_items || '[]'); } catch {}
    if (Array.isArray(items) && items.length > 0) {
      items.forEach(item => {
        if (item.type && item.coverage) {
          covByType[item.type] = (covByType[item.type] || 0) + (parseFloat(item.coverage) || 0);
        }
      });
    } else if (p.coverage > 0) {
      // Fallback: map policy type to coverage type
      const typeMap = {
        'Term Life': 'Death / Life', 'Whole Life': 'Death / Life',
        'ILP': 'Death / Life', 'IUL': 'Death / Life',
        'Early CI': 'Early Critical Illness', 'Standalone CI': 'Late Stage Critical Illness',
        'Multi-Pay CI': 'Late Stage Critical Illness',
        'Medical': 'Hospitalization',
        'Disability Income': 'Disability Income',
        'TPD': 'TPD',
      };
      const mapped = typeMap[p.type] || p.type;
      covByType[mapped] = (covByType[mapped] || 0) + (p.coverage || 0);
    }
  });

  const rec = {
    'Death / Life': deps > 0 ? income * Math.max(8, yearsToRetire) : income * Math.max(5, yearsToRetire * 0.7),
    'Early Critical Illness': income * 3,
    'Late Stage Critical Illness': income * 5,
    'TPD': income * Math.max(5, yearsToRetire * 0.7),
    'Hospitalization': 150000,
  };

  const gaps = Object.entries(rec).map(([type, recommended]) => {
    const current = covByType[type] || 0;
    const gap = Math.max(0, recommended - current);
    const pct = recommended > 0 ? Math.min(100, Math.round(current / recommended * 100)) : 100;
    const status = pct >= 100 ? 'adequate' : pct >= 60 ? 'partial' : 'critical';
    return { type, current, recommended, gap, pct, status };
  });

  const totalGap = gaps.reduce((s, g) => s + g.gap, 0);
  const totalRec = gaps.reduce((s, g) => s + g.recommended, 0);
  const totalCurrent = gaps.reduce((s, g) => s + g.current, 0);
  res.json({ gaps, totalGap, totalRec, totalCurrent, income, age, deps });
});

// ── Policies ───────────────────────────────────────────────────────────────────
function guardClient(req, res) {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) { res.status(403).json({ error: 'Forbidden' }); return false; }
  return true;
}

app.get('/api/clients/:id/policies', authenticate, (req, res) => {
  if (!guardClient(req, res)) return;
  const rows = dbAll('SELECT * FROM policies WHERE client_id=? ORDER BY type, created_at', [req.params.id]);
  rows.forEach(r => { try { r.coverage_items = JSON.parse(r.coverage_items || '[]'); } catch { r.coverage_items = []; } });
  res.json(rows);
});

app.post('/api/clients/:id/policies', authenticate, (req, res) => {
  if (!guardClient(req, res)) return;
  const { type, product_name, policy_number, insurer, product_type, coverage_items, premium, start_date, end_date, status, recommended, notes } = req.body;
  const items = Array.isArray(coverage_items) ? coverage_items : [];
  // coverage_items can be [{type,coverage}] objects (new) or strings (legacy)
  const totalCoverage = items.reduce((s, i) => s + (parseFloat(i.coverage) || 0), 0);
  const primaryType = items.length > 0 ? (items[0].type || items[0]) : (type || '');
  const itemsJson = JSON.stringify(items);
  const id = dbRun('INSERT INTO policies (client_id,type,product_name,policy_number,insurer,product_type,coverage,coverage_items,premium,start_date,end_date,status,recommended,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [req.params.id, primaryType, product_name||'', policy_number||'', insurer||'', product_type||'', totalCoverage||0, itemsJson, premium||0, start_date||'', end_date||'', status||'Active', recommended||0, notes||'']);
  const row = dbGet('SELECT * FROM policies WHERE id=?', [id]);
  if (row) { try { row.coverage_items = JSON.parse(row.coverage_items || '[]'); } catch { row.coverage_items = []; } }
  res.json(row);
});

app.put('/api/clients/:id/policies/:pid', authenticate, (req, res) => {
  if (!guardClient(req, res)) return;
  const body = req.body;
  // Recompute coverage from coverage_items if provided
  if (Array.isArray(body.coverage_items)) {
    body.coverage = body.coverage_items.reduce((s, i) => s + (parseFloat(i.coverage) || 0), 0);
    body.type = body.coverage_items.length > 0 ? body.coverage_items[0].type : '';
    body.coverage_items = JSON.stringify(body.coverage_items);
  }
  const f = ['type','product_name','policy_number','insurer','product_type','coverage','coverage_items','premium','start_date','end_date','status','recommended','notes'];
  const sets = [], vals = [];
  f.filter(k => k !== 'coverage_items').forEach(k => { if (body[k] !== undefined) { sets.push(`${k}=?`); vals.push(body[k]); } });
  if (body.coverage_items !== undefined) { sets.push('coverage_items=?'); vals.push(body.coverage_items); }
  if (sets.length) { vals.push(req.params.pid, req.params.id); dbRun(`UPDATE policies SET ${sets.join(',')} WHERE id=? AND client_id=?`, vals); }
  const row = dbGet('SELECT * FROM policies WHERE id=?', [req.params.pid]);
  if (row) { try { row.coverage_items = JSON.parse(row.coverage_items || '[]'); } catch { row.coverage_items = []; } }
  res.json(row);
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

// ── Invite Tokens ──────────────────────────────────────────────────────────────
app.post('/api/admin/clients/:id/invite', authenticate, requireAdmin, (req, res) => {
  const clientId = req.params.id;
  const client = dbGet('SELECT id, username, name FROM clients WHERE id=? AND role=?', [clientId, 'client']);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Revoke old unused tokens for this client
  db.run('DELETE FROM invite_tokens WHERE client_id=? AND used=0', [clientId]);
  saveDb();

  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date();
  expires.setDate(expires.getDate() + 7); // 7-day expiry
  dbRun('INSERT INTO invite_tokens (token, client_id, expires_at) VALUES (?,?,?)',
    [token, clientId, expires.toISOString()]);

  const baseUrl = req.headers.origin || `https://${req.headers.host}`;
  res.json({ token, link: `${baseUrl}/invite?token=${token}`, expires: expires.toISOString(), client });
});

// Resolve invite token → return client credentials info (not password)
app.get('/api/invite/:token', (req, res) => {
  const row = dbGet('SELECT * FROM invite_tokens WHERE token=?', [req.params.token]);
  if (!row) return res.status(404).json({ error: 'Invalid or expired invite link' });
  if (row.used) return res.status(410).json({ error: 'This invite link has already been used' });
  if (row.expires_at && new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'This invite link has expired' });
  const client = dbGet('SELECT id, name, username FROM clients WHERE id=?', [row.client_id]);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json({ client, expires: row.expires_at });
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
    const clients = dbAll(`SELECT id, username, name, age, gender, occupation, annual_income, dependents, email, phone, role, notion_page_id, created_at, updated_at FROM clients WHERE role='client'`);
    let synced = 0;
    for (const c of clients) { try { await notionPushClient(c); synced++; } catch {} }
    res.json({ success: true, synced });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Expiry Alerts ───────────────────────────────────────────────
app.get('/api/admin/expiry-alerts', authenticate, requireAdmin, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 90, 1), 365);
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

// ── Backup & Restore ───────────────────────────────────────────────────────────
app.get('/api/admin/backup', authenticate, requireAdmin, (req, res) => {
  try {
    const clients = dbAll(`SELECT id, username, name, age, gender, occupation, annual_income, dependents, email, phone, role, notion_page_id, created_at, updated_at FROM clients WHERE role='client'`);
    const policies = dbAll(`SELECT * FROM policies`);
    const investments = dbAll(`SELECT * FROM investments`);
    const snapshots = dbAll(`SELECT * FROM snapshots`);
    const backup = {
      version: 1,
      exported_at: new Date().toISOString(),
      counts: { clients: clients.length, policies: policies.length, investments: investments.length, snapshots: snapshots.length },
      clients, policies, investments, snapshots
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="finview-backup-${new Date().toISOString().slice(0,10)}.json"`);
    res.json(backup);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/restore', authenticate, requireAdmin, (req, res) => {
  try {
    const { clients = [], policies = [], investments = [], snapshots = [] } = req.body;
    if (!Array.isArray(clients)) return res.status(400).json({ error: 'Invalid backup format' });

    let imported = { clients: 0, policies: 0, investments: 0, snapshots: 0, skipped: 0 };

    // Restore clients (skip admin, skip duplicates by id)
    for (const c of clients) {
      if (c.role === 'admin') continue;
      const exists = dbGet('SELECT id FROM clients WHERE id=?', [c.id]);
      if (exists) { imported.skipped++; continue; }
      try {
        dbRun(`INSERT INTO clients (id,username,password_hash,name,age,gender,occupation,annual_income,dependents,email,phone,role,notion_page_id,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [c.id, c.username, c.password_hash, c.name, c.age||0, c.gender||'', c.occupation||'', c.annual_income||0,
           c.dependents||0, c.email||'', c.phone||'', c.role||'client', c.notion_page_id||'', c.created_at||new Date().toISOString(), c.updated_at||new Date().toISOString()]);
        imported.clients++;
      } catch (e) { imported.skipped++; }
    }

    // Restore policies (upsert by original id if numeric — re-insert otherwise)
    for (const p of policies) {
      const clientExists = dbGet('SELECT id FROM clients WHERE id=?', [p.client_id]);
      if (!clientExists) { imported.skipped++; continue; }
      try {
        dbRun(`INSERT OR IGNORE INTO policies (id,client_id,type,product_name,insurer,product_type,coverage,premium,start_date,end_date,status,recommended,notes,policy_number,coverage_items,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [p.id, p.client_id, p.type||'', p.product_name||'', p.insurer||'', p.product_type||'', p.coverage||0,
           p.premium||0, p.start_date||'', p.end_date||'', p.status||'Active', p.recommended||0,
           p.notes||'', p.policy_number||'', p.coverage_items||'[]', p.created_at||new Date().toISOString(), p.updated_at||new Date().toISOString()]);
        imported.policies++;
      } catch (e) { imported.skipped++; }
    }

    // Restore investments
    for (const i of investments) {
      const clientExists = dbGet('SELECT id FROM clients WHERE id=?', [i.client_id]);
      if (!clientExists) { imported.skipped++; continue; }
      try {
        dbRun(`INSERT OR IGNORE INTO investments (id,client_id,name,type,invested,value_now,target,goal_by,contribution,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [i.id, i.client_id, i.name||'', i.type||'', i.invested||0, i.value_now||0,
           i.target||0, i.goal_by||'', i.contribution||0, i.created_at||new Date().toISOString(), i.updated_at||new Date().toISOString()]);
        imported.investments++;
      } catch (e) { imported.skipped++; }
    }

    // Restore snapshots
    for (const s of snapshots) {
      const clientExists = dbGet('SELECT id FROM clients WHERE id=?', [s.client_id]);
      if (!clientExists) { imported.skipped++; continue; }
      try {
        dbRun(`INSERT OR IGNORE INTO snapshots (id,client_id,year,snapshot_date,total_coverage,total_investment_value,notes,created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
          [s.id, s.client_id, s.year, s.snapshot_date||'', s.total_coverage||0,
           s.total_investment_value||0, s.notes||'', s.created_at||new Date().toISOString()]);
        imported.snapshots++;
      } catch (e) { imported.skipped++; }
    }

    saveDb();
    res.json({ success: true, imported });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Client Notes & Pipeline ──────────────────────────────────────────────────
app.patch('/api/clients/:id/notes', authenticate, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { notes, deal_stage, next_action, last_contact } = req.body;
  const fields = [], vals = [];
  if (notes !== undefined) { fields.push('notes=?'); vals.push(notes); }
  if (deal_stage !== undefined) { fields.push('deal_stage=?'); vals.push(deal_stage); }
  if (next_action !== undefined) { fields.push('next_action=?'); vals.push(next_action); }
  if (last_contact !== undefined) { fields.push('last_contact=?'); vals.push(last_contact); }
  if (!fields.length) return res.json({ success: true });
  vals.push(req.params.id);
  dbRun(`UPDATE clients SET ${fields.join(',')} WHERE id=?`, vals);
  saveDb();
  res.json({ success: true });
});

app.get('/api/pipeline', authenticate, requireAdmin, (req, res) => {
  const stages = ['Prospect','Contacted','Proposal Sent','Negotiation','Closed Won','Closed Lost'];
  const result = {};
  stages.forEach(s => {
    result[s] = dbAll(`SELECT id, name, annual_income, age, deal_stage, last_contact, next_action FROM clients WHERE deal_stage=? AND role='client' ORDER BY name`, [s]);
  });
  res.json({ stages, pipeline: result });
});

// ── Bootstrap admin ────────────────────────────────────────────────────────────
app.post('/api/bootstrap', (req, res) => {
  const { adminPassword, bootstrapSecret } = req.body || {};
  // Require bootstrap secret to prevent unauthorized admin creation
  const requiredSecret = process.env.BOOTSTRAP_SECRET;
  if (requiredSecret && bootstrapSecret !== requiredSecret) {
    return res.status(403).json({ error: 'Invalid bootstrap secret' });
  }
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
    console.log(`   Admin: admin / admin2026\n`);
  });
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });

// ── Client Recommendation Engine (SG data-backed) ─────────────────────────
app.get('/api/clients/:id/recommendation', authenticate, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  try {
    const client = dbGet('SELECT * FROM clients WHERE id=?', [req.params.id]);
    if (!client) return res.status(404).json({ error: 'Not found' });
    
    const policies = dbAll('SELECT * FROM policies WHERE client_id=? AND status=?', [req.params.id, 'Active']);
    const investments = dbAll('SELECT * FROM investments WHERE client_id=?', [req.params.id]);
    
    // SG reference data (MAS 2024, CPF Board 2025, SingStat HES 2024)
    const SG = {
      life_mult_employed: 10, life_mult_dependents: 15, ci_mult: 5,
      cpf_frs_payout: 1700, cpf_brs_payout: 850,
      median_exp_single: 2800, median_exp_family: 5200,
      inflation: 0.024, life_exp_male: 82, life_exp_female: 86,
      srs_limit: 15300,
      cancer_cost: 350000,
    };
    
    const age = client.age || 30, inc = client.annual_income || 60000;
    const deps = client.dependents || 0, gender = client.gender || 'Male';
    const ytr = Math.max(0, 65 - age);
    const lifeExp = gender === 'Female' ? SG.life_exp_female : SG.life_exp_male;
    const monthlyExp = Math.min(deps > 0 ? SG.median_exp_family : SG.median_exp_single, inc / 12 * 0.7);
    
    // Coverage analysis
    const totalCoverage = policies.reduce((s, p) => s + (p.coverage || 0), 0);
    const annualPremPaid = policies.reduce((s, p) => s + (p.premium || 0), 0);
    const invValue = investments.reduce((s, i) => s + (i.value_now || 0), 0);
    const reqLife = inc * (deps > 0 ? SG.life_mult_dependents : SG.life_mult_employed);
    const reqCI = inc * SG.ci_mult;
    
    // Risk score — equal 20% each factor
    const time_sc = Math.min(5, Math.max(1, Math.floor(ytr / 5)));
    const occ = (client.occupation || '').toLowerCase();
    const stable = /engineer|doctor|lawyer|accountant|civil|teacher|manager|analyst/.test(occ);
    const inc_sc = stable ? 4 : 3;
    const dep_sc = Math.max(1, 4 - deps);
    const inv_sc = Math.min(5, 1 + (invValue > 50000 ? 1 : 0) + (invValue > 150000 ? 1 : 0) + (investments.length > 2 ? 1 : 0));
    
    // Protection score from coverage
    const lifeGapPct = totalCoverage / reqLife;
    const cov_sc = lifeGapPct >= 1 ? 5 : lifeGapPct >= 0.7 ? 4 : lifeGapPct >= 0.4 ? 3 : totalCoverage > 0 ? 2 : 1;
    
    const riskScore = (time_sc + inc_sc + dep_sc + inv_sc + cov_sc) / 5;
    const riskLevel = Math.max(1, Math.min(5, Math.round(riskScore)));
    const riskLabels = { 1: 'Very Conservative', 2: 'Conservative', 3: 'Moderate', 4: 'Growth', 5: 'Aggressive' };
    
    // Fund allocation by risk level
    const allocations = {
      1: [['sg-managed-dividend',50],['global-multi-asset',35],['us-dividend',15]],
      2: [['sg-managed-dividend',40],['us-dividend',25],['global-multi-asset',25],['asian-income',10]],
      3: [['sg-managed-dividend',30],['us-dividend',25],['global-multi-asset',20],['sg-growth',15],['asian-income',10]],
      4: [['sg-managed-dividend',25],['global-technology',20],['sg-growth',20],['us-dividend',20],['global-multi-asset',15]],
      5: [['global-technology',35],['sg-growth',25],['sg-managed-dividend',20],['strategic-income-c',15],['us-dividend',5]],
    };
    
    const recPremium = Math.max(12000, Math.min(60000, Math.round(Math.max(inc * 0.15, 12000) / 3000) * 3000));
    const payTerm = age >= 55 ? 5 : 10;
    const projYears = Math.max(10, ytr);
    
    // Blend parameters by risk level
    const blends = { 1:[0.0748,0.007], 2:[0.0758,0.008], 3:[0.0780,0.010], 4:[0.0880,0.012], 5:[0.0950,0.015] };
    const [blendYield, blendVol] = blends[riskLevel];
    
    // Simple retirement projection (deterministic median)
    const BASE_PRICE = 0.9804;
    const adminRate = payTerm === 5 ? 0.033 : 0.027;
    let units = 0, prevGross = 0;
    for (let yr = 1; yr <= projYears; yr++) {
      const C = yr <= payTerm ? recPremium : 0;
      const wb = yr === 1 ? recPremium * 0.01 : 0;
      const ib = yr > payTerm ? prevGross * BASE_PRICE * 0.005 : 0;
      const gross = units + (C + wb + ib) / BASE_PRICE;
      prevGross = gross;
      units = gross - (yr <= payTerm + 2 ? gross * adminRate : 0);
    }
    const medianMonthlyDiv = Math.round((units * blendYield) / 12);
    const cpfPayout = SG.cpf_frs_payout;
    const totalRetIncome = medianMonthlyDiv + cpfPayout;
    const retNeed = Math.round(monthlyExp * Math.pow(1 + SG.inflation, ytr));
    const srsLimit = inc >= 72000 ? SG.srs_limit : 0;
    const taxSavings = Math.round(srsLimit * (inc >= 160000 ? 0.22 : inc >= 120000 ? 0.18 : inc >= 80000 ? 0.115 : 0));
    
    // Goals readiness
    const goals = [
      { goal: 'Retire at 65 · $3K/mo', needed: 47412, current: annualPremPaid },
      { goal: 'Financial Freedom · $5K/mo', needed: 71986, current: annualPremPaid },
      { goal: 'Semi-Retire at 55 · $2K/mo', needed: 30393, current: annualPremPaid },
      { goal: 'CPF Top-Up · $1.5K/mo', needed: 53353, current: annualPremPaid },
      { goal: 'University Fund · $2K/mo', needed: 70716, current: annualPremPaid },
    ].map(g => ({
      ...g,
      pct: Math.min(100, Math.round(g.current / g.needed * 100)),
      level: g.current >= g.needed ? 5 : g.current >= g.needed * 0.7 ? 4 : g.current >= g.needed * 0.4 ? 3 : g.current > 0 ? 2 : 1,
    }));
    
    res.json({
      client_id: req.params.id, generated_at: new Date().toISOString(),
      risk_score: Math.round(riskScore * 100) / 100, risk_level: riskLevel, risk_label: riskLabels[riskLevel],
      risk_components: { time_horizon: time_sc, income_stability: inc_sc, dependents: dep_sc, investment_exp: inv_sc, coverage: cov_sc },
      required_life: Math.round(reqLife), required_ci: Math.round(reqCI),
      current_coverage: Math.round(totalCoverage), coverage_gap: Math.round(Math.max(0, reqLife - totalCoverage)),
      annual_premium_paid: Math.round(annualPremPaid),
      recommendation: {
        product: 'PVW II', annual_premium: recPremium, pay_term: payTerm, proj_years: projYears,
        fund_allocation: allocations[riskLevel].map(([id, pct]) => ({ fund_id: id, allocation_pct: pct, annual_amount: Math.round(recPremium * pct / 100) })),
        blended_yield_pct: Math.round(blendYield * 10000) / 100,
        median_monthly_div: medianMonthlyDiv,
      },
      retirement: {
        ilp_dividend: medianMonthlyDiv, cpf_payout: cpfPayout,
        total_income: totalRetIncome, monthly_need: retNeed,
        surplus_deficit: totalRetIncome - retNeed,
      },
      tax: { srs_limit: srsLimit, estimated_tax_savings: taxSavings },
      goals_readiness: goals,
      data_sources: ['MAS Financial Planning Guidelines 2024', 'CPF Board 2025', 'SingStat HES 2024', 'PRULink UIF Analysis April 2026'],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
