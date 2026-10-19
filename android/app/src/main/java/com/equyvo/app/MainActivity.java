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
        // Android 15/16 (targetSdk 35/36) enforce edge-to-edge: without this,
        // the WebView draws UNDER the status bar and the top of every page
        // (Home, Discover, Moments, Thoughts, Settings headers…) is covered.
        // Pad the content root so the app sits between the system bars. The
        // insets are passed through so Capacitor's own keyboard/IME handling
        // still sees them.
        View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return windowInsets;
        });
    }
}
