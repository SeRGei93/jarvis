import type { ComponentType } from "react";
import {
  type Icon,
  IconAdjustments,
  IconBox,
  IconChartBar,
  IconCpu,
  IconPlug,
  IconReportMoney,
  IconSparkles,
  IconUsers,
} from "@tabler/icons-react";
import { SkillsScreen } from "./screens/SkillsScreen.js";
import { ModelsScreen } from "./screens/ModelsScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";
import { PromptsScreen } from "./screens/PromptsScreen.js";
import { PlansScreen } from "./screens/PlansScreen.js";
import { UsersScreen } from "./screens/UsersScreen.js";
import { UsageScreen } from "./screens/UsageScreen.js";
import { McpScreen } from "./screens/McpScreen.js";

/** One admin section: a route, a sidebar label/icon, and its screen component. */
export interface NavEntry {
  /** Route path under "/" — also the React Router segment. */
  path: string;
  /** Russian sidebar label. */
  label: string;
  icon: Icon;
  component: ComponentType;
}

/**
 * Single source of truth for the admin navigation. Layout renders the sidebar
 * from this array and App generates a <Route> per entry. To add or replace a
 * screen, add/edit one object here — no other file changes needed.
 */
export const NAV: NavEntry[] = [
  { path: "skills", label: "Скилы", icon: IconSparkles, component: SkillsScreen },
  { path: "models", label: "Модели", icon: IconCpu, component: ModelsScreen },
  { path: "settings", label: "Настройки", icon: IconAdjustments, component: SettingsScreen },
  { path: "prompts", label: "Промпты", icon: IconBox, component: PromptsScreen },
  { path: "plans", label: "Планы", icon: IconReportMoney, component: PlansScreen },
  { path: "users", label: "Пользователи", icon: IconUsers, component: UsersScreen },
  { path: "usage", label: "Использование", icon: IconChartBar, component: UsageScreen },
  { path: "mcp", label: "MCP", icon: IconPlug, component: McpScreen },
];

/** Default landing section (first entry). */
export const DEFAULT_PATH = NAV[0].path;
