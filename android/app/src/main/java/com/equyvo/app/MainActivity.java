package com.equyvo.app;

import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import androidx.activity.EdgeToEdge;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

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

        final View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout());
            int top = Math.min(bars.top, 96);
            int bottom = Math.min(bars.bottom, 64);
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
    public void onDestroy() {
        insetHandler.removeCallbacksAndMessages(null);
        super.onDestroy();
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
