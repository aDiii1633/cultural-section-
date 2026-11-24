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

`ADMIN_PASSWORD` is only used the very first time, to create the owner account.

## Admin panel

- **Forms & responses** — build forms (about screen, questions, helper text, thank-you message), open/close, duplicate, preview, copy share link, view/search/delete responses, download CSV.
- **Excel & Sheets**
  - *Google Sheets auto-sync*: paste the Apps Script web-app URL (setup steps + script are inside the panel). Every new response lands in the sheet instantly. Test / send past responses / disconnect.
  - *Excel live link*: Excel → Data → From Web → paste link → Refresh All any time. Also works in Google Sheets with `=IMPORTDATA("link")`. “Reset link” revokes the old one.
- **Announcements** — post, edit, delete. Newest shows on the homepage hero card.
- **Photos** — upload (auto-resized), edit captions, choose the big first photo, delete.
- **Team & roles** — give other people their own login. Roles: Owner, Editor, Data manager, Content manager, Responses viewer, or custom permissions. The server enforces every permission.

## Data

- `data/db.json` — forms, responses, users (hashed passwords), announcements. **Back it up.**
- `public/uploads/` — photos uploaded from the admin panel.
- `public/img/` — the starter photos shipped with the site.

Both `data/` and `public/uploads/` are git-ignored. Host on anything that runs Node with a persistent disk
(Render, Railway, a VPS…) so they survive restarts and redeploys.
