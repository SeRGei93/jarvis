import { useCallback, useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconRefresh, IconRotateClockwise } from "@tabler/icons-react";
import { apiDelete, apiGet } from "../lib/api.js";
import { useAuthGate } from "../components/AuthGate.js";
import { daysAgoIso, fmtCost, handleApiError, notifyOk } from "./_adminHelpers.js";

interface UsageRowAgg {
  userId: number;
  cost: number;
  requests: number;
}

interface UsageAggResponse {
  since: string | null;
  users: UsageRowAgg[];
  total: { cost: number; requests: number };
}

/** Minimal user shape we need to label rows (names from GET /users). */
interface UserLabel {
  id: number;
  name: string;
  displayName: string;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function UsageScreen() {
  const { reportError } = useAuthGate();
  const [since, setSince] = useState<string>(daysAgoIso(30));
  const [data, setData] = useState<UsageAggResponse | null>(null);
  const [names, setNames] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<number | null>(null);

  const validSince = since === "" || ISO_RE.test(since);

  const load = useCallback(
    async (sinceValue: string) => {
      setLoading(true);
      setError(null);
      try {
        const qs = ISO_RE.test(sinceValue) ? `?since=${encodeURIComponent(sinceValue)}` : "";
        const [usage, usersRes] = await Promise.all([
          apiGet<UsageAggResponse>(`/usage${qs}`),
          apiGet<{ users: UserLabel[] }>("/users").catch(() => ({ users: [] as UserLabel[] })),
        ]);
        setData(usage);
        setNames(
          Object.fromEntries(
            usersRes.users.map((u) => [u.id, u.displayName || u.name || `#${u.id}`]),
          ),
        );
      } catch (err) {
        setError(handleApiError(err, reportError));
      } finally {
        setLoading(false);
      }
    },
    [reportError],
  );

  useEffect(() => {
    void load(since);
    // initial load only; subsequent loads are triggered by the "Применить" button
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function resetRateLimit(userId: number) {
    setResettingId(userId);
    try {
      await apiDelete<{ ok: boolean }>(`/usage/ratelimit/${userId}`);
      notifyOk(`Лимит пользователя #${userId} сброшен`);
    } catch (err) {
      handleApiError(err, reportError);
    } finally {
      setResettingId(null);
    }
  }

  const rows = data?.users ?? [];

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>Использование</Title>
        <ActionIcon variant="subtle" onClick={() => void load(since)} aria-label="Обновить">
          <IconRefresh size={18} />
        </ActionIcon>
      </Group>

      <Card withBorder padding="md" radius="md">
        <Group align="flex-end" wrap="wrap">
          <TextInput
            label="С даты (YYYY-MM-DD)"
            placeholder="2026-06-01"
            value={since}
            onChange={(e) => setSince(e.currentTarget.value)}
            error={!validSince ? "Формат YYYY-MM-DD" : undefined}
            w={200}
          />
          <Button onClick={() => void load(since)} disabled={!validSince} loading={loading}>
            Применить
          </Button>
          <Text size="xs" c="dimmed">
            Пусто = за всё время.
          </Text>
        </Group>
      </Card>

      {error && (
        <Alert color="red" title="Ошибка">
          {error}
        </Alert>
      )}

      {data && (
        <Group gap="xs">
          <Badge variant="light" color="grape" size="lg">
            Итого: {fmtCost(data.total.cost)}
          </Badge>
          <Badge variant="light" size="lg">
            Запросов: {data.total.requests}
          </Badge>
        </Group>
      )}

      {loading ? (
        <Group justify="center" py="xl">
          <Loader />
        </Group>
      ) : (
        <Table.ScrollContainer minWidth={600}>
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Пользователь</Table.Th>
                <Table.Th ta="right">Стоимость</Table.Th>
                <Table.Th ta="right">Запросов</Table.Th>
                <Table.Th ta="right">Действия</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={4}>
                    <Text c="dimmed">Нет данных за выбранный период.</Text>
                  </Table.Td>
                </Table.Tr>
              ) : (
                rows.map((r) => (
                  <Table.Tr key={r.userId}>
                    <Table.Td>
                      <Text fw={600}>{names[r.userId] ?? `#${r.userId}`}</Text>
                      <Text size="xs" c="dimmed">
                        id {r.userId}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">{fmtCost(r.cost)}</Table.Td>
                    <Table.Td ta="right">{r.requests}</Table.Td>
                    <Table.Td ta="right">
                      <Button
                        size="xs"
                        variant="light"
                        color="orange"
                        leftSection={<IconRotateClockwise size={14} />}
                        loading={resettingId === r.userId}
                        onClick={() => void resetRateLimit(r.userId)}
                      >
                        Сбросить лимит
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  );
}
