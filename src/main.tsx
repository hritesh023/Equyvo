import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./globals.css";

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
const EQUYVO_DATA_SCHEMA_V = "2026-10-24-native-nav-fix";
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
