# Deploy WP Agent in 5 minutes

## Step 1 — GitHub pe daalo (2 min)

Terminal kholo aur ye commands chalaao:

```bash
cd wp-agent
git init
git add -A
git commit -m "Initial commit"
```

GitHub pe jaao → New repository → naam do `wp-agent` → Create

```bash
git remote add origin https://github.com/TUMHARA_USERNAME/wp-agent.git
git push -u origin main
```

---

## Step 2 — Railway account banao (1 min)

1. **railway.app** kholo
2. **"Start a New Project"** click karo
3. **GitHub se login** karo (1 click)

---

## Step 3 — Deploy karo (1 min)

1. Railway dashboard mein **"New Project"** → **"Deploy from GitHub repo"**
2. `wp-agent` repo select karo
3. **Ek environment variable add karo:**

   | Name | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | `sk-ant-...` (tumhara key) |

4. **Deploy** click karo

Railway automatically build karega aur deploy kar dega.

---

## Step 4 — App live ho gayi! 🎉

Railway ek URL dega jaise:
```
https://wp-agent-production-xxxx.railway.app
```

Ye URL browser mein kholo — WP Agent chat interface open hoga!

---

## Persistent Storage (important!)

Railway mein ek Volume add karo taaki data safe rahe:

1. Project mein jaao → **"Add Volume"**
2. Mount path: `/app/data`
3. Done!

Bina volume ke, app restart hone pe data delete ho jaata hai.

---

## Environment Variables (optional)

Inhe Railway dashboard mein add karo agar chahiye:

| Variable | Kya hai |
|---|---|
| `REQUIRE_APPROVAL` | `true` = high-risk kaam pe approval maange |
| `SLACK_WEBHOOK_URL` | Slack notifications |
| `DASHBOARD_PORT` | Default 3000 (Railway khud set karta hai) |

---

## Update karna

Jab bhi code change karo:
```bash
git add -A && git commit -m "Update" && git push
```

Railway automatically redeploy kar deta hai.
