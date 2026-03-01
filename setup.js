// Setup script - creates the demo client with sample data
const https = require('https');

const BASE = 'http://localhost:3847';

async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function main() {
  const adminKey = { 'x-admin-key': 'dylan-admin-2026' };

  console.log('Creating demo client...');
  const r = await post('/api/admin/clients', {
    id: 'C001',
    username: 'sarah.tan',
    password: 'secure123',
    name: 'Sarah Tan',
    age: 35,
    gender: 'Female',
    occupation: 'Marketing Manager',
    annual_income: 120000,
    dependents: 2,
    email: 'sarah.tan@example.com',
    phone: '+65 9123 4567'
  }, adminKey);
  console.log('Client:', r);

  console.log('Seeding data...');
  const s = await post('/api/admin/seed/C001', {
    policies: [
      { type: 'Death / Life', product_name: 'PRUActive Protect', insurer: 'Prudential', product_type: 'Term Life', coverage: 500000, premium: 1200, start_date: '2020-01-01', end_date: '2050-12-31', status: 'Active', recommended: 1200000, notes: 'Convertible term with cash value option' },
      { type: 'Early Critical Illness', product_name: 'PRUEarly Stage Crisis Cover', insurer: 'Prudential', product_type: 'Early CI', coverage: 300000, premium: 1800, start_date: '2022-01-01', end_date: '2052-12-31', status: 'Active', recommended: 600000, notes: 'Multi-stage crisis coverage' },
      { type: 'TPD', product_name: 'PRUActive Protect', insurer: 'Prudential', product_type: 'Term Life', coverage: 200000, premium: 600, start_date: '2022-01-01', end_date: '2032-12-31', status: 'Active', recommended: 1200000, notes: 'Bundled with death benefit' },
      { type: 'Savings Plan', product_name: 'PRUSave Endowment', insurer: 'Prudential', product_type: 'Endowment', coverage: 150000, premium: 3600, start_date: '2021-06-01', end_date: '2041-06-01', status: 'Active', recommended: 150000, notes: '10-year endowment savings plan' }
    ],
    investments: [
      { name: 'PRULink Growth Fund', type: 'ILP', invested: 50000, value_now: 65000, target: 150000, goal_by: '2040-01-01', contribution: 1000 },
      { name: 'PRULink Asia Equity', type: 'ILP', invested: 25000, value_now: 22000, target: 70000, goal_by: '2035-01-01', contribution: 500 },
      { name: 'SRS Account', type: 'SRS', invested: 25000, value_now: 28000, target: 80000, goal_by: '2042-01-01', contribution: 600 }
    ],
    snapshots: [
      { year: 2023, snapshot_date: '2023-12-31', total_coverage: 800000, total_investment_value: 80000, notes: 'Foundation set' },
      { year: 2024, snapshot_date: '2024-12-31', total_coverage: 1000000, total_investment_value: 100000, notes: 'Added critical illness coverage' },
      { year: 2025, snapshot_date: '2025-12-31', total_coverage: 1150000, total_investment_value: 115000, notes: 'Added savings plan, steady growth' }
    ]
  }, adminKey);
  console.log('Seed:', s);
  console.log('\n✅ Setup complete. Login with: sarah.tan / secure123');
}

main().catch(console.error);
