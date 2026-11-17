package app.noortasks;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

public class TodayWidgetService extends RemoteViewsService {

    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new TodayRemoteViewsFactory(getApplicationContext());
    }

    private static class WidgetTask {
        final String id;
        final String projectId;
        final String title;
        final String dueLabel;
        final int priority;

        WidgetTask(String id, String projectId, String title, String dueLabel, int priority) {
            this.id = id;
            this.projectId = projectId;
            this.title = title;
            this.dueLabel = dueLabel;
            this.priority = priority;
        }
    }

    private static class TodayRemoteViewsFactory implements RemoteViewsFactory {
        private final Context ctx;
        private final List<WidgetTask> items = new ArrayList<>();

        TodayRemoteViewsFactory(Context ctx) {
            this.ctx = ctx;
        }

        @Override
        public void onCreate() {}

        @Override
        public void onDataSetChanged() {
            items.clear();
            JSONArray arr = TodayWidgetProvider.loadTasks(ctx);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                String id = o.optString("id", "");
                if (id.isEmpty()) continue;
                items.add(new WidgetTask(
                    id,
                    o.optString("projectId", ""),
                    o.optString("title", "Untitled"),
                    o.optString("dueLabel", ""),
                    o.optInt("priority", 0)
                ));
            }
        }

        @Override
        public void onDestroy() {
            items.clear();
        }

        @Override
        public int getCount() {
            return items.size();
        }

        @Override
        public RemoteViews getViewAt(int position) {
            if (position < 0 || position >= items.size()) return null;
            WidgetTask item = items.get(position);
            RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget_today_item);
            rv.setTextViewText(R.id.widget_item_title, item.title);
            if (item.dueLabel.isEmpty()) {
                rv.setViewVisibility(R.id.widget_item_due, View.GONE);
            } else {
                rv.setViewVisibility(R.id.widget_item_due, View.VISIBLE);
                rv.setTextViewText(R.id.widget_item_due, item.dueLabel);
            }

            int dotColor = priorityColor(item.priority);
            rv.setInt(R.id.widget_item_dot, "setColorFilter", dotColor);

            Intent toggleFill = new Intent();
            toggleFill.putExtra(TodayWidgetProvider.EXTRA_WIDGET_ACTION, "toggle");
            toggleFill.putExtra(TodayWidgetProvider.EXTRA_TASK_ID, item.id);
            toggleFill.putExtra(TodayWidgetProvider.EXTRA_PROJECT_ID, item.projectId);
            rv.setOnClickFillInIntent(R.id.widget_item_check, toggleFill);

            Intent openFill = new Intent();
            openFill.putExtra(TodayWidgetProvider.EXTRA_WIDGET_ACTION, "open");
            openFill.putExtra(TodayWidgetProvider.EXTRA_TASK_ID, item.id);
            openFill.putExtra(TodayWidgetProvider.EXTRA_PROJECT_ID, item.projectId);
            rv.setOnClickFillInIntent(R.id.widget_item_title, openFill);
            rv.setOnClickFillInIntent(R.id.widget_item_due, openFill);

            return rv;
        }

        private static int priorityColor(int priority) {
            if (priority >= 5) return Color.parseColor("#E05252");
            if (priority >= 3) return Color.parseColor("#E69C24");
            if (priority >= 1) return Color.parseColor("#3B82F6");
            return Color.parseColor("#9CA3AF");
        }

        @Override
        public RemoteViews getLoadingView() {
            return null;
        }

        @Override
        public int getViewTypeCount() {
            return 1;
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public boolean hasStableIds() {
            return false;
        }
    }
}
