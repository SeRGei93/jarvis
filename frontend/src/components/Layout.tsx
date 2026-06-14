import { AppShell, Burger, Group, NavLink, ScrollArea, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { NavLink as RouterLink, Outlet, useLocation } from "react-router-dom";
import { NAV } from "../nav.js";

/**
 * AppShell with a data-driven sidebar (from NAV) and a routed content area
 * (<Outlet/>). On mobile the navbar collapses behind a burger. Adding a screen
 * is purely a NAV edit — this component needs no changes.
 */
export function Layout() {
  const [opened, { toggle, close }] = useDisclosure();
  const { pathname } = useLocation();

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 240, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" gap="sm">
          <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
          <Title order={4}>jarvis admin</Title>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="xs">
        <ScrollArea>
          {NAV.map((entry) => {
            const Icon = entry.icon;
            return (
              <NavLink
                key={entry.path}
                component={RouterLink}
                to={`/${entry.path}`}
                label={entry.label}
                leftSection={<Icon size={18} stroke={1.5} />}
                active={pathname === `/${entry.path}`}
                onClick={close}
              />
            );
          })}
        </ScrollArea>
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
