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

## Android release build (R8)

Release builds run **full R8** (dead-code elimination + optimization +
obfuscation) so Play Console sees real shrinking — previously
"Obfuscation percentage 1%" because `minifyEnabled` was false.

- Config: `android/app/build.gradle` (`minifyEnabled`, `shrinkResources`,
  `proguard-android-optimize.txt`) + `android/app/proguard-rules.pro`
  (keeps for the Capacitor reflection bridge, AdMob/UMP surfaces,
  `@JavascriptInterface` methods).
- Only English resources ship (`androidResources.localeFilters = ['en']`) —
  app i18n lives in the web layer.
- AGP stays on the latest 8.x. AGP 9 requires dropping the separate
  `kotlin-android` plugin (built-in Kotlin), which the AdMob community
  plugin still uses in `node_modules`; upgrade AGP together with Capacitor 9
  when it reaches GA.

```bash
# from Equyvo/ (not android/)
npm run build:production
npx cap sync android
cd android ; .\gradlew assembleRelease bundleRelease
```

Outputs (after every release build):

- `app/build/outputs/apk/release/app-release.apk` → root `equyvo-app.apk`
- `app/build/outputs/bundle/release/app-release.aab` → root `equyvo-app.aab`
- `app/build/outputs/mapping/release/mapping.txt` → root
  `equyvo-mapping-<version>.txt` — upload this to **Play Console →
  App releases → Release → Retrace/De-obfuscation files** so Play shows
  readable stack traces for the obfuscated build. Never commit it.

Bump `versionCode` (+1, integer) and `versionName` in
`android/app/build.gradle` every release: Play never accepts a reused
versionCode. The new code must be higher than the highest code already
uploaded to **any** track (internal/closed/open/production), not just the
track you are updating. Current: `versionCode 46` / `1.2.24`.

Before uploading, verify the generated bundle actually contains the new
code. A stale file from a previous build is the usual cause of Play's
"This release does not add or remove any app bundles" error:

```bash
# from Equyvo/android
java -jar bundletool.jar dump manifest \
  --bundle app/build/outputs/bundle/release/app-release.aab \
  | findstr versionCode
```

Upload `android/app/build/outputs/bundle/release/app-release.aab` directly.
If you copy it to the repo root as `equyvo-app.aab`, overwrite it in the
same step and re-run the check on the copy.

### Play Console rollout errors

- **"This release does not add or remove any app bundles"** — the uploaded
  AAB's `versionCode` is already in Play's bundle library (or the file is a
  stale copy from an earlier build). Rebuild with a higher code; do not
  re-upload an old file.
- **"You can't roll out this release because it doesn't allow any existing
  users to upgrade…"** — same root cause: `versionCode` is not strictly
  higher, or the package name / upload signing key changed. Keep
  `applicationId` and `equyvo-release.keystore` unchanged.
- Device support must never shrink. Do not raise `minSdkVersion`, do not
  add required `<uses-feature>` entries, and do not add `abiFilters`. The
  camera/mic features are already declared `android:required="false"`, and
  the bundle contains no native `.so` files, so no ABI splits are dropped.
  Check **Play Console → Reach and devices → Device catalog** after upload
  if Play reports a device-support regression.
