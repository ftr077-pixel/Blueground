# Handoff: move VoiceBridge from the ngrok tunnel onto its own domain

Instructions for an agent with shell access to the server. Denis is present
and will log into the registrar, Twilio and Google Cloud when asked — he
cannot be replaced for those three, so ask for exactly one thing at a time.

## What this system is

A translation bridge that sits inside a live phone call: a caller speaks
Hebrew on a normal phone, an operator hears English in a browser, and back.
It currently answers on an ngrok URL that changes and dies; the job is to put
it on a permanent HTTPS address.

- Server: Vultr box, Ubuntu, root access.
- Repository: `/root/Blueground`, working directory `/root/Blueground/voicebridge`.
- Branch: `main`. A systemd timer (`voicebridge-update.timer`) deploys `main`
  every minute — do not disable it, and do not check out another branch.
- Service: `systemctl status voicebridge`, listens on `localhost:8080`.
- Configuration: `/root/Blueground/voicebridge/.env`.

## Rules

1. **Never print the contents of `.env`,** and never paste a value from it into
   chat. It holds live API keys and a Twilio auth token. `make check-env`
   reports which values are set without showing any of them — use that.
2. **Never commit `.env`** or any file containing a key.
3. Do not disable TLS verification or work around a certificate error. A
   certificate failure here means DNS is wrong; fix DNS.
4. Do not edit application code for this task. Everything needed is already in
   `deploy/`.
5. If a step fails, stop and report the exact error. Do not improvise a
   different route to the same result.

## Step 1 — get two facts from Denis

- The domain he owns (e.g. `example.com`).
- Confirm the subdomain to use. Default to `voice.<his-domain>`; a subdomain
  leaves his existing site untouched.

Get the box's public IP yourself:

```bash
curl -fsS https://api.ipify.org
```

## Step 2 — DNS (Denis does this, you dictate)

Ask him to open his registrar's DNS panel and add one record:

| Field | Value |
|---|---|
| Type | `A` |
| Name / Host | `voice` |
| Value / Points to | the IP from step 1 |
| TTL | default |

Then wait for it to propagate and verify from the box:

```bash
getent hosts voice.<his-domain>
```

The address it prints must equal the IP from step 1. If it prints nothing,
wait and retry — usually 5–15 minutes, occasionally longer. Do not continue
until it matches; a certificate cannot be issued before then.

## Step 3 — switch the server over (you do this)

```bash
sudo bash /root/Blueground/voicebridge/deploy/use-domain.sh voice.<his-domain>
```

This sets `VOICE_DOMAIN` and `PUBLIC_HOST` in `.env`, installs Caddy, obtains
the certificate, restarts the service, and prints the two strings needed in
step 4 and step 5. It refuses to run if DNS is not yet pointing at this box.

Verify from the box:

```bash
curl -s https://voice.<his-domain>/health
```

Expect `ok operators_waiting=0 calls_active=0`.

## Step 4 — Twilio webhook (Denis logs in, you dictate)

Twilio Console → Phone Numbers → Manage → Active numbers → his number →
"Voice Configuration" → "A call comes in":

- Type: Webhook
- URL: `https://voice.<his-domain>/twilio/voice`
- Method: **HTTP POST**

Save. Until this is changed, incoming calls still go to the dead ngrok URL.

## Step 5 — Google sign-in redirect (Denis logs in, you dictate)

Only if `GOOGLE_CLIENT_ID` is set — check with `make check-env`, which prints
names and verdicts only.

Google Cloud Console → APIs & Services → Credentials → the OAuth 2.0 Client ID
→ "Authorised redirect URIs" → add, exactly:

```
https://voice.<his-domain>/auth/callback
```

Character for character, no trailing slash. A mismatch fails with
`redirect_uri_mismatch` at sign-in. The old ngrok entry can be removed.

## Step 6 — verify end to end

1. Open `https://voice.<his-domain>/operator` in Chrome. If sign-in is
   configured it should redirect to Google and back; if not, the page loads
   directly and shows "no login configured".
2. Click **Connect** and allow the microphone. State should read
   "waiting for a call".
3. Ask Denis to call the Twilio number from his phone and say a sentence in
   Hebrew. The English translation should appear in the timeline and be
   audible in the browser within about a second.
4. Check the numbers: `https://voice.<his-domain>/debug/last-call` — the
   latency budget is p50 ≤ 1500 ms. Report what you see.

Once the call works, the ngrok agent is no longer needed:

```bash
systemctl disable --now ngrok
```

Leave it installed as a fallback.

## When something fails

- **`does not resolve yet`** — DNS has not propagated. Wait, re-run step 2's
  check. Do not skip ahead.
- **`points at X but this box is Y`** — the A record has the wrong IP, or an
  old record still exists. Denis must fix it at the registrar.
- **Certificate issuance fails** — check `journalctl -u caddy -n 40`. Almost
  always DNS, or port 80 blocked. Caddy needs both 80 and 443 reachable.
- **Calls reach the number but nothing happens** — the Twilio webhook still
  points at the old address. Step 4.
- **`redirect_uri_mismatch`** — the string in Google does not match step 5
  exactly.
- **Service will not start** — `journalctl -u voicebridge -n 50`. A missing
  configuration value stops startup deliberately; `make check-env` names it
  without revealing any value.
- **Vendor errors during a call** — `make preflight` dials every vendor and
  names the one that refused. Safe to run any time; it makes one short
  request per vendor.

## Do not

- Do not touch the segmenter thresholds in `.env` (`STABILITY_MS`,
  `MAX_UNCOMMITTED_MS`, `VAD_SILENCE_MS`). They are changed from measurements,
  never to make one call sound better.
- Do not add numbers to `OUTBOUND_ALLOWED` beyond what Denis asks for. That
  list is the only thing standing between a public endpoint and his phone bill.
- Do not open `/twilio/voice` or `/ws/twilio` to any authentication. Twilio
  cannot answer a login prompt; adding one takes every call down.
