# Cultural Section website

Full-width club website + dedicated step-by-step form page + admin panel with team roles.
Only needs Node.js 18+ (no `npm install`).

## Run

```
npm start          # or: node server.js
```

| Page | URL |
|------|-----|
| Website | `/` |
| Form (one question per screen) | `/form` or `/form?f=<form id>` |
| Admin | `/admin` |

**First login:** username `admin`, password from the `ADMIN_PASSWORD` env var — or `cultural123` if it is not set.
Change it right away in **Admin → My account** (the panel warns you until you do).

```
$env:ADMIN_PASSWORD = "your-strong-password"; npm start     # PowerShell
ADMIN_PASSWORD=your-strong-password npm start                # Linux / Mac / hosting
```

`ADMIN_USER` (optional, default `admin`) and `ADMIN_PASSWORD` control the **main owner login**. Change either one
(locally or in Vercel → Settings → Environment Variables) and restart / **redeploy**, and the login follows — also the way
back in if you forget the password. A password changed inside the panel is kept until you change the env values again.
Usernames are not case-sensitive; extra team members (Admin → Team & roles) are never touched by these variables.

## Admin panel

- **Forms & responses** — build forms (about screen, questions, helper text, thank-you message), open/close, duplicate, preview, copy share link, view/search/delete responses, download CSV.
- **Excel & Sheets**
  - *Google Sheets auto-sync*: paste the Apps Script web-app URL (setup steps + script are inside the panel). Every new response lands in the sheet instantly. Test / send past responses / disconnect.
  - *Excel live link*: Excel → Data → From Web → paste link → Refresh All any time. Also works in Google Sheets with `=IMPORTDATA("link")`. “Reset link” revokes the old one.
- **Announcements** — post, edit, delete. Newest shows on the homepage hero card.
- **Photos** — upload (auto-resized), edit captions, choose the big first photo, delete.
- **Team & roles** — give other people their own login. Roles: Owner, Editor, Data manager, Content manager, Responses viewer, or custom permissions. The server enforces every permission.

## Deploy on Vercel

Vercel has no permanent disk, so the live site stores everything in a **Postgres database (Neon)**. Localhost keeps using `data/db.json` — nothing to set up.

1. Vercel → your project → **Storage** → **Create Database** → **Neon (Postgres)** → connect it to the project (this adds `DATABASE_URL` automatically).
2. Project → **Settings → Environment Variables** → add `ADMIN_USER` (e.g. `admin`) and `ADMIN_PASSWORD` (your own strong password) for Production. Env changes only apply to a **new deployment**, so redeploy after every change.
3. **Deployments → Redeploy**. Open the site: forms, photos, announcements and `/admin` all work. The tables are created on the first visit.

If you see “Database not connected”, step 1 is missing. Photos uploaded in admin are stored in the same database (keep each under ≈3 MB).
Google Sheets sync and the Excel link work the same on Vercel; use your real `https://…vercel.app` address in the links.

## Data (local)

- `data/db.json` — forms, responses, users (hashed passwords), announcements. **Back it up.**
- `public/uploads/` — photos uploaded from the admin panel.
- `public/img/` — the starter photos shipped with the site.

Both `data/` and `public/uploads/` are git-ignored. Host on anything that runs Node with a persistent disk
(Render, Railway, a VPS…) so they survive restarts and redeploys.
