package com.equyvo.app;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/**
 * Lightweight service used ONLY to observe task removal.
 *
 * Android does not notify an Activity when the user swipes the app off the
 * Recent Apps list — but a started Service receives onTaskRemoved(). Equyvo
 * starts this service while the in-app PiP mini player is active, so removing
 * the task can dismiss the system PiP window completely instead of leaving a
 * floating window behind. It shows no notification and holds no resources.
 */
public class PipLifecycleService extends Service {

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Do NOT restart on its own: it exists only for the current PiP session.
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // App was removed from Recents while PiP was active — exit PiP entirely.
        try { MainActivity.onAppTaskRemoved(); } catch (Throwable ignored) {}
        try { stopSelf(); } catch (Throwable ignored) {}
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
