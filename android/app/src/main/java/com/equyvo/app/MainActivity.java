package com.equyvo.app;

import android.os.Bundle;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Deterministic, once-and-for-all safe area handling for EVERY device:
        //
        // • Top: pad by the real status-bar + cutout inset, but capped at
        //   44dp — no device on the market has a taller occupied top strip,
        //   and curved phones can report absurdly large cutout boxes.
        // • Sides: never padded — content fills the full width, into the
        //   curved edges ("fully filled" layout).
        // • Bottom: never padded — the WebView extends into the gesture/curve
        //   zone and the bottom nav draws its own fixed interior padding, so
        //   the footer is visually filled to the physical bottom edge.
        // • Downstream (SystemBars CSS vars / WebView env()): system-bar
        //   insets are zeroed so no layer can double-apply. The web app also
        //   marks <html> with .cap-native and uses fixed safe values there.
        // • IME (keyboard) insets are preserved untouched so the chat
        //   composer always rides above the keyboard.
        final View content = findViewById(android.R.id.content);
        final float density = getResources().getDisplayMetrics().density;
        final int maxTopPad = Math.round(44f * density);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            int top = Math.min(Math.max(bars.top, 0), maxTopPad);
            v.setPadding(0, top, 0, 0);
            return new WindowInsetsCompat.Builder(windowInsets)
                    .setInsets(
                            WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(),
                            Insets.of(0, 0, 0, 0))
                    .build();
        });
    }
}
