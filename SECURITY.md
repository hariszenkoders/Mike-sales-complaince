# Security notes (self-review, November 2026)

This is a review of the code as built, for the developer who takes it over. It is not a penetration test.

## In place

| Area | What the code does |
|---|---|
| Passwords | scrypt (N=16384) with a random salt per user; 12-character minimum and a weak-password check; reset tokens are random 256-bit values stored only as SHA-256 hashes and expire in 1 hour (invites: 72 hours). |
| Sessions | HMAC-signed cookie (`SESSION_SECRET`), HttpOnly, SameSite=Lax, Secure over HTTPS, 7-day life. Each user has a session version: changing a password, role or access signs that user out everywhere. |
| 2-step sign-in | TOTP (RFC 6238, tested against the RFC vectors), ±30 s window, attempt limits. The owner can reset another user's 2-step. |
| Brute force | Sign-in limited per IP (20/15 min) and per email (8/15 min); 2-step codes, password changes, upload codes and the forgot-password form are rate limited too. The limits are in memory, so they reset on restart. |
| Access control | Every API call checks the user's workspace list (`users.ws`) on the server; file downloads and records packages check the file's workspace. Roles: owner, QI, staff, view only. Approvals and signatures (`sign`, `approve`, `reeval`, `plan_sign`, `capa_close`) are QI or owner only; view-only users can't post anything except their own account settings. |
| CSRF | API calls must be `application/json` (a form on another site can't send that) and cookies are SameSite=Lax. Login and reset forms are plain forms; login CSRF is low impact here. |
| Uploads | 15 MB limit; supplier uploads allow only PDF, image, Word, Excel, CSV and text. Files are stored under random names outside the web root, and served with `X-Content-Type-Options: nosniff`, a sandboxing Content-Security-Policy, and as downloads unless they are PDF or images (or an archived plan, which is sandboxed). |
| Supplier upload page | No account; the upload code identifies the supplier. Codes are 4 random characters plus a supplier prefix and are rate limited. Supplier files wait for review before they count as records. |
| Output | Server-side text inputs have `<` and `>` stripped before storage; generated HTML escapes FDA data and user text in the newer code. The page sets `X-Frame-Options: DENY` and `Referrer-Policy: same-origin`. |
| Email | SMTP over TLS (465) or STARTTLS (587) with certificate checking. Requests and reminders go only to addresses saved on the supplier. |
| Audit trail | Every change is written to the `events` table with user, time, action and details; shown per supplier and included in the records package. |
| Backups | Owner can download a full backup (database copy made with `VACUUM INTO`, uploads, private seeds). A weekly records-only copy is emailed to the owner. Render also snapshots the disk daily and keeps snapshots for 7 days. |

## Recommended before paying customers

1. **Longer upload codes.** Make supplier codes at least 10 random characters, and let the owner rotate a code.
2. **Escape all output in the portal.** Older parts of `app/portal.html` build HTML from stored strings without `esc()`. Input stripping makes this hard to exploit, but every interpolation should be escaped. A Content-Security-Policy for `/app` (moving the inline script to a file with a nonce) would add a second layer.
3. **Rate limits that survive restarts**, kept in the database, and an alert to the owner after repeated failed sign-ins.
4. **Make 2-step sign-in required** for owner and QI accounts, with one-time recovery codes.
5. **Virus scanning** of uploads (for example ClamAV in a separate service) and re-checking file types by content, not only by name.
6. **Move off a single SQLite file** to managed Postgres with point-in-time recovery once there are several customers, and test restoring a backup.
7. **Separate the demo and real data**: the `/api/reset` and workspace import endpoints are owner-only, but should be removed or put behind a feature flag in production.
8. **Dependency-free code means no automatic security updates from libraries**: keep Node on a supported LTS version and redeploy when Node security releases come out.
9. **Records package links** expire after an hour but are bearer links within a signed-in session; consider deleting the file after the first download.
10. **Logging**: send server logs to a log service with retention, and never log request bodies (the code doesn't today).
11. **Legal**: have a lawyer review `public/privacy.html` and `public/terms.html`, and sign data processing terms with Render and Google.
