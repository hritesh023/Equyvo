package com.equyvo.app;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.app.PictureInPictureParams;
import android.util.Rational;
import androidx.activity.EdgeToEdge;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import java.lang.reflect.Method;

public class MainActivity extends BridgeActivity {

    /** Active instance, used by PipLifecycleService when the task is removed. */
    private static MainActivity activeInstance = null;

    /** Called when the app is swiped away from Recent Apps while PiP is active. */
    public static void onAppTaskRemoved() {
        MainActivity activity = activeInstance;
        if (activity != null) activity.exitSystemPip();
    }

    /**
     * v1.1.0 edge-to-edge + insets contract (Play Console Android-15 guidance):
     * <ul>
     *   <li>Edge-to-edge is enabled EXPLICITLY with the modern, non-deprecated
     *       androidx.activity API before layout, so display is consistent for
     *       ALL users on ALL Android versions — not only where SDK 35 enforces
     *       it.</li>
     *   <li>ALL clearance still owned by the WEB layer (CSS floors 48px top /
     *       28px bottom). Native layer adds NO padding.</li>
     *   <li>Real system-bar + display-cutout insets are measured here, capped
     *       to sane maxima (curved screens can report huge values), and
     *       forwarded to the WebView as CSS custom properties
     *       (--native-safe-top / --native-safe-bottom). The web CSS resolves
     *       max(floor, native) — genuine insets handling without layout risk.
     *       Only value \u200bchanges re-send JS to avoid injection spam.</li>
     *   <li>System-bar + cutout insets are still zeroed downstream so
     *       Capacitor's own CSS injection / parent padding cannot double-apply
     *       on top of the web floors.</li>
     *   <li>IME (keyboard) insets pass through INTACT for Capacitor's keyboard
     *       handling.</li>
     * </ul>
     */
    private static final long RETRY_DELAY_MS = 120L;
    private static final int MAX_RETRIES = 12;

    private String lastInsetsPayload = "";
    private volatile boolean fullscreenActive = false;
    /** True while the web layer shows its draggable IN-APP mini player. */
    private volatile boolean inAppPipActive = false;
    private volatile boolean inPipMode = false;
    private volatile boolean pipPromotionPending = false;
    /** Web layer finished hiding the app UI; the snapshot is media-only. */
    private volatile boolean pipSnapshotReady = false;
    /** Tracks foreground state (Activity has no public isResumed()). */
    private volatile boolean appResumed = true;
    /** Aspect of the actual upload (width/height), reported by the web layer. */
    private volatile int pipAspectWidth = 9;
    private volatile int pipAspectHeight = 16;
    private final Handler systemPipHandler = new Handler(Looper.getMainLooper());
    private int pendingTop = 0;
    private int pendingBottom = 0;
    private int pendingRetry = 0;
    private final Handler insetHandler = new Handler(Looper.getMainLooper());
    private final Runnable forwardInsetsRunnable = new Runnable() {
        @Override
        public void run() {
            forwardInsetsToWeb();
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must run before super.onCreate / setContentView (modern edge-to-edge).
        try {
            EdgeToEdge.enable(this);
        } catch (Throwable ignored) {}
        if (android.os.Build.VERSION.SDK_INT >= 35) {
            try {
                if (getWindow() != null) {
                    getWindow().setDecorFitsSystemWindows(false);
                }
            } catch (Throwable ignored) {}
        }
        super.onCreate(savedInstanceState);
        activeInstance = this;

        // Expose a system-level Picture-in-Picture trigger to the web layer.
        final Handler pipHandler = new Handler(Looper.getMainLooper());
        final Runnable registerPip = new Runnable() {
            @Override
            public void run() {
                try {
                    if (bridge != null && bridge.getWebView() != null) {
                        bridge.getWebView().addJavascriptInterface(new PiPBridge(), "AndroidPiP");
                        bridge.getWebView().addJavascriptInterface(new NavBridge(), "AndroidNav");
                        bridge.getWebView().addJavascriptInterface(new LiveBridge(), "EquyvoLive");
                    } else {
                        pipHandler.postDelayed(this, 200L);
                    }
                } catch (Throwable ignored) {}
            }
        };
        pipHandler.postDelayed(registerPip, 200L);

        // Enable native keyboard autofill + DOM storage so the WebView behaves
        // like other apps: password managers, address/contact autofill and
        // keyboard shortcuts work out of the box.
        final Handler webSettingsHandler = new Handler(Looper.getMainLooper());
        final Runnable configureWebView = new Runnable() {
            @Override
            public void run() {
                try {
                    if (bridge != null && bridge.getWebView() != null) {
                        android.webkit.WebSettings ws = bridge.getWebView().getSettings();
                        ws.setJavaScriptEnabled(true);
                        ws.setDomStorageEnabled(true);
                        ws.setDatabaseEnabled(true);
                        ws.setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
                        // Keep the WebView's own InputConnection (captureInput=false) so the
                        // system keyboard keeps its suggestion strip / autocorrect /
                        // spell-check / autofill. Mark the view important for autofill.
                        try { bridge.getWebView().setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_YES); } catch (Throwable ignored) {}
                        try { bridge.getWebView().setSaveEnabled(true); } catch (Throwable ignored) {}
                    } else {
                        webSettingsHandler.postDelayed(this, 200L);
                    }
                } catch (Throwable ignored) {}
            }
        };
        webSettingsHandler.postDelayed(configureWebView, 200L);

        final View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout());
            // WindowInsets are in PHYSICAL pixels; CSS pixels are density-
            // independent (1 CSS px ~= 1 dp). Convert before forwarding so
            // high-density devices don't receive shrunk values. Caps are
            // expressed in CSS pixels to match the web floors.
            float density = 1f;
            try {
                density = getResources().getDisplayMetrics().density;
                if (density <= 0f) density = 1f;
            } catch (Throwable ignored) {}
            int top = Math.min(Math.round(bars.top / density), 96);
            int navBarRes = 0;
            try {
                int resId = getResources().getIdentifier("navigation_bar_height", "dimen", "android");
                if (resId > 0) navBarRes = Math.round(getResources().getDimensionPixelSize(resId) / density);
            } catch (Throwable ignored) {}
            int bottom = Math.min(Math.max(Math.round(bars.bottom / density), navBarRes), 80);
            String payload = top + "/" + bottom;
            if (!payload.equals(lastInsetsPayload)) {
                lastInsetsPayload = payload;
                pendingTop = top;
                pendingBottom = bottom;
                pendingRetry = 0;
                insetHandler.removeCallbacks(forwardInsetsRunnable);
                insetHandler.postDelayed(forwardInsetsRunnable, 60L);
            }
            return new WindowInsetsCompat.Builder(windowInsets)
                    .setInsets(
                            WindowInsetsCompat.Type.systemBars()
                                    | WindowInsetsCompat.Type.displayCutout(),
                            Insets.of(0, 0, 0, 0))
                    .build();
        });
    }

    @Override
    public void onResume() {
        super.onResume();
        appResumed = true;
    }

    @Override
    public void onDestroy() {
        insetHandler.removeCallbacksAndMessages(null);
        // Task removal / app exit must never leave a floating PiP window.
        activeInstance = null;
        exitSystemPip();
        super.onDestroy();
    }

    /** JS bridge exposing the measured bottom nav inset. */
    public class NavBridge {
        @android.webkit.JavascriptInterface
        public int getBottomInset() {
            try {
                View content = findViewById(android.R.id.content);
                if (content != null) {
                    WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(content);
                    if (insets != null) {
                        Insets bars = insets.getInsets(
                                WindowInsetsCompat.Type.systemBars()
                                        | WindowInsetsCompat.Type.displayCutout());
                        float density = 1f;
                        try {
                            density = getResources().getDisplayMetrics().density;
                            if (density <= 0f) density = 1f;
                        } catch (Throwable ignored) {}
                        int navBarRes = 0;
                        try {
                            int resId = getResources().getIdentifier("navigation_bar_height", "dimen", "android");
                            if (resId > 0) navBarRes = Math.round(getResources().getDimensionPixelSize(resId) / density);
                        } catch (Throwable ignored) {}
                        return Math.min(Math.max(Math.round(bars.bottom / density), navBarRes), 80);
                    }
                }
            } catch (Throwable ignored) {}
            return pendingBottom;
        }
    }

    /**
     * During a screen live the user may browse anywhere inside Equyvo, but
     * MediaProjection captures whatever is on screen. FLAG_SECURE makes this
     * window invisible to screen capture (it renders black in the recording),
     * so no Equyvo screen ever leaks into the broadcaster's video.
     */
    public class LiveBridge {
        @android.webkit.JavascriptInterface
        public void setSecure(final boolean secure) {
            runOnUiThread(() -> {
                try {
                    if (secure) {
                        getWindow().setFlags(
                            WindowManager.LayoutParams.FLAG_SECURE,
                            WindowManager.LayoutParams.FLAG_SECURE);
                    } else {
                        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
                    }
                } catch (Throwable ignored) {}
            });
        }
    }

    /**
     * Promote the current in-app mini player to a native system PiP window.
     *
     * Before the OS snapshots the Activity we tell the web layer to reveal
     * ONLY the full-screen media (remove the in-app mini window and hide every
     * overlay). That snapshot is what the floating PiP window shows, so it
     * can never contain the app shell/header. The short delay lets the web
     * layout settle before the snapshot is taken.
     */
    private void enterSystemPip() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || isInPictureInPictureMode()) {
            return;
        }
        // onUserLeaveHint(), onPause() and onStop() can all fire for one exit.
        // One promotion only: otherwise the prepare event / snapshot is sent
        // twice and enterPictureInPictureMode() may be called twice.
        if (pipPromotionPending) return;
        pipPromotionPending = true;
        pipSnapshotReady = false;
        try {
            if (bridge != null && bridge.getWebView() != null) {
                bridge.getWebView().evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('prepareForSystemPip'));", null);
            }
        } catch (Throwable ignored) {}

        // Enter SYNCHRONOUSLY. Any handler delay risks Android refusing PiP
        // because the Activity is already stopping. The web layer applies the
        // media-only CSS synchronously on visibilitychange/prepare, and the
        // pipModeChanged(true) event also switches it to content-only after
        // the window appears. Retries in tryEnterPip() cover OEM quirks.
        tryEnterPip();
    }

    private void tryEnterPip() {
        pipPromotionPending = false;
        if (isFinishing() || isDestroyed() || isInPictureInPictureMode()) return;
        try {
            int pw = Math.max(1, Math.min(pipAspectWidth, 239));
            int ph = Math.max(1, Math.min(pipAspectHeight, 239));
            PictureInPictureParams.Builder b = new PictureInPictureParams.Builder()
                    .setAspectRatio(new Rational(pw, ph));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                try { b.setAutoEnterEnabled(false); } catch (Throwable ignored) {}
            }
            enterPictureInPictureMode(b.build());
            inPipMode = isInPictureInPictureMode();
            if (!inPipMode) {
                // One quick retry: some OEMs need a second call after the
                // first layout pass. Still done before the Activity stops.
                systemPipHandler.postDelayed(() -> {
                    try {
                        if (!isFinishing() && !isDestroyed() && !isInPictureInPictureMode()) {
                            enterPictureInPictureMode(b.build());
                            inPipMode = isInPictureInPictureMode();
                        }
                    } catch (Throwable ignored) {}
                    if (!inPipMode) {
                        systemPipHandler.postDelayed(() -> {
                            try {
                                if (!isFinishing() && !isDestroyed() && !isInPictureInPictureMode()) {
                                    enterPictureInPictureMode(b.build());
                                    inPipMode = isInPictureInPictureMode();
                                }
                            } catch (Throwable ignored) {}
                            if (!inPipMode) restoreWebAfterFailedPip();
                        }, 450L);
                    }
                }, 150L);
            }
        } catch (Throwable ignored) {
            restoreWebAfterFailedPip();
        }
    }

    private void restoreWebAfterFailedPip() {
        try {
            inAppPipActive = false;
            inPipMode = false;
            if (bridge != null && bridge.getWebView() != null) {
                bridge.getWebView().evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('pipModeChanged',{detail:{active:false}}));", null);
            }
        } catch (Throwable ignored) {}
    }

    /** Dismiss the system PiP window and clear every PiP flag. */
    private void exitSystemPip() {
        systemPipHandler.removeCallbacksAndMessages(null);
        pipPromotionPending = false;
        pipSnapshotReady = false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isInPictureInPictureMode()) {
                // Reflection keeps this compatible with every compile SDK level.
                Method exit = android.app.Activity.class.getMethod("exitPictureInPicture");
                exit.invoke(this);
            }
        } catch (Throwable ignored) {}
        inAppPipActive = false;
        inPipMode = false;
        fullscreenActive = false;
        try { stopService(new Intent(this, PipLifecycleService.class)); } catch (Throwable ignored) {}
        try {
            if (bridge != null && bridge.getWebView() != null) {
                bridge.getWebView().evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('pipModeChanged',{detail:{active:false}}));", null);
            }
        } catch (Throwable ignored) {}
    }

    /** JS bridge for system-level Picture-in-Picture. */
    public class PiPBridge {
        /** Kept for compatibility. Promotes an active in-app PiP to system PiP. */
        @android.webkit.JavascriptInterface
        public void enter() {
            runOnUiThread(() -> {
                if (inAppPipActive || fullscreenActive) enterSystemPip();
            });
        }

        /**
         * Ask the web layer to exit PiP. System PiP dismissal is driven by the
         * OS controls (expand / close / drag-to-close), which fire
         * onPictureInPictureModeChanged -> pipModeChanged on the web side.
         */
        @android.webkit.JavascriptInterface
        public void exit() {
            runOnUiThread(() -> {
                try {
                    if (bridge != null && bridge.getWebView() != null) {
                        bridge.getWebView().evaluateJavascript(
                                "window.dispatchEvent(new CustomEvent('pipModeChanged',{detail:{active:false}}));", null);
                    }
                } catch (Throwable ignored) {}
            });
        }

        @android.webkit.JavascriptInterface
        public void setFullscreenActive(boolean active) {
            fullscreenActive = active;
        }

        /** Set by the web layer when the in-app mini player opens/closes. */
        @android.webkit.JavascriptInterface
        public void setInAppPip(boolean active) {
            inAppPipActive = active;
            try {
                if (active) {
                    // Keep an observer alive so task removal can dismiss PiP.
                    startService(new Intent(MainActivity.this, PipLifecycleService.class));
                } else {
                    stopService(new Intent(MainActivity.this, PipLifecycleService.class));
                }
            } catch (Throwable ignored) {}
        }

        /** Web layer calls this once ONLY the fullscreen media is visible. */
        @android.webkit.JavascriptInterface
        public void readyForSnapshot() {
            pipSnapshotReady = true;
        }

        /** Called by the web layer with the media's measured width/height. */
        @android.webkit.JavascriptInterface
        public void setPipAspect(int width, int height) {
            if (width > 0 && height > 0) {
                pipAspectWidth = width;
                pipAspectHeight = height;
            }
        }

        @android.webkit.JavascriptInterface
        public boolean isInPip() {
            return inPipMode;
        }
    }

    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        // Only promote to a system PiP window when the user explicitly asked
        // for PiP (the in-app mini player is active). A plain full-screen
        // viewer must simply background like any other screen.
        if (inAppPipActive) enterSystemPip();
    }

    @Override
    public void onPause() {
        super.onPause();
        appResumed = false;
        // Belt-and-braces fallback: many OEMs skip onUserLeaveHint. If the app
        // is really backgrounded (not just briefly paused) while the in-app
        // mini player is active, promote it to the system PiP window.
        if (inAppPipActive && !isFinishing() && !isInPictureInPictureMode()) {
            enterSystemPip();
        }
    }

    @Override
    public void onStop() {
        super.onStop();
        // Some OEMs / navigation paths do not call onUserLeaveHint (recents,
        // screen off, app switcher). Cover those here so a PiP request always
        // turns into a persistent system window when the app is left.
        if (inAppPipActive && !isInPictureInPictureMode() && !isFinishing()) {
            enterSystemPip();
        }
    }

    @Override
    public void onStart() {
        super.onStart();
        // Returning from a system PiP window that was dismissed while the app
        // was in the background: make sure the web layer restores its normal
        // full-screen viewer instead of a stale content-only appearance.
        if (!isInPictureInPictureMode() && inPipMode) {
            inPipMode = false;
            systemPipHandler.postDelayed(() -> {
                try {
                    if (bridge != null && bridge.getWebView() != null) {
                        bridge.getWebView().evaluateJavascript(
                                "window.dispatchEvent(new CustomEvent('pipModeChanged',{detail:{active:false}}));", null);
                    }
                } catch (Throwable ignored) {}
            }, 120L);
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, android.content.res.Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        inPipMode = isInPictureInPictureMode;
        try {
            if (bridge != null && bridge.getWebView() != null) {
                String js = "window.dispatchEvent(new CustomEvent('pipModeChanged',{detail:{active:" + isInPictureInPictureMode + "}}));";
                bridge.getWebView().evaluateJavascript(js, null);
            }
        } catch (Throwable ignored) {}
        // When the system PiP window is dismissed (expand, close button,
        // drag-to-middle/close gesture, or removed from recents) the PiP view
        // must exit cleanly: clear all PiP state so nothing is left on screen.
        if (!isInPictureInPictureMode) {
            inAppPipActive = false;
            pipPromotionPending = false;
            if (isFinishing()) fullscreenActive = false;
        }
    }

    /**
     * Publishes the measured insets into the web layer as CSS custom
     * properties. Retries briefly while the WebView finishes attaching, then
     * gives up silently (web floors remain a safe fallback).
     */
    private void forwardInsetsToWeb() {
        if (isFinishing() || isDestroyed()) {
            return;
        }
        if (bridge != null && bridge.getWebView() != null) {
            String js = "(function(){var d=document.documentElement;"
                    + "d.style.setProperty('--native-safe-top','" + pendingTop + "px');"
                    + "d.style.setProperty('--native-safe-bottom','" + pendingBottom + "px');"
                    + "d.classList.add('cap-native');"
                    + "d.setAttribute('data-native-insets','" + lastInsetsPayload + "');})();";
            bridge.getWebView().evaluateJavascript(js, null);
            return;
        }
        if (pendingRetry < MAX_RETRIES) {
            pendingRetry++;
            insetHandler.postDelayed(forwardInsetsRunnable, RETRY_DELAY_MS);
        }
    }
}
