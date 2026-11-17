package app.noortasks;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.ref.WeakReference;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(name = "NoorNative")
public class NoorNativePlugin extends Plugin {

    public static final String ACTION_QUICK_ADD = "app.noortasks.ACTION_QUICK_ADD";
    public static final String ACTION_OPEN_HASH = "app.noortasks.ACTION_OPEN_HASH";
    public static final String EXTRA_HASH = "noor_hash";

    static final String PREFS_NAME = "noor_prefs";
    static final String KEY_SERVER_URL = "server_url";
    static final String KEY_WIDGET_COMPLETIONS = "pending_widget_completions";

    private static final String LN_ID_KEY = "LocalNotificationId";
    private static final String LN_ACTION_KEY = "LocalNotificationUserAction";
    private static final String LN_OBJ_KEY = "LocalNotficationObject";

    private static final Object LOCK = new Object();
    private static final List<JSObject> PENDING_ACTIONS = new ArrayList<>();
    private static WeakReference<NoorNativePlugin> activeInstance = new WeakReference<>(null);

    @Override
    public void load() {
        super.load();
        synchronized (LOCK) {
            activeInstance = new WeakReference<>(this);
        }
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().addJavascriptInterface(new NoorJsBridge(getContext()), "NoorNativeBridge");
        }
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (LOCK) {
            if (activeInstance.get() == this) {
                activeInstance = new WeakReference<>(null);
            }
        }
        super.handleOnDestroy();
    }

    public static void recordIntent(Context ctx, Intent intent, boolean isColdStart) {
        if (intent == null) return;
        String action = intent.getAction();
        JSObject payload = null;

        if (Intent.ACTION_SEND.equals(action) && "text/plain".equals(intent.getType())) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            if ((text != null && !text.isEmpty()) || (subject != null && !subject.isEmpty())) {
                payload = new JSObject();
                payload.put("type", "share");
                payload.put("text", text != null ? text : "");
                payload.put("subject", subject != null ? subject : "");
                intent.removeExtra(Intent.EXTRA_TEXT);
                intent.removeExtra(Intent.EXTRA_SUBJECT);
            }
        } else if (ACTION_QUICK_ADD.equals(action)) {
            payload = new JSObject();
            payload.put("type", "quickAdd");
            intent.setAction(Intent.ACTION_MAIN);
        } else if (ACTION_OPEN_HASH.equals(action)) {
            String hash = intent.getStringExtra(EXTRA_HASH);
            if (hash != null && !hash.isEmpty()) {
                payload = new JSObject();
                payload.put("type", "openHash");
                payload.put("hash", hash);
                intent.removeExtra(EXTRA_HASH);
                intent.setAction(Intent.ACTION_MAIN);
            }
        } else if (isColdStart && intent.hasExtra(LN_ID_KEY)) {
            String actionId = intent.getStringExtra(LN_ACTION_KEY);
            String rawNotif = intent.getStringExtra(LN_OBJ_KEY);
            payload = new JSObject();
            payload.put("type", "notificationAction");
            payload.put("actionId", actionId != null ? actionId : "tap");
            if (rawNotif != null && !rawNotif.isEmpty()) {
                try {
                    payload.put("notification", new JSObject(rawNotif));
                } catch (JSONException ignored) {}
            }
            intent.removeExtra(LN_ID_KEY);
            intent.removeExtra(LN_ACTION_KEY);
            intent.removeExtra(LN_OBJ_KEY);
        }

        if (payload != null) {
            emitOrQueue(payload);
        }
    }

    static void notifyWidgetCompletionsChanged() {
        JSObject ev = new JSObject();
        ev.put("type", "widgetCompletions");
        emitOrQueue(ev);
    }

    private static void emitOrQueue(JSObject payload) {
        NoorNativePlugin instance;
        synchronized (LOCK) {
            instance = activeInstance.get();
            if (instance == null) {
                PENDING_ACTIONS.add(payload);
                return;
            }
            // Also keep a copy in pending until JS explicitly consumes, or notify directly if webview active
            PENDING_ACTIONS.add(payload);
        }
        instance.notifyListeners("noorAction", payload, false);
    }

    @PluginMethod
    public void consumePendingActions(PluginCall call) {
        JSArray actions = new JSArray();
        synchronized (LOCK) {
            for (JSObject item : PENDING_ACTIONS) {
                actions.put(item);
            }
            PENDING_ACTIONS.clear();
        }
        JSArray completedIds = new JSArray();
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String raw = prefs.getString(KEY_WIDGET_COMPLETIONS, "[]");
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                String id = arr.optString(i, "");
                if (!id.isEmpty()) completedIds.put(id);
            }
        } catch (JSONException ignored) {}
        prefs.edit().remove(KEY_WIDGET_COMPLETIONS).apply();

        JSObject res = new JSObject();
        res.put("actions", actions);
        res.put("completedTaskIds", completedIds);
        call.resolve(res);
    }

    @PluginMethod
    public void setServerUrl(PluginCall call) {
        String url = call.getString("url", "");
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(KEY_SERVER_URL, url != null ? url : "").apply();
        call.resolve();
    }

    @PluginMethod
    public void setSystemBarColor(PluginCall call) {
        String hex = call.getString("color", "#FFFFFF");
        boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", false));
        final int color;
        try {
            color = Color.parseColor(hex);
        } catch (IllegalArgumentException e) {
            call.reject("Invalid color");
            return;
        }
        final Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            Window window = activity.getWindow();
            View decor = window.getDecorView();
            decor.setBackgroundColor(color);
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
            controller.setAppearanceLightStatusBars(!dark);
            controller.setAppearanceLightNavigationBars(!dark);
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
                @SuppressWarnings("deprecation")
                Runnable r = () -> {
                    window.setStatusBarColor(color);
                    window.setNavigationBarColor(color);
                };
                r.run();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void syncWidgetData(PluginCall call) {
        JSArray tasks = call.getArray("tasks");
        String json = tasks != null ? tasks.toString() : "[]";
        TodayWidgetProvider.saveTasksJson(getContext(), json);
        TodayWidgetProvider.refreshAllWidgets(getContext());
        call.resolve();
    }

    public static class NoorJsBridge {
        private final Context ctx;

        NoorJsBridge(Context ctx) {
            this.ctx = ctx.getApplicationContext();
        }

        @JavascriptInterface
        public String getCsrfToken(String url) {
            if (url == null || url.isEmpty()) return "";
            try {
                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies == null || cookies.isEmpty()) return "";
                for (String part : cookies.split(";")) {
                    String trimmed = part.trim();
                    if (trimmed.startsWith("_csrf_token=")) {
                        String val = trimmed.substring("_csrf_token=".length());
                        try {
                            return URLDecoder.decode(val, StandardCharsets.UTF_8.name());
                        } catch (Exception e) {
                            return val;
                        }
                    }
                }
            } catch (Exception ignored) {}
            return "";
        }

        @JavascriptInterface
        public String getServerUrl() {
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            return prefs.getString(KEY_SERVER_URL, "");
        }
    }
}
