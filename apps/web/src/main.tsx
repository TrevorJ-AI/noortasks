import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { AppProvider } from "./ui/ctx";
import { M4Provider } from "./ui/m4ctx";
import { M5Provider } from "./ui/m5ctx";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/views.css";
import "./styles/m4.css";
import "./styles/habits.css";
import "./styles/focus.css";
import "./styles/stats.css";
import "./styles/countdown.css";
import "./styles/summary.css";
import "./styles/m5.css";
import "./styles/cal.css";
import "./styles/m8.css";
import "./styles/polish.css";
import "./styles/settings.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider>
      <M4Provider>
        <M5Provider>
          <App />
        </M5Provider>
      </M4Provider>
    </AppProvider>
  </StrictMode>,
);

import { isCapacitor } from "./lib/capacitor";

if ("serviceWorker" in navigator && import.meta.env.PROD && !isCapacitor() && !new URLSearchParams(location.search).has("nosw")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
