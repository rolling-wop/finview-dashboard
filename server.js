const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

// ─── PostgreSQL / SQLite Dual-Mode Adapter ─────────────────────────────────────
// When DATABASE_URL is set (Railway) → PostgreSQL (persistent)
// Otherwise → SQLite (local dev)
let USE_POSTGRES = !!process.env.DATABASE_URL;

let _pgPool = null;
async function _getPgPool() {
  if (!_pgPool) {
    const { Pool } = require('pg');
    _pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
      max: 5
    });
  }
  return _pgPool;
}

// Convert SQLite-style ? params + datetime() calls to Postgres syntax
function _toPg(sql) {
  let i = 0;
  return sql
    .replace(/\?/g, () => `$${++i}`)
    .replace(/datetime\('now'\)/g, `NOW()`)
    .replace(/date\('now'\)/g, `CURRENT_DATE`)
    .replace(/AUTOINCREMENT/gi, '')
    .replace(/INTEGER PRIMARY KEY(?!\s+AUTOINCREMENT)/gi, 'SERIAL PRIMARY KEY')
    .replace(/\bREAL\b/g, 'FLOAT')
    .replace(/TEXT\s+DEFAULT\s+\(datetime\('now'\)\)/g, 'TIMESTAMPTZ DEFAULT NOW()')
    .replace(/TEXT\s+DEFAULT\s+\(date\('now'\)\)/g, 'DATE DEFAULT CURRENT_DATE');
}

// Async wrappers used when USE_POSTGRES=true
async function _pgGet(sql, params = []) {
  const pool = await _getPgPool();
  const { rows } = await pool.query(_toPg(sql), params);
  return rows[0] || null;
}
async function _pgAll(sql, params = []) {
  const pool = await _getPgPool();
  const { rows } = await pool.query(_toPg(sql), params);
  return rows;
}
async function _pgRun(sql, params = []) {
  const pool = await _getPgPool();
  let pgSql = _toPg(sql);
  if (/^\s*INSERT/i.test(pgSql) && !/RETURNING/i.test(pgSql)) {
    pgSql = pgSql.replace(/;?\s*$/, ' RETURNING id');
  }
  const { rows } = await pool.query(pgSql, params);
  return rows[0]?.id || null;
}
async function _pgExec(sql) {
  const pool = await _getPgPool();
  await pool.query(_toPg(sql));
}

async function testPgConnection() {
  try {
    const pool = await _getPgPool();
    // Hard 6-second timeout — if PG hangs, we fall back to SQLite immediately
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('PG connection timeout')), 6000))
    ]);
    return true;
  } catch (e) {
    console.warn('⚠️  PostgreSQL unreachable, falling back to SQLite:', e.message);
    // Close the pool so it doesn't leave hanging connections
    try { if (_pgPool) { await _pgPool.end(); _pgPool = null; } } catch {}
    return false;
  }
}

// Sync wrappers for SQLite (unchanged from original)
// dbGet, dbAll, dbRun defined below after db init
// ── End Adapter ──────────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3847;
const JWT_SECRET = process.env.JWT_SECRET || 'dylan-findb-secret-2026-!@#';
const DB_PATH = path.join(__dirname, 'data', 'dashboard.db');

let db;

// ── Database ───────────────────────────────────────────────────────────────────
async function initDb() {
  if (USE_POSTGRES) {
    console.log('🐘 Using PostgreSQL (persistent)');
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
        name TEXT NOT NULL, age INTEGER DEFAULT 0, gender TEXT DEFAULT '', occupation TEXT DEFAULT '',
        annual_income FLOAT DEFAULT 0, dependents INTEGER DEFAULT 0, email TEXT DEFAULT '',
        phone TEXT DEFAULT '', role TEXT DEFAULT 'client', notion_page_id TEXT DEFAULT '',
        notes TEXT DEFAULT '', deal_stage TEXT DEFAULT 'Prospect',
        last_contact TEXT DEFAULT '', next_action TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS policies (
        id SERIAL PRIMARY KEY, client_id TEXT NOT NULL, type TEXT DEFAULT '',
        product_name TEXT DEFAULT '', policy_number TEXT DEFAULT '', insurer TEXT DEFAULT '',
        product_type TEXT DEFAULT '', coverage FLOAT DEFAULT 0, premium FLOAT DEFAULT 0,
        start_date TEXT DEFAULT '', end_date TEXT DEFAULT '', status TEXT DEFAULT 'Active',
        recommended FLOAT DEFAULT 0, notes TEXT DEFAULT '', coverage_items TEXT DEFAULT '[]',
        payment_frequency TEXT DEFAULT 'annual', cpf_medisave_amount FLOAT DEFAULT 0,
        cash_amount FLOAT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS investments (
        id SERIAL PRIMARY KEY, client_id TEXT NOT NULL, name TEXT DEFAULT '',
        type TEXT DEFAULT '', invested FLOAT DEFAULT 0, value_now FLOAT DEFAULT 0,
        target FLOAT DEFAULT 0, goal_by TEXT DEFAULT '', contribution FLOAT DEFAULT 0,
        investment_subtype TEXT DEFAULT '', payment_frequency TEXT DEFAULT 'annual',
        growth_rate_assumption FLOAT DEFAULT 0, start_date TEXT DEFAULT '',
        maturity_date TEXT DEFAULT '', guaranteed_return FLOAT DEFAULT 0,
        projected_return FLOAT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id SERIAL PRIMARY KEY, client_id TEXT NOT NULL, year INTEGER NOT NULL,
        snapshot_date TEXT DEFAULT '', total_coverage FLOAT DEFAULT 0,
        total_investment_value FLOAT DEFAULT 0, notes TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(client_id, year),
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS invite_tokens (
        token TEXT PRIMARY KEY, client_id TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(), expires_at TEXT, used INTEGER DEFAULT 0,
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS needs_analysis (
        id SERIAL PRIMARY KEY, client_id TEXT NOT NULL,
        coverage_type TEXT NOT NULL, recommended_amount FLOAT DEFAULT 0,
        current_amount FLOAT DEFAULT 0, gap FLOAT DEFAULT 0,
        rationale TEXT DEFAULT '', priority TEXT DEFAULT 'medium', sources TEXT DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS prospects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT 'Unknown',
        dob TEXT DEFAULT '', gender TEXT DEFAULT '', occupation TEXT DEFAULT '',
        annual_income FLOAT DEFAULT 0, phone TEXT DEFAULT '', email TEXT DEFAULT '',
        notes TEXT DEFAULT '', source TEXT DEFAULT '',
        deal_stage TEXT DEFAULT 'New Prospect',
        last_contact TEXT DEFAULT '', next_action TEXT DEFAULT '',
        raw_input TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS prospect_policies (
        id SERIAL PRIMARY KEY, prospect_id TEXT NOT NULL,
        insurer TEXT DEFAULT '', product_name TEXT DEFAULT '',
        category TEXT DEFAULT '', sub_type TEXT DEFAULT '',
        sum_assured FLOAT DEFAULT 0, annual_premium FLOAT DEFAULT 0,
        payment_mode TEXT DEFAULT '', payment_term_years INTEGER,
        policy_term_years INTEGER, age_bought INTEGER, age_end INTEGER,
        start_date TEXT DEFAULT '', end_date TEXT DEFAULT '',
        status TEXT DEFAULT 'Active',
        total_paid_estimate FLOAT, surrender_value FLOAT,
        projected_maturity FLOAT, deductible FLOAT, coinsurance FLOAT,
        key_exclusions TEXT DEFAULT '[]', riders TEXT DEFAULT '[]',
        multiplier_end_age INTEGER, multiplier_times INTEGER,
        raw_json TEXT DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (prospect_id) REFERENCES prospects(id) ON DELETE CASCADE
      )
    `);
    console.log('✅ PostgreSQL schema ready');

    // Seed admin
    const adminExists = await _pgGet(`SELECT id FROM clients WHERE role='admin'`);
    if (!adminExists) {
      const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin2026', 10);
      await _pgRun(`INSERT INTO clients (id,username,password_hash,name,role) VALUES ($1,$2,$3,$4,$5)`,
        ['ADMIN001', 'admin', hash, 'Dylan Ho', 'admin']);
      console.log('✅ Admin seeded');
    }
    return;
  }

  // ── SQLite mode (local dev) ────────────────────────────────────────────────
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
    CREATE TABLE IF NOT EXISTS needs_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      coverage_type TEXT NOT NULL,
      recommended_amount REAL DEFAULT 0,
      current_amount REAL DEFAULT 0,
      gap REAL DEFAULT 0,
      rationale TEXT DEFAULT '',
      priority TEXT DEFAULT 'medium',
      sources TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
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

  // Prospects tables (SQLite)
  db.run(`CREATE TABLE IF NOT EXISTS prospects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT 'Unknown',
    dob TEXT DEFAULT '', gender TEXT DEFAULT '', occupation TEXT DEFAULT '',
    annual_income REAL DEFAULT 0, phone TEXT DEFAULT '', email TEXT DEFAULT '',
    notes TEXT DEFAULT '', source TEXT DEFAULT '',
    deal_stage TEXT DEFAULT 'New Prospect',
    last_contact TEXT DEFAULT '', next_action TEXT DEFAULT '',
    raw_input TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS prospect_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT, prospect_id TEXT NOT NULL,
    insurer TEXT DEFAULT '', product_name TEXT DEFAULT '',
    category TEXT DEFAULT '', sub_type TEXT DEFAULT '',
    sum_assured REAL DEFAULT 0, annual_premium REAL DEFAULT 0,
    payment_mode TEXT DEFAULT '', payment_term_years INTEGER,
    policy_term_years INTEGER, age_bought INTEGER, age_end INTEGER,
    start_date TEXT DEFAULT '', end_date TEXT DEFAULT '',
    status TEXT DEFAULT 'Active',
    total_paid_estimate REAL, surrender_value REAL,
    projected_maturity REAL, deductible REAL, coinsurance REAL,
    key_exclusions TEXT DEFAULT '[]', riders TEXT DEFAULT '[]',
    multiplier_end_age INTEGER, multiplier_times INTEGER,
    raw_json TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (prospect_id) REFERENCES prospects(id) ON DELETE CASCADE
  )`);

  // Phase 2 migrations — policies new columns
  try { db.run(`ALTER TABLE policies ADD COLUMN payment_frequency TEXT DEFAULT 'annual'`); } catch {}
  try { db.run(`ALTER TABLE policies ADD COLUMN cpf_medisave_amount REAL DEFAULT 0`); } catch {}
  try { db.run(`ALTER TABLE policies ADD COLUMN cash_amount REAL DEFAULT 0`); } catch {}
  // Phase 2 migrations — investments new columns
  try { db.run(`ALTER TABLE investments ADD COLUMN investment_subtype TEXT DEFAULT ''`); } catch {}
  try { db.run(`ALTER TABLE investments ADD COLUMN payment_frequency TEXT DEFAULT 'annual'`); } catch {}
  try { db.run(`ALTER TABLE investments ADD COLUMN growth_rate_assumption REAL DEFAULT 0`); } catch {}
  try { db.run(`ALTER TABLE investments ADD COLUMN start_date TEXT DEFAULT ''`); } catch {}
  try { db.run(`ALTER TABLE investments ADD COLUMN maturity_date TEXT DEFAULT ''`); } catch {}
  try { db.run(`ALTER TABLE investments ADD COLUMN guaranteed_return REAL DEFAULT 0`); } catch {}
  try { db.run(`ALTER TABLE investments ADD COLUMN projected_return REAL DEFAULT 0`); } catch {}

  // Auto-seed admin
  const adminExists = await dbGet(`SELECT id FROM clients WHERE role='admin'`);
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

// Unified DB helpers — return Promises in PG mode, sync values in SQLite mode
// All route handlers must await these
function dbGet(sql, params = []) {
  if (USE_POSTGRES) return _pgGet(sql, params);
  const s = db.prepare(sql); s.bind(params);
  if (s.step()) { const r = s.getAsObject(); s.free(); return r; }
  s.free(); return null;
}
function dbAll(sql, params = []) {
  if (USE_POSTGRES) return _pgAll(sql, params);
  const s = db.prepare(sql); s.bind(params);
  const rows = [];
  while (s.step()) rows.push(s.getAsObject());
  s.free(); return rows;
}
function dbRun(sql, params = []) {
  if (USE_POSTGRES) return _pgRun(sql, params);
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
app.get('/api/ping', (req, res) => res.json({ ok: true, version: 'v8-2026-04-09', routes: ['expiry-alerts','coverage-gaps','invite','gaps-per-client','coverage-items','needs-analysis','projection','notion-crm-export','pull-from-notion','import-b2b-leads','rolling-dollar'] }));

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
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const client = await dbGet('SELECT * FROM clients WHERE username = ?', [username]);
  if (!client || !bcrypt.compareSync(password, client.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });
  const token = jwt.sign({ id: client.id, username: client.username, role: client.role }, JWT_SECRET, { expiresIn: '8h' });
  res.json({
    token, role: client.role,
    client: { id: client.id, name: client.name, email: client.email, age: client.age, annual_income: client.annual_income, occupation: client.occupation, role: client.role }
  });
});

// ── Admin: List all clients ────────────────────────────────────────────────────
app.get('/api/admin/clients', authenticate, requireAdmin, async (req, res) => {
  const clients = await dbAll(`SELECT id, username, name, age, gender, occupation, annual_income, email, phone, role, created_at FROM clients WHERE role != 'admin' ORDER BY name`);
  const enriched = await Promise.all(clients.map(async c => {
    const r1 = await dbGet('SELECT COUNT(*) as cnt FROM policies WHERE client_id=?', [c.id]);
    const r2 = await dbGet('SELECT SUM(coverage) as total FROM policies WHERE client_id=? AND status=?', [c.id, 'Active']);
    const r3 = await dbGet('SELECT SUM(premium) as total FROM policies WHERE client_id=?', [c.id]);
    const r4 = await dbGet('SELECT SUM(value_now) as total FROM investments WHERE client_id=?', [c.id]);
    return { ...c, policyCount: r1?.cnt || 0, totalCoverage: r2?.total || 0, totalPremium: r3?.total || 0, totalInvestments: r4?.total || 0 };
  }));
  res.json(enriched);
});

// ── Admin: Create client ───────────────────────────────────────────────────────
app.post('/api/admin/clients', authenticate, requireAdmin, async (req, res) => {
  const { username, password, name, age, gender, occupation, annual_income, dependents, email, phone } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'username, password and name required' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const id = `C${Date.now()}`;
    await dbRun('INSERT INTO clients (id,username,password_hash,name,age,gender,occupation,annual_income,dependents,email,phone,role) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, username, hash, name, age||0, gender||'', occupation||'', annual_income||0, dependents||0, email||'', phone||'', 'client']);
    const newClient = await dbGet('SELECT id,username,name,age,gender,occupation,annual_income,email,phone,role FROM clients WHERE id=?', [id]);
    notionPushClient(newClient).catch(() => {});
    res.json(newClient);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Admin: Update client ───────────────────────────────────────────────────────
app.put('/api/admin/clients/:id', authenticate, requireAdmin, async (req, res) => {
  const { name, age, gender, occupation, annual_income, dependents, email, phone, password, notes, deal_stage, last_contact, next_action } = req.body;
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    await dbRun(`UPDATE clients SET password_hash=?, updated_at=datetime('now') WHERE id=?`, [hash, req.params.id]);
  }
  await dbRun(`UPDATE clients SET name=?,age=?,gender=?,occupation=?,annual_income=?,dependents=?,email=?,phone=?,notes=?,deal_stage=?,last_contact=?,next_action=?,updated_at=datetime('now') WHERE id=?`,
    [name, age||0, gender||'', occupation||'', annual_income||0, dependents||0, email||'', phone||'',
     notes||'', deal_stage||'Prospect', last_contact||'', next_action||'', req.params.id]);
  // Fire-and-forget 2nd Brain auto-log if notes is non-empty
  if (notes && notes.trim()) {
    const clientData = { name, occupation: occupation||'', annual_income: annual_income||0, deal_stage: deal_stage||'Prospect', last_contact: last_contact||'', next_action: next_action||'', notes };
    setImmediate(() => {
      try {
        fs.mkdirSync(BRAIN_PEOPLE_DIR, { recursive: true });
        const safeName = (clientData.name || 'unknown').replace(/[^a-zA-Z0-9 _-]/g, '').trim();
        const mdPath = `${BRAIN_PEOPLE_DIR}/${safeName}.md`;
        const content = `---\nname: ${clientData.name}\ntype: person\ncategory: client\n---\n# ${clientData.name}\n\n**Occupation:** ${clientData.occupation}\n**Annual Income:** S$${clientData.annual_income}\n**Deal Stage:** ${clientData.deal_stage}\n**Last Contact:** ${clientData.last_contact}\n**Next Action:** ${clientData.next_action}\n\n## Notes\n${clientData.notes}\n`;
        fs.writeFileSync(mdPath, content, 'utf8');
      } catch {}
    });
  }
  res.json({ success: true });
});

// ── Admin: Delete client ───────────────────────────────────────────────────────
app.delete('/api/admin/clients/:id', authenticate, requireAdmin, async (req, res) => {
  await dbRun('DELETE FROM clients WHERE id=? AND role!=?', [req.params.id, 'admin']);
  res.json({ success: true });
});

// ── Admin: Stats overview ──────────────────────────────────────────────────────
app.get('/api/admin/stats', authenticate, requireAdmin, async (req, res) => {
  const totalClients = await dbGet(`SELECT COUNT(*) as cnt FROM clients WHERE role='client'`)?.cnt || 0;
  const totalPolicies = await dbGet('SELECT COUNT(*) as cnt FROM policies')?.cnt || 0;
  const totalCoverage = await dbGet(`SELECT SUM(p.coverage) as total FROM policies p JOIN clients c ON p.client_id=c.id WHERE c.role='client' AND p.status='Active'`)?.total || 0;
  const totalPremium = await dbGet(`SELECT SUM(p.premium) as total FROM policies p JOIN clients c ON p.client_id=c.id WHERE c.role='client'`)?.total || 0;
  const totalInvestments = await dbGet(`SELECT SUM(i.value_now) as total FROM investments i JOIN clients c ON i.client_id=c.id WHERE c.role='client'`)?.total || 0;
  res.json({ totalClients, totalPolicies, totalCoverage, totalPremium, totalInvestments });
});

// ── Admin: Expiry alerts across all clients ────────────────────────────────────
app.get('/api/admin/expiry-alerts', authenticate, requireAdmin, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 90, 1), 365);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];
  const policies = await dbAll(`
    SELECT p.*, c.name as client_name, c.id as client_id, c.email as client_email
    FROM policies p JOIN clients c ON p.client_id = c.id
    WHERE p.end_date != '' AND p.end_date >= ? AND p.end_date <= ? AND p.status = 'Active'
    ORDER BY p.end_date ASC
  `, [today, cutoffStr]);
  res.json(policies);
});

// ── Admin: Coverage gaps across all clients ────────────────────────────────────
app.get('/api/admin/coverage-gaps', authenticate, requireAdmin, async (req, res) => {
  const clients = await dbAll(`SELECT id, name, age, annual_income, dependents, occupation FROM clients WHERE role='client'`);
  const result = clients.map(async c => {
    const income = c.annual_income || 0;
    const age = c.age || 30;
    const deps = c.dependents || 0;
    const policies = await dbAll(`SELECT type, SUM(coverage) as total FROM policies WHERE client_id=? AND status='Active' GROUP BY type`, [c.id]);
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
app.get('/api/clients/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  const c = await dbGet('SELECT id,name,age,gender,occupation,annual_income,dependents,email,phone,role,deal_stage,last_contact,next_action,notes FROM clients WHERE id=?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

app.put('/api/clients/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  const { name, age, gender, occupation, annual_income, dependents, email, phone } = req.body;
  await dbRun(`UPDATE clients SET name=?,age=?,gender=?,occupation=?,annual_income=?,dependents=?,email=?,phone=?,updated_at=datetime('now') WHERE id=?`,
    [name, age||0, gender||'', occupation||'', annual_income||0, dependents||0, email||'', phone||'', req.params.id]);
  res.json({ success: true });
});

// ── Client: Coverage gap analysis ─────────────────────────────────────────────
app.get('/api/clients/:id/coverage-gaps', authenticate, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  const c = await dbGet('SELECT * FROM clients WHERE id=?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Not found' });

  const income = c.annual_income || 0;
  const age = c.age || 30;
  const deps = c.dependents || 0;
  const yearsToRetire = Math.max(0, 65 - age);

  const policies = await dbAll(`SELECT type, coverage, coverage_items FROM policies WHERE client_id=? AND status='Active'`, [c.id]);
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

app.get('/api/clients/:id/policies', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  const rows = await dbAll('SELECT * FROM policies WHERE client_id=? ORDER BY type, created_at', [req.params.id]);
  rows.forEach(r => { try { r.coverage_items = JSON.parse(r.coverage_items || '[]'); } catch { r.coverage_items = []; } });
  res.json(rows);
});

app.post('/api/clients/:id/policies', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  const { type, product_name, policy_number, insurer, product_type, coverage_items, premium, start_date, end_date, status, recommended, notes, payment_frequency, cpf_medisave_amount, cash_amount } = req.body;
  const items = Array.isArray(coverage_items) ? coverage_items : [];
  // coverage_items can be [{type,coverage}] objects (new) or strings (legacy)
  const totalCoverage = items.reduce((s, i) => s + (parseFloat(i.coverage) || 0), 0);
  const primaryType = items.length > 0 ? (items[0].type || items[0]) : (type || '');
  const itemsJson = JSON.stringify(items);
  const id = await dbRun('INSERT INTO policies (client_id,type,product_name,policy_number,insurer,product_type,coverage,coverage_items,premium,start_date,end_date,status,recommended,notes,payment_frequency,cpf_medisave_amount,cash_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [req.params.id, primaryType, product_name||'', policy_number||'', insurer||'', product_type||'', totalCoverage||0, itemsJson, premium||0, start_date||'', end_date||'', status||'Active', recommended||0, notes||'', payment_frequency||'annual', cpf_medisave_amount||0, cash_amount||0]);
  const row = await dbGet('SELECT * FROM policies WHERE id=?', [id]);
  if (row) { try { row.coverage_items = JSON.parse(row.coverage_items || '[]'); } catch { row.coverage_items = []; } }
  res.json(row);
});

app.put('/api/clients/:id/policies/:pid', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  const body = req.body;
  // Recompute coverage from coverage_items if provided
  if (Array.isArray(body.coverage_items)) {
    body.coverage = body.coverage_items.reduce((s, i) => s + (parseFloat(i.coverage) || 0), 0);
    body.type = body.coverage_items.length > 0 ? body.coverage_items[0].type : '';
    body.coverage_items = JSON.stringify(body.coverage_items);
  }
  const f = ['type','product_name','policy_number','insurer','product_type','coverage','coverage_items','premium','start_date','end_date','status','recommended','notes','payment_frequency','cpf_medisave_amount','cash_amount'];
  const sets = [], vals = [];
  f.filter(k => k !== 'coverage_items').forEach(k => { if (body[k] !== undefined) { sets.push(`${k}=?`); vals.push(body[k]); } });
  if (body.coverage_items !== undefined) { sets.push('coverage_items=?'); vals.push(body.coverage_items); }
  if (sets.length) { vals.push(req.params.pid, req.params.id); await dbRun(`UPDATE policies SET ${sets.join(',')} WHERE id=? AND client_id=?`, vals); }
  const row = await dbGet('SELECT * FROM policies WHERE id=?', [req.params.pid]);
  if (row) { try { row.coverage_items = JSON.parse(row.coverage_items || '[]'); } catch { row.coverage_items = []; } }
  res.json(row);
});

app.delete('/api/clients/:id/policies/:pid', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  await dbRun('DELETE FROM policies WHERE id=? AND client_id=?', [req.params.pid, req.params.id]);
  res.json({ success: true });
});

// ── Investments ────────────────────────────────────────────────────────────────
app.get('/api/clients/:id/investments', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  res.json(await dbAll('SELECT * FROM investments WHERE client_id=? ORDER BY created_at', [req.params.id]));
});

app.post('/api/clients/:id/investments', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  const { name, type, invested, value_now, target, goal_by, contribution, investment_subtype, payment_frequency, growth_rate_assumption, start_date, maturity_date, guaranteed_return, projected_return } = req.body;
  const id = await dbRun('INSERT INTO investments (client_id,name,type,invested,value_now,target,goal_by,contribution,investment_subtype,payment_frequency,growth_rate_assumption,start_date,maturity_date,guaranteed_return,projected_return) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [req.params.id, name||'', type||'', invested||0, value_now||0, target||0, goal_by||'', contribution||0, investment_subtype||'', payment_frequency||'annual', growth_rate_assumption||0, start_date||'', maturity_date||'', guaranteed_return||0, projected_return||0]);
  res.json(await dbGet('SELECT * FROM investments WHERE id=?', [id]));
});

app.put('/api/clients/:id/investments/:iid', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  const f = ['name','type','invested','value_now','target','goal_by','contribution','investment_subtype','payment_frequency','growth_rate_assumption','start_date','maturity_date','guaranteed_return','projected_return'];
  const sets = [], vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { sets.push(`${k}=?`); vals.push(req.body[k]); } });
  if (sets.length) { vals.push(req.params.iid, req.params.id); await dbRun(`UPDATE investments SET ${sets.join(',')} WHERE id=? AND client_id=?`, vals); }
  res.json(await dbGet('SELECT * FROM investments WHERE id=?', [req.params.iid]));
});

app.delete('/api/clients/:id/investments/:iid', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  await dbRun('DELETE FROM investments WHERE id=? AND client_id=?', [req.params.iid, req.params.id]);
  res.json({ success: true });
});

// ── Snapshots ──────────────────────────────────────────────────────────────────
app.get('/api/clients/:id/snapshots', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  res.json(await dbAll('SELECT * FROM snapshots WHERE client_id=? ORDER BY year', [req.params.id]));
});

app.post('/api/clients/:id/snapshots', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  const { year, snapshot_date, total_coverage, total_investment_value, notes } = req.body;
  const id = await dbRun('INSERT OR REPLACE INTO snapshots (client_id,year,snapshot_date,total_coverage,total_investment_value,notes) VALUES (?,?,?,?,?,?)',
    [req.params.id, year, snapshot_date||'', total_coverage||0, total_investment_value||0, notes||'']);
  res.json({ id, year, total_coverage, total_investment_value });
});

app.post('/api/clients/:id/snapshots/auto', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  const year = new Date().getFullYear();
  const policies = await dbAll('SELECT coverage FROM policies WHERE client_id=? AND status=?', [req.params.id, 'Active']);
  const investments = await dbAll('SELECT value_now FROM investments WHERE client_id=?', [req.params.id]);
  const tc = policies.reduce((s, p) => s + (p.coverage || 0), 0);
  const ti = investments.reduce((s, i) => s + (i.value_now || 0), 0);
  await dbRun(`INSERT OR REPLACE INTO snapshots (client_id,year,snapshot_date,total_coverage,total_investment_value,notes) VALUES (?,?,date('now'),?,?,'Auto snapshot')`,
    [req.params.id, year, tc, ti]);
  res.json({ year, total_coverage: tc, total_investment_value: ti });
});

// ── Invite Tokens ──────────────────────────────────────────────────────────────
app.post('/api/admin/clients/:id/invite', authenticate, requireAdmin, async (req, res) => {
  const clientId = req.params.id;
  const client = await dbGet('SELECT id, username, name FROM clients WHERE id=? AND role=?', [clientId, 'client']);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Revoke old unused tokens for this client
  db.run('DELETE FROM invite_tokens WHERE client_id=? AND used=0', [clientId]);
  saveDb();

  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date();
  expires.setDate(expires.getDate() + 7); // 7-day expiry
  await dbRun('INSERT INTO invite_tokens (token, client_id, expires_at) VALUES (?,?,?)',
    [token, clientId, expires.toISOString()]);

  const baseUrl = req.headers.origin || `https://${req.headers.host}`;
  res.json({ token, link: `${baseUrl}/invite?token=${token}`, expires: expires.toISOString(), client });
});

// Resolve invite token → return client credentials info (not password)
app.get('/api/invite/:token', async (req, res) => {
  const row = await dbGet('SELECT * FROM invite_tokens WHERE token=?', [req.params.token]);
  if (!row) return res.status(404).json({ error: 'Invalid or expired invite link' });
  if (row.used) return res.status(410).json({ error: 'This invite link has already been used' });
  if (row.expires_at && new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'This invite link has expired' });
  const client = await dbGet('SELECT id, name, username FROM clients WHERE id=?', [row.client_id]);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json({ client, expires: row.expires_at });
});

// ── Notion Sync ────────────────────────────────────────────────────────────────
const NOTION_KEY = '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';
const NOTION_CLIENTS_DB = '9b9b9db9-65ed-4da0-b833-c2ffcc96f0dc';
const NOTION_B2B_LEADS_DB = 'bb801d58-81ac-4902-97b1-462c4ba2a42c';
const NOTION_SCRIPT_BACKLOG_DB = 'ec7d305c-83c0-4fe8-9702-5d6c2ff50607';
const BRAIN_PEOPLE_DIR = '/Users/dylanho/.openclaw/workspace/brain/people';

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
  const policies = await dbAll('SELECT * FROM policies WHERE client_id=?', [client.id]);
  const investments = await dbAll('SELECT * FROM investments WHERE client_id=?', [client.id]);
  const needsAnalysis = await dbAll('SELECT * FROM needs_analysis WHERE client_id=? ORDER BY gap DESC LIMIT 1', [client.id]);
  const totalPremium = policies.reduce((s, p) => s + (p.premium || 0), 0);
  const totalCoverage = policies.reduce((s, p) => s + (p.coverage || 0), 0);
  const policyNames = policies.map(p => p.product_name || p.type).filter(Boolean).join(', ');
  const totalInvested = investments.reduce((s, i) => s + (i.invested || 0), 0);
  const totalInvValue = investments.reduce((s, i) => s + (i.value_now || 0), 0);
  const biggestGap = needsAnalysis[0] ? `${needsAnalysis[0].coverage_type}: S$${Math.round(needsAnalysis[0].gap||0).toLocaleString()} gap` : '';
  const notesContent = [
    `Synced: ${new Date().toLocaleDateString('en-SG')}`,
    client.notes ? `Notes: ${client.notes}` : '',
    biggestGap ? `Coverage gap: ${biggestGap}` : ''
  ].filter(Boolean).join(' | ');
  const props = {
    'Name': { title: [{ text: { content: client.name } }] },
    'Email': { email: client.email || null },
    'Phone': { phone_number: client.phone || null },
    'Total Premium (SGD)': { number: totalPremium },
    'Total Coverage (SGD)': { number: totalCoverage },
    'Policies': { number: policies.length },
    'Policy List': { rich_text: [{ text: { content: policyNames.slice(0, 2000) } }] },
    'Total Invested (SGD)': { number: totalInvested },
    'Investment Value (SGD)': { number: totalInvValue },
    'Investments': { number: investments.length },
    'Deal Stage': { select: { name: client.deal_stage || 'Prospect' } },
    'Last Contact': { rich_text: [{ text: { content: client.last_contact || '' } }] },
    'Next Action': { rich_text: [{ text: { content: client.next_action || '' } }] },
    'Age': { number: client.age || null },
    'Occupation': { rich_text: [{ text: { content: client.occupation || '' } }] },
    'Annual Income (SGD)': { number: client.annual_income || null },
    'Status': { select: { name: 'Active' } },
    'Notes': { rich_text: [{ text: { content: notesContent.slice(0, 2000) } }] }
  };
  // Remove null-valued props to avoid Notion API errors
  Object.keys(props).forEach(k => { if (props[k]?.email === null) delete props[k]; if (props[k]?.phone_number === null) delete props[k]; if (props[k]?.number === null) delete props[k]; });
  const existingClient = await dbGet('SELECT notion_page_id FROM clients WHERE id=?', [client.id]);
  if (existingClient?.notion_page_id) {
    await notionReq('PATCH', `/pages/${existingClient.notion_page_id}`, { properties: props });
  } else {
    const page = await notionReq('POST', '/pages', { parent: { database_id: NOTION_CLIENTS_DB }, properties: props });
    if (page.id) await dbRun(`UPDATE clients SET notion_page_id=? WHERE id=?`, [page.id, client.id]);
  }
}

app.post('/api/sync/push/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  try {
    const client = await dbGet('SELECT * FROM clients WHERE id=?', [req.params.id]);
    await notionPushClient(client);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sync/push-all', authenticate, requireAdmin, async (req, res) => {
  try {
    const clients = await dbAll(`SELECT * FROM clients WHERE role='client'`);
    let synced = 0;
    for (const c of clients) { try { await notionPushClient(c); synced++; } catch {} }
    res.json({ success: true, synced });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Notion → FinView pull (two-way sync) ──────────────────────────────────────
app.post('/api/sync/pull-from-notion', authenticate, requireAdmin, async (req, res) => {
  try {
    let cursor = undefined;
    const pages = [];
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const result = await notionReq('POST', `/databases/${NOTION_CLIENTS_DB}/query`, body);
      if (result.results) pages.push(...result.results);
      cursor = result.has_more ? result.next_cursor : undefined;
    } while (cursor);

    let updated = 0, skipped = 0;
    for (const page of pages) {
      try {
        const props = page.properties || {};
        const nameArr = props['Name']?.title || [];
        const name = nameArr.map(t => t.plain_text).join('').trim();
        if (!name) { skipped++; continue; }
        // Match by notion_page_id first, then by name
        let client = await dbGet('SELECT * FROM clients WHERE notion_page_id=?', [page.id]);
        if (!client) client = await dbGet('SELECT * FROM clients WHERE name=? AND role=\'client\'', [name]);
        if (!client) { skipped++; continue; }
        const deal_stage = props['Deal Stage']?.select?.name || client.deal_stage;
        const last_contact = (props['Last Contact']?.rich_text || []).map(t => t.plain_text).join('').trim() || client.last_contact;
        const next_action = (props['Next Action']?.rich_text || []).map(t => t.plain_text).join('').trim() || client.next_action;
        const notes = (props['Notes']?.rich_text || []).map(t => t.plain_text).join('').trim() || client.notes;
        await dbRun(`UPDATE clients SET deal_stage=?,last_contact=?,next_action=?,notes=?,notion_page_id=? WHERE id=?`,
          [deal_stage, last_contact, next_action, notes, page.id, client.id]);
        updated++;
      } catch { skipped++; }
    }
    res.json({ success: true, pulled: pages.length, updated, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── B2B Leads → FinView Pipeline ──────────────────────────────────────────────
app.post('/api/sync/import-b2b-leads', authenticate, requireAdmin, async (req, res) => {
  try {
    let cursor = undefined;
    const pages = [];
    do {
      const body = { page_size: 100, filter: { property: 'Status', select: { equals: 'Interested' } } };
      if (cursor) body.start_cursor = cursor;
      const result = await notionReq('POST', `/databases/${NOTION_B2B_LEADS_DB}/query`, body);
      if (result.results) pages.push(...result.results);
      cursor = result.has_more ? result.next_cursor : undefined;
    } while (cursor);

    let imported = 0, skipped = 0;
    for (const page of pages) {
      try {
        const props = page.properties || {};
        const nameArr = props['Name']?.title || [];
        const name = nameArr.map(t => t.plain_text).join('').trim();
        if (!name) { skipped++; continue; }
        const existing = await dbGet('SELECT id FROM clients WHERE name=?', [name]);
        if (existing) { skipped++; continue; }
        const email = props['Email']?.email || '';
        const phone = props['Phone']?.phone_number || '';
        const username = name.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '') + '_' + Date.now().toString(36);
        const hash = bcrypt.hashSync('client2026', 10);
        const id = 'B2B_' + Date.now().toString(36).toUpperCase() + '_' + Math.random().toString(36).slice(2,6).toUpperCase();
        await dbRun(`INSERT INTO clients (id,username,password_hash,name,email,phone,role,deal_stage,notes) VALUES (?,?,?,?,?,?,?,?,?)`,
          [id, username, hash, name, email, phone, 'client', 'Prospect', 'Imported from B2B Lead Pipeline']);
        imported++;
        await new Promise(r => setTimeout(r, 50)); // avoid tight loop
      } catch { skipped++; }
    }
    res.json({ success: true, found: pages.length, imported, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Rolling Dollar Script Backlog ─────────────────────────────────────────────
app.get('/api/rolling-dollar/scripts', authenticate, requireAdmin, async (req, res) => {
  try {
    let cursor = undefined;
    const pages = [];
    do {
      const body = { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] };
      if (cursor) body.start_cursor = cursor;
      const result = await notionReq('POST', `/databases/${NOTION_SCRIPT_BACKLOG_DB}/query`, body);
      if (result.results) pages.push(...result.results);
      cursor = result.has_more ? result.next_cursor : undefined;
    } while (cursor);

    const scripts = pages.map(page => {
      const props = page.properties || {};
      const titleArr = props['Name']?.title || props['Title']?.title || [];
      const title = titleArr.map(t => t.plain_text).join('').trim();
      // Status might be a select or status property
      const status = props['Status']?.select?.name || props['Status']?.status?.name || '';
      return { id: page.id, title, status, url: page.url, created: page.created_time };
    });

    const counts = {};
    scripts.forEach(s => { counts[s.status || 'Unknown'] = (counts[s.status || 'Unknown'] || 0) + 1; });
    res.json({ success: true, total: scripts.length, counts, scripts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rolling-dollar/scripts/:id/update-status', authenticate, requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['Scripted', 'Filmed', 'Uploaded', 'Published'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status. Must be: ' + allowed.join(', ') });
    // Try select first, fallback status property
    let result = await notionReq('PATCH', `/pages/${req.params.id}`, { properties: { 'Status': { select: { name: status } } } });
    if (result.object === 'error') {
      result = await notionReq('PATCH', `/pages/${req.params.id}`, { properties: { 'Status': { status: { name: status } } } });
    }
    res.json({ success: true, id: req.params.id, status, result: result.object });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Expiry Alerts ───────────────────────────────────────────────
app.get('/api/admin/expiry-alerts', authenticate, requireAdmin, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 90, 1), 365);
  const today = new Date();
  const cutoff = new Date(today); cutoff.setDate(today.getDate() + days);
  const todayStr = today.toISOString().split('T')[0];
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const policies = await dbAll(`
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
app.get('/api/admin/backup', authenticate, requireAdmin, async (req, res) => {
  try {
    const clients = await dbAll(`SELECT id, username, name, age, gender, occupation, annual_income, dependents, email, phone, role, notion_page_id, created_at, updated_at FROM clients WHERE role='client'`);
    const policies = await dbAll(`SELECT * FROM policies`);
    const investments = await dbAll(`SELECT * FROM investments`);
    const snapshots = await dbAll(`SELECT * FROM snapshots`);
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

app.post('/api/admin/restore', authenticate, requireAdmin, async (req, res) => {
  try {
    const { clients = [], policies = [], investments = [], snapshots = [] } = req.body;
    if (!Array.isArray(clients)) return res.status(400).json({ error: 'Invalid backup format' });

    let imported = { clients: 0, policies: 0, investments: 0, snapshots: 0, skipped: 0 };

    // Restore clients (skip admin, skip duplicates by id)
    for (const c of clients) {
      if (c.role === 'admin') continue;
      const exists = await dbGet('SELECT id FROM clients WHERE id=?', [c.id]);
      if (exists) { imported.skipped++; continue; }
      try {
        await dbRun(`INSERT INTO clients (id,username,password_hash,name,age,gender,occupation,annual_income,dependents,email,phone,role,notion_page_id,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [c.id, c.username, c.password_hash, c.name, c.age||0, c.gender||'', c.occupation||'', c.annual_income||0,
           c.dependents||0, c.email||'', c.phone||'', c.role||'client', c.notion_page_id||'', c.created_at||new Date().toISOString(), c.updated_at||new Date().toISOString()]);
        imported.clients++;
      } catch (e) { imported.skipped++; }
    }

    // Restore policies (upsert by original id if numeric — re-insert otherwise)
    for (const p of policies) {
      const clientExists = await dbGet('SELECT id FROM clients WHERE id=?', [p.client_id]);
      if (!clientExists) { imported.skipped++; continue; }
      try {
        await dbRun(`INSERT OR IGNORE INTO policies (id,client_id,type,product_name,insurer,product_type,coverage,premium,start_date,end_date,status,recommended,notes,policy_number,coverage_items,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [p.id, p.client_id, p.type||'', p.product_name||'', p.insurer||'', p.product_type||'', p.coverage||0,
           p.premium||0, p.start_date||'', p.end_date||'', p.status||'Active', p.recommended||0,
           p.notes||'', p.policy_number||'', p.coverage_items||'[]', p.created_at||new Date().toISOString(), p.updated_at||new Date().toISOString()]);
        imported.policies++;
      } catch (e) { imported.skipped++; }
    }

    // Restore investments
    for (const i of investments) {
      const clientExists = await dbGet('SELECT id FROM clients WHERE id=?', [i.client_id]);
      if (!clientExists) { imported.skipped++; continue; }
      try {
        await dbRun(`INSERT OR IGNORE INTO investments (id,client_id,name,type,invested,value_now,target,goal_by,contribution,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [i.id, i.client_id, i.name||'', i.type||'', i.invested||0, i.value_now||0,
           i.target||0, i.goal_by||'', i.contribution||0, i.created_at||new Date().toISOString(), i.updated_at||new Date().toISOString()]);
        imported.investments++;
      } catch (e) { imported.skipped++; }
    }

    // Restore snapshots
    for (const s of snapshots) {
      const clientExists = await dbGet('SELECT id FROM clients WHERE id=?', [s.client_id]);
      if (!clientExists) { imported.skipped++; continue; }
      try {
        await dbRun(`INSERT OR IGNORE INTO snapshots (id,client_id,year,snapshot_date,total_coverage,total_investment_value,notes,created_at)
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
app.patch('/api/clients/:id/notes', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { notes, deal_stage, next_action, last_contact } = req.body;
  const fields = [], vals = [];
  if (notes !== undefined) { fields.push('notes=?'); vals.push(notes); }
  if (deal_stage !== undefined) { fields.push('deal_stage=?'); vals.push(deal_stage); }
  if (next_action !== undefined) { fields.push('next_action=?'); vals.push(next_action); }
  if (last_contact !== undefined) { fields.push('last_contact=?'); vals.push(last_contact); }
  if (!fields.length) return res.json({ success: true });
  vals.push(req.params.id);
  await dbRun(`UPDATE clients SET ${fields.join(',')} WHERE id=?`, vals);
  saveDb();
  res.json({ success: true });
});

app.get('/api/pipeline', authenticate, requireAdmin, async (req, res) => {
  const stages = ['Prospect','Contacted','Proposal Sent','Negotiation','Closed Won','Closed Lost'];
  const result = {};
  await Promise.all(stages.map(async s => {
    result[s] = await dbAll(`SELECT id, name, annual_income, age, deal_stage, last_contact, next_action FROM clients WHERE deal_stage=? AND role='client' ORDER BY name`, [s]);
  }));
  res.json({ stages, pipeline: result });
});

// ── Needs Analysis CRUD ────────────────────────────────────────────────────────
app.get('/api/clients/:id/needs-analysis', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  const rows = await dbAll('SELECT * FROM needs_analysis WHERE client_id=? ORDER BY coverage_type', [req.params.id]);
  rows.forEach(r => { try { r.sources = JSON.parse(r.sources || '[]'); } catch { r.sources = []; } });
  res.json(rows);
});

app.post('/api/clients/:id/needs-analysis', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  const { coverage_type, recommended_amount, current_amount, gap, rationale, priority, sources } = req.body;
  const sourcesJson = JSON.stringify(Array.isArray(sources) ? sources : []);
  const existing = await dbGet('SELECT id FROM needs_analysis WHERE client_id=? AND coverage_type=?', [req.params.id, coverage_type]);
  let rowId;
  if (existing) {
    await dbRun(`UPDATE needs_analysis SET recommended_amount=?,current_amount=?,gap=?,rationale=?,priority=?,sources=?,updated_at=datetime('now') WHERE client_id=? AND coverage_type=?`,
      [recommended_amount||0, current_amount||0, gap||0, rationale||'', priority||'medium', sourcesJson, req.params.id, coverage_type]);
    rowId = existing.id;
  } else {
    rowId = await dbRun('INSERT INTO needs_analysis (client_id,coverage_type,recommended_amount,current_amount,gap,rationale,priority,sources) VALUES (?,?,?,?,?,?,?,?)',
      [req.params.id, coverage_type||'', recommended_amount||0, current_amount||0, gap||0, rationale||'', priority||'medium', sourcesJson]);
  }
  const row = await dbGet('SELECT * FROM needs_analysis WHERE id=?', [rowId]);
  if (row) { try { row.sources = JSON.parse(row.sources || '[]'); } catch { row.sources = []; } }
  res.json(row);
});

app.put('/api/clients/:id/needs-analysis/:nid', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  const { recommended_amount, current_amount, gap, rationale, priority, sources } = req.body;
  const sourcesJson = JSON.stringify(Array.isArray(sources) ? sources : []);
  await dbRun(`UPDATE needs_analysis SET recommended_amount=?,current_amount=?,gap=?,rationale=?,priority=?,sources=?,updated_at=datetime('now') WHERE id=? AND client_id=?`,
    [recommended_amount||0, current_amount||0, gap||0, rationale||'', priority||'medium', sourcesJson, req.params.nid, req.params.id]);
  const row = await dbGet('SELECT * FROM needs_analysis WHERE id=?', [req.params.nid]);
  if (row) { try { row.sources = JSON.parse(row.sources || '[]'); } catch { row.sources = []; } }
  res.json(row);
});

app.delete('/api/clients/:id/needs-analysis/:nid', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  await dbRun('DELETE FROM needs_analysis WHERE id=? AND client_id=?', [req.params.nid, req.params.id]);
  res.json({ success: true });
});

// ── Investment Projection ──────────────────────────────────────────────────────
app.get('/api/clients/:id/investments/:iid/projection', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  const inv = await dbGet('SELECT * FROM investments WHERE id=? AND client_id=?', [req.params.iid, req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Investment not found' });

  const ratesParam = req.query.rates || '3,4,5,6,7,8';
  const yearsParam = req.query.years || '5,10,15,20,25,30';
  const rates = ratesParam.split(',').map(Number).filter(r => !isNaN(r));
  const years = yearsParam.split(',').map(Number).filter(y => !isNaN(y));

  const subtype = inv.investment_subtype || '';
  const pv = parseFloat(inv.value_now) || 0;
  let annualPmt = parseFloat(inv.contribution) || 0;

  // Convert contribution to annual equivalent based on payment frequency
  const freq = inv.payment_frequency || 'annual';
  if (freq === 'monthly') annualPmt *= 12;
  else if (freq === 'quarterly') annualPmt *= 4;
  else if (freq === 'semi-annual') annualPmt *= 2;

  // CPF fixed rates override user-provided rates
  let effectiveRates = rates;
  if (subtype === 'CPF-OA') effectiveRates = [2.5];
  else if (subtype === 'CPF-SA') effectiveRates = [4.0];

  function fvCalc(pv, r, n, pmt) {
    if (r === 0) return pv + pmt * n;
    return pv * Math.pow(1 + r, n) + pmt * (Math.pow(1 + r, n) - 1) / r;
  }

  const projection = {};
  effectiveRates.forEach(rate => {
    const r = rate / 100;
    projection[rate] = {};
    years.forEach(n => { projection[rate][n] = Math.round(fvCalc(pv, r, n, annualPmt)); });
  });

  // Realistic vs optimistic labels per subtype
  const getLabel = (sub, rate) => {
    if (sub === 'CPF-OA' || sub === 'CPF-SA') return 'fixed';
    if (sub === 'ILP' || sub === 'Unit Trust') return rate <= 4 ? 'conservative' : rate <= 6 ? 'realistic' : 'optimistic';
    if (sub === 'Endowment') return rate <= 3 ? 'conservative' : rate <= 5 ? 'realistic' : 'optimistic';
    if (sub === 'Bond') return rate <= 3 ? 'realistic' : 'optimistic';
    if (sub === 'SRS') return rate <= 5 ? 'realistic' : 'optimistic';
    return rate <= 4 ? 'conservative' : rate <= 6 ? 'realistic' : 'optimistic';
  };

  const rateLabels = {};
  effectiveRates.forEach(rate => { rateLabels[rate] = getLabel(subtype, rate); });

  const endowmentData = subtype === 'Endowment' ? {
    guaranteed_return: parseFloat(inv.guaranteed_return) || 0,
    projected_return: parseFloat(inv.projected_return) || 0,
    maturity_date: inv.maturity_date || '',
  } : null;

  res.json({
    investment: { id: inv.id, name: inv.name, subtype, payment_frequency: freq, value_now: pv, annual_contribution: annualPmt },
    rates: effectiveRates, years, projection, rate_labels: rateLabels, endowment_data: endowmentData,
  });
});

// ── Notion CRM Full Export ─────────────────────────────────────────────────────
app.post('/api/admin/notion-crm-export', authenticate, requireAdmin, async (req, res) => {
  try {
    const clients = await dbAll(`SELECT * FROM clients WHERE role='client'`);
    const results = { success: 0, failed: 0, errors: [] };

    for (const client of clients) {
      try {
        const policies = await dbAll('SELECT * FROM policies WHERE client_id=?', [client.id]);
        const investments = await dbAll('SELECT * FROM investments WHERE client_id=?', [client.id]);
        const needsAnalysis = await dbAll('SELECT * FROM needs_analysis WHERE client_id=?', [client.id]);
        const totalPremium = policies.reduce((s, p) => s + (p.premium || 0), 0);

        const blocks = [
          { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: '👤 Client Profile' } }] } },
          { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: `Age: ${client.age||'—'} | Gender: ${client.gender||'—'} | Occupation: ${client.occupation||'—'} | Annual Income: S$${(client.annual_income||0).toLocaleString()} | Dependents: ${client.dependents||0}` } }] } },
          { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: `Email: ${client.email||'—'} | Phone: ${client.phone||'—'}` } }] } },
        ];

        if (policies.length) {
          blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: `🛡️ Insurance Policies (${policies.length}) — Total Premium: S$${Math.round(totalPremium).toLocaleString()}/yr` } }] } });
          policies.slice(0, 30).forEach(p => {
            blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ text: { content: `${p.product_name||p.type} (${p.insurer||'—'}) | Coverage: S$${(p.coverage||0).toLocaleString()} | Premium: S$${(p.premium||0).toLocaleString()}/yr | ${p.status} | Freq: ${p.payment_frequency||'annual'}` } }] } });
          });
        }

        if (investments.length) {
          blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: `📈 Investments (${investments.length})` } }] } });
          investments.slice(0, 20).forEach(i => {
            blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ text: { content: `${i.name} (${i.investment_subtype||i.type||'—'}) | Value: S$${(i.value_now||0).toLocaleString()} | Invested: S$${(i.invested||0).toLocaleString()} | Target: S$${(i.target||0).toLocaleString()}` } }] } });
          });
        }

        if (needsAnalysis.length) {
          blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: `📋 Needs Analysis` } }] } });
          needsAnalysis.forEach(n => {
            blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ text: { content: `${n.coverage_type} | Recommended: S$${(n.recommended_amount||0).toLocaleString()} | Current: S$${(n.current_amount||0).toLocaleString()} | Gap: S$${(n.gap||0).toLocaleString()} | Priority: ${n.priority}` } }] } });
          });
        }

        const props = {
          'Name': { title: [{ text: { content: client.name } }] },
          'Email': { email: client.email || null },
          'Phone': { phone_number: client.phone || null },
          'Total Premium (SGD)': { number: totalPremium },
          'Status': { select: { name: 'Active' } },
          'Notes': { rich_text: [{ text: { content: `Full CRM export: ${new Date().toLocaleDateString('en-SG')} | ${policies.length} policies | ${investments.length} investments | ${needsAnalysis.length} needs analysis` } }] }
        };

        const existingPageId = client.notion_page_id;
        if (existingPageId) {
          await notionReq('PATCH', `/pages/${existingPageId}`, { properties: props });
          // Append new content blocks
          if (blocks.length > 0) {
            await notionReq('PATCH', `/blocks/${existingPageId}/children`, { children: blocks.slice(0, 100) });
          }
        } else {
          const page = await notionReq('POST', '/pages', {
            parent: { database_id: NOTION_CLIENTS_DB },
            properties: props,
            children: blocks.slice(0, 100)
          });
          if (page.id) {
            await dbRun(`UPDATE clients SET notion_page_id=? WHERE id=?`, [page.id, client.id]);
          }
        }
        results.success++;
      } catch (e) {
        results.failed++;
        results.errors.push({ client: client.name, error: e.message });
      }
    }

    res.json({ success: true, total: clients.length, ...results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bootstrap admin ────────────────────────────────────────────────────────────
app.post('/api/bootstrap', async (req, res) => {
  const { adminPassword, bootstrapSecret } = req.body || {};
  // Require bootstrap secret to prevent unauthorized admin creation
  const requiredSecret = process.env.BOOTSTRAP_SECRET;
  if (requiredSecret && bootstrapSecret !== requiredSecret) {
    return res.status(403).json({ error: 'Invalid bootstrap secret' });
  }
  const existing = await dbGet(`SELECT id FROM clients WHERE role='admin'`);
  if (existing) return res.status(400).json({ error: 'Admin already exists' });
  const hash = bcrypt.hashSync(adminPassword || 'admin2026', 10);
  await dbRun('INSERT INTO clients (id,username,password_hash,name,role) VALUES (?,?,?,?,?)',
    ['ADMIN001', 'admin', hash, 'Dylan Ho', 'admin']);
  res.json({ success: true, username: 'admin' });
});


// ── Policy Parser (Prospects) ──────────────────────────────────────────────────

const PARSER_SYSTEM_PROMPT = `You are a Prudential Singapore financial advisor's policy parser. Extract from insurance PDF/image (NTUC Income, Singlife, Prudential, Great Eastern, AIA, Manulife). Focus on protection + ILPs/wealth.

Output ONLY valid JSON array [] of policies. Each policy:
{
  "insurer": "NTUC Income | Singlife | Prudential | Great Eastern | AIA | Manulife",
  "product_name": "string",
  "category": "Protection | ILP | Savings | Annuity",
  "sub_type": "Death | TPD | TECI | Early CI | Multi CI | Hospital Private | Hospital B1 | Hospital B2 | Hospital C | Accident",
  "sum_assured": number,
  "annual_premium": number,
  "payment_mode": "Annual | Monthly | Quarterly",
  "payment_term_years": number or null,
  "policy_term_years": number or null,
  "age_bought": number or null,
  "age_end": number or null,
  "start_date": "YYYY-MM-DD or null",
  "end_date": "YYYY-MM-DD or null",
  "status": "Active | Lapsed | Paid-up | Matured",
  "total_paid_estimate": number or null,
  "surrender_value": number or null,
  "projected_maturity": number or null,
  "deductible": number or null,
  "coinsurance": number or null,
  "key_exclusions": ["Pre-existing conditions", ...] max 10 from doc,
  "riders": [{"name": "string", "sum_assured": number}] or [],
  "multiplier_end_age": number or null,
  "multiplier_times": number or null
}

Rules:
- key_exclusions: Extract ALL listed. Max 10. Quote exactly.
- age_bought: Compute from start_date + DOB if provided.
- Multi CI: Extract multiplier_end_age (age multiplier ends e.g. 65/70) and multiplier_times (how many times e.g. 5).
- Hospital wards: Private / B1 / B2+ / B2 / C.
- SGD numbers, no $ sign. Null for unknown.
- If unparseable: [{"error": "unparseable", "reason": "string"}]`;

async function callAnthropicParser(userContent) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not configured on server');

  // Build OpenAI messages — convert Anthropic-style content blocks to OpenAI format
  const messages = [
    { role: 'system', content: PARSER_SYSTEM_PROMPT },
    { role: 'user', content: Array.isArray(userContent)
        ? userContent.map(c => {
            if (c.type === 'text') return { type: 'text', text: c.text };
            if (c.type === 'image') return { type: 'image_url', image_url: { url: `data:${c.source.media_type};base64,${c.source.data}` } };
            return c;
          })
        : userContent }
  ];

  const body = JSON.stringify({
    model: 'gpt-4o', max_tokens: 4096, messages
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`,
        'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const resp = JSON.parse(data);
          if (resp.error) return reject(new Error(resp.error.message || JSON.stringify(resp.error)));
          const text = resp.choices?.[0]?.message?.content || '';
          const m = text.match(/\[[\s\S]*\]/);
          if (m) resolve(JSON.parse(m[0]));
          else reject(new Error('No JSON array in GPT-4o response: ' + text.slice(0,200)));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function computeGapAnalysis(prospect, policies) {
  const income = parseFloat(prospect.annual_income) || 0;
  const active = policies.filter(p => p.status === 'Active');
  const sum = arr => arr.reduce((s, p) => s + (parseFloat(p.sum_assured) || 0), 0);

  const deathPols = active.filter(p => p.sub_type === 'Death');
  const tpdPols   = active.filter(p => p.sub_type === 'TPD');
  const teciPols  = active.filter(p => ['TECI','Early CI'].includes(p.sub_type));
  const multiPols = active.filter(p => p.sub_type === 'Multi CI');
  const allCIPols = active.filter(p => ['TECI','Early CI','Multi CI'].includes(p.sub_type));
  const hospPols  = active.filter(p => (p.sub_type||'').startsWith('Hospital'));
  const accPols   = active.filter(p => p.sub_type === 'Accident');
  const ilpPols   = active.filter(p => ['ILP','Savings','Annuity'].includes(p.category));

  const deathTarget = income * 10;
  const ciTarget    = income * 5;
  const earlyTarget = income * 3;

  const flag = (have, need) => need > 0 ? (have >= need ? 'ok' : have >= need * 0.5 ? 'partial' : 'gap') : (have > 0 ? 'ok' : 'gap');

  const hasMultiCI = multiPols.length > 0;
  const multEndAges = multiPols.map(p => p.multiplier_end_age).filter(Boolean);
  const multTimes   = multiPols.map(p => p.multiplier_times).filter(Boolean);
  const earliestEnd = multEndAges.length ? Math.min(...multEndAges) : null;

  const wardRank = {'Hospital Private':5,'Hospital B1':4,'Hospital B2+':3,'Hospital B2':2,'Hospital C':1};
  const bestWard = hospPols.reduce((b, p) => (wardRank[p.sub_type]||0) > (wardRank[b]||0) ? p.sub_type : b, null);

  return {
    income,
    death:    { have: sum(deathPols), need: deathTarget, gap: Math.max(0, deathTarget - sum(deathPols)), status: flag(sum(deathPols), deathTarget), policies: deathPols.map(p => p.product_name) },
    tpd:      { have: sum(tpdPols),   need: deathTarget, gap: Math.max(0, deathTarget - sum(tpdPols)),   status: flag(sum(tpdPols),   deathTarget), policies: tpdPols.map(p => p.product_name) },
    ci:       { have: sum(allCIPols), need: ciTarget,    gap: Math.max(0, ciTarget    - sum(allCIPols)), status: flag(sum(allCIPols), ciTarget),    policies: allCIPols.map(p => p.product_name) },
    early_ci: { have: sum(teciPols),  need: earlyTarget, gap: Math.max(0, earlyTarget - sum(teciPols)),  status: flag(sum(teciPols),  earlyTarget), policies: teciPols.map(p => p.product_name) },
    multi_ci: {
      has: hasMultiCI, sum_assured: sum(multiPols), status: hasMultiCI ? 'ok' : 'gap',
      policies: multiPols.map(p => ({ name: p.product_name, insurer: p.insurer, sum_assured: p.sum_assured, multiplier_end_age: p.multiplier_end_age, multiplier_times: p.multiplier_times })),
      multiplier_end_age: earliestEnd,
      multiplier_times: multTimes.length ? Math.max(...multTimes) : null,
      note: hasMultiCI ? `Multi-pay CI ✓${earliestEnd ? ` — multiplier ends age ${earliestEnd}` : ''}${multTimes.length ? ` (${Math.max(...multTimes)}x)` : ''}` : 'No multi-pay CI — gap to address'
    },
    hospital: {
      ward: bestWard, status: bestWard === 'Hospital Private' ? 'ok' : bestWard ? 'partial' : 'gap',
      note: !bestWard ? 'No hospitalisation coverage' : bestWard === 'Hospital Private' ? 'Private ward ✓' : `${bestWard} — consider upgrading to Private`,
      policies: hospPols.map(p => p.product_name)
    },
    accident: { has: accPols.length > 0, status: accPols.length > 0 ? 'ok' : 'gap', policies: accPols.map(p => p.product_name) },
    ilp:      { has: ilpPols.length > 0, status: ilpPols.length > 0 ? 'ok' : 'gap', total_value: sum(ilpPols), policies: ilpPols.map(p => p.product_name) },
    total_annual_premium: active.reduce((s, p) => s + (parseFloat(p.annual_premium)||0), 0),
    premium_benchmark: income * 0.15,
  };
}

// POST /api/prospect/parse
app.post('/api/prospect/parse', authenticate, requireAdmin, async (req, res) => {
  try {
    const { text, image_base64, media_type } = req.body;
    if (!text && !image_base64) return res.status(400).json({ error: 'Provide text or image_base64' });
    const userContent = image_base64
      ? [{ type: 'image', source: { type: 'base64', media_type: media_type||'image/jpeg', data: image_base64 } },
         { type: 'text', text: 'Extract all policies. Return ONLY valid JSON array [].' }]
      : [{ type: 'text', text }];
    const parsed = await callAnthropicParser(userContent);
    res.json({ ok: true, policies: parsed, count: Array.isArray(parsed) ? parsed.length : 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/prospects
app.post('/api/prospects', authenticate, requireAdmin, async (req, res) => {
  try {
    const { name, dob, gender, occupation, annual_income, phone, email, notes, source, deal_stage, raw_input, policies = [] } = req.body;
    const id = 'PROS_' + Date.now() + '_' + Math.random().toString(36).slice(2,6).toUpperCase();
    await dbRun(`INSERT INTO prospects (id,name,dob,gender,occupation,annual_income,phone,email,notes,source,deal_stage,raw_input) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, name||'Unknown', dob||'', gender||'', occupation||'', parseFloat(annual_income)||0, phone||'', email||'', notes||'', source||'', deal_stage||'New Prospect', raw_input||'']);
    for (const p of policies) {
      await dbRun(`INSERT INTO prospect_policies (prospect_id,insurer,product_name,category,sub_type,sum_assured,annual_premium,payment_mode,payment_term_years,policy_term_years,age_bought,age_end,start_date,end_date,status,total_paid_estimate,surrender_value,projected_maturity,deductible,coinsurance,key_exclusions,riders,multiplier_end_age,multiplier_times,raw_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, p.insurer||'', p.product_name||'', p.category||'', p.sub_type||'',
         p.sum_assured||0, p.annual_premium||0, p.payment_mode||'',
         p.payment_term_years||null, p.policy_term_years||null, p.age_bought||null, p.age_end||null,
         p.start_date||'', p.end_date||'', p.status||'Active',
         p.total_paid_estimate||null, p.surrender_value||null, p.projected_maturity||null,
         p.deductible||null, p.coinsurance||null,
         JSON.stringify(p.key_exclusions||[]), JSON.stringify(p.riders||[]),
         p.multiplier_end_age||null, p.multiplier_times||null, JSON.stringify(p)]);
    }
    const prospect = await dbGet('SELECT * FROM prospects WHERE id=?', [id]);
    const savedPolicies = await dbAll('SELECT * FROM prospect_policies WHERE prospect_id=?', [id]);
    const parsed2 = savedPolicies.map(p => ({...p, key_exclusions: JSON.parse(p.key_exclusions||'[]'), riders: JSON.parse(p.riders||'[]')}));
    res.status(201).json({ ok: true, prospect, policies: parsed2, gap: computeGapAnalysis(prospect, parsed2) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/prospects
app.get('/api/prospects', authenticate, requireAdmin, async (req, res) => {
  try {
    const list = await dbAll(`SELECT p.*, (SELECT COUNT(*) FROM prospect_policies pp WHERE pp.prospect_id=p.id) as policy_count FROM prospects p ORDER BY p.created_at DESC`, []);
    res.json(list);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/prospects/:id
app.get('/api/prospects/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const prospect = await dbGet('SELECT * FROM prospects WHERE id=?', [req.params.id]);
    if (!prospect) return res.status(404).json({ error: 'Not found' });
    const pols = await dbAll('SELECT * FROM prospect_policies WHERE prospect_id=? ORDER BY category,insurer', [req.params.id]);
    const parsed2 = pols.map(p => ({...p, key_exclusions: JSON.parse(p.key_exclusions||'[]'), riders: JSON.parse(p.riders||'[]')}));
    res.json({ prospect, policies: parsed2, gap: computeGapAnalysis(prospect, parsed2) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/prospects/:id
app.put('/api/prospects/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { name, dob, gender, occupation, annual_income, phone, email, notes, deal_stage, next_action } = req.body;
    await dbRun(`UPDATE prospects SET name=?,dob=?,gender=?,occupation=?,annual_income=?,phone=?,email=?,notes=?,deal_stage=?,next_action=?,updated_at=datetime('now') WHERE id=?`,
      [name||'', dob||'', gender||'', occupation||'', parseFloat(annual_income)||0, phone||'', email||'', notes||'', deal_stage||'New Prospect', next_action||'', req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/prospects/:id
app.delete('/api/prospects/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await dbRun('DELETE FROM prospects WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/prospects/:id/convert — convert to full client
app.post('/api/prospects/:id/convert', authenticate, requireAdmin, async (req, res) => {
  try {
    const prospect = await dbGet('SELECT * FROM prospects WHERE id=?', [req.params.id]);
    if (!prospect) return res.status(404).json({ error: 'Not found' });
    const pols = await dbAll('SELECT * FROM prospect_policies WHERE prospect_id=?', [req.params.id]);
    const clientId = 'CLI_' + Date.now();
    const username = req.body.username || prospect.email || `client_${clientId.slice(-6)}`;
    const password = req.body.password || 'change-me-2026';
    const hash = bcrypt.hashSync(password, 10);
    const age = prospect.dob ? Math.floor((Date.now() - new Date(prospect.dob).getTime()) / 31557600000) : 0;
    await dbRun(`INSERT INTO clients (id,username,password_hash,name,age,gender,occupation,annual_income,phone,email,notes,deal_stage) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [clientId, username, hash, prospect.name, age, prospect.gender, prospect.occupation, prospect.annual_income, prospect.phone, prospect.email, prospect.notes, 'Client']);
    for (const p of pols) {
      const noteStr = [p.multiplier_end_age ? `Multiplier ends age ${p.multiplier_end_age}` : '', p.key_exclusions ? `Exclusions: ${p.key_exclusions}` : ''].filter(Boolean).join(' | ');
      await dbRun(`INSERT INTO policies (client_id,insurer,product_name,type,product_type,coverage,premium,start_date,end_date,status,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [clientId, p.insurer, p.product_name, p.category, p.sub_type, p.sum_assured, p.annual_premium, p.start_date, p.end_date, p.status, noteStr]);
    }
    await dbRun('DELETE FROM prospects WHERE id=?', [prospect.id]);
    res.json({ ok: true, client_id: clientId, username, password, message: `${prospect.name} converted to client` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Start ──────────────────────────────────────────────────────────────────────
async function startServer() {
  // If DATABASE_URL is set, verify the connection first.
  // If PostgreSQL is unreachable, fall back to SQLite so the app never hard-crashes.
  if (USE_POSTGRES) {
    const pgOk = await testPgConnection();
    if (!pgOk) {
      console.warn('⚠️  Falling back to SQLite — PostgreSQL unavailable');
      USE_POSTGRES = false;
      _pgPool = null;
    }
  }
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`\n🚀 FinView Dashboard → http://localhost:${PORT}`);
      console.log(`   Mode: ${USE_POSTGRES ? 'PostgreSQL' : 'SQLite'}`);
      console.log(`   Admin: admin / admin2026\n`);
    });
  } catch (e) {
    console.error('DB init failed:', e);
    process.exit(1);
  }
}

startServer();

// ── Client Recommendation Engine (SG data-backed) ─────────────────────────
app.get('/api/clients/:id/recommendation', authenticate, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  try {
    const client = await dbGet('SELECT * FROM clients WHERE id=?', [req.params.id]);
    if (!client) return res.status(404).json({ error: 'Not found' });
    
    const policies = await dbAll('SELECT * FROM policies WHERE client_id=? AND status=?', [req.params.id, 'Active']);
    const investments = await dbAll('SELECT * FROM investments WHERE client_id=?', [req.params.id]);
    
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
