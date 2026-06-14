import { createTheme, type MantineColorsTuple } from "@mantine/core";
import WebApp from "@twa-dev/sdk";

/** Expand a single hex into the 10-shade tuple Mantine expects. */
function tuple(hex: string): MantineColorsTuple {
  return Array.from({ length: 10 }, () => hex) as unknown as MantineColorsTuple;
}

/**
 * Build a Mantine theme from Telegram's themeParams so the Mini App matches the
 * surrounding client chrome. Unknown params fall back to Mantine defaults.
 */
export function buildTheme() {
  const tp = WebApp.themeParams ?? {};
  const button = tp.button_color;

  return createTheme({
    primaryColor: button ? "tg" : "blue",
    colors: button ? { tg: tuple(button) } : {},
    // Telegram drives the page background/text via CSS variables it injects;
    // we keep Mantine's own scheme in sync below in main.tsx.
  });
}

/** "dark" when Telegram reports a dark color scheme, else "light". */
export function tgColorScheme(): "light" | "dark" {
  return WebApp.colorScheme === "dark" ? "dark" : "light";
}
