# FinView Deployment Guide

## Deploy to Railway
```bash
cd ~/finview-dashboard
railway login  # use DylanJ account
railway up --detach
```

## Environment Variables Required
- `DATABASE_URL` — PostgreSQL connection string (auto-set by Railway Postgres service)
- `JWT_SECRET` — any secure random string (already set: `dylan-findb-secret-2026-!@#`)
- `ADMIN_PASSWORD` — admin login password (default: `admin2026`)
- `ANTHROPIC_API_KEY` — for AI needs analysis (optional, falls back to rule-based)
- `PORT` — auto-set by Railway

## Test Credentials
- Admin: `admin` / `admin2026`
- Test prospect: `test.prospect` / `prospect123`

## Features
- Three-tier access: admin / client / prospect
- Investment tracking (single premium + DCA)
- CPF calculator
- Commission tracker
- AI needs analysis
- PDF report generation
- Document vault
- WhatsApp booking CTAs → +65 8484 7001
- Gmail: dylanjh.cjo@gmail.com

## Version
v11-2026-06-10
