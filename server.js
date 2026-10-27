const express = require('express');
const bcrypt = require('bcryptjs');
const { seedIfEmpty } = require('./seed');
const jwt = require('jsonwebtoken');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const multer = require('multer');
const xlsx = require('xlsx');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.includes('spreadsheet') || file.originalname.endsWith('.xlsx') || file.originalname.endsWith('.xls')) cb(null, true);
    else cb(new Error('Only Excel files allowed'));
  }
});

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
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 60000,
      max: 5,
      min: 0,
      allowExitOnIdle: false,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000
    });
    _pgPool.on('error', (err) => {
      console.warn('[FinView] PG pool error (auto-recovering):', err.message);
      _pgPool = null;
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
  const maxAttempts = 8;
  const delayMs = 3000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const pool = await _getPgPool();
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('PG connection timeout')), 8000))
      ]);
      if (attempt > 1) console.log(`✅ PostgreSQL connected on attempt ${attempt}`);
      return true;
    } catch (e) {
      console.warn(`⚠️  PostgreSQL attempt ${attempt}/${maxAttempts} failed: ${e.message}`);
      try { if (_pgPool) { await _pgPool.end(); _pgPool = null; } } catch {}
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  console.warn('⚠️  Falling back to SQLite after all retries exhausted');
  return false;
}

// Sync wrappers for SQLite (unchanged from original)
// dbGet, dbAll, dbRun defined below after db init
// ── End Adapter ──────────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3847;
if (!process.env.JWT_SECRET) { console.error('FATAL: JWT_SECRET env var is required'); process.exit(1); }
const JWT_SECRET = process.env.JWT_SECRET;
const DB_PATH = path.join(__dirname, 'data', 'dashboard.db');

// ── Dylan Contact Info (for CTAs, booking) ─────────────────────────────────────
const DYLAN_WHATSAPP = '+65 8484 7001';
const DYLAN_WHATSAPP_LINK = 'https://wa.me/6584847001?text=Hi%20Dylan%2C%20I%27d%20like%20to%20schedule%20a%20financial%20planning%20consultation';
const DYLAN_EMAIL = 'dylanjh.cjo@gmail.com';

// ── Global crash prevention ────────────────────────────────────────────────────
// Node 15+ kills the process on unhandled rejections — catch them all here
process.on('uncaughtException', err => {
  console.error('[FinView] Uncaught exception (server kept alive):', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FinView] Unhandled rejection (server kept alive):', reason);
});
// Wraps async route handlers so thrown errors go to Express error handler
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
        feature_flags TEXT DEFAULT '[]',
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
        premium_type TEXT DEFAULT 'regular',
        term_years INTEGER DEFAULT 0,
        units_held FLOAT DEFAULT 0,
        nav_price FLOAT DEFAULT 0,
        fund_name TEXT DEFAULT '',
        irr FLOAT DEFAULT 0,
        break_even_year INTEGER DEFAULT 0,
        notes TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS dca_entries (
        id SERIAL PRIMARY KEY,
        investment_id INTEGER NOT NULL,
        entry_date TEXT NOT NULL DEFAULT '',
        amount FLOAT DEFAULT 0,
        units FLOAT DEFAULT 0,
        nav FLOAT DEFAULT 0,
        notes TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
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
    // Migrations for PG: add columns that may not exist in older deployments
    try { await _pgExec(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''`); } catch {}
    try { await _pgExec(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS deal_stage TEXT DEFAULT 'Prospect'`); } catch {}
    try { await _pgExec(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_contact TEXT DEFAULT ''`); } catch {}
    try { await _pgExec(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS next_action TEXT DEFAULT ''`); } catch {}
    try { await _pgExec(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS referral_source TEXT DEFAULT ''`); } catch {}
    try { await _pgExec(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS referred_by TEXT DEFAULT ''`); } catch {}
    try { await _pgExec(`ALTER TABLE policies ADD COLUMN IF NOT EXISTS coverage_items TEXT DEFAULT '[]'`); } catch {}
    try { await _pgExec(`ALTER TABLE policies ADD COLUMN IF NOT EXISTS payment_frequency TEXT DEFAULT 'annual'`); } catch {}
    try { await _pgExec(`ALTER TABLE policies ADD COLUMN IF NOT EXISTS cpf_medisave_amount FLOAT DEFAULT 0`); } catch {}
    try { await _pgExec(`ALTER TABLE policies ADD COLUMN IF NOT EXISTS cash_amount FLOAT DEFAULT 0`); } catch {}
    try { await _pgExec(`ALTER TABLE policies ADD COLUMN IF NOT EXISTS feature_flags TEXT DEFAULT '[]'`); } catch {}
    // Investments migrations for new columns
    try { await _pgExec(`ALTER TABLE investments ADD COLUMN IF NOT EXISTS premium_type TEXT DEFAULT 'regular'`); } catch {}
    try { await _pgExec(`ALTER TABLE investments ADD COLUMN IF NOT EXISTS term_years INTEGER DEFAULT 0`); } catch {}
    try { await _pgExec(`ALTER TABLE investments ADD COLUMN IF NOT EXISTS units_held FLOAT DEFAULT 0`); } catch {}
    try { await _pgExec(`ALTER TABLE investments ADD COLUMN IF NOT EXISTS nav_price FLOAT DEFAULT 0`); } catch {}
    try { await _pgExec(`ALTER TABLE investments ADD COLUMN IF NOT EXISTS fund_name TEXT DEFAULT ''`); } catch {}
    try { await _pgExec(`ALTER TABLE investments ADD COLUMN IF NOT EXISTS irr FLOAT DEFAULT 0`); } catch {}
    try { await _pgExec(`ALTER TABLE investments ADD COLUMN IF NOT EXISTS break_even_year INTEGER DEFAULT 0`); } catch {}
    try { await _pgExec(`ALTER TABLE investments ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''`); } catch {}
    try { await _pgExec(`ALTER TABLE investments ADD COLUMN IF NOT EXISTS payout_start TEXT DEFAULT ''`); } catch {}
    try { await _pgExec(`ALTER TABLE investments ADD COLUMN IF NOT EXISTS payout_end TEXT DEFAULT ''`); } catch {}
    try { await _pgExec(`ALTER TABLE investments ADD COLUMN IF NOT EXISTS payout_monthly FLOAT DEFAULT 0`); } catch {}
    try { await _pgExec(`ALTER TABLE investments ADD COLUMN IF NOT EXISTS surrender_value FLOAT DEFAULT 0`); } catch {}
    try { await _pgExec(`ALTER TABLE investments ADD COLUMN IF NOT EXISTS total_paid FLOAT DEFAULT 0`); } catch {}
    try { await _pgExec(`ALTER TABLE investments ADD COLUMN IF NOT EXISTS policy_number TEXT DEFAULT ''`); } catch {}

    // Documents table
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        client_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        file_type TEXT DEFAULT '',
        file_size INTEGER DEFAULT 0,
        category TEXT DEFAULT 'other',
        notes TEXT DEFAULT '',
        uploaded_by TEXT DEFAULT 'admin',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);

    // Commissions table
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS commissions (
        id SERIAL PRIMARY KEY,
        client_id TEXT NOT NULL,
        policy_id INTEGER,
        product_name TEXT DEFAULT '',
        insurer TEXT DEFAULT '',
        commission_type TEXT DEFAULT 'first_year',
        amount FLOAT DEFAULT 0,
        expected_date TEXT DEFAULT '',
        received_date TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        notes TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);
    // Net Worth Items table
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS net_worth_items (
        id SERIAL PRIMARY KEY,
        client_id TEXT NOT NULL,
        category TEXT DEFAULT 'asset',
        name TEXT DEFAULT '',
        amount FLOAT DEFAULT 0,
        as_of_date TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);

    // Financial Goals table
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS goals (
        id SERIAL PRIMARY KEY,
        client_id TEXT NOT NULL,
        name TEXT DEFAULT '',
        target_amount FLOAT DEFAULT 0,
        current_amount FLOAT DEFAULT 0,
        target_date TEXT DEFAULT '',
        category TEXT DEFAULT 'general',
        notes TEXT DEFAULT '',
        status TEXT DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);

    // Cashflow Entries table
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS cashflow_entries (
        id SERIAL PRIMARY KEY,
        client_id TEXT NOT NULL,
        type TEXT DEFAULT 'expense',
        category TEXT DEFAULT 'other',
        description TEXT DEFAULT '',
        amount FLOAT DEFAULT 0,
        entry_date TEXT DEFAULT '',
        recurring INTEGER DEFAULT 0,
        frequency TEXT DEFAULT 'monthly',
        notes TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);

    // Cashflow Analyses table (uploaded Excel files)
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS cashflow_analyses (
        id SERIAL PRIMARY KEY,
        client_id TEXT NOT NULL,
        filename TEXT DEFAULT '',
        presentation_date TEXT DEFAULT '',
        parsed_data JSONB,
        uploaded_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);

    // Reviews table (PG)
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        client_id TEXT NOT NULL,
        review_date TEXT NOT NULL,
        next_review_date TEXT,
        meeting_type TEXT DEFAULT 'annual_review',
        notes TEXT DEFAULT '',
        action_items TEXT DEFAULT '',
        created_by TEXT DEFAULT 'admin',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);
    // Beneficiaries table (PG)
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS beneficiaries (
        id SERIAL PRIMARY KEY,
        client_id TEXT NOT NULL,
        policy_id INTEGER,
        name TEXT NOT NULL,
        relationship TEXT DEFAULT '',
        percentage INTEGER DEFAULT 100,
        ic_number TEXT DEFAULT '',
        contact TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);
    // Claims table (PG)
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS claims (
        id SERIAL PRIMARY KEY,
        client_id TEXT NOT NULL,
        policy_id INTEGER,
        claim_date TEXT NOT NULL,
        claim_type TEXT DEFAULT '',
        amount_claimed FLOAT DEFAULT 0,
        amount_approved FLOAT DEFAULT 0,
        status TEXT DEFAULT 'pending',
        notes TEXT DEFAULT '',
        settled_date TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);
    // Dependents table (PG)
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS dependents (
        id SERIAL PRIMARY KEY,
        client_id TEXT NOT NULL,
        name TEXT NOT NULL,
        relationship TEXT DEFAULT '',
        age INTEGER DEFAULT 0,
        has_coverage INTEGER DEFAULT 0,
        coverage_notes TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);

    // New holistic planning tables (PG)
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS client_profile_extended (
        id SERIAL PRIMARY KEY,
        client_id TEXT UNIQUE NOT NULL,
        date_of_birth TEXT DEFAULT '',
        nationality TEXT DEFAULT 'Singaporean',
        marital_status TEXT DEFAULT 'single',
        spouse_name TEXT DEFAULT '',
        spouse_age INTEGER DEFAULT 0,
        spouse_occupation TEXT DEFAULT '',
        spouse_income FLOAT DEFAULT 0,
        children TEXT DEFAULT '[]',
        parents_dependent INTEGER DEFAULT 0,
        parent1_age INTEGER DEFAULT 0,
        parent2_age INTEGER DEFAULT 0,
        retirement_age INTEGER DEFAULT 62,
        target_monthly_income FLOAT DEFAULT 3000,
        life_expectancy INTEGER DEFAULT 85,
        risk_tolerance INTEGER DEFAULT 3,
        investment_philosophy TEXT DEFAULT 'balanced',
        primary_objective TEXT DEFAULT 'protection',
        has_will INTEGER DEFAULT 0,
        cpf_nomination_done INTEGER DEFAULT 0,
        policy_nomination_done INTEGER DEFAULT 0,
        emergency_fund_months FLOAT DEFAULT 0,
        property_owned INTEGER DEFAULT 0,
        property_type TEXT DEFAULT '',
        property_value FLOAT DEFAULT 0,
        rental_income FLOAT DEFAULT 0,
        education_plans TEXT DEFAULT '[]',
        planner_notes TEXT DEFAULT '',
        updated_at TEXT DEFAULT '',
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);
    await _pgExec(`
      CREATE TABLE IF NOT EXISTS income_streams (
        id SERIAL PRIMARY KEY,
        client_id TEXT NOT NULL,
        label TEXT NOT NULL,
        type TEXT DEFAULT 'rental',
        amount FLOAT DEFAULT 0,
        frequency TEXT DEFAULT 'monthly',
        start_date TEXT DEFAULT '',
        end_date TEXT DEFAULT '',
        is_retirement_income INTEGER DEFAULT 0,
        notes TEXT DEFAULT '',
        created_at TEXT DEFAULT '',
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);

    console.log('✅ PostgreSQL schema ready');

    // Reset sequences to avoid duplicate key errors after backup/restore
    await _pgExec(`SELECT setval('policies_id_seq', COALESCE((SELECT MAX(id) FROM policies), 0) + 1, false)`);
    await _pgExec(`SELECT setval('investments_id_seq', COALESCE((SELECT MAX(id) FROM investments), 0) + 1, false)`);
    await _pgExec(`SELECT setval('snapshots_id_seq', COALESCE((SELECT MAX(id) FROM snapshots), 0) + 1, false)`);
    await _pgExec(`SELECT setval('needs_analysis_id_seq', COALESCE((SELECT MAX(id) FROM needs_analysis), 0) + 1, false)`);
    try { await _pgExec(`SELECT setval('dca_entries_id_seq', COALESCE((SELECT MAX(id) FROM dca_entries), 0) + 1, false)`); } catch {}
    try { await _pgExec(`SELECT setval('commissions_id_seq', COALESCE((SELECT MAX(id) FROM commissions), 0) + 1, false)`); } catch {}
    try { await _pgExec(`SELECT setval('documents_id_seq', COALESCE((SELECT MAX(id) FROM documents), 0) + 1, false)`); } catch {}
    try { await _pgExec(`SELECT setval('net_worth_items_id_seq', COALESCE((SELECT MAX(id) FROM net_worth_items), 0) + 1, false)`); } catch {}
    try { await _pgExec(`SELECT setval('goals_id_seq', COALESCE((SELECT MAX(id) FROM goals), 0) + 1, false)`); } catch {}
    try { await _pgExec(`SELECT setval('cashflow_entries_id_seq', COALESCE((SELECT MAX(id) FROM cashflow_entries), 0) + 1, false)`); } catch {}
    try { await _pgExec(`SELECT setval('cashflow_analyses_id_seq', COALESCE((SELECT MAX(id) FROM cashflow_analyses), 0) + 1, false)`); } catch {}
    try { await _pgExec(`SELECT setval('reviews_id_seq', COALESCE((SELECT MAX(id) FROM reviews), 0) + 1, false)`); } catch {}
    try { await _pgExec(`SELECT setval('beneficiaries_id_seq', COALESCE((SELECT MAX(id) FROM beneficiaries), 0) + 1, false)`); } catch {}
    try { await _pgExec(`SELECT setval('claims_id_seq', COALESCE((SELECT MAX(id) FROM claims), 0) + 1, false)`); } catch {}
    try { await _pgExec(`SELECT setval('dependents_id_seq', COALESCE((SELECT MAX(id) FROM dependents), 0) + 1, false)`); } catch {}
    try { await _pgExec(`SELECT setval('client_profile_extended_id_seq', COALESCE((SELECT MAX(id) FROM client_profile_extended), 0) + 1, false)`); } catch {}
    try { await _pgExec(`SELECT setval('income_streams_id_seq', COALESCE((SELECT MAX(id) FROM income_streams), 0) + 1, false)`); } catch {}
    // CPF balances table
    await _pgExec(`CREATE TABLE IF NOT EXISTS cpf_balances (
      id SERIAL PRIMARY KEY,
      client_id TEXT UNIQUE NOT NULL,
      oa_balance FLOAT DEFAULT 0,
      sa_balance FLOAT DEFAULT 0,
      ma_balance FLOAT DEFAULT 0,
      ra_balance FLOAT DEFAULT 0,
      oa_monthly_contrib FLOAT DEFAULT 0,
      sa_monthly_contrib FLOAT DEFAULT 0,
      ma_monthly_contrib FLOAT DEFAULT 0,
      as_of_date TEXT DEFAULT '',
      cpf_life_option TEXT DEFAULT 'standard',
      projected_cpf_life_monthly FLOAT DEFAULT 0,
      updated_at TEXT DEFAULT '',
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    )`);
    try { await _pgExec(`SELECT setval('cpf_balances_id_seq', COALESCE((SELECT MAX(id) FROM cpf_balances), 0) + 1, false)`); } catch {}
    console.log('✅ Sequences synced');

    // Seed admin
    const adminExists = await _pgGet(`SELECT id FROM clients WHERE role='admin'`);
    if (!adminExists) {
      const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin2026', 10);
      await _pgRun(`INSERT INTO clients (id,username,password_hash,name,role) VALUES ($1,$2,$3,$4,$5)`,
        ['ADMIN001', 'admin', hash, 'Dylan Ho', 'admin']);
      console.log('✅ Admin seeded');
    }
    // Auto-seed clients + policies if DB is empty
    await seedIfEmpty(_pgGet, _pgAll, _pgRun);
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
  // Phase 3 migrations — investments single/DCA columns
  try { db.run(`ALTER TABLE investments ADD COLUMN premium_type TEXT DEFAULT 'regular'`); } catch {}
  try { db.run(`ALTER TABLE investments ADD COLUMN term_years INTEGER DEFAULT 0`); } catch {}
  try { db.run(`ALTER TABLE investments ADD COLUMN units_held REAL DEFAULT 0`); } catch {}
  try { db.run(`ALTER TABLE investments ADD COLUMN nav_price REAL DEFAULT 0`); } catch {}
  try { db.run(`ALTER TABLE investments ADD COLUMN fund_name TEXT DEFAULT ''`); } catch {}
  try { db.run(`ALTER TABLE investments ADD COLUMN irr REAL DEFAULT 0`); } catch {}
  try { db.run(`ALTER TABLE investments ADD COLUMN break_even_year INTEGER DEFAULT 0`); } catch {}
  try { db.run(`ALTER TABLE investments ADD COLUMN notes TEXT DEFAULT ''`); } catch {}
  // DCA entries table
  db.run(`CREATE TABLE IF NOT EXISTS dca_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investment_id INTEGER NOT NULL,
    entry_date TEXT NOT NULL DEFAULT '',
    amount REAL DEFAULT 0,
    units REAL DEFAULT 0,
    nav REAL DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
  )`);

  // Documents table
  db.run(`CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    file_type TEXT DEFAULT '',
    file_size INTEGER DEFAULT 0,
    category TEXT DEFAULT 'other',
    notes TEXT DEFAULT '',
    uploaded_by TEXT DEFAULT 'admin',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`);

  // Commissions table
  db.run(`CREATE TABLE IF NOT EXISTS commissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    policy_id INTEGER,
    product_name TEXT DEFAULT '',
    insurer TEXT DEFAULT '',
    commission_type TEXT DEFAULT 'first_year',
    amount REAL DEFAULT 0,
    expected_date TEXT DEFAULT '',
    received_date TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`);

  // Referral columns on clients
  try { db.run(`ALTER TABLE clients ADD COLUMN referral_source TEXT DEFAULT ''`); } catch {}
  try { db.run(`ALTER TABLE clients ADD COLUMN referred_by TEXT DEFAULT ''`); } catch {}

  // Net Worth Items table (SQLite)
  db.run(`CREATE TABLE IF NOT EXISTS net_worth_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    category TEXT DEFAULT 'asset',
    name TEXT DEFAULT '',
    amount REAL DEFAULT 0,
    as_of_date TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`);

  // Financial Goals table (SQLite)
  db.run(`CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    name TEXT DEFAULT '',
    target_amount REAL DEFAULT 0,
    current_amount REAL DEFAULT 0,
    target_date TEXT DEFAULT '',
    category TEXT DEFAULT 'general',
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`);

  // Cashflow Analyses table (SQLite)
  db.run(`CREATE TABLE IF NOT EXISTS cashflow_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    filename TEXT DEFAULT '',
    presentation_date TEXT DEFAULT '',
    parsed_data TEXT,
    uploaded_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`);

  // Cashflow Entries table (SQLite)
  db.run(`CREATE TABLE IF NOT EXISTS cashflow_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    type TEXT DEFAULT 'expense',
    category TEXT DEFAULT 'other',
    description TEXT DEFAULT '',
    amount REAL DEFAULT 0,
    entry_date TEXT DEFAULT '',
    recurring INTEGER DEFAULT 0,
    frequency TEXT DEFAULT 'monthly',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`);

  // Reviews table (SQLite)
  db.run(`CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    review_date TEXT NOT NULL,
    next_review_date TEXT,
    meeting_type TEXT DEFAULT 'annual_review',
    notes TEXT DEFAULT '',
    action_items TEXT DEFAULT '',
    created_by TEXT DEFAULT 'admin',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`);
  // Beneficiaries table (SQLite)
  db.run(`CREATE TABLE IF NOT EXISTS beneficiaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    policy_id INTEGER,
    name TEXT NOT NULL,
    relationship TEXT DEFAULT '',
    percentage INTEGER DEFAULT 100,
    ic_number TEXT DEFAULT '',
    contact TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`);
  // Claims table (SQLite)
  db.run(`CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    policy_id INTEGER,
    claim_date TEXT NOT NULL,
    claim_type TEXT DEFAULT '',
    amount_claimed REAL DEFAULT 0,
    amount_approved REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    notes TEXT DEFAULT '',
    settled_date TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`);
  // Dependents table (SQLite)
  db.run(`CREATE TABLE IF NOT EXISTS dependents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    relationship TEXT DEFAULT '',
    age INTEGER DEFAULT 0,
    has_coverage INTEGER DEFAULT 0,
    coverage_notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`);

  // Holistic planning tables (SQLite)
  db.run(`CREATE TABLE IF NOT EXISTS client_profile_extended (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT UNIQUE NOT NULL,
    date_of_birth TEXT DEFAULT '',
    nationality TEXT DEFAULT 'Singaporean',
    marital_status TEXT DEFAULT 'single',
    spouse_name TEXT DEFAULT '',
    spouse_age INTEGER DEFAULT 0,
    spouse_occupation TEXT DEFAULT '',
    spouse_income REAL DEFAULT 0,
    children TEXT DEFAULT '[]',
    parents_dependent INTEGER DEFAULT 0,
    parent1_age INTEGER DEFAULT 0,
    parent2_age INTEGER DEFAULT 0,
    retirement_age INTEGER DEFAULT 62,
    target_monthly_income REAL DEFAULT 3000,
    life_expectancy INTEGER DEFAULT 85,
    risk_tolerance INTEGER DEFAULT 3,
    investment_philosophy TEXT DEFAULT 'balanced',
    primary_objective TEXT DEFAULT 'protection',
    has_will INTEGER DEFAULT 0,
    cpf_nomination_done INTEGER DEFAULT 0,
    policy_nomination_done INTEGER DEFAULT 0,
    emergency_fund_months REAL DEFAULT 0,
    property_owned INTEGER DEFAULT 0,
    property_type TEXT DEFAULT '',
    property_value REAL DEFAULT 0,
    rental_income REAL DEFAULT 0,
    education_plans TEXT DEFAULT '[]',
    planner_notes TEXT DEFAULT '',
    updated_at TEXT DEFAULT '',
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS income_streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    label TEXT NOT NULL,
    type TEXT DEFAULT 'rental',
    amount REAL DEFAULT 0,
    frequency TEXT DEFAULT 'monthly',
    start_date TEXT DEFAULT '',
    end_date TEXT DEFAULT '',
    is_retirement_income INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT '',
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS cpf_balances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT UNIQUE NOT NULL,
    oa_balance REAL DEFAULT 0,
    sa_balance REAL DEFAULT 0,
    ma_balance REAL DEFAULT 0,
    ra_balance REAL DEFAULT 0,
    oa_monthly_contrib REAL DEFAULT 0,
    sa_monthly_contrib REAL DEFAULT 0,
    ma_monthly_contrib REAL DEFAULT 0,
    as_of_date TEXT DEFAULT '',
    cpf_life_option TEXT DEFAULT 'standard',
    projected_cpf_life_monthly REAL DEFAULT 0,
    updated_at TEXT DEFAULT '',
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`);

  // Auto-seed admin
  const adminExists = await dbGet(`SELECT id FROM clients WHERE role='admin'`);
  if (!adminExists) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin2026', 10);
    db.run(`INSERT INTO clients (id,username,password_hash,name,role) VALUES ('ADMIN001','admin',?,'Dylan Ho','admin')`, [hash]);
    console.log('✅ Admin user seeded');
  }
  // Auto-seed clients + policies if DB is empty (SQLite local dev)
  await seedIfEmpty(dbGet, dbAll, dbRun);

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
// Security: helmet headers
app.use(helmet({ contentSecurityPolicy: false }));

// Security: CORS locked to known origins
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://finview-dashboard.up.railway.app',
  'http://localhost:3847'
].filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  credentials: true
}));

// Security: rate limit login endpoint
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many login attempts, try again later' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use(express.static(path.join(__dirname, 'public')));

// PWA manifest
app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'FinView Dashboard',
    short_name: 'FinView',
    description: 'Financial planning dashboard for clients and prospects',
    start_url: '/',
    display: 'standalone',
    background_color: '#EEF2FF',
    theme_color: '#0EA5E9',
    orientation: 'portrait-primary',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
    ]
  });
});

// Favicon / icon placeholders to avoid 404s
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/icon-192.png', (req, res) => res.status(204).end());

// Version / health ping — update this to confirm new deploys
app.get('/api/ping', (req, res) => res.json({ ok: true, version: 'v11-2026-06-10', anthropicEnabled: !!process.env.ANTHROPIC_API_KEY, routes: ['expiry-alerts','coverage-gaps','invite','gaps-per-client','coverage-items','needs-analysis','projection','notion-crm-export','pull-from-notion','import-b2b-leads','rolling-dollar'] }));

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

function requireNotAdmin(req, res, next) {
  if (req.user?.role === 'admin') return res.status(403).json({ error: 'Not for admin' });
  next();
}

// ── Auth ───────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', loginLimiter, asyncRoute(async (req, res) => {
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
}));

// ── Admin: List all clients ────────────────────────────────────────────────────
app.get('/api/admin/clients', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const clients = await dbAll(`SELECT id, username, name, age, gender, occupation, annual_income, email, phone, role, created_at FROM clients WHERE role != 'admin' ORDER BY name`);
  const enriched = await Promise.all(clients.map(async c => {
    const r1 = await dbGet('SELECT COUNT(*) as cnt FROM policies WHERE client_id=?', [c.id]);
    const r2 = await dbGet('SELECT SUM(coverage) as total FROM policies WHERE client_id=? AND status=?', [c.id, 'Active']);
    const r3 = await dbGet('SELECT SUM(premium) as total FROM policies WHERE client_id=?', [c.id]);
    const r4 = await dbGet('SELECT SUM(CASE WHEN value_now > 0 THEN value_now ELSE invested END) as total FROM investments WHERE client_id=?', [c.id]);
    return { ...c, policyCount: r1?.cnt || 0, totalCoverage: r2?.total || 0, totalPremium: Math.round((r3?.total || 0) * 100) / 100, totalInvestments: r4?.total || 0 };
  }));
  res.json(enriched);
}));

// ── Admin: Create client ───────────────────────────────────────────────────────
app.post('/api/admin/clients', authenticate, requireAdmin, async (req, res) => {
  const { username, password, name, age, gender, occupation, annual_income, dependents, email, phone, referral_source, referred_by } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'username, password and name required' });
  const roleToCreate = req.body.role === 'prospect' ? 'prospect' : 'client'; // Support prospect role
  try {
    const hash = bcrypt.hashSync(password, 10);
    const id = `C${Date.now()}`;
    await dbRun('INSERT INTO clients (id,username,password_hash,name,age,gender,occupation,annual_income,dependents,email,phone,role,referral_source,referred_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, username, hash, name, age||0, gender||'', occupation||'', annual_income||0, dependents||0, email||'', phone||'', roleToCreate, referral_source||'', referred_by||'']);
    const newClient = await dbGet('SELECT id,username,name,age,gender,occupation,annual_income,email,phone,role,referral_source,referred_by FROM clients WHERE id=?', [id]);
    notionPushClient(newClient).catch(() => {});
    sheetsPushClient(newClient).catch(() => {});
    res.json(newClient);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Admin: Update client ───────────────────────────────────────────────────────
app.put('/api/admin/clients/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const { name, age, gender, occupation, annual_income, dependents, email, phone, password, notes, deal_stage, last_contact, next_action, role, referral_source, referred_by } = req.body;
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    await dbRun(`UPDATE clients SET password_hash=?, updated_at=datetime('now') WHERE id=?`, [hash, req.params.id]);
  }
  // Support role update (prospect -> client conversion)
  if (role && (role === 'client' || role === 'prospect')) {
    await dbRun(`UPDATE clients SET role=?, updated_at=datetime('now') WHERE id=?`, [role, req.params.id]);
  }
  await dbRun(`UPDATE clients SET name=?,age=?,gender=?,occupation=?,annual_income=?,dependents=?,email=?,phone=?,notes=?,deal_stage=?,last_contact=?,next_action=?,referral_source=?,referred_by=?,updated_at=datetime('now') WHERE id=?`,
    [name, age||0, gender||'', occupation||'', annual_income||0, dependents||0, email||'', phone||'',
     notes||'', deal_stage||'Prospect', last_contact||'', next_action||'', referral_source||'', referred_by||'', req.params.id]);
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
}));

// ── Admin: Delete client ───────────────────────────────────────────────────────
app.delete('/api/admin/clients/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  await dbRun('DELETE FROM clients WHERE id=? AND role!=?', [req.params.id, 'admin']);
  res.json({ success: true });
}));

// ── Admin: Stats overview ──────────────────────────────────────────────────────
app.get('/api/admin/stats', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const totalClients = Number((await dbGet(`SELECT COUNT(*) as cnt FROM clients WHERE role='client'`))?.cnt || 0);
  const totalPolicies = Number((await dbGet('SELECT COUNT(*) as cnt FROM policies'))?.cnt || 0);
  const totalCoverage = Number((await dbGet(`SELECT SUM(p.coverage) as total FROM policies p JOIN clients c ON p.client_id=c.id WHERE c.role='client' AND p.status='Active'`))?.total || 0);
  const totalPremium = Math.round(Number((await dbGet(`SELECT SUM(p.premium) as total FROM policies p JOIN clients c ON p.client_id=c.id WHERE c.role='client'`))?.total || 0) * 100) / 100;
  const totalInvestments = Number((await dbGet(`SELECT SUM(CASE WHEN i.value_now > 0 THEN i.value_now ELSE i.invested END) as total FROM investments i JOIN clients c ON i.client_id=c.id WHERE c.role='client'`))?.total || 0);
  res.json({ totalClients, totalPolicies, totalCoverage, totalPremium, totalInvestments });
}));

// ── Admin: Expiry alerts across all clients ────────────────────────────────────
app.get('/api/admin/expiry-alerts', authenticate, requireAdmin, asyncRoute(async (req, res) => {
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
}));

// ── Admin: Coverage gaps across all clients ────────────────────────────────────
app.get('/api/admin/coverage-gaps', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const clients = await dbAll(`SELECT id, name, age, annual_income, dependents, occupation FROM clients WHERE role='client'`);
  const resolved = await Promise.all(clients.map(async c => {
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
      // level1=Critical(<20%), level2=At Risk(20-40%), level3=Below Target(40-70%), level4=Near Target(70-99%), level5=Protected(100%+)
      const status = pct >= 100 ? 'level5' : pct >= 70 ? 'level4' : pct >= 40 ? 'level3' : pct >= 20 ? 'level2' : 'level1';
      return { type, current, recommended, gap, pct, status };
    }).filter(g => g.gap > 0);

    const totalGap = gaps.reduce((s, g) => s + g.gap, 0);
    return { ...c, gaps, totalGap };
  }));
  const result = resolved.filter(c => c.totalGap > 0).sort((a, b) => b.totalGap - a.totalGap);
  res.json(result);
}));

// ── Client: Get profile ────────────────────────────────────────────────────────
app.get('/api/clients/:id', authenticate, asyncRoute(async (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  const c = await dbGet('SELECT id,name,age,gender,occupation,annual_income,dependents,email,phone,role,deal_stage,last_contact,next_action,notes FROM clients WHERE id=?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
}));

app.put('/api/clients/:id', authenticate, asyncRoute(async (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  const { name, age, gender, occupation, annual_income, dependents, email, phone } = req.body;
  await dbRun(`UPDATE clients SET name=?,age=?,gender=?,occupation=?,annual_income=?,dependents=?,email=?,phone=?,updated_at=datetime('now') WHERE id=?`,
    [name, age||0, gender||'', occupation||'', annual_income||0, dependents||0, email||'', phone||'', req.params.id]);
  res.json({ success: true });
}));

// ── Client: Coverage gap analysis ─────────────────────────────────────────────
app.get('/api/clients/:id/coverage-gaps', authenticate, asyncRoute(async (req, res) => {
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
    const status = pct >= 100 ? 'level5' : pct >= 70 ? 'level4' : pct >= 40 ? 'level3' : pct >= 20 ? 'level2' : 'level1';
    return { type, current, recommended, gap, pct, status };
  });

  const totalGap = gaps.reduce((s, g) => s + g.gap, 0);
  const totalRec = gaps.reduce((s, g) => s + g.recommended, 0);
  const totalCurrent = gaps.reduce((s, g) => s + g.current, 0);
  res.json({ gaps, totalGap, totalRec, totalCurrent, income, age, deps });
}));

// ── Policies ───────────────────────────────────────────────────────────────────
function guardClient(req, res) {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) { res.status(403).json({ error: 'Forbidden' }); return false; }
  return true;
}

app.get('/api/clients/:id/policies', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  const rows = await dbAll('SELECT * FROM policies WHERE client_id=? ORDER BY type, created_at', [req.params.id]);
  rows.forEach(r => {
    try { r.coverage_items = JSON.parse(r.coverage_items || '[]'); } catch { r.coverage_items = []; }
    try { r.feature_flags = JSON.parse(r.feature_flags || '[]'); } catch { r.feature_flags = []; }
  });
  res.json(rows);
});

app.post('/api/clients/:id/policies', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const { type, product_name, policy_number, insurer, product_type, coverage_items, premium, start_date, end_date, status, recommended, notes, payment_frequency, cpf_medisave_amount, cash_amount, feature_flags } = req.body;
  const items = Array.isArray(coverage_items) ? coverage_items : [];
  // coverage_items can be [{type,coverage}] objects (new) or strings (legacy)
  // Multi-pay CI can pay out multiple times (separate events) — sum is correct for those.
  // All other policies: mutually exclusive benefits — coverage = max single-event payout.
  const flags = Array.isArray(feature_flags) ? feature_flags : [];
  const isMultiPay = flags.some(f => /multi.?pay/i.test(String(f))) ||
    items.some(i => i && /multi.?pay/i.test(String(i.type || '')));
  const totalCoverage = items.length === 0 ? 0 : (isMultiPay
    ? items.reduce((s, i) => s + (parseFloat(i.coverage) || 0), 0)
    : Math.max(0, ...items.map(i => parseFloat(i.coverage) || 0)));
  const primaryType = items.length > 0 ? (items[0].type || items[0]) : (type || '');
  const itemsJson = JSON.stringify(items);
  const flagsJson = JSON.stringify(Array.isArray(feature_flags) ? feature_flags : []);
  const id = await dbRun('INSERT INTO policies (client_id,type,product_name,policy_number,insurer,product_type,coverage,coverage_items,feature_flags,premium,start_date,end_date,status,recommended,notes,payment_frequency,cpf_medisave_amount,cash_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [req.params.id, primaryType, product_name||'', policy_number||'', insurer||'', product_type||'', totalCoverage||0, itemsJson, flagsJson, premium||0, start_date||'', end_date||'', status||'Active', recommended||0, notes||'', payment_frequency||'annual', cpf_medisave_amount||0, cash_amount||0]);
  const row = await dbGet('SELECT * FROM policies WHERE id=?', [id]);
  if (row) {
    try { row.coverage_items = JSON.parse(row.coverage_items || '[]'); } catch { row.coverage_items = []; }
    try { row.feature_flags = JSON.parse(row.feature_flags || '[]'); } catch { row.feature_flags = []; }
  }
  res.json(row);
}));

app.put('/api/clients/:id/policies/:pid', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const body = req.body;
  // Recompute coverage from coverage_items if provided
  if (Array.isArray(body.coverage_items)) {
    const hasObjects = body.coverage_items.some(i => i !== null && typeof i === 'object' && 'coverage' in i);
    if (hasObjects) {
      // Modal format: [{type, coverage}] — update coverage totals
      const objectItems = body.coverage_items.filter(i => i && typeof i === 'object' && 'coverage' in i);
      // Multi-pay CI stacks (separate events); all other policies: mutually exclusive = max payout
      const putFlags = Array.isArray(body.feature_flags) ? body.feature_flags : [];
      const putIsMultiPay = putFlags.some(f => /multi.?pay/i.test(String(f))) ||
        objectItems.some(i => /multi.?pay/i.test(String(i.type || '')));
      body.coverage = objectItems.length === 0 ? 0 : (putIsMultiPay
        ? objectItems.reduce((s, i) => s + (parseFloat(i.coverage) || 0), 0)
        : Math.max(0, ...objectItems.map(i => parseFloat(i.coverage) || 0)));
      body.type = objectItems[0]?.type || '';
      body.coverage_items = JSON.stringify(body.coverage_items);
    } else {
      // String-only IDs (feature-flag checklist) — do NOT overwrite coverage/type
      delete body.coverage;
      delete body.type;
      delete body.coverage_items; // skip coverage_items update entirely
    }
  }
  // Handle feature_flags update (JSON array of string IDs)
  if (Array.isArray(body.feature_flags)) {
    body.feature_flags = JSON.stringify(body.feature_flags);
  }
  const f = ['type','product_name','policy_number','insurer','product_type','coverage','coverage_items','feature_flags','premium','start_date','end_date','status','recommended','notes','payment_frequency','cpf_medisave_amount','cash_amount'];
  const sets = [], vals = [];
  const jsonFields = new Set(['coverage_items','feature_flags']);
  f.forEach(k => { if (body[k] !== undefined) { sets.push(`${k}=?`); vals.push(body[k]); } });
  if (sets.length) { vals.push(req.params.pid, req.params.id); await dbRun(`UPDATE policies SET ${sets.join(',')} WHERE id=? AND client_id=?`, vals); }
  const row = await dbGet('SELECT * FROM policies WHERE id=?', [req.params.pid]);
  if (row) {
    try { row.coverage_items = JSON.parse(row.coverage_items || '[]'); } catch { row.coverage_items = []; }
    try { row.feature_flags = JSON.parse(row.feature_flags || '[]'); } catch { row.feature_flags = []; }
  }
  res.json(row);
}));

app.delete('/api/clients/:id/policies/:pid', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  await dbRun('DELETE FROM policies WHERE id=? AND client_id=?', [req.params.pid, req.params.id]);
  res.json({ success: true });
}));

// ── Investments ────────────────────────────────────────────────────────────────
app.get('/api/clients/:id/investments', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  res.json(await dbAll('SELECT * FROM investments WHERE client_id=? ORDER BY created_at', [req.params.id]));
}));

app.post('/api/clients/:id/investments', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const { name, type, invested, value_now, target, goal_by, contribution, investment_subtype, payment_frequency, growth_rate_assumption, start_date, maturity_date, guaranteed_return, projected_return, premium_type, term_years, units_held, nav_price, fund_name, irr, break_even_year, notes, payout_start, payout_end, payout_monthly, surrender_value, total_paid, policy_number } = req.body;
  const id = await dbRun('INSERT INTO investments (client_id,name,type,invested,value_now,target,goal_by,contribution,investment_subtype,payment_frequency,growth_rate_assumption,start_date,maturity_date,guaranteed_return,projected_return,premium_type,term_years,units_held,nav_price,fund_name,irr,break_even_year,notes,payout_start,payout_end,payout_monthly,surrender_value,total_paid,policy_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [req.params.id, name||'', type||'', invested||0, value_now||0, target||0, goal_by||'', contribution||0, investment_subtype||'', payment_frequency||'annual', growth_rate_assumption||0, start_date||'', maturity_date||'', guaranteed_return||0, projected_return||0, premium_type||'regular', term_years||0, units_held||0, nav_price||0, fund_name||'', irr||0, break_even_year||0, notes||'', payout_start||'', payout_end||'', payout_monthly||0, surrender_value||0, total_paid||0, policy_number||'']);
  res.json(await dbGet('SELECT * FROM investments WHERE id=?', [id]));
}));

app.put('/api/clients/:id/investments/:iid', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const f = ['name','type','invested','value_now','target','goal_by','contribution','investment_subtype','payment_frequency','growth_rate_assumption','start_date','maturity_date','guaranteed_return','projected_return','premium_type','term_years','units_held','nav_price','fund_name','irr','break_even_year','notes','payout_start','payout_end','payout_monthly','surrender_value','total_paid','policy_number'];
  const sets = [], vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { sets.push(`${k}=?`); vals.push(req.body[k]); } });
  if (sets.length) { vals.push(req.params.iid, req.params.id); await dbRun(`UPDATE investments SET ${sets.join(',')} WHERE id=? AND client_id=?`, vals); }
  res.json(await dbGet('SELECT * FROM investments WHERE id=?', [req.params.iid]));
}));

app.delete('/api/clients/:id/investments/:iid', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  await dbRun('DELETE FROM investments WHERE id=? AND client_id=?', [req.params.iid, req.params.id]);
  res.json({ success: true });
}));

// ── DCA Entries ────────────────────────────────────────────────────────────────
// Helper to recalculate investment totals from DCA entries
async function recalcDcaTotals(investmentId) {
  const entries = await dbAll('SELECT amount, units, nav, entry_date FROM dca_entries WHERE investment_id=? ORDER BY entry_date DESC', [investmentId]);
  const totalInvested = entries.reduce((s, e) => s + (e.amount || 0), 0);
  const totalUnits = entries.reduce((s, e) => s + (e.units || 0), 0);
  const latestNav = entries.length > 0 ? (entries[0].nav || 0) : 0;
  await dbRun('UPDATE investments SET invested=?, units_held=?, nav_price=? WHERE id=?', [totalInvested, totalUnits, latestNav, investmentId]);
}

app.get('/api/clients/:id/investments/:iid/dca', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  // Verify investment belongs to client
  const inv = await dbGet('SELECT id FROM investments WHERE id=? AND client_id=?', [req.params.iid, req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Investment not found' });
  res.json(await dbAll('SELECT * FROM dca_entries WHERE investment_id=? ORDER BY entry_date DESC', [req.params.iid]));
}));

app.post('/api/clients/:id/investments/:iid/dca', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const inv = await dbGet('SELECT id FROM investments WHERE id=? AND client_id=?', [req.params.iid, req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Investment not found' });
  const { entry_date, amount, units, nav, notes } = req.body;
  const id = await dbRun('INSERT INTO dca_entries (investment_id,entry_date,amount,units,nav,notes) VALUES (?,?,?,?,?,?)',
    [req.params.iid, entry_date||'', amount||0, units||0, nav||0, notes||'']);
  await recalcDcaTotals(req.params.iid);
  res.json(await dbGet('SELECT * FROM dca_entries WHERE id=?', [id]));
}));

app.put('/api/clients/:id/investments/:iid/dca/:did', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const inv = await dbGet('SELECT id FROM investments WHERE id=? AND client_id=?', [req.params.iid, req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Investment not found' });
  const f = ['entry_date','amount','units','nav','notes'];
  const sets = [], vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { sets.push(`${k}=?`); vals.push(req.body[k]); } });
  if (sets.length) { vals.push(req.params.did, req.params.iid); await dbRun(`UPDATE dca_entries SET ${sets.join(',')} WHERE id=? AND investment_id=?`, vals); }
  await recalcDcaTotals(req.params.iid);
  res.json(await dbGet('SELECT * FROM dca_entries WHERE id=?', [req.params.did]));
}));

app.delete('/api/clients/:id/investments/:iid/dca/:did', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const inv = await dbGet('SELECT id FROM investments WHERE id=? AND client_id=?', [req.params.iid, req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Investment not found' });
  await dbRun('DELETE FROM dca_entries WHERE id=? AND investment_id=?', [req.params.did, req.params.iid]);
  await recalcDcaTotals(req.params.iid);
  res.json({ success: true });
}));

// ── Snapshots ──────────────────────────────────────────────────────────────────
app.get('/api/clients/:id/snapshots', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  res.json(await dbAll('SELECT * FROM snapshots WHERE client_id=? ORDER BY year', [req.params.id]));
}));

app.post('/api/clients/:id/snapshots', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const { year, snapshot_date, total_coverage, total_investment_value, notes } = req.body;
  const id = await dbRun('INSERT OR REPLACE INTO snapshots (client_id,year,snapshot_date,total_coverage,total_investment_value,notes) VALUES (?,?,?,?,?,?)',
    [req.params.id, year, snapshot_date||'', total_coverage||0, total_investment_value||0, notes||'']);
  res.json({ id, year, total_coverage, total_investment_value });
}));

app.post('/api/clients/:id/snapshots/auto', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const year = new Date().getFullYear();
  const policies = await dbAll('SELECT coverage FROM policies WHERE client_id=? AND status=?', [req.params.id, 'Active']);
  const investments = await dbAll('SELECT value_now FROM investments WHERE client_id=?', [req.params.id]);
  const tc = policies.reduce((s, p) => s + (p.coverage || 0), 0);
  const ti = investments.reduce((s, i) => s + (i.value_now || 0), 0);
  await dbRun(`INSERT OR REPLACE INTO snapshots (client_id,year,snapshot_date,total_coverage,total_investment_value,notes) VALUES (?,?,date('now'),?,?,'Auto snapshot')`,
    [req.params.id, year, tc, ti]);
  res.json({ year, total_coverage: tc, total_investment_value: ti });
}));

// ── Invite Tokens ──────────────────────────────────────────────────────────────
app.post('/api/admin/clients/:id/invite', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const clientId = req.params.id;
  // Support invite for both client and prospect roles
  const client = await dbGet('SELECT id, username, name, role FROM clients WHERE id=? AND role IN (?,?)', [clientId, 'client', 'prospect']);
  if (!client) return res.status(404).json({ error: 'Client or prospect not found' });

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
}));

// Resolve invite token → return client credentials info (not password)
app.get('/api/invite/:token', asyncRoute(async (req, res) => {
  const row = await dbGet('SELECT * FROM invite_tokens WHERE token=?', [req.params.token]);
  if (!row) return res.status(404).json({ error: 'Invalid or expired invite link' });
  if (row.used) return res.status(410).json({ error: 'This invite link has already been used' });
  if (row.expires_at && new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'This invite link has expired' });
  const client = await dbGet('SELECT id, name, username FROM clients WHERE id=?', [row.client_id]);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json({ client, expires: row.expires_at });
}));

// ── Prospect Profile Endpoints ──────────────────────────────────────────────────
app.get('/api/prospect/:id/profile', authenticate, asyncRoute(async (req, res) => {
  // Admin or own prospect can view
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  const p = await dbGet('SELECT id,name,age,gender,occupation,annual_income,dependents,email,phone,notes,role FROM clients WHERE id=? AND role=?', [req.params.id, 'prospect']);
  if (!p) return res.status(404).json({ error: 'Prospect not found' });
  res.json(p);
}));

app.put('/api/prospect/:id/profile', authenticate, asyncRoute(async (req, res) => {
  // Only own prospect can update
  if (req.user.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  const existing = await dbGet('SELECT role FROM clients WHERE id=?', [req.params.id]);
  if (!existing || existing.role !== 'prospect') return res.status(403).json({ error: 'Only prospects can update via this endpoint' });
  const { name, age, gender, occupation, annual_income, dependents, email, phone } = req.body;
  await dbRun(`UPDATE clients SET name=?,age=?,gender=?,occupation=?,annual_income=?,dependents=?,email=?,phone=?,updated_at=datetime('now') WHERE id=?`,
    [name||'', age||0, gender||'', occupation||'', annual_income||0, dependents||0, email||'', phone||'', req.params.id]);
  res.json({ success: true });
}));

// ── CPF Calculator (public, no auth needed) ──────────────────────────────────
app.get('/api/cpf/calculate', (req, res) => {
  const age = parseInt(req.query.age) || 30;
  const annualIncome = parseFloat(req.query.income) || 60000;
  const bonusMonths = parseFloat(req.query.bonus) || 1;
  const yearsToProject = parseInt(req.query.years) || 35;
  const initOA = parseFloat(req.query.oa) || 0;
  const initSA = parseFloat(req.query.sa) || 0;
  const initMA = parseFloat(req.query.ma) || 0;

  // CPF contribution rates by age band [employee%, employer%]
  function getRates(a) {
    if (a <= 35) return [0.20, 0.17];
    if (a <= 45) return [0.19, 0.15];
    if (a <= 50) return [0.18, 0.13];
    if (a <= 55) return [0.15, 0.13];
    if (a <= 60) return [0.115, 0.105];
    if (a <= 65) return [0.09, 0.085];
    return [0.075, 0.06];
  }

  // OA/SA/MA allocation by age
  function getAlloc(a) {
    if (a <= 35) return [0.6217, 0.1621, 0.2162];
    if (a <= 45) return [0.5677, 0.1891, 0.2432];
    if (a <= 50) return [0.5136, 0.2162, 0.2702];
    if (a <= 55) return [0.4025, 0.3108, 0.2867];
    if (a <= 60) return [0.0000, 0.6800, 0.3200];
    if (a <= 65) return [0.0000, 0.7143, 0.2857];
    return [0.0000, 0.7143, 0.2857];
  }

  const CPF_CEILING = 6000; // monthly ceiling
  const OA_INTEREST = 0.025;
  const SA_INTEREST = 0.04;
  const MA_INTEREST = 0.04;
  const EXTRA_RATE = 0.01; // extra 1% on first $20k OA + first $40k SA
  const FRS = 205800, BRS = 102900, ERS = 308700;

  let oa = initOA, sa = initSA, ma = initMA;
  const projections = [];
  const totalMonthlyIncome = (annualIncome * (1 + bonusMonths / 12)) / 12;
  const cappedMonthly = Math.min(totalMonthlyIncome, CPF_CEILING);

  let summary55 = null, summary60 = null, summary65 = null;

  for (let y = 0; y < yearsToProject; y++) {
    const currentAge = age + y;
    if (currentAge > 65) break;

    const [empRate, erRate] = getRates(currentAge);
    const [oaAlloc, saAlloc, maAlloc] = getAlloc(currentAge);
    const totalRate = empRate + erRate;
    const annualContrib = cappedMonthly * 12 * totalRate;

    oa += annualContrib * oaAlloc;
    sa += annualContrib * saAlloc;
    ma += annualContrib * maAlloc;

    // Interest (simplified annual)
    const oaInterest = oa * OA_INTEREST + Math.min(oa, 20000) * EXTRA_RATE;
    const saInterest = sa * SA_INTEREST + Math.min(sa + oa, 40000) * EXTRA_RATE;
    const maInterest = ma * MA_INTEREST;

    oa += oaInterest;
    sa += saInterest;
    ma += maInterest;

    projections.push({
      age: currentAge + 1,
      year: y + 1,
      oa: Math.round(oa),
      sa: Math.round(sa),
      ma: Math.round(ma),
      total: Math.round(oa + sa + ma),
      annual_contribution: Math.round(annualContrib)
    });

    if (currentAge + 1 === 55) summary55 = { oa: Math.round(oa), sa: Math.round(sa), ma: Math.round(ma), total: Math.round(oa + sa + ma) };
    if (currentAge + 1 === 60) summary60 = { oa: Math.round(oa), sa: Math.round(sa), ma: Math.round(ma), total: Math.round(oa + sa + ma) };
    if (currentAge + 1 === 65) summary65 = { oa: Math.round(oa), sa: Math.round(sa), ma: Math.round(ma), total: Math.round(oa + sa + ma) };
  }

  const finalAge65 = summary65 || projections[projections.length - 1] || { oa: 0, sa: 0, ma: 0, total: 0 };
  const rsType = finalAge65.sa >= ERS ? 'Above ERS' : finalAge65.sa >= FRS ? 'FRS' : finalAge65.sa >= BRS ? 'BRS' : 'Below BRS';
  const monthlyPayout = Math.round((Math.min(finalAge65.sa, FRS) * 0.065) / 12);

  res.json({
    projections,
    summary: {
      at55: summary55,
      at60: summary60,
      at65: summary65,
      retirement_sum_type: rsType,
      monthly_payout_estimate: monthlyPayout,
      frs: FRS,
      brs: BRS,
      ers: ERS
    },
    input: { age, income: annualIncome, bonus: bonusMonths, years: yearsToProject }
  });
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

// ── Google Sheets Push ───────────────────────────────────────────────────────
const { spawnSync: _spawnSync } = require('child_process');
const SHEETS_SYNC_SCRIPT = '/Users/dylanho/.openclaw/workspace/scripts/finview-sheets-sync.js';

async function sheetsPushClient(client) {
  // Fire-and-forget: push new client to Google Sheets via sync script
  try {
    const state = (() => { try { return JSON.parse(require('fs').readFileSync('/Users/dylanho/.openclaw/workspace/scripts/finview-sheets-state.json','utf8')); } catch { return {}; } })();
    if (!state.sheetId) return; // Sheet not initialised yet — skip silently
    _spawnSync(process.execPath, [SHEETS_SYNC_SCRIPT, '--direction=to-sheets'], {
      timeout: 30000, detached: true, stdio: 'ignore'
    });
  } catch {}
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


// ── Expiry Alerts: Telegram Notify ───────────────────────────────────────────
async function sendExpiryAlertsTelegram() {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8633895902:AAHOkhez6N1XW3fM0sM1b78NvQBupOOZcFQ';
  const TELEGRAM_CHAT_ID = '8193595101';

  const days = 90;
  const today = new Date();
  const cutoff = new Date(today); cutoff.setDate(today.getDate() + days);
  const todayStr = today.toISOString().split('T')[0];
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const policies = await dbAll(`
    SELECT p.*, c.name as client_name, c.email as client_email, c.phone as client_phone
    FROM policies p JOIN clients c ON p.client_id = c.id
    WHERE c.role != 'admin' AND p.end_date != '' AND p.end_date >= ? AND p.end_date <= ? AND p.status = 'Active'
    ORDER BY p.end_date ASC
  `, [todayStr, cutoffStr]);

  if (!policies.length) return { sent: false, count: 0 };

  const tagged = policies.map(p => {
    const daysLeft = Math.ceil((new Date(p.end_date) - today) / (1000 * 60 * 60 * 24));
    const urgency = daysLeft <= 14 ? 'critical' : daysLeft <= 30 ? 'high' : daysLeft <= 60 ? 'medium' : 'low';
    return { ...p, days_left: daysLeft, urgency };
  });

  const critical = tagged.filter(p => p.urgency === 'critical');
  const high = tagged.filter(p => p.urgency === 'high');
  const medium = tagged.filter(p => p.urgency === 'medium');

  const fmt = arr => arr.map(p => `  • ${p.client_name}: ${p.product_name||p.type} (${p.days_left}d)`).join('\n');
  let msg = '⚠️ FinView Expiry Alert\n';
  if (critical.length) msg += `\n🔴 Critical (≤14d):\n${fmt(critical)}`;
  if (high.length) msg += `\n🟠 High (≤30d):\n${fmt(high)}`;
  if (medium.length) msg += `\n🟡 Medium (≤60d):\n${fmt(medium)}`;
  msg += `\n\nTotal: ${tagged.length} policies`;

  await new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.write(body); req.end();
  });

  return { sent: true, count: tagged.length };
}

app.post('/api/admin/expiry-alerts/notify', authenticate, requireAdmin, async (req, res) => {
  try { res.json(await sendExpiryAlertsTelegram()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/expiry-alerts/notify', authenticate, requireAdmin, async (req, res) => {
  try { res.json(await sendExpiryAlertsTelegram()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Dashboard Overview Chart Data ─────────────────────────────────────────────
app.get('/api/admin/overview', authenticate, requireAdmin, async (req, res) => {
  try {
    const clients = await dbAll(`SELECT id, deal_stage FROM clients WHERE role='client'`);
    const policies = await dbAll(`SELECT p.coverage, p.premium, p.type, c.deal_stage FROM policies p JOIN clients c ON p.client_id=c.id WHERE c.role='client' AND p.status='Active'`);

    const coverage_by_stage = {};
    const premium_by_type = {};
    for (const p of policies) {
      const stage = p.deal_stage || 'Unknown';
      coverage_by_stage[stage] = (coverage_by_stage[stage] || 0) + Number(p.coverage || 0);
      const t = p.type || 'Other';
      premium_by_type[t] = (premium_by_type[t] || 0) + Number(p.premium || 0);
    }

    // Top clients by total coverage
    const clientIds = clients.map(c => c.id);
    const topClients = [];
    for (const c of clients.slice(0, 20)) {
      const r1 = await dbGet(`SELECT SUM(coverage) as cov, SUM(premium) as prem FROM policies WHERE client_id=? AND status='Active'`, [c.id]);
      const nameRow = await dbGet(`SELECT name FROM clients WHERE id=?`, [c.id]);
      topClients.push({ name: nameRow?.name || c.id, coverage: Number(r1?.cov || 0), premium: Number(r1?.prem || 0) });
    }
    topClients.sort((a, b) => b.coverage - a.coverage);

    res.json({ coverage_by_stage, premium_by_type, top_clients: topClients.slice(0, 10) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Backup & Restore ───────────────────────────────────────────────────────────
app.get('/api/admin/backup', authenticate, requireAdmin, async (req, res) => {
  try {
    const clients = await dbAll(`SELECT id, username, name, age, gender, occupation, annual_income, dependents, email, phone, role, notion_page_id, referral_source, referred_by, created_at, updated_at FROM clients WHERE role='client'`);
    const policies = await dbAll(`SELECT * FROM policies`);
    const investments = await dbAll(`SELECT * FROM investments`);
    const snapshots = await dbAll(`SELECT * FROM snapshots`);
    const dca_entries = await dbAll(`SELECT * FROM dca_entries`);
    const commissions = await dbAll(`SELECT * FROM commissions`);
    const backup = {
      version: 3,
      exported_at: new Date().toISOString(),
      counts: { clients: clients.length, policies: policies.length, investments: investments.length, snapshots: snapshots.length, dca_entries: dca_entries.length, commissions: commissions.length },
      clients, policies, investments, snapshots, dca_entries, commissions
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="finview-backup-${new Date().toISOString().slice(0,10)}.json"`);
    res.json(backup);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/restore', authenticate, requireAdmin, async (req, res) => {
  try {
    const { clients = [], policies = [], investments = [], snapshots = [], dca_entries = [], commissions = [] } = req.body;
    if (!Array.isArray(clients)) return res.status(400).json({ error: 'Invalid backup format' });

    let imported = { clients: 0, policies: 0, investments: 0, snapshots: 0, dca_entries: 0, commissions: 0, skipped: 0 };

    // Restore clients (skip admin, skip duplicates by id)
    for (const c of clients) {
      if (c.role === 'admin') continue;
      const exists = await dbGet('SELECT id FROM clients WHERE id=?', [c.id]);
      if (exists) { imported.skipped++; continue; }
      try {
        await dbRun(`INSERT INTO clients (id,username,password_hash,name,age,gender,occupation,annual_income,dependents,email,phone,role,notion_page_id,notes,deal_stage,last_contact,next_action,referral_source,referred_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [c.id, c.username, c.password_hash, c.name, c.age||0, c.gender||'', c.occupation||'', c.annual_income||0,
           c.dependents||0, c.email||'', c.phone||'', c.role||'client', c.notion_page_id||'',
           c.notes||'', c.deal_stage||'Prospect', c.last_contact||'', c.next_action||'',
           c.referral_source||'', c.referred_by||'',
           c.created_at||new Date().toISOString(), c.updated_at||new Date().toISOString()]);
        imported.clients++;
      } catch (e) { imported.skipped++; }
    }

    // Restore policies (upsert by original id if numeric — re-insert otherwise)
    for (const p of policies) {
      const clientExists = await dbGet('SELECT id FROM clients WHERE id=?', [p.client_id]);
      if (!clientExists) { imported.skipped++; continue; }
      try {
        const polSql = USE_POSTGRES
          ? `INSERT INTO policies (id,client_id,type,product_name,insurer,product_type,coverage,premium,start_date,end_date,status,recommended,notes,policy_number,coverage_items,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`
          : `INSERT OR IGNORE INTO policies (id,client_id,type,product_name,insurer,product_type,coverage,premium,start_date,end_date,status,recommended,notes,policy_number,coverage_items,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
        await dbRun(polSql,
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
        const invSql = USE_POSTGRES
          ? `INSERT INTO investments (id,client_id,name,type,invested,value_now,target,goal_by,contribution,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`
          : `INSERT OR IGNORE INTO investments (id,client_id,name,type,invested,value_now,target,goal_by,contribution,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
        await dbRun(invSql,
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
        const snapSql = USE_POSTGRES
          ? `INSERT INTO snapshots (id,client_id,year,snapshot_date,total_coverage,total_investment_value,notes,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`
          : `INSERT OR IGNORE INTO snapshots (id,client_id,year,snapshot_date,total_coverage,total_investment_value,notes,created_at) VALUES (?,?,?,?,?,?,?,?)`;
        await dbRun(snapSql,
          [s.id, s.client_id, s.year, s.snapshot_date||'', s.total_coverage||0,
           s.total_investment_value||0, s.notes||'', s.created_at||new Date().toISOString()]);
        imported.snapshots++;
      } catch (e) { imported.skipped++; }
    }

    // Restore DCA entries (after investments so FKs are satisfied)
    for (const d of dca_entries) {
      const invExists = await dbGet('SELECT id FROM investments WHERE id=?', [d.investment_id]);
      if (!invExists) { imported.skipped++; continue; }
      try {
        const dcaSql = USE_POSTGRES
          ? `INSERT INTO dca_entries (id,investment_id,entry_date,amount,units,nav,notes,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`
          : `INSERT OR IGNORE INTO dca_entries (id,investment_id,entry_date,amount,units,nav,notes,created_at) VALUES (?,?,?,?,?,?,?,?)`;
        await dbRun(dcaSql,
          [d.id, d.investment_id, d.entry_date||'', d.amount||0, d.units||0, d.nav||0, d.notes||'', d.created_at||new Date().toISOString()]);
        imported.dca_entries++;
      } catch (e) { imported.skipped++; }
    }

    // Restore commissions
    for (const cm of commissions) {
      const clientExists = await dbGet('SELECT id FROM clients WHERE id=?', [cm.client_id]);
      if (!clientExists) { imported.skipped++; continue; }
      try {
        const commSql = USE_POSTGRES
          ? `INSERT INTO commissions (id,client_id,policy_id,product_name,insurer,commission_type,amount,expected_date,received_date,status,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`
          : `INSERT OR IGNORE INTO commissions (id,client_id,policy_id,product_name,insurer,commission_type,amount,expected_date,received_date,status,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`;
        await dbRun(commSql,
          [cm.id, cm.client_id, cm.policy_id||null, cm.product_name||'', cm.insurer||'', cm.commission_type||'first_year',
           cm.amount||0, cm.expected_date||'', cm.received_date||'', cm.status||'pending', cm.notes||'',
           cm.created_at||new Date().toISOString(), cm.updated_at||new Date().toISOString()]);
        imported.commissions++;
      } catch (e) { imported.skipped++; }
    }

    if (!USE_POSTGRES) saveDb();

    // Reset PostgreSQL sequences after restore so next INSERT doesn't collide
    if (USE_POSTGRES) {
      await dbRun(`SELECT setval('policies_id_seq', COALESCE((SELECT MAX(id) FROM policies), 0) + 1, false)`);
      await dbRun(`SELECT setval('investments_id_seq', COALESCE((SELECT MAX(id) FROM investments), 0) + 1, false)`);
      await dbRun(`SELECT setval('snapshots_id_seq', COALESCE((SELECT MAX(id) FROM snapshots), 0) + 1, false)`);
      try { await dbRun(`SELECT setval('dca_entries_id_seq', COALESCE((SELECT MAX(id) FROM dca_entries), 0) + 1, false)`); } catch {}
      try { await dbRun(`SELECT setval('commissions_id_seq', COALESCE((SELECT MAX(id) FROM commissions), 0) + 1, false)`); } catch {}
    }

    res.json({ success: true, imported });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Recalculate Coverage Totals ────────────────────────────────────────────────
app.post('/api/admin/recalculate-coverage', authenticate, asyncRoute(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const policies = await dbAll('SELECT id, coverage_items, feature_flags FROM policies', []);
  let updated = 0, skipped = 0;
  for (const pol of policies) {
    let items = [];
    try { items = JSON.parse(pol.coverage_items || '[]'); } catch { items = []; }
    const hasObjects = Array.isArray(items) && items.some(i => i && typeof i === 'object' && 'coverage' in i);
    if (!hasObjects) { skipped++; continue; }
    let flags = [];
    try { flags = JSON.parse(pol.feature_flags || '[]'); } catch { flags = []; }
    const objectItems = items.filter(i => i && typeof i === 'object' && 'coverage' in i);
    const isMultiPay = (Array.isArray(flags) && flags.some(f => /multi.?pay/i.test(String(f)))) ||
      objectItems.some(i => /multi.?pay/i.test(String(i.type || '')));
    const newCoverage = objectItems.length === 0 ? 0 : (isMultiPay
      ? objectItems.reduce((s, i) => s + (parseFloat(i.coverage) || 0), 0)
      : Math.max(0, ...objectItems.map(i => parseFloat(i.coverage) || 0)));
    await dbRun('UPDATE policies SET coverage=? WHERE id=?', [newCoverage, pol.id]);
    updated++;
  }
  res.json({ success: true, updated, skipped, total: policies.length });
}));

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

app.get('/api/pipeline', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const stages = ['Prospect','Contacted','Proposal Sent','Negotiation','Closed Won','Closed Lost'];
  const result = {};
  await Promise.all(stages.map(async s => {
    result[s] = await dbAll(`SELECT id, name, annual_income, age, deal_stage, last_contact, next_action FROM clients WHERE deal_stage=? AND role='client' ORDER BY name`, [s]);
  }));
  res.json({ stages, pipeline: result });
}));

// ── Commissions CRUD ────────────────────────────────────────────────────────────
app.get('/api/admin/commissions', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const { year, status } = req.query;
  let sql = `SELECT c.*, cl.name as client_name FROM commissions c LEFT JOIN clients cl ON c.client_id = cl.id`;
  const conditions = [], params = [];
  if (year) { conditions.push(`strftime('%Y', COALESCE(c.received_date, c.expected_date)) = ?`); params.push(year); }
  if (status) { conditions.push(`c.status = ?`); params.push(status); }
  if (conditions.length) sql += ` WHERE ` + conditions.join(' AND ');
  sql += ` ORDER BY COALESCE(c.received_date, c.expected_date) DESC`;
  const rows = await dbAll(sql, params);
  res.json(rows);
}));

app.get('/api/admin/commissions/summary', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const currentYear = new Date().getFullYear();
  const all = await dbAll(`SELECT * FROM commissions`);
  const ytd = all.filter(c => {
    const d = c.received_date || c.expected_date;
    return d && new Date(d).getFullYear() === currentYear;
  });
  const received = ytd.filter(c => c.status === 'received').reduce((s, c) => s + (c.amount || 0), 0);
  const pending = ytd.filter(c => c.status === 'pending').reduce((s, c) => s + (c.amount || 0), 0);
  const clawback = ytd.filter(c => c.status === 'clawback').reduce((s, c) => s + (c.amount || 0), 0);
  
  // Monthly breakdown
  const months = [];
  for (let m = 0; m < 12; m++) {
    const monthReceived = all.filter(c => {
      if (c.status !== 'received' || !c.received_date) return false;
      const d = new Date(c.received_date);
      return d.getFullYear() === currentYear && d.getMonth() === m;
    }).reduce((s, c) => s + (c.amount || 0), 0);
    const monthPending = all.filter(c => {
      if (c.status !== 'pending' || !c.expected_date) return false;
      const d = new Date(c.expected_date);
      return d.getFullYear() === currentYear && d.getMonth() === m;
    }).reduce((s, c) => s + (c.amount || 0), 0);
    months.push({ month: m, received: monthReceived, pending: monthPending });
  }
  
  res.json({ received, pending, clawback, months });
}));

app.post('/api/admin/commissions', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const { client_id, policy_id, product_name, insurer, commission_type, amount, expected_date, received_date, status, notes } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  const id = await dbRun(
    `INSERT INTO commissions (client_id, policy_id, product_name, insurer, commission_type, amount, expected_date, received_date, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [client_id, policy_id || null, product_name || '', insurer || '', commission_type || 'first_year', amount || 0, expected_date || '', received_date || '', status || 'pending', notes || '']
  );
  res.json({ success: true, id });
}));

app.put('/api/admin/commissions/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const { client_id, policy_id, product_name, insurer, commission_type, amount, expected_date, received_date, status, notes } = req.body;
  const fields = [], vals = [];
  if (client_id !== undefined) { fields.push('client_id=?'); vals.push(client_id); }
  if (policy_id !== undefined) { fields.push('policy_id=?'); vals.push(policy_id); }
  if (product_name !== undefined) { fields.push('product_name=?'); vals.push(product_name); }
  if (insurer !== undefined) { fields.push('insurer=?'); vals.push(insurer); }
  if (commission_type !== undefined) { fields.push('commission_type=?'); vals.push(commission_type); }
  if (amount !== undefined) { fields.push('amount=?'); vals.push(amount); }
  if (expected_date !== undefined) { fields.push('expected_date=?'); vals.push(expected_date); }
  if (received_date !== undefined) { fields.push('received_date=?'); vals.push(received_date); }
  if (status !== undefined) { fields.push('status=?'); vals.push(status); }
  if (notes !== undefined) { fields.push('notes=?'); vals.push(notes); }
  if (!fields.length) return res.json({ success: true });
  fields.push('updated_at=?'); vals.push(new Date().toISOString());
  vals.push(req.params.id);
  await dbRun(`UPDATE commissions SET ${fields.join(',')} WHERE id=?`, vals);
  res.json({ success: true });
}));

app.delete('/api/admin/commissions/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  await dbRun(`DELETE FROM commissions WHERE id=?`, [req.params.id]);
  res.json({ success: true });
}));

// ── Referral Stats ─────────────────────────────────────────────────────────────
app.get('/api/admin/referrals/stats', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const clients = await dbAll(`SELECT id, name, referral_source, referred_by, deal_stage FROM clients WHERE role='client'`);
  
  // Sources breakdown
  const sourceMap = {};
  clients.forEach(c => {
    const src = c.referral_source || 'Unknown';
    if (!sourceMap[src]) sourceMap[src] = { source: src, count: 0, converted: 0 };
    sourceMap[src].count++;
    if (c.deal_stage === 'Closed Won') sourceMap[src].converted++;
  });
  const sources = Object.values(sourceMap).sort((a, b) => b.count - a.count);
  
  // Top referrers
  const referrerMap = {};
  clients.forEach(c => {
    if (c.referred_by) {
      if (!referrerMap[c.referred_by]) referrerMap[c.referred_by] = { name: c.referred_by, count: 0 };
      referrerMap[c.referred_by].count++;
    }
  });
  const topReferrers = Object.values(referrerMap).sort((a, b) => b.count - a.count).slice(0, 10);
  
  res.json({ sources, topReferrers });
}));

// ── Needs Analysis CRUD ────────────────────────────────────────────────────────
app.get('/api/clients/:id/needs-analysis', authenticate, async (req, res) => {
  if (!guardClient(req, res)) return;
  const rows = await dbAll('SELECT * FROM needs_analysis WHERE client_id=? ORDER BY coverage_type', [req.params.id]);
  rows.forEach(r => { try { r.sources = JSON.parse(r.sources || '[]'); } catch { r.sources = []; } });
  res.json(rows);
});

app.post('/api/clients/:id/needs-analysis', authenticate, asyncRoute(async (req, res) => {
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
}));

app.put('/api/clients/:id/needs-analysis/:nid', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const { recommended_amount, current_amount, gap, rationale, priority, sources } = req.body;
  const sourcesJson = JSON.stringify(Array.isArray(sources) ? sources : []);
  await dbRun(`UPDATE needs_analysis SET recommended_amount=?,current_amount=?,gap=?,rationale=?,priority=?,sources=?,updated_at=datetime('now') WHERE id=? AND client_id=?`,
    [recommended_amount||0, current_amount||0, gap||0, rationale||'', priority||'medium', sourcesJson, req.params.nid, req.params.id]);
  const row = await dbGet('SELECT * FROM needs_analysis WHERE id=?', [req.params.nid]);
  if (row) { try { row.sources = JSON.parse(row.sources || '[]'); } catch { row.sources = []; } }
  res.json(row);
}));

app.delete('/api/clients/:id/needs-analysis/:nid', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  await dbRun('DELETE FROM needs_analysis WHERE id=? AND client_id=?', [req.params.nid, req.params.id]);
  res.json({ success: true });
}));

// ── Documents (Secure Vault) ────────────────────────────────────────────────────────────────
app.get('/api/clients/:id/documents', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const docs = await dbAll('SELECT * FROM documents WHERE client_id=? ORDER BY created_at DESC', [req.params.id]);
  res.json(docs);
}));

app.post('/api/clients/:id/documents', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const { name, file_type, file_size, category, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Document name required' });
  const id = await dbRun(
    'INSERT INTO documents (client_id, name, file_type, file_size, category, notes, uploaded_by) VALUES (?,?,?,?,?,?,?)',
    [req.params.id, name, file_type || 'pdf', file_size || 0, category || 'other', notes || '', req.user?.role || 'admin']
  );
  res.json({ success: true, id });
}));

app.delete('/api/clients/:id/documents/:did', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  await dbRun('DELETE FROM documents WHERE id=? AND client_id=?', [req.params.did, req.params.id]);
  res.json({ success: true });
}));

// ── Net Worth Tracker ────────────────────────────────────────────────────────────────
app.get('/api/clients/:id/networth', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const items = await dbAll('SELECT * FROM net_worth_items WHERE client_id=? ORDER BY category, name', [req.params.id]);
  const assets = items.filter(i => i.category === 'asset').reduce((s, i) => s + (i.amount || 0), 0);
  const liabilities = items.filter(i => i.category === 'liability').reduce((s, i) => s + (i.amount || 0), 0);
  res.json({ items, summary: { assets, liabilities, net_worth: assets - liabilities } });
}));

app.post('/api/clients/:id/networth', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const { category = 'asset', name, amount = 0, as_of_date = '', notes = '' } = req.body;
  const id = await dbRun(
    'INSERT INTO net_worth_items (client_id, category, name, amount, as_of_date, notes) VALUES (?,?,?,?,?,?)',
    [req.params.id, category, name || 'Unnamed', amount, as_of_date, notes]
  );
  res.json({ success: true, id });
}));

app.put('/api/clients/:id/networth/:nwid', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const { category, name, amount, as_of_date, notes } = req.body;
  const fields = [], vals = [];
  if (category !== undefined) { fields.push(`category=?`); vals.push(category); }
  if (name !== undefined) { fields.push(`name=?`); vals.push(name); }
  if (amount !== undefined) { fields.push(`amount=?`); vals.push(amount); }
  if (as_of_date !== undefined) { fields.push(`as_of_date=?`); vals.push(as_of_date); }
  if (notes !== undefined) { fields.push(`notes=?`); vals.push(notes); }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
  fields.push(`updated_at=datetime('now')`);
  vals.push(req.params.nwid, req.params.id);
  await dbRun(`UPDATE net_worth_items SET ${fields.join(',')} WHERE id=? AND client_id=?`, vals);
  res.json({ success: true });
}));

app.delete('/api/clients/:id/networth/:nwid', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  await dbRun('DELETE FROM net_worth_items WHERE id=? AND client_id=?', [req.params.nwid, req.params.id]);
  res.json({ success: true });
}));

// ── Financial Goals ───────────────────────────────────────────────────────────────────
app.get('/api/clients/:id/goals', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const goals = await dbAll('SELECT * FROM goals WHERE client_id=? ORDER BY target_date', [req.params.id]);
  res.json(goals);
}));

app.post('/api/clients/:id/goals', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const { name, target_amount = 0, current_amount = 0, target_date = '', category = 'general', notes = '' } = req.body;
  const id = await dbRun(
    'INSERT INTO goals (client_id, name, target_amount, current_amount, target_date, category, notes) VALUES (?,?,?,?,?,?,?)',
    [req.params.id, name || 'New Goal', target_amount, current_amount, target_date, category, notes]
  );
  res.json({ success: true, id });
}));

app.put('/api/clients/:id/goals/:gid', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const { name, target_amount, current_amount, target_date, category, notes, status } = req.body;
  const fields = [], vals = [];
  if (name !== undefined) { fields.push(`name=?`); vals.push(name); }
  if (target_amount !== undefined) { fields.push(`target_amount=?`); vals.push(target_amount); }
  if (current_amount !== undefined) { fields.push(`current_amount=?`); vals.push(current_amount); }
  if (target_date !== undefined) { fields.push(`target_date=?`); vals.push(target_date); }
  if (category !== undefined) { fields.push(`category=?`); vals.push(category); }
  if (notes !== undefined) { fields.push(`notes=?`); vals.push(notes); }
  if (status !== undefined) { fields.push(`status=?`); vals.push(status); }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
  fields.push(`updated_at=datetime('now')`);
  vals.push(req.params.gid, req.params.id);
  await dbRun(`UPDATE goals SET ${fields.join(',')} WHERE id=? AND client_id=?`, vals);
  res.json({ success: true });
}));

app.delete('/api/clients/:id/goals/:gid', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  await dbRun('DELETE FROM goals WHERE id=? AND client_id=?', [req.params.gid, req.params.id]);
  res.json({ success: true });
}));

// ── Cashflow Tracker ─────────────────────────────────────────────────────────────────
app.get('/api/clients/:id/cashflow', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const { month } = req.query; // YYYY-MM format
  let sql = 'SELECT * FROM cashflow_entries WHERE client_id=?';
  const params = [req.params.id];
  if (month) { sql += ` AND entry_date LIKE ?`; params.push(`${month}%`); }
  sql += ' ORDER BY entry_date DESC';
  const entries = await dbAll(sql, params);
  const income = entries.filter(e => e.type === 'income').reduce((s, e) => s + (e.amount || 0), 0);
  const expenses = entries.filter(e => e.type === 'expense').reduce((s, e) => s + (e.amount || 0), 0);
  res.json({ entries, summary: { income, expenses, net: income - expenses } });
}));

app.post('/api/clients/:id/cashflow', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const { type = 'expense', category = 'other', description = '', amount = 0, entry_date = '', recurring = 0, frequency = 'monthly', notes = '' } = req.body;
  const id = await dbRun(
    'INSERT INTO cashflow_entries (client_id, type, category, description, amount, entry_date, recurring, frequency, notes) VALUES (?,?,?,?,?,?,?,?,?)',
    [req.params.id, type, category, description, amount, entry_date, recurring ? 1 : 0, frequency, notes]
  );
  res.json({ success: true, id });
}));

app.put('/api/clients/:id/cashflow/:cfid', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const { type, category, description, amount, entry_date, recurring, frequency, notes } = req.body;
  const fields = [], vals = [];
  if (type !== undefined) { fields.push(`type=?`); vals.push(type); }
  if (category !== undefined) { fields.push(`category=?`); vals.push(category); }
  if (description !== undefined) { fields.push(`description=?`); vals.push(description); }
  if (amount !== undefined) { fields.push(`amount=?`); vals.push(amount); }
  if (entry_date !== undefined) { fields.push(`entry_date=?`); vals.push(entry_date); }
  if (recurring !== undefined) { fields.push(`recurring=?`); vals.push(recurring ? 1 : 0); }
  if (frequency !== undefined) { fields.push(`frequency=?`); vals.push(frequency); }
  if (notes !== undefined) { fields.push(`notes=?`); vals.push(notes); }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
  fields.push(`updated_at=datetime('now')`);
  vals.push(req.params.cfid, req.params.id);
  await dbRun(`UPDATE cashflow_entries SET ${fields.join(',')} WHERE id=? AND client_id=?`, vals);
  res.json({ success: true });
}));

app.delete('/api/clients/:id/cashflow/:cfid', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  await dbRun('DELETE FROM cashflow_entries WHERE id=? AND client_id=?', [req.params.cfid, req.params.id]);
  res.json({ success: true });
}));

// ── Cashflow Analysis (Excel Upload) ─────────────────────────────────────────────────

function parseCashflowExcel(buffer) {
  const wb = xlsx.read(buffer, { type: 'buffer' });

  // Parse Comments sheet for structured data
  const ws = wb.Sheets['Comments'] || wb.Sheets[wb.SheetNames[1]] || wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null });

  const result = {
    client: { name: '', dob: '', consultant: '', presentationDate: '', employmentStatus: '' },
    income: [],
    expenses: [],
    loans: [],
    insurance: [],
    savings: [],
    others: [],
    cpf: { oa: 0, sa: 0, ma: 0 },
    summary: { netIncome: 0, totalInsurance: 0, totalSavings: 0, totalExpenses: 0, totalLoans: 0, totalOthers: 0, netCashflow: 0 }
  };

  // Skip header row (row 0)
  for (let i = 1; i < rows.length; i++) {
    const [category, item, frequency, rawInput, monthly, annual, comment] = rows[i] || [];
    if (!category) continue;
    const cat = String(category).trim();
    const monthlyVal = parseFloat(monthly) || 0;
    const annualVal = parseFloat(annual) || 0;
    const commentStr = comment ? String(comment).trim() : '';
    const itemStr = item ? String(item).trim() : '';

    if (cat === 'Client') {
      if (itemStr === 'Client Name') result.client.name = commentStr;
      else if (itemStr === 'Date of Birth') result.client.dob = commentStr;
      else if (itemStr === 'Consultant') result.client.consultant = commentStr;
      else if (itemStr === 'Presentation Date') result.client.presentationDate = commentStr;
      else if (itemStr === 'Employment Status') result.client.employmentStatus = commentStr;
    } else if (cat === 'Income') {
      result.income.push({ item: itemStr, monthly: monthlyVal, annual: annualVal, comment: commentStr });
    } else if (cat === 'Personal Expense') {
      result.expenses.push({ item: itemStr, monthly: monthlyVal, annual: annualVal, comment: commentStr });
    } else if (cat === 'Loan Liability') {
      result.loans.push({ item: itemStr, monthly: monthlyVal, annual: annualVal, comment: commentStr });
    } else if (cat === 'Insurance') {
      result.insurance.push({ item: itemStr, monthly: monthlyVal, annual: annualVal, comment: commentStr });
    } else if (cat === 'Savings Contribution') {
      result.savings.push({ item: itemStr, monthly: monthlyVal, annual: annualVal, comment: commentStr });
    } else if (['Other', 'Others', 'Miscellaneous', 'Misc', 'Other Income', 'Other Expense', 'Other Expenses', 'Miscellaneous Income', 'Miscellaneous Expense'].includes(cat)) {
      result.others.push({ item: itemStr, monthly: monthlyVal, annual: annualVal, comment: commentStr });
    }
  }

  // Parse CPF from Sheet1 (rows 8-11)
  const ws1 = wb.Sheets['Sheet1'] || wb.Sheets[wb.SheetNames[0]];
  if (ws1) {
    const s1rows = xlsx.utils.sheet_to_json(ws1, { header: 1, defval: null });
    for (let i = 0; i < s1rows.length; i++) {
      const row = s1rows[i];
      if (!row || row[0] == null) continue;
      const label = String(row[0]).toLowerCase();
      if (label.includes('ordinary')) result.cpf.oa = parseFloat(row[1]) || 0;
      else if (label.includes('special')) result.cpf.sa = parseFloat(row[1]) || 0;
      else if (label.includes('medisave')) result.cpf.ma = parseFloat(row[1]) || 0;
    }
  }

  // Calculate summary
  const totalIncome  = result.income.reduce((s, r) => s + r.monthly, 0);
  const totalIns     = result.insurance.reduce((s, r) => s + r.monthly, 0);
  const totalSav     = result.savings.reduce((s, r) => s + r.monthly, 0);
  const totalExp     = result.expenses.reduce((s, r) => s + r.monthly, 0);
  const totalLoans   = result.loans.reduce((s, r) => s + r.monthly, 0);
  const totalOthers  = result.others.reduce((s, r) => s + r.monthly, 0);
  result.summary = {
    netIncome: totalIncome,
    totalInsurance: totalIns,
    totalSavings: totalSav,
    totalExpenses: totalExp,
    totalLoans: totalLoans,
    totalOthers: totalOthers,
    netCashflow: totalIncome - totalIns - totalSav - totalExp - totalLoans - totalOthers
  };

  return result;
}

// Upload cashflow Excel
app.post('/api/clients/:id/cashflow/upload', authenticate, requireAdmin, upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const clientId = req.params.id;
  const parsed = parseCashflowExcel(req.file.buffer);
  const presentationDate = parsed.client.presentationDate || new Date().toISOString().slice(0, 10);

  // Delete previous analysis for this client (keep only latest)
  await dbRun('DELETE FROM cashflow_analyses WHERE client_id=?', [clientId]);

  // Insert new
  await dbRun(
    'INSERT INTO cashflow_analyses (client_id, filename, presentation_date, parsed_data) VALUES (?,?,?,?)',
    [clientId, req.file.originalname, presentationDate, JSON.stringify(parsed)]
  );

  res.json({ success: true, parsed });
}));

// Get cashflow analysis for client
app.get('/api/clients/:id/cashflow/analysis', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const row = await dbGet('SELECT * FROM cashflow_analyses WHERE client_id=? ORDER BY uploaded_at DESC LIMIT 1', [req.params.id]);
  if (!row) return res.json({ analysis: null });
  const parsed = typeof row.parsed_data === 'string' ? JSON.parse(row.parsed_data) : row.parsed_data;
  res.json({ analysis: { ...row, parsed_data: parsed } });
}));

// Delete cashflow analysis
app.delete('/api/clients/:id/cashflow/analysis', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  await dbRun('DELETE FROM cashflow_analyses WHERE client_id=?', [req.params.id]);
  res.json({ success: true });
}));

// ── AI Needs Analysis ──────────────────────────────────────────────────────────────────
app.post('/api/admin/clients/:id/ai-analysis', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const clientId = req.params.id;
  const client = await dbGet('SELECT * FROM clients WHERE id=?', [clientId]);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const policies = await dbAll('SELECT * FROM policies WHERE client_id=? AND status=?', [clientId, 'Active']);
  const investments = await dbAll('SELECT * FROM investments WHERE client_id=?', [clientId]);
  const needs = await dbAll('SELECT * FROM needs_analysis WHERE client_id=?', [clientId]);

  const totalCoverage = policies.reduce((s, p) => s + (p.coverage || 0), 0);
  const totalPremium = policies.reduce((s, p) => s + (p.premium || 0), 0);
  const totalInvested = investments.reduce((s, i) => s + (i.invested || 0), 0);
  const totalValue = investments.reduce((s, i) => s + (i.value_now || 0), 0);

  const prompt = `You are a Singapore financial planning expert. Analyse this client and provide a structured needs analysis.

Client Profile:
- Name: ${client.name}, Age: ${client.age}, Gender: ${client.gender || '—'}
- Occupation: ${client.occupation}, Annual Income: S$${(client.annual_income || 0).toLocaleString()}
- Dependents: ${client.dependents || 0}

Current Protection:
- Total Life/TPD Coverage: S$${totalCoverage.toLocaleString()}
- Annual Premium: S$${totalPremium.toLocaleString()}
- Policy types: ${[...new Set(policies.map(p => p.type))].join(', ') || 'None'}

Current Investments:
- Total Invested: S$${totalInvested.toLocaleString()}
- Portfolio Value: S$${totalValue.toLocaleString()}

Needs Analysis Summary:
${needs.length > 0 ? needs.map(n => `- ${n.coverage_type}: current S$${(n.current_amount || 0).toLocaleString()}, recommended S$${(n.recommended_amount || 0).toLocaleString()}, gap S$${(n.gap || 0).toLocaleString()}`).join('\n') : 'Not yet assessed'}

Singapore context: MAS guidelines, CPF integration, relevant insurers (AIA, Prudential, Manulife, Great Eastern, NTUC Income, Aviva/Singlife).

Provide a structured analysis in this JSON format:
{
  "overall_health": "good|fair|needs_attention",
  "health_score": 0-100,
  "summary": "2-3 sentence executive summary",
  "strengths": ["list of 2-3 financial strengths"],
  "gaps": [{"area": "coverage type", "severity": "critical|high|medium|low", "current": amount, "recommended": amount, "gap": amount, "action": "specific recommendation"}],
  "recommendations": ["3-5 specific actionable recommendations"],
  "next_steps": ["2-3 concrete next steps"]
}`;

  try {
    const { Anthropic } = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY });
    const msg = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });
    const content = msg.content[0]?.text || '{}';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: content };
    res.json({ success: true, analysis, client: { name: client.name, id: client.id } });
  } catch (e) {
    // Fallback: rule-based analysis if AI unavailable
    const income = client.annual_income || 50000;
    const lifeNeeded = income * 10;
    const lifeGap = Math.max(0, lifeNeeded - totalCoverage);
    res.json({
      success: true,
      analysis: {
        overall_health: totalCoverage >= lifeNeeded * 0.8 ? 'good' : totalCoverage >= lifeNeeded * 0.5 ? 'fair' : 'needs_attention',
        health_score: Math.min(100, Math.round((totalCoverage / lifeNeeded) * 60 + (totalValue > 0 ? 40 : 0))),
        summary: `${client.name} has S$${totalCoverage.toLocaleString()} in coverage against a recommended S$${lifeNeeded.toLocaleString()} (10x income). ${lifeGap > 0 ? `There is a coverage gap of S$${lifeGap.toLocaleString()}.` : 'Coverage appears adequate.'}`,
        gaps: lifeGap > 0 ? [{ area: 'Life/TPD Coverage', severity: 'high', current: totalCoverage, recommended: lifeNeeded, gap: lifeGap, action: `Increase life and TPD coverage by S$${lifeGap.toLocaleString()}` }] : [],
        recommendations: ['Review and update coverage annually', 'Consider supplementing CPF with voluntary top-ups', 'Diversify investment portfolio with DCA strategies'],
        next_steps: ['Schedule annual policy review', 'Run CPF projection to check retirement readiness']
      },
      fallback: true
    });
  }
}));

// ── Investment Projection ──────────────────────────────────────────────────────
app.get('/api/clients/:id/investments/:iid/projection', authenticate, asyncRoute(async (req, res) => {
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
}));

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
app.post('/api/bootstrap', asyncRoute(async (req, res) => {
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
}));


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

// ── Reviews CRUD ────────────────────────────────────────────────────────────────
app.get('/api/clients/:id/reviews', authenticate, asyncRoute(async (req, res) => {
  const rows = await dbAll('SELECT * FROM reviews WHERE client_id=? ORDER BY review_date DESC', [req.params.id]);
  res.json(rows);
}));
app.post('/api/clients/:id/reviews', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const { review_date, next_review_date, meeting_type, notes, action_items } = req.body || {};
  if (!review_date) return res.status(400).json({ error: 'review_date required' });
  const id = await dbRun(
    'INSERT INTO reviews (client_id,review_date,next_review_date,meeting_type,notes,action_items,created_by) VALUES (?,?,?,?,?,?,?)',
    [req.params.id, review_date, next_review_date||null, meeting_type||'annual_review', notes||'', action_items||'', req.user.username||'admin']
  );
  res.json({ id });
}));
app.put('/api/clients/:id/reviews/:rid', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const { review_date, next_review_date, meeting_type, notes, action_items } = req.body || {};
  await dbRun(
    'UPDATE reviews SET review_date=?,next_review_date=?,meeting_type=?,notes=?,action_items=? WHERE id=? AND client_id=?',
    [review_date, next_review_date||null, meeting_type||'annual_review', notes||'', action_items||'', req.params.rid, req.params.id]
  );
  res.json({ ok: true });
}));
app.delete('/api/clients/:id/reviews/:rid', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  await dbRun('DELETE FROM reviews WHERE id=? AND client_id=?', [req.params.rid, req.params.id]);
  res.json({ ok: true });
}));

// ── Beneficiaries CRUD ────────────────────────────────────────────────────────
app.get('/api/clients/:id/beneficiaries', authenticate, asyncRoute(async (req, res) => {
  const rows = await dbAll('SELECT * FROM beneficiaries WHERE client_id=? ORDER BY id', [req.params.id]);
  res.json(rows);
}));
app.post('/api/clients/:id/beneficiaries', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const { name, relationship, percentage, ic_number, contact, policy_id, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = await dbRun(
    'INSERT INTO beneficiaries (client_id,policy_id,name,relationship,percentage,ic_number,contact,notes) VALUES (?,?,?,?,?,?,?,?)',
    [req.params.id, policy_id||null, name, relationship||'', percentage||100, ic_number||'', contact||'', notes||'']
  );
  res.json({ id });
}));
app.put('/api/clients/:id/beneficiaries/:bid', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const { name, relationship, percentage, ic_number, contact, policy_id, notes } = req.body || {};
  await dbRun(
    'UPDATE beneficiaries SET name=?,relationship=?,percentage=?,ic_number=?,contact=?,policy_id=?,notes=? WHERE id=? AND client_id=?',
    [name, relationship||'', percentage||100, ic_number||'', contact||'', policy_id||null, notes||'', req.params.bid, req.params.id]
  );
  res.json({ ok: true });
}));
app.delete('/api/clients/:id/beneficiaries/:bid', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  await dbRun('DELETE FROM beneficiaries WHERE id=? AND client_id=?', [req.params.bid, req.params.id]);
  res.json({ ok: true });
}));

// ── Claims CRUD ───────────────────────────────────────────────────────────────
app.get('/api/clients/:id/claims', authenticate, asyncRoute(async (req, res) => {
  const rows = await dbAll('SELECT * FROM claims WHERE client_id=? ORDER BY claim_date DESC', [req.params.id]);
  res.json(rows);
}));
app.post('/api/clients/:id/claims', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const { claim_date, claim_type, amount_claimed, amount_approved, status, notes, settled_date, policy_id } = req.body || {};
  if (!claim_date) return res.status(400).json({ error: 'claim_date required' });
  const id = await dbRun(
    'INSERT INTO claims (client_id,policy_id,claim_date,claim_type,amount_claimed,amount_approved,status,notes,settled_date) VALUES (?,?,?,?,?,?,?,?,?)',
    [req.params.id, policy_id||null, claim_date, claim_type||'', amount_claimed||0, amount_approved||0, status||'pending', notes||'', settled_date||null]
  );
  res.json({ id });
}));
app.put('/api/clients/:id/claims/:cid', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const { claim_date, claim_type, amount_claimed, amount_approved, status, notes, settled_date, policy_id } = req.body || {};
  await dbRun(
    'UPDATE claims SET claim_date=?,claim_type=?,amount_claimed=?,amount_approved=?,status=?,notes=?,settled_date=?,policy_id=? WHERE id=? AND client_id=?',
    [claim_date, claim_type||'', amount_claimed||0, amount_approved||0, status||'pending', notes||'', settled_date||null, policy_id||null, req.params.cid, req.params.id]
  );
  res.json({ ok: true });
}));
app.delete('/api/clients/:id/claims/:cid', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  await dbRun('DELETE FROM claims WHERE id=? AND client_id=?', [req.params.cid, req.params.id]);
  res.json({ ok: true });
}));

// ── Dependents CRUD ───────────────────────────────────────────────────────────
app.get('/api/clients/:id/dependents', authenticate, asyncRoute(async (req, res) => {
  const rows = await dbAll('SELECT * FROM dependents WHERE client_id=? ORDER BY id', [req.params.id]);
  res.json(rows);
}));
app.post('/api/clients/:id/dependents', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const { name, relationship, age, has_coverage, coverage_notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = await dbRun(
    'INSERT INTO dependents (client_id,name,relationship,age,has_coverage,coverage_notes) VALUES (?,?,?,?,?,?)',
    [req.params.id, name, relationship||'', age||0, has_coverage||0, coverage_notes||'']
  );
  res.json({ id });
}));
app.put('/api/clients/:id/dependents/:did', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const { name, relationship, age, has_coverage, coverage_notes } = req.body || {};
  await dbRun(
    'UPDATE dependents SET name=?,relationship=?,age=?,has_coverage=?,coverage_notes=? WHERE id=? AND client_id=?',
    [name, relationship||'', age||0, has_coverage||0, coverage_notes||'', req.params.did, req.params.id]
  );
  res.json({ ok: true });
}));
app.delete('/api/clients/:id/dependents/:did', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  await dbRun('DELETE FROM dependents WHERE id=? AND client_id=?', [req.params.did, req.params.id]);
  res.json({ ok: true });
}));

// ── Extended Profile Routes ────────────────────────────────────────────────────
app.get('/api/clients/:id/profile-extended', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const row = await dbGet('SELECT * FROM client_profile_extended WHERE client_id=?', [req.params.id]);
  res.json({ profile: row || null });
}));

app.post('/api/clients/:id/profile-extended', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const cid = req.params.id;
  const d = req.body;
  const existing = await dbGet('SELECT id FROM client_profile_extended WHERE client_id=?', [cid]);
  const fields = ['date_of_birth','nationality','marital_status','spouse_name','spouse_age','spouse_occupation','spouse_income','children','parents_dependent','parent1_age','parent2_age','retirement_age','target_monthly_income','life_expectancy','risk_tolerance','investment_philosophy','primary_objective','has_will','cpf_nomination_done','policy_nomination_done','emergency_fund_months','property_owned','property_type','property_value','rental_income','education_plans','planner_notes'];
  const now = new Date().toISOString();
  if (existing) {
    const sets = fields.map(f => `${f}=?`).join(',') + ',updated_at=?';
    const vals = [...fields.map(f => d[f] !== undefined ? d[f] : null), now, cid];
    await dbRun(`UPDATE client_profile_extended SET ${sets} WHERE client_id=?`, vals);
  } else {
    const cols = ['client_id', ...fields, 'updated_at'].join(',');
    const phs = Array(fields.length + 2).fill('?').join(',');
    await dbRun(`INSERT INTO client_profile_extended (${cols}) VALUES (${phs})`, [cid, ...fields.map(f => d[f] !== undefined ? d[f] : null), now]);
  }
  res.json({ success: true });
}));

// ── Income Streams Routes ──────────────────────────────────────────────────────
app.get('/api/clients/:id/income-streams', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const rows = await dbAll('SELECT * FROM income_streams WHERE client_id=? ORDER BY created_at DESC', [req.params.id]);
  res.json(rows || []);
}));

app.post('/api/clients/:id/income-streams', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const cid = req.params.id;
  const { label, type, amount, frequency, start_date, end_date, is_retirement_income, notes } = req.body;
  const now = new Date().toISOString();
  if (!label) return res.status(400).json({ error: 'label required' });
  await dbRun('INSERT INTO income_streams (client_id, label, type, amount, frequency, start_date, end_date, is_retirement_income, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [cid, label, type||'rental', amount||0, frequency||'monthly', start_date||'', end_date||'', is_retirement_income?1:0, notes||'', now]);
  res.json({ success: true });
}));

app.put('/api/clients/:id/income-streams/:sid', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const { label, type, amount, frequency, start_date, end_date, is_retirement_income, notes } = req.body;
  await dbRun('UPDATE income_streams SET label=?,type=?,amount=?,frequency=?,start_date=?,end_date=?,is_retirement_income=?,notes=? WHERE id=? AND client_id=?',
    [label, type, amount||0, frequency, start_date||'', end_date||'', is_retirement_income?1:0, notes||'', req.params.sid, req.params.id]);
  res.json({ success: true });
}));

app.delete('/api/clients/:id/income-streams/:sid', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  await dbRun('DELETE FROM income_streams WHERE id=? AND client_id=?', [req.params.sid, req.params.id]);
  res.json({ success: true });
}));

// ── CPF Balances ──────────────────────────────────────────────────────────────
function guardClient(req, res) {
  const role = req.user?.role;
  const uid = req.user?.id;
  const cid = req.params.id;
  if (role === 'admin') return true;
  if (uid === cid) return true;
  res.status(403).json({ error: 'Forbidden' });
  return false;
}

app.get('/api/clients/:id/cpf-balances', authenticate, asyncRoute(async (req, res) => {
  if (!guardClient(req, res)) return;
  const row = await dbGet('SELECT * FROM cpf_balances WHERE client_id=?', [req.params.id]);
  res.json({ cpf: row || null });
}));

app.post('/api/clients/:id/cpf-balances', authenticate, asyncRoute(async (req, res) => {
  const role = req.user?.role;
  if (role !== 'admin') { res.status(403).json({ error: 'Forbidden' }); return; }
  const cid = req.params.id;
  const d = req.body;
  const now = new Date().toISOString();
  const clientRow = await dbGet('SELECT age FROM clients WHERE id=?', [cid]);
  const clientAge = clientRow?.age || 30;
  const yearsTo65 = Math.max(0, 65 - clientAge);
  const currentSA = parseFloat(d.sa_balance) || 0;
  const saContrib = parseFloat(d.sa_monthly_contrib) || 0;
  const r = 0.04 / 12;
  const n = yearsTo65 * 12;
  const projectedSA = n > 0 ? currentSA * Math.pow(1 + r, n) + saContrib * (Math.pow(1 + r, n) - 1) / r : currentSA;
  const FRS_2025 = 205800;
  const cpfLifeMonthly = Math.min(projectedSA, FRS_2025) / 240 + Math.max(0, projectedSA - FRS_2025) / 360;
  const projectedCpfLife = Math.round(cpfLifeMonthly);
  const existing = await dbGet('SELECT id FROM cpf_balances WHERE client_id=?', [cid]);
  if (existing) {
    await dbRun('UPDATE cpf_balances SET oa_balance=?,sa_balance=?,ma_balance=?,ra_balance=?,oa_monthly_contrib=?,sa_monthly_contrib=?,ma_monthly_contrib=?,as_of_date=?,cpf_life_option=?,projected_cpf_life_monthly=?,updated_at=? WHERE client_id=?',
      [d.oa_balance||0, d.sa_balance||0, d.ma_balance||0, d.ra_balance||0, d.oa_monthly_contrib||0, d.sa_monthly_contrib||0, d.ma_monthly_contrib||0, d.as_of_date||now.slice(0,10), d.cpf_life_option||'standard', projectedCpfLife, now, cid]);
  } else {
    await dbRun('INSERT INTO cpf_balances (client_id,oa_balance,sa_balance,ma_balance,ra_balance,oa_monthly_contrib,sa_monthly_contrib,ma_monthly_contrib,as_of_date,cpf_life_option,projected_cpf_life_monthly,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [cid, d.oa_balance||0, d.sa_balance||0, d.ma_balance||0, d.ra_balance||0, d.oa_monthly_contrib||0, d.sa_monthly_contrib||0, d.ma_monthly_contrib||0, d.as_of_date||now.slice(0,10), d.cpf_life_option||'standard', projectedCpfLife, now]);
  }
  res.json({ success: true, projectedCpfLife });
}));

// ── Pre-Meeting AI Brief ───────────────────────────────────────────────────────
app.post('/api/admin/clients/:id/meeting-brief', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const cid = req.params.id;
  const [client, policies, investments, reviews, goals, cashflowAnalysis, extProfile, cpfBalances, incomeStreams, beneficiaries, claims] = await Promise.all([
    dbGet('SELECT * FROM clients WHERE id=?', [cid]),
    dbAll('SELECT * FROM policies WHERE client_id=? ORDER BY start_date DESC', [cid]),
    dbAll('SELECT * FROM investments WHERE client_id=?', [cid]),
    dbAll('SELECT * FROM reviews WHERE client_id=? ORDER BY review_date DESC LIMIT 5', [cid]),
    dbAll('SELECT * FROM goals WHERE client_id=?', [cid]),
    dbGet('SELECT * FROM cashflow_analyses WHERE client_id=? ORDER BY uploaded_at DESC LIMIT 1', [cid]).catch(()=>null),
    dbGet('SELECT * FROM client_profile_extended WHERE client_id=?', [cid]).catch(()=>null),
    dbGet('SELECT * FROM cpf_balances WHERE client_id=?', [cid]).catch(()=>null),
    dbAll('SELECT * FROM income_streams WHERE client_id=?', [cid]).catch(()=>[]),
    dbAll('SELECT * FROM beneficiaries WHERE client_id=?', [cid]).catch(()=>[]),
    dbAll('SELECT * FROM claims WHERE client_id=?', [cid]).catch(()=>[]),
  ]);
  if (!client) { res.status(404).json({ error: 'Client not found' }); return; }
  const activePolicies = (policies||[]).filter(p => p.status === 'Active');
  const expiringPolicies = (policies||[]).filter(p => {
    if (!p.end_date) return false;
    const days = Math.ceil((new Date(p.end_date) - new Date()) / 86400000);
    return days >= 0 && days <= 180;
  });
  const lastReview = (reviews||[])[0];
  const daysSinceReview = lastReview ? Math.ceil((new Date() - new Date(lastReview.review_date)) / 86400000) : null;
  const today = new Date().toLocaleDateString('en-SG', { day: '2-digit', month: 'long', year: 'numeric' });
  const prompt = `You are a CFP (Certified Financial Planner) helping Dylan Ho, a Prudential financial consultant in Singapore, prepare for a client meeting.

Generate a concise, professional pre-meeting brief for this client. Be specific, data-driven, and actionable. Write as if briefing a senior advisor.

CLIENT: ${client.name}
Age: ${client.age} | Occupation: ${client.occupation || 'Unknown'} | Income: SGD ${(client.annual_income||0).toLocaleString()}/yr | Dependents: ${client.dependents || 0}

LAST REVIEW: ${lastReview ? `${lastReview.review_date} (${daysSinceReview} days ago). Notes: ${lastReview.notes || 'None recorded'}` : 'No review on record'}

ACTIVE POLICIES (${activePolicies.length}):
${activePolicies.map(p => `- ${p.product_name || p.type}: ${p.coverage ? `$${p.coverage.toLocaleString()} coverage` : ''}, $${(p.premium || 0).toLocaleString()}/yr premium, ends ${p.end_date || 'ongoing'}`).join('\n') || 'None'}

EXPIRING SOON:
${expiringPolicies.map(p => `- ${p.product_name}: expires ${p.end_date} (${Math.ceil((new Date(p.end_date) - new Date()) / 86400000)} days)`).join('\n') || 'None in next 180 days'}

INVESTMENTS:
${(investments||[]).map(i => `- ${i.name}: invested $${(i.invested || 0).toLocaleString()}, current value $${(i.value_now || 0).toLocaleString()}`).join('\n') || 'None'}

GOALS:
${(goals||[]).map(g => `- ${g.name}: target $${(g.target_amount || 0).toLocaleString()}, saved $${(g.current_amount || 0).toLocaleString()} (${g.target_date ? 'due ' + g.target_date : 'no date'})`).join('\n') || 'None set'}

CPF: ${cpfBalances ? `OA: $${(cpfBalances.oa_balance||0).toLocaleString()}, SA: $${(cpfBalances.sa_balance||0).toLocaleString()}, MA: $${(cpfBalances.ma_balance||0).toLocaleString()}. Projected CPF Life: ~$${(cpfBalances.projected_cpf_life_monthly||0).toLocaleString()}/mo` : 'Not recorded'}

INCOME STREAMS: ${(incomeStreams||[]).length ? incomeStreams.map(s => `${s.label}: $${s.amount}/mo (${s.is_retirement_income ? 'retirement income' : 'current only'})`).join(', ') : 'None beyond employment'}

CLAIMS HISTORY: ${(claims||[]).length ? claims.map(c => `${c.claim_type}: $${(c.amount_approved||0).toLocaleString()} (${c.status})`).join(', ') : 'No claims on record'}

Generate a meeting brief with these EXACT sections:

## 📋 Meeting Brief — ${client.name}
**Prepared:** ${today} | **Meeting Type:** Annual Review

### 🔍 Situation Summary (2-3 sentences)
[Honest assessment of where this client stands financially]

### ✅ What's Going Well
[2-3 specific positives based on data]

### ⚠️ Key Issues to Address
[Top 3 specific concerns, numbered, with data to support each]

### 💼 Recommended Discussion Points
[3-4 specific topics to raise in this meeting, with talking points]

### 🎯 Suggested Next Actions
[2-3 concrete recommendations Dylan could propose today, with brief rationale]

### ❓ Questions to Ask the Client
[3-4 open questions to understand their current situation better]

### 📝 Admin Reminders
[Any policy renewals due, documentation gaps, beneficiary updates needed, etc.]

Be direct, specific, and professional. No fluff. Write for an experienced FA.`;
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  });
  const brief = message.content[0].text;
  res.json({ brief, clientName: client.name, generatedAt: new Date().toISOString() });
}));

// ── Client Priority Matrix ─────────────────────────────────────────────────────
app.get('/api/admin/clients/priority-matrix', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const clients = await dbAll('SELECT * FROM clients WHERE role != \'admin\'', []);
  const expiryRows = await dbAll('SELECT client_id, end_date FROM policies WHERE end_date IS NOT NULL AND end_date != \'\'', []);
  const reviewRows = await dbAll('SELECT client_id, review_date FROM reviews ORDER BY review_date DESC', []);
  const lastReviews = {};
  for (const r of reviewRows) { if (!lastReviews[r.client_id]) lastReviews[r.client_id] = r.review_date; }
  const now = new Date();
  const matrix = clients.map(c => {
    let urgency = 0;
    const clientExpiry = expiryRows.filter(p => p.client_id === c.id);
    const expiryDays = clientExpiry.map(p => Math.ceil((new Date(p.end_date) - now) / 86400000)).filter(d => d >= 0);
    const daysToExpiry = expiryDays.length ? Math.min(...expiryDays) : 999;
    if (daysToExpiry <= 14) urgency += 40;
    else if (daysToExpiry <= 30) urgency += 25;
    else if (daysToExpiry <= 90) urgency += 10;
    const lastReviewDate = lastReviews[c.id];
    const daysSince = lastReviewDate ? Math.ceil((now - new Date(lastReviewDate)) / 86400000) : 999;
    if (daysSince > 365) urgency += 40;
    else if (daysSince > 180) urgency += 20;
    else if (daysSince > 90) urgency += 10;
    const value = Math.min(100, ((c.annual_premium || 0) / 500) + ((c.total_investments || 0) / 10000));
    return { id: c.id, name: c.name, urgency: Math.min(100, urgency), value: Math.min(100, value), daysToExpiry, daysSince };
  });
  res.json(matrix);
}));


// ── Start ──────────────────────────────────────────────────────────────────────
async function startServer() {
  // Start listening immediately so Railway health checks pass while DB initialises.
  app.listen(PORT, () => {
    console.log(`\n🚀 FinView Dashboard → http://localhost:${PORT} (DB init in progress…)`);
  });

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
    console.log(`\n✅ FinView ready — Mode: ${USE_POSTGRES ? 'PostgreSQL' : 'SQLite'} | Admin: admin / admin2026\n`);
  } catch (e) {
    console.error('[FinView] DB init error (non-fatal, server still running):', e.message);
  }
}

// ── Prudential Fund Prices ────────────────────────────────────────────────────
let _fundCache = null;
let _fundCacheAt = 0;
const FUND_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function scrapePruFunds(fundType = 'pl') {
  const fetch = (await import('node-fetch')).default;
  const url = `https://pruaccess.prudential.com.sg/prulinkfund/viewFundPricing.do${fundType !== 'pl' ? '?fundType=' + fundType : ''}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    timeout: 15000
  });
  const html = await res.text();
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);

  // Extract update date
  const dateMatch = html.match(/Updated On <span>(.*?)<\/span>/);
  const updatedOn = dateMatch ? dateMatch[1] : '';

  const funds = [];
  const typeLabel = fundType === 'ps' ? 'PruSelect' : 'PruLink';

  $('#Table tbody tr').each((_, row) => {
    const nameCell = $(row).find('td[data-input="inputFundName"]');
    const bidCell = $(row).find('td[data-input="inputBidPrice"]');
    const offerCell = $(row).find('td[data-input="inputOfferPrice"]');
    const currCell = $(row).find('td[data-input="inputCurrencyCode"]');
    const dateCell = $(row).find('td[data-input="inputFirstEffectiveDate"]');

    const name = nameCell.text().trim();
    if (!name) return;
    const bidPrice = bidCell.find('span').first().text().trim() || bidCell.text().trim();
    const offerPrice = offerCell.find('span').first().text().trim() || offerCell.text().trim() || bidPrice;
    const currency = currCell.text().trim();
    const firstEffectiveDate = dateCell.text().trim();
    funds.push({ name, bidPrice, offerPrice, currency, firstEffectiveDate, type: typeLabel });
  });

  return { updatedOn, funds };
}

app.get('/api/fund-prices', asyncRoute(async (req, res) => {
  const now = Date.now();
  if (_fundCache && (now - _fundCacheAt) < FUND_CACHE_TTL) {
    return res.json(_fundCache);
  }
  try {
    const [pl, ps] = await Promise.all([scrapePruFunds('pl'), scrapePruFunds('ps')]);
    const result = {
      updatedOn: pl.updatedOn || ps.updatedOn,
      cachedAt: new Date().toISOString(),
      funds: [...pl.funds, ...ps.funds]
    };
    _fundCache = result;
    _fundCacheAt = now;
    res.json(result);
  } catch (e) {
    console.error('[fund-prices] scrape error:', e.message);
    if (_fundCache) return res.json({ ..._fundCache, stale: true });
    res.status(500).json({ error: 'Failed to fetch fund prices: ' + e.message });
  }
}));

// ── Global Express error handler (MUST be last middleware) ─────────────────
app.use((err, req, res, next) => {
  console.error('[FinView] Route error on', req.method, req.path, ':', err.message);
  if (!res.headersSent) res.status(500).json({ error: err.message || 'Internal server error' });
});

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
