import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import WebApp from "@twa-dev/sdk";
import { App } from "./App.js";
import { buildTheme, tgColorScheme } from "./lib/theme.js";

// Tell Telegram the Mini App is ready and request the full viewport height.
WebApp.ready();
WebApp.expand();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <MantineProvider theme={buildTheme()} defaultColorScheme={tgColorScheme()}>
      <Notifications position="top-center" />
      <App />
    </MantineProvider>
  </StrictMode>,
);
