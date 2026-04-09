import urllib.request, urllib.error, json, time, sys

RAIL_URL = "https://finview-dashboard-production.up.railway.app"
BACKUP_FILE = "/Users/dylanho/finview-dashboard/railway-backup-7clients.json"

def api_post(path, data, token=None):
    headers = {"Content-Type": "application/json"}
    if token: headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(RAIL_URL + path,
        data=json.dumps(data).encode(), headers=headers, method="POST")
    try:
        resp = urllib.request.urlopen(req)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  ERROR {e.code}: {body[:200]}")
        return None

def api_get(path, token):
    req = urllib.request.Request(RAIL_URL + path,
        headers={"Authorization": f"Bearer {token}"})
    return json.loads(urllib.request.urlopen(req).read())

# Wait for new version
print("Checking Railway version...")
for i in range(30):
    try:
        ping = json.loads(urllib.request.urlopen(RAIL_URL + "/api/ping").read())
        version = ping.get("version", "")
        print(f"  Version: {version}")
        if "v6" in version:
            print("✅ New version live!")
            break
        time.sleep(10)
    except: time.sleep(10)
else:
    print("⚠️ Still on old version — restoring anyway")

# Login
print("\nLogging in...")
token_resp = api_post("/api/auth/login", {"username":"admin","password":"admin2026"})
if not token_resp:
    print("❌ Login failed"); sys.exit(1)
token = token_resp["token"]
print("✅ Logged in")

# Load backup
backup = json.load(open(BACKUP_FILE))
print(f"\nRestoring {len(backup)} clients...")

for entry in backup:
    c = entry["client"]
    # Create client account
    result = api_post("/api/admin/create-client", {
        "username": c.get("username", c["id"].lower()),
        "password": "client2026",
        "name": c["name"],
        "age": c.get("age", 0),
        "gender": c.get("gender", ""),
        "occupation": c.get("occupation", ""),
        "annual_income": c.get("annual_income", 0),
        "dependents": c.get("dependents", 0),
        "email": c.get("email", ""),
        "phone": c.get("phone", ""),
        "notes": c.get("notes", ""),
        "deal_stage": c.get("deal_stage", "Prospect"),
        "last_contact": c.get("last_contact", ""),
        "next_action": c.get("next_action", "")
    }, token)
    
    if not result:
        print(f"  ⚠️ {c['name']} — create failed (may already exist)")
        # Try to find existing client
        try:
            all_clients = api_get("/api/admin/clients", token)
            match = next((x for x in all_clients if x["name"] == c["name"]), None)
            new_id = match["id"] if match else None
        except: new_id = None
    else:
        new_id = result.get("client", {}).get("id") or result.get("id")
    
    if not new_id:
        print(f"  ❌ {c['name']} — skipping (no ID)")
        continue
    
    print(f"  ✅ {c['name']} → {new_id}")
    
    # Restore policies
    for p in entry["policies"]:
        r = api_post(f"/api/clients/{new_id}/policies", {
            "type": p.get("type",""),
            "product_name": p.get("product_name",""),
            "policy_number": p.get("policy_number",""),
            "insurer": p.get("insurer",""),
            "coverage": p.get("coverage",0),
            "premium": p.get("premium",0),
            "start_date": p.get("start_date",""),
            "end_date": p.get("end_date",""),
            "status": p.get("status","Active"),
            "notes": p.get("notes","")
        }, token)
        if r: print(f"    📋 Policy: {p.get('product_name','?')}")
    
    # Restore investments
    for inv in entry["investments"]:
        r = api_post(f"/api/clients/{new_id}/investments", {
            "name": inv.get("name",""),
            "type": inv.get("type",""),
            "invested": inv.get("invested",0),
            "value_now": inv.get("value_now",0),
            "target": inv.get("target",0),
            "goal_by": inv.get("goal_by",""),
            "contribution": inv.get("contribution",0)
        }, token)
        if r: print(f"    💰 Investment: {inv.get('name','?')}")

print("\n✅ Restore complete!")
