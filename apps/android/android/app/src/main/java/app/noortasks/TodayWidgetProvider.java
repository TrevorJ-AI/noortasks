package app.noortasks;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public class TodayWidgetProvider extends AppWidgetProvider {

    static final String WIDGET_PREFS = "noor_widget";
    static final String KEY_TASKS_JSON = "today_tasks";
    static final String ACTION_WIDGET_ITEM = "app.noortasks.ACTION_WIDGET_ITEM";
    static final String EXTRA_WIDGET_ACTION = "widget_action";
    static final String EXTRA_TASK_ID = "task_id";
    static final String EXTRA_PROJECT_ID = "project_id";

    static void saveTasksJson(Context ctx, String json) {
        ctx.getSharedPreferences(WIDGET_PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_TASKS_JSON, json != null ? json : "[]")
            .apply();
    }

    static JSONArray loadTasks(Context ctx) {
        String raw = ctx.getSharedPreferences(WIDGET_PREFS, Context.MODE_PRIVATE)
            .getString(KEY_TASKS_JSON, "[]");
        try {
            return new JSONArray(raw);
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    public static void refreshAllWidgets(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, TodayWidgetProvider.class));
        if (ids == null || ids.length == 0) return;
        mgr.notifyAppWidgetViewDataChanged(ids, R.id.widget_list);
        for (int id : ids) {
            updateWidget(ctx, mgr, id);
        }
    }

    static void updateWidget(Context ctx, AppWidgetManager mgr, int appWidgetId) {
        RemoteViews views = new RemoteViews(ctx.getPackageName(), R.layout.widget_today);

        JSONArray tasks = loadTasks(ctx);
        int count = tasks.length();
        views.setTextViewText(R.id.widget_count, count > 0 ? String.valueOf(count) : "");
        views.setViewVisibility(R.id.widget_empty, count == 0 ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.widget_list, count == 0 ? View.GONE : View.VISIBLE);

        // Header click -> open Today view
        Intent todayIntent = new Intent(ctx, MainActivity.class);
        todayIntent.setAction(NoorNativePlugin.ACTION_OPEN_HASH);
        todayIntent.putExtra(NoorNativePlugin.EXTRA_HASH, "#q/today/tasks");
        todayIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent todayPi = PendingIntent.getActivity(
            ctx,
            2001,
            todayIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.widget_title, todayPi);

        // "+" button -> Quick Add
        Intent addIntent = new Intent(ctx, MainActivity.class);
        addIntent.setAction(NoorNativePlugin.ACTION_QUICK_ADD);
        addIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent addPi = PendingIntent.getActivity(
            ctx,
            2002,
            addIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.widget_add_btn, addPi);

        // ListView adapter
        Intent svcIntent = new Intent(ctx, TodayWidgetService.class);
        svcIntent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        svcIntent.setData(Uri.parse(svcIntent.toUri(Intent.URI_INTENT_SCHEME)));
        views.setRemoteAdapter(R.id.widget_list, svcIntent);
        views.setEmptyView(R.id.widget_list, R.id.widget_empty);

        // Item click template -> broadcast handled in onReceive
        Intent itemIntent = new Intent(ctx, TodayWidgetProvider.class);
        itemIntent.setAction(ACTION_WIDGET_ITEM);
        itemIntent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        PendingIntent itemPi = PendingIntent.getBroadcast(
            ctx,
            appWidgetId,
            itemIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE
        );
        views.setPendingIntentTemplate(R.id.widget_list, itemPi);

        mgr.updateAppWidget(appWidgetId, views);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int id : appWidgetIds) {
            updateWidget(context, appWidgetManager, id);
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (!ACTION_WIDGET_ITEM.equals(intent.getAction())) return;

        String action = intent.getStringExtra(EXTRA_WIDGET_ACTION);
        String taskId = intent.getStringExtra(EXTRA_TASK_ID);
        String projectId = intent.getStringExtra(EXTRA_PROJECT_ID);
        if (taskId == null || taskId.isEmpty()) return;

        if ("toggle".equals(action)) {
            markTaskCompletedInWidget(context, taskId);
            refreshAllWidgets(context);
            NoorNativePlugin.notifyWidgetCompletionsChanged();
        } else if ("open".equals(action)) {
            String hash = (projectId != null && !projectId.isEmpty())
                ? "#p/" + projectId + "/tasks/" + taskId
                : "#q/today/tasks";
            Intent openIntent = new Intent(context, MainActivity.class);
            openIntent.setAction(NoorNativePlugin.ACTION_OPEN_HASH);
            openIntent.putExtra(NoorNativePlugin.EXTRA_HASH, hash);
            openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            context.startActivity(openIntent);
        }
    }

    private void markTaskCompletedInWidget(Context ctx, String taskId) {
        JSONArray current = loadTasks(ctx);
        JSONArray next = new JSONArray();
        for (int i = 0; i < current.length(); i++) {
            JSONObject obj = current.optJSONObject(i);
            if (obj == null) continue;
            if (!taskId.equals(obj.optString("id"))) {
                next.put(obj);
            }
        }
        saveTasksJson(ctx, next.toString());

        SharedPreferences prefs = ctx.getSharedPreferences(NoorNativePlugin.PREFS_NAME, Context.MODE_PRIVATE);
        String raw = prefs.getString(NoorNativePlugin.KEY_WIDGET_COMPLETIONS, "[]");
        JSONArray pending;
        try {
            pending = new JSONArray(raw);
        } catch (JSONException e) {
            pending = new JSONArray();
        }
        boolean exists = false;
        for (int i = 0; i < pending.length(); i++) {
            if (taskId.equals(pending.optString(i))) {
                exists = true;
                break;
            }
        }
        if (!exists) pending.put(taskId);
        prefs.edit().putString(NoorNativePlugin.KEY_WIDGET_COMPLETIONS, pending.toString()).apply();
    }
}
