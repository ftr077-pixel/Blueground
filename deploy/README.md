# Deploying to a box (Vultr / any Ubuntu)

Runs the whole thing on one machine: the **dashboard** (Next.js, durable SQLite on
disk) + the **scraper** (`run_agent.py` on a daily cron) + **Caddy** for HTTPS and a
login. `setup-box.sh` does all of it.

## Prerequisites (the parts only you can provide)

1. **An Ubuntu box** (Vultr, 22.04/24.04). Cheapest plan is fine.
2. **A residential proxy** — e.g. IPRoyal / Decodo. Datacenter IPs get blocked by
   Airbnb, so it's required for **live scanning**. You can skip it for a
   dashboard-only first run and add it later. You'll get a `http://user:pass@host:port` URL.
3. **A GitHub token** to clone this private repo: create a fine-grained PAT
   (Contents: Read-only), then your `REPO_URL` is
   `https://<TOKEN>@github.com/ftr077-pixel/Blueground.git`.
4. **A domain** (optional but needed for the login-from-anywhere part). Point its
   DNS **A record** at the box's public IP. Skip it and the app is reachable at
   `http://<box-ip>:3000` with **no login** (fine for a quick look, not for leaving up).

## Run it

```bash
# on the box, as root:
REPO_URL="https://<TOKEN>@github.com/ftr077-pixel/Blueground.git" \
DOMAIN="visibility.yourdomain.com" \
BASIC_AUTH_USER="you" \
BASIC_AUTH_PASS="a-good-password" \
PROXY_URL="http://user:pass@proxy-host:port" \
bash setup-box.sh
```

(You can also edit the CONFIG block at the top of the script instead of passing env vars.)

## What it sets up

| Piece | How |
|-------|-----|
| Dashboard | systemd service `rohub` → `next start` on port 3000 |
| Data | SQLite at `<app>/data/orchestrator.db` (persists on the box disk) |
| Scraper | `/etc/cron.d/visibility-scan` runs `run_agent.py` daily |
| Auth between them | `SCRAPER_API_KEY` (auto-generated into `.env.local`) |
| HTTPS + login | Caddy reverse-proxy with `basic_auth` (only if `DOMAIN` set) |

## After it runs

- Open `https://your-domain.com` (or `http://<box-ip>:3000`) → **Search Visibility**.
- Kick a scan immediately (don't wait for cron) with the command the script prints.
- Logs: `journalctl -u rohub -f` (app) and `tail -f /var/log/visibility-scan.log` (scraper).
- Re-run `setup-box.sh` anytime to pull new code and rebuild.

## Notes

- The script runs the app as `root` for simplicity — fine for a single-operator
  POC; harden (dedicated user, firewall) before treating it as production.
- `SCRAPER_API_KEY` lives in `<app>/.env.local`; the scraper cron reads the same value.
