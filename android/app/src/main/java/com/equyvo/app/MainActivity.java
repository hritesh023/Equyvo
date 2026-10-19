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

        // Deterministic safe-area handling for ALL Android versions.
        //
        // Capacitor 8's SystemBars compensation only pads/we- adjusts on
        // SDK >= 35; on Android 14 and below Capacitor still lays the app out
        // edge-to-edge, so page headers ended up under the status bar. Here
        // we (1) pad the content root by the real system-bar + cutout insets
        // — works on every API level — and (2) return insets with the system
        // bars zeroed (IME preserved) so nothing downstream (SystemBars CSS
        // vars, WebView env(), child padding) applies the SAME inset a
        // second time. Keyboard/IME insets pass through untouched, so
        // Capacitor's IME padding keeps the composer above the keyboard.
        final View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return new WindowInsetsCompat.Builder(windowInsets)
                    .setInsets(
                            WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(),
                            Insets.of(0, 0, 0, 0))
                    .build();
        });
    }
}
