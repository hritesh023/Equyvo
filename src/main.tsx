import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./globals.css";

/*
 * GLOBAL MEDIA FAILSAFE.
 *
 * Deleted content, expired CDN URLs and blocked hosts previously left the
 * browser's broken-image icon inline in feeds, profiles and comments. One
 * capture-phase listener swaps any failed <img> for a neutral Equyvo
 * placeholder (once per element), so a stale URL degrades quietly instead of
 * looking like a broken app. Local components with their own fallbacks still
 * win because their React onError runs after this and can replace the src.
 */
const MEDIA_PLACEHOLDER =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#2a2a33"/>
          <stop offset="1" stop-color="#17171d"/>
        </linearGradient>
      </defs>
      <rect width="160" height="160" fill="url(#g)"/>
      <g fill="none" stroke="#6b7280" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="40" y="48" width="80" height="64" rx="10"/>
        <circle cx="62" cy="70" r="8"/>
        <path d="M44 104l24-24 18 18 12-12 18 18"/>
      </g>
    </svg>`,
  );

try {
  document.addEventListener(
    "error",
    (event) => {
      const el = event.target as HTMLElement | null;
      if (!el || el.tagName !== "IMG") return;
      const img = el as HTMLImageElement;
      if (img.dataset.equyvoFallback === "1") return;
      // An explicit zero-length src is intentional (avatar placeholder) —
      // leave it to the component, don't paint a placeholder over initials.
      const src = img.getAttribute("src") || "";
      if (!src.trim()) return;
      img.dataset.equyvoFallback = "1";
      img.removeAttribute("srcset");
      img.src = MEDIA_PLACEHOLDER;
      img.classList.add("equyvo-media-fallback");
    },
    true,
  );
} catch { /* non-browser environment */ }


/*
 * LOCAL CONTENT-CACHE SCHEMA RESET.
 *
 * The production content store was purged (no seeded/dev/tester content may
 * exist anywhere). Devices cache content locally — saved posts, watch
 * history, uploaded stories, follow graph, hidden ids, chat contacts and
 * dismissed notification ids — and an app update keeps the same WebView
 * origin, so old caches would resurface content that no longer exists on
 * the server. Every build bumps EQUYVO_DATA_SCHEMA_V: any device opening
 * this build with an older schema clears content caches once. Account data
 * (stored user/token, profile/avatar, plans, settings, theme, language) is
 * NEVER touched.
 */
const EQUYVO_DATA_SCHEMA_V = "2026-10-26-identity-email-privacy";
try {
  if (localStorage.getItem("equyvo_data_schema_v") !== EQUYVO_DATA_SCHEMA_V) {
    const CONTENT_CACHE_KEYS = [
      "savedContentData",          // saved posts data (content repo)
      "savedPosts",                // saved-post id set
      "savedStories",              // saved stories (data + ids)
      "savedThoughts",             // saved thoughts (ids)
      "userReactedThoughts",       // reacted thoughts (data + ids)
      "equyvo_saved_ids",          // saved-content id set, if any
      "equyvo_liked_stories",      // story like ledger (content ids)
      "userUploadedStories",       // local story uploads
      "equyvo_watch_history",      // watch history feed
      "watchHistory",              // legacy watch-history key
      "equyvo_hidden_ids",         // hidden content ids
      "equyvo_following",          // local follow graph
      "equyvo_social_profiles",    // cached follower/following profiles
      "equyvo_chat_contacts",      // cached chat contacts
      "equyvo_chat_v2_threads",    // cached chat thread list (account-scoped)
      "equyvo_chat_v2_messages",   // cached chat messages (account-scoped)
      "equyvo_notifications_v1",   // cached notification rows (account-scoped)
      "equyvo_notif_dismissed_v1", // dismissed notification ids
      "equyvo_active_live",        // stale "someone is live" banner
      "equyvo_live_notifications", // stale live notification history
      // Legacy content caches from older builds:
      "posts", "thoughts", "stories", "moments", "equyvo_content_cache",
      "userMoments", "userThoughts", "contentData",
    ];
    for (const key of CONTENT_CACHE_KEYS) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    }
    // The own-profile cache (userProfile) keeps account fields (name, avatar,
    // bio) but must not keep locally cached posts/stories — the server store
    // is empty, so stale local copies would show content that doesn't exist.
    try {
      const rawProfile = localStorage.getItem("userProfile");
      if (rawProfile) {
        const parsed = JSON.parse(rawProfile);
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.posts) && parsed.posts.length > 0) {
          parsed.posts = [];
          localStorage.setItem("userProfile", JSON.stringify(parsed));
        }
      }
    } catch { /* ignore */ }
    localStorage.setItem("equyvo_data_schema_v", EQUYVO_DATA_SCHEMA_V);
  }
} catch { /* storage unavailable — proceed */ }

try {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    document.body.innerHTML = '<div style="color: red; padding: 20px;">❌ Root element not found</div>';
    throw new Error("Root element not found");
  }

  const root = createRoot(rootElement);
  // ROOT error boundary: catches failures the inner boundary (inside the
  // Router) cannot — crash on mount, at provider level, or before render.
  // It falls back to plain window.location navigation outside Router context.
  root.render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );

  // DEPLOY RESILIENCE — stale chunk auto-recovery. When a new release is
  // deployed, an already-open tab keeps requesting JS bundles that no longer
  // exist, producing "Failed to fetch dynamically imported module" style
  // errors and a blank screen. Detect that signature once per session and
  // silently reload into the fresh build. One-shot with post-success re-arm:
  // a healthy boot clears the guard so the next deploy can also auto-heal.
  const CHUNK_FAIL = /(failed to fetch dynamically imported module|importing a module script failed|loading chunk \w+ failed|dynamically imported module)/i;
  let chunkRecovering = false;
  try {
    if (sessionStorage.getItem("equyvo_chunk_reload") === "1") chunkRecovering = true;
  } catch { /* ignore */ }
  const recoverFromStaleChunk = () => {
    try {
      if (chunkRecovering) return;
      chunkRecovering = true;
      sessionStorage.setItem("equyvo_chunk_reload", "1");
    } catch { /* ignore */ }
    window.location.reload();
  };
  window.addEventListener("error", (e) => {
    const msg = String((e as ErrorEvent).message || (e as ErrorEvent).filename || "");
    if (CHUNK_FAIL.test(msg)) recoverFromStaleChunk();
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = (e as PromiseRejectionEvent).reason as { message?: string } | undefined;
    if (CHUNK_FAIL.test(String(reason?.message || reason || ""))) recoverFromStaleChunk();
  });
  // Vite's explicit preload signal (fires when a hashed chunk was removed by
  // a deploy while this tab was open).
  window.addEventListener("vite:preloadError", (e) => {
    try { (e as Event).preventDefault(); } catch { /* ignore */ }
    recoverFromStaleChunk();
  });
  // Fresh build booted fine (no failure within 15s): re-arm for next deploy.
  setTimeout(() => {
    try { sessionStorage.removeItem("equyvo_chunk_reload"); } catch { /* ignore */ }
  }, 15000);

} catch (error) {
  document.body.innerHTML = `
    <div style="padding: 20px; background: #ff4444; color: white; font-family: monospace;">
      <h1>❌ App Failed to Start</h1>
      <p>Error: ${error instanceof Error ? error.message : String(error)}</p>
      <details>
        <summary>Stack Trace</summary>
        <pre>${error instanceof Error ? error.stack : ""}</pre>
      </details>
    </div>
  `;
}

/*
 * BUNDLE-FRESHNESS SELF-HEAL (boot time).
 *
 * A device whose WebView cached the previous release's index.html boots the
 * OLD bundle even after the page is reopened — features then behave like a
 * ghost release and fixed bugs "come back". This runs once per session after
 * boot: fetch a cache-busted copy of the deployed index.html, compare the
 * entry bundle name (index-<hash>.js) it ships against the one actually
 * running, and reload once into the fresh build when they differ. The
 * sessionStorage guard makes it a single attempt (no reload loops) and a
 * healthy boot clears it, re-arming for the next deploy.
 */
try {
  if (import.meta.env.PROD) {
    const SELF_HEAL_KEY = "equyvo_bundle_selfheal";
    const alreadyHealed = (() => {
      try { return sessionStorage.getItem(SELF_HEAL_KEY) === "1"; } catch { return false; }
    })();
    const localBase = (() => {
      const src = Array.from(document.scripts).find((s) => s.type === "module" && s.src)?.src || "";
      return (src.match(/index-[\w-]+\.js/) || [""])[0];
    })();
    if (!alreadyHealed && localBase) {
      fetch(`/index.html?v=${Date.now()}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.text() : ""))
        .then((html) => {
          const remoteBase = (String(html).match(/index-[\w-]+\.js/) || [""])[0];
          if (!remoteBase || remoteBase === localBase) return;
          try { sessionStorage.setItem(SELF_HEAL_KEY, "1"); } catch { /* ignore */ }
          window.location.reload();
        })
        .catch(() => { /* offline or fetch blocked — keep running */ });
    }
  }
} catch { /* non-browser environment */ }
