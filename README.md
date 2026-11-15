# FSVP Vault: working demo

A small, dependency-free web app with:

- **Landing page** at `/` (company overview, features, pricing, sign in)
- **Single-user login** at `/login`
- **The portal** at `/app`, with every screen linked and every button saving to a database:
  approvals, reevaluations, signatures, uploads, document requests, supplier add/remove/reinstate,
  scoping answers, procedures, verification records, corrective actions, the plan review and the plan signature
- **Workspaces you can switch between**: a fictional sample importer (Harbor Lane Foods) is always there.
  Private workspaces (real customer data) are imported onto the server's disk and are never stored in the code repository.

There are no payments. FDA monitor connections are placeholders until the last build step (see "Still to do").

## How it's built

| Part | What it is |
|---|---|
| `server.js` | Node.js built-ins only (`http`, `crypto`, `fs`, `node:sqlite`). Needs **Node 22.13 or newer**. No `npm install`. Routes, sign-in, access control, uploads, email jobs, records package, backups. |
| `lib/actions.js` | Every portal action: takes the workspace data, changes it, returns a message. Each one is logged to the `events` table. |
| `lib/auth.js` | Users, roles, scrypt passwords, TOTP 2-step codes, reset and invite tokens. |
| `lib/fda.js` | Live FDA checks: import alert pages, openFDA recalls, warning letters, FDA Data Dashboard (refusals, inspections, compliance actions). |
| `lib/mail.js` | SMTP client (TLS or STARTTLS) and the email layout. |
| `lib/pdftext.js`, `lib/certread.js` | Text from PDFs and Word files; reads expiry, issue date, standard, certification body, scope and checks name and address. |
| `lib/zip.js` | ZIP reader and writer (document import, records package, backups). |
| `app/portal.html` | The portal page. Plain ES5 JavaScript so it runs on older iPhone Safari. The server inserts the workspace data at `<!--BOOT-->`. |
| `public/` | Landing page, sign-in and account pages, supplier upload page, privacy and terms (drafts). |
| `seed/demo.json` | The fictional sample workspace (rebuild with `npm run seed:demo`). |
| `test/` | Playwright tests at iPhone width: `e2e.js` (every button), `features.js` (certificates, shipments, package, to-do, imports, plan archive), `email.js` (needs a test SMTP server), `accounts.js` (roles, 2-step, reset, backup), `plan-fields.js`. Fixtures in `test/fixtures`. |

Data lives in `DATA_DIR`: `fsvpvault.db` (SQLite: workspaces, events, files, users, mail log), `uploads/`, `seeds/` (imported private workspaces), `cache/` (FDA pages, 24 h), `packages/` (records packages, deleted after 1 hour).

See `SECURITY.md` for the security review and what to do before paying customers.

## Run it on a computer

```
cp .env.example .env      # then edit the values
export $(grep -v '^#' .env | xargs)
npm start                 # http://localhost:3000
```

## Settings (environment variables)

| Name | Purpose |
|---|---|
| `DEMO_EMAIL`, `DEMO_PASSWORD` | The owner account. Changing `DEMO_PASSWORD` in Render resets the owner's password (the way back in if it's lost). Other people are invited from Account → Team. |
| `DEMO_NAME` | Owner's name on signatures and history |
| `SESSION_SECRET` | Long random string. Changing it signs everyone out. |
| `DATA_DIR` | Where the database and uploads live. On a host this must be the persistent disk. |
| `PUBLIC_URL` | Address used in email links (default `https://fsvpvault.com`) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Outgoing email. Google Workspace: `smtp.gmail.com`, `465`, the mailbox address, a Google app password, `FSVP Vault <hello@fsvpvault.com>` |
| `SUPPORT_TO`, `MAIL_REPLY_TO` | Where support messages go (default hello@fsvpvault.com); fallback reply-to for supplier emails |
| `FDA_DD_USER`, `FDA_DD_KEY` | FDA Data Dashboard API credentials |
| `OPENFDA_API_KEY` | Optional; raises openFDA limits |
| `AUTO_CHECK=off`, `AUTO_MAIL=off` | Turn off the weekly FDA checks or the daily emails (for testing) |
| `PORT` | Set by most hosts automatically. |

## Put it on fsvpvault.com (Render)

1. **GitHub**: create a **private** repository and push this folder. `.gitignore` already keeps `data/` and any private workspace file out.
2. **Render** (render.com): New → Web Service → connect the repository.
   - Runtime: Node. Build command: *(leave empty)*. Start command: `npm start`.
   - Instance: a paid instance (Starter); free instances can't keep a disk and fall asleep.
   - Disks → Add disk: mount path `/var/data`, 1 GB.
   - Environment: `DATA_DIR=/var/data`, `NODE_VERSION=22.13.0` (or newer), plus `DEMO_EMAIL`, `DEMO_PASSWORD`, `DEMO_NAME`, `SESSION_SECRET`.
   - Health check path: `/health`.
3. **Domain**: Settings → Custom domains → add `fsvpvault.com` and `www.fsvpvault.com`. Render shows the DNS records; add them at the registrar where you bought the domain. HTTPS is issued automatically.
4. **Private workspace**: sign in → Get help → "Import a workspace file" → choose the `.json` file. It's saved to the server's disk only.

Cost at the time of writing: about $7/month for the instance plus a few cents for the disk. Check Render's pricing page.

## Still to do

- Payments (Stripe) and plan limits
- The items in `SECURITY.md` under "Recommended before paying customers"
- Lawyer review of the privacy policy and terms (`public/privacy.html`, `public/terms.html`)
- Server-side checks of field values against FSVP rules (today the server trusts values after basic cleaning)
