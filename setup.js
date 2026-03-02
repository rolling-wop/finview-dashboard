const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const BASE = 'http://localhost:3847/api';

async function setup() {
  // 1. Bootstrap admin
  console.log('Creating admin account...');
  const admin = await fetch(`${BASE}/bootstrap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminPassword: 'admin2026' }) });
  const adminRes = await admin.json();
  console.log('Admin:', adminRes.error || '✅ admin / admin2026');

  // 2. Get admin token
  const loginRes = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin2026' }) });
  const { token } = await loginRes.json();
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-admin-key': 'dylan-admin-2026' };

  // 3. Create demo client
  console.log('Creating demo client...');
  const clientRes = await fetch(`${BASE}/admin/clients`, { method: 'POST', headers: H, body: JSON.stringify({ username: 'sarah.tan', password: 'secure123', name: 'Sarah Tan Wei Lin', age: 29, gender: 'Female', occupation: 'Software Engineer', annual_income: 84000, dependents: 0, email: 'sarah.tan@email.com', phone: '+65 9123 4567' }) });
  const client = await clientRes.json();
  console.log('Client:', client.error || `✅ ${client.name} (${client.id})`);
  if (!client.id) { console.log('Client may already exist, skipping seed.'); return; }

  // 4. Seed policies
  const policies = [
    { type: 'Death / Life', product_name: 'PRUActive Protect', policy_number: 'PRU-20240001', insurer: 'Prudential', product_type: 'Term Life', coverage: 500000, premium: 1440, start_date: '2024-01-01', end_date: '2054-01-01', status: 'Active', recommended: 840000, notes: '10x income cover' },
    { type: 'Early Critical Illness', product_name: 'PRUEarly Stage Crisis Cover', policy_number: 'PRU-20240002', insurer: 'Prudential', product_type: 'Early CI', coverage: 300000, premium: 2160, start_date: '2024-01-01', end_date: '2054-01-01', status: 'Active', recommended: 300000, notes: '' },
    { type: 'Savings Plan', product_name: 'PRUSave Endowment', policy_number: 'PRU-20240003', insurer: 'Prudential', product_type: 'Endowment', coverage: 150000, premium: 6000, start_date: '2024-01-01', end_date: '2039-01-01', status: 'Active', recommended: 150000, notes: '15-yr endowment' },
    { type: 'TPD', product_name: 'PRUActive Protect (TPD Rider)', policy_number: 'PRU-20240001R', insurer: 'Prudential', product_type: 'TPD', coverage: 200000, premium: 480, start_date: '2024-01-01', end_date: '2054-01-01', status: 'Active', recommended: 200000, notes: 'Rider on term policy' },
  ];
  for (const p of policies) await fetch(`${BASE}/clients/${client.id}/policies`, { method: 'POST', headers: H, body: JSON.stringify(p) });
  console.log(`✅ ${policies.length} policies seeded`);

  // 5. Seed investments
  const investments = [
    { name: 'PRULink Growth Fund', type: 'ILP', invested: 24000, value_now: 28400, target: 80000, goal_by: '2034-01-01', contribution: 500 },
    { name: 'CPF Savings (SA)', type: 'CPF-SA', invested: 42000, value_now: 46800, target: 200000, goal_by: '2055-01-01', contribution: 1200 },
    { name: 'IBKR S&P 500 ETF', type: 'ETF', invested: 18000, value_now: 22600, target: 100000, goal_by: '2040-01-01', contribution: 800 },
  ];
  for (const i of investments) await fetch(`${BASE}/clients/${client.id}/investments`, { method: 'POST', headers: H, body: JSON.stringify(i) });
  console.log(`✅ ${investments.length} investments seeded`);

  // 6. Seed snapshots
  const snapshots = [
    { year: 2022, snapshot_date: '2022-12-31', total_coverage: 800000, total_investment_value: 52000, notes: 'Started financial planning' },
    { year: 2023, snapshot_date: '2023-12-31', total_coverage: 950000, total_investment_value: 74000, notes: 'Added CI cover' },
    { year: 2024, snapshot_date: '2024-12-31', total_coverage: 1150000, total_investment_value: 97800, notes: 'Added TPD rider + ETF portfolio' },
  ];
  for (const s of snapshots) await fetch(`${BASE}/clients/${client.id}/snapshots`, { method: 'POST', headers: H, body: JSON.stringify(s) });
  console.log(`✅ ${snapshots.length} snapshots seeded`);

  console.log('\n✅ Setup complete!');
  console.log('   Admin:  admin / admin2026');
  console.log('   Client: sarah.tan / secure123\n');
}

setup().catch(console.error);
