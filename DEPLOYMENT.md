# Equyvo — Deployment (Cloudflare Pages, the only target)

App + API deploy together as the Cloudflare Pages project **`equyvo`**
(custom domain `equyvo.acronous.com`):
- `dist/` — Vite production build (frontend).
- `functions/api/[[path]].ts` — Pages Functions (entire `/api/*` backend:
  posts, thoughts, stories, moments, follow graph, chat, notifications,
  reports, billing quotas, R2 media).
- `public/_redirects` + `public/_headers` — SPA fallback + cache/security headers.

There is no Vercel / Netlify / S3 deploy. Do not add another `vercel.json`
or platform config — Pages is the single production target.

## Local development (frontend + API)

Vite serves the app on `:3000` and proxies `/api/*` to a Functions server on
`:8788`. If `:8788` isn't running, **every** `/api` call fails and all feeds
render empty — devtools shows a one-line hint telling you what to start.

```bash
# Terminal 1 — app with HMR
npm run dev

# Terminal 2 — Cloudflare Pages Functions
npm run build        # dist/ must exist for pages dev
npm run dev:api      # serves Functions on http://localhost:8788
```

Production needs none of this: Pages serves `dist/` and `functions/`
together, so `/api` resolves on the same origin.

## Ship to production

```bash
npm run type-check   # tsc --noEmit, must pass
npm run build:production
node --check 'functions/api/[[path]].ts'
npx wrangler pages deploy dist --project-name=equyvo --branch=main
```

`--branch=main` makes the deployment **Production** (serves
`equyvo.acronous.com`). Verify afterwards:

```bash
Invoke-WebRequest https://equyvo.acronous.com/api/health
```

## Secrets (Pages dashboard or `wrangler pages secret put --project-name=equyvo`)

Never commit these, never prefix with `VITE_`:

- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_UPLOAD_PRESET`
- `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- `REPORTS_ADMIN_TOKEN` — must match the dashboard's env of the same name,
  otherwise `dashboard.acronous.com/reports` shows "Not connected".

Recommended vars (see `wrangler.toml` `[vars]`):

- `REQUIRE_VERIFIED_WRITES=true` — reject unverified `X-User-Id` writes (prod).
- `BILLING_BASE_URL=https://api.acronous.com`
- `R2_PUBLIC_BASE=https://cdn.equyvo.com` (optional; same-origin
  `/api/media/<key>` proxy works with zero DNS setup).
- `BRAIN_URL=https://brain.acronous.com`

KV (`EQUYVO_KV`) and R2 (`equyvo-media`) bindings live in `wrangler.toml`.

## Notes

- R2 is the primary media store (zero egress); Cloudinary is used
  selectively for derived variants (thumbnails/optimized).
- `worker/` is a standalone-Worker mirror of the backend (including a
  `scheduled()` keep-warm hook). Pages Functions is what production serves;
  keep the two in sync when adding API routes.
- `android/` + `ios/` are the Capacitor native shells — the same `dist/`
  build ships to mobile. Use `npx cap sync` after building.
