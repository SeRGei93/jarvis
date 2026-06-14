import { Center, Stack, Text, Title } from "@mantine/core";
import { IconLock } from "@tabler/icons-react";

/**
 * Full-screen "no access" state shown when initData is missing (opened outside
 * Telegram) or the backend rejects the admin (401/403).
 */
export function AccessDenied({ detail }: { detail?: string }) {
  return (
    <Center h="100vh" p="md">
      <Stack align="center" gap="sm" maw={360}>
        <IconLock size={48} stroke={1.5} />
        <Title order={2}>Нет доступа</Title>
        <Text c="dimmed" ta="center">
          Эта панель доступна только администраторам и открывается из Telegram.
        </Text>
        {detail ? (
          <Text c="dimmed" size="xs" ta="center">
            {detail}
          </Text>
        ) : null}
      </Stack>
    </Center>
  );
}
