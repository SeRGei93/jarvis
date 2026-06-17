import { useCallback, useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Group,
  Loader,
  Stack,
  Switch,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconRefresh, IconTrash } from "@tabler/icons-react";
import type { CronTask, Timestamp } from "../lib/types.js";
import { apiDelete, apiGet, apiPatch } from "../lib/api.js";
import { useAuthGate } from "../components/AuthGate.js";
import { handleApiError, notifyOk } from "./_adminHelpers.js";

/** Local date/time, or "—" for a null timestamp. */
function fmtDate(ts: Timestamp | null): string {
  if (ts == null) return "—";
  const d = new Date(Number(ts));
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** Human-readable schedule: immediate / one-time (+when) / recurring (+cron). */
function scheduleLabel(t: CronTask): string {
  if (t.schedule === "now") return "Сейчас (фон)";
  if (t.schedule === "once") {
    return t.scheduledAt != null ? `Однократно · ${fmtDate(t.scheduledAt)}` : "Однократно";
  }
  return `По расписанию · ${t.schedule}`;
}

/** Owner label: prefer display name, then login name, then a #id fallback. */
function userLabel(t: CronTask): string {
  return t.user.displayName || t.user.name || `#${t.userId}`;
}

/** Coloured badge for the last run outcome (error carries its message as a tooltip). */
function ResultBadge({ task }: { task: CronTask }) {
  if (task.lastRunStatus === "success") return <Badge color="green">успех</Badge>;
  if (task.lastRunStatus === "error") {
    return (
      <Tooltip label={task.lastRunError ?? "ошибка"} multiline w={320} withArrow>
        <Badge color="red">ошибка</Badge>
      </Tooltip>
    );
  }
  return <Text c="dimmed">—</Text>;
}

/**
 * Tasks screen (/tasks): scheduled tasks the assistant created via the `automation`
 * skill. All cron_tasks rows are agent-created, so the page lists them all. Admin
 * can pause/resume (toggle is_active) and delete; creating/editing tasks stays with
 * the agent.
 */
export function TasksScreen() {
  const { reportError } = useAuthGate();
  const [tasks, setTasks] = useState<CronTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ tasks: CronTask[] }>("/tasks");
      setTasks(res.tasks);
    } catch (err) {
      setError(handleApiError(err, reportError));
    } finally {
      setLoading(false);
    }
  }, [reportError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleActive(t: CronTask) {
    setTogglingId(t.id);
    try {
      await apiPatch<CronTask>(`/tasks/${t.id}`, { is_active: !t.isActive });
      notifyOk(t.isActive ? "Задача остановлена" : "Задача возобновлена");
      await load();
    } catch (err) {
      handleApiError(err, reportError);
    } finally {
      setTogglingId(null);
    }
  }

  async function deleteRow(t: CronTask) {
    setDeletingId(t.id);
    try {
      await apiDelete<{ ok: boolean }>(`/tasks/${t.id}`);
      notifyOk("Задача удалена");
      await load();
    } catch (err) {
      handleApiError(err, reportError);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>Задачи</Title>
        <ActionIcon variant="subtle" onClick={() => void load()} aria-label="Обновить">
          <IconRefresh size={18} />
        </ActionIcon>
      </Group>

      <Text size="sm" c="dimmed">
        Задачи, которые ассистент создал через скилл automation. Здесь их можно
        приостановить/возобновить или удалить.
      </Text>

      {error && (
        <Alert color="red" title="Ошибка">
          {error}
        </Alert>
      )}

      {loading ? (
        <Group justify="center" py="xl">
          <Loader />
        </Group>
      ) : (
        <Table.ScrollContainer minWidth={900}>
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Пользователь</Table.Th>
                <Table.Th>Название</Table.Th>
                <Table.Th>Скилл</Table.Th>
                <Table.Th>Расписание</Table.Th>
                <Table.Th>Статус</Table.Th>
                <Table.Th>Последний запуск</Table.Th>
                <Table.Th>Создано</Table.Th>
                <Table.Th ta="right">Действия</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {tasks.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={8}>
                    <Text c="dimmed">
                      Задач пока нет — ассистент ещё не создавал задачи через скилл automation.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ) : (
                tasks.map((t) => (
                  <Table.Tr key={t.id}>
                    <Table.Td>{userLabel(t)}</Table.Td>
                    <Table.Td>
                      <Text size="sm">{t.name}</Text>
                      {t.description && (
                        <Text size="xs" c="dimmed">
                          {t.description}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>{t.skillName || "—"}</Table.Td>
                    <Table.Td>{scheduleLabel(t)}</Table.Td>
                    <Table.Td>
                      <Switch
                        checked={t.isActive}
                        onChange={() => void toggleActive(t)}
                        disabled={togglingId === t.id}
                        aria-label={t.isActive ? "Остановить задачу" : "Возобновить задачу"}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Text size="sm">{fmtDate(t.lastRunAt)}</Text>
                        <ResultBadge task={t} />
                      </Group>
                    </Table.Td>
                    <Table.Td>{fmtDate(t.createdAt)}</Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          loading={deletingId === t.id}
                          onClick={() => void deleteRow(t)}
                          aria-label="Удалить"
                          title="Удалить"
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Group>
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
