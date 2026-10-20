import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./globals.css";

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
