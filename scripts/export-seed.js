#!/usr/bin/env node
// Usage: node scripts/export-seed.js
// Pulls live data from Railway and regenerates seed.js

const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.FINVIEW_URL || 'https://finview-dashboard-production-63cc.up.railway.app';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin2026';

async function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function main() {
  console.log('[export-seed] Logging in...');
  const login = await fetchJson(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS })
  });

  const token = login.token;
  if (!token) throw new Error('Login failed: ' + JSON.stringify(login));

  console.log('[export-seed] Fetching backup...');
  const backup = await fetchJson(`${BASE_URL}/api/admin/backup`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const { clients, policies, investments } = backup;
  const now = new Date().toISOString().slice(0, 10);

  const out = `// seed.js — Auto-generated from live Railway data (${now})
// Runs automatically on startup if DB is empty (local dev / fresh deploy)
// To refresh: node scripts/export-seed.js

const SEED_CLIENTS = ${JSON.stringify(clients, null, 2)};

const SEED_POLICIES = ${JSON.stringify(policies, null, 2)};

const SEED_INVESTMENTS = ${JSON.stringify(investments, null, 2)};

async function seedIfEmpty(dbGet, dbAll, dbRun) {
  const existing = await dbGet('SELECT COUNT(*) as count FROM clients WHERE role = ?', ['client']);
  const count = existing ? (existing.count || existing['COUNT(*)'] || 0) : 0;

  if (count > 0) {
    console.log(\`[seed] DB has \${count} client(s) — skipping seed\`);
    return false;
  }

  console.log('[seed] Empty DB detected — seeding with live data...');

  for (const c of SEED_CLIENTS) {
    if (c.role === 'admin') continue;
    try {
      await dbRun(
        \`INSERT INTO clients (id, username, password_hash, name, age, gender, occupation, annual_income, dependents, email, phone, role, notion_page_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`,
        [c.id, c.username, c.password_hash || '$2a$10$placeholder', c.name,
         c.age || 0, c.gender || '', c.occupation || '', c.annual_income || 0,
         c.dependents || 0, c.email || '', c.phone || '', c.role || 'client',
         c.notion_page_id || '', c.created_at, c.updated_at]
      );
    } catch (e) {
      console.warn(\`[seed] Skipped client \${c.name}: \${e.message}\`);
    }
  }

  for (const p of SEED_POLICIES) {
    try {
      await dbRun(
        \`INSERT INTO policies (client_id, type, product_name, policy_number, insurer, product_type, coverage, premium, start_date, end_date, status, recommended, notes, coverage_items, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`,
        [p.client_id, p.type || '', p.product_name || '', p.policy_number || '',
         p.insurer || '', p.product_type || '', p.coverage || 0, p.premium || 0,
         p.start_date || '', p.end_date || '', p.status || 'Active',
         p.recommended || 0, p.notes || '', p.coverage_items || null,
         p.created_at, p.updated_at]
      );
    } catch (e) {
      console.warn(\`[seed] Skipped policy \${p.product_name}: \${e.message}\`);
    }
  }

  for (const inv of SEED_INVESTMENTS) {
    try {
      await dbRun(
        \`INSERT INTO investments (client_id, name, type, invested, value_now, target, goal_by, contribution, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`,
        [inv.client_id, inv.name || '', inv.type || '', inv.invested || 0,
         inv.value_now || 0, inv.target || 0, inv.goal_by || '',
         inv.contribution || 0, inv.created_at, inv.updated_at]
      );
    } catch (e) {
      console.warn(\`[seed] Skipped investment \${inv.name}: \${e.message}\`);
    }
  }

  const clientCount = SEED_CLIENTS.filter(c => c.role !== 'admin').length;
  console.log(\`[seed] ✅ Seeded \${clientCount} clients + \${SEED_POLICIES.length} policies + \${SEED_INVESTMENTS.length} investments\`);
  return true;
}

module.exports = { seedIfEmpty };
`;

  const outPath = path.join(__dirname, '..', 'seed.js');
  fs.writeFileSync(outPath, out);
  console.log(`[export-seed] ✅ seed.js refreshed with ${clients.filter(c => c.role !== 'admin').length} clients, ${policies.length} policies, ${investments.length} investments`);
}

main().catch(e => { console.error(e); process.exit(1); });
