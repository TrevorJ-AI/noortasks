package app.noortasks;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NoorNativePlugin.class);
        super.onCreate(savedInstanceState);
        NoorNativePlugin.recordIntent(this, getIntent(), true);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        NoorNativePlugin.recordIntent(this, intent, false);
    }
}
