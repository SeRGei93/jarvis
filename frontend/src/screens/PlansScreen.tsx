import { useCallback, useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Group,
  Loader,
  NumberInput,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconDeviceFloppy, IconPlus, IconRefresh, IconTrash } from "@tabler/icons-react";
import type { Plan } from "../lib/types.js";
import { apiDelete, apiGet, apiPatch, apiPost } from "../lib/api.js";
import { useAuthGate } from "../components/AuthGate.js";
import { handleApiError, notifyOk } from "./_adminHelpers.js";

/** Per-row editable draft (kept separate so unsaved edits don't fight reloads). */
interface PlanDraft {
  name: string;
  hourlyLimit: number | "";
  maxTasks: number | "";
}

function draftOf(p: Plan): PlanDraft {
  return { name: p.name, hourlyLimit: p.hourlyLimit, maxTasks: p.maxTasks };
}

function draftDirty(p: Plan, d: PlanDraft): boolean {
  return d.name !== p.name || d.hourlyLimit !== p.hourlyLimit || d.maxTasks !== p.maxTasks;
}

export function PlansScreen() {
  const { reportError } = useAuthGate();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [drafts, setDrafts] = useState<Record<number, PlanDraft>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // add form
  const [newName, setNewName] = useState("");
  const [newHourly, setNewHourly] = useState<number | "">(0);
  const [newMax, setNewMax] = useState<number | "">(0);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ plans: Plan[] }>("/plans");
      setPlans(res.plans);
      setDrafts(Object.fromEntries(res.plans.map((p) => [p.id, draftOf(p)])));
    } catch (err) {
      setError(handleApiError(err, reportError));
    } finally {
      setLoading(false);
    }
  }, [reportError]);

  useEffect(() => {
    void load();
  }, [load]);

  function patchDraft(id: number, patch: Partial<PlanDraft>) {
    setDrafts((d) => ({ ...d, [id]: { ...d[id]!, ...patch } }));
  }

  async function saveRow(p: Plan) {
    const d = drafts[p.id];
    if (!d) return;
    setSavingId(p.id);
    try {
      const body: Record<string, unknown> = {};
      if (d.name !== p.name) body.name = d.name;
      if (d.hourlyLimit !== p.hourlyLimit) body.hourly_limit = d.hourlyLimit === "" ? 0 : d.hourlyLimit;
      if (d.maxTasks !== p.maxTasks) body.max_tasks = d.maxTasks === "" ? 0 : d.maxTasks;
      await apiPatch<Plan>(`/plans/${p.id}`, body);
      notifyOk("План сохранён");
      await load();
    } catch (err) {
      handleApiError(err, reportError);
    } finally {
      setSavingId(null);
    }
  }

  async function deleteRow(p: Plan) {
    setDeletingId(p.id);
    try {
      await apiDelete<{ ok: boolean }>(`/plans/${p.id}`);
      notifyOk("План удалён");
      await load();
    } catch (err) {
      // 409 surfaces the "assigned to users" message via the toast.
      handleApiError(err, reportError);
    } finally {
      setDeletingId(null);
    }
  }

  async function createPlan() {
    if (newName.trim() === "") return;
    setCreating(true);
    try {
      await apiPost<Plan>("/plans", {
        name: newName.trim(),
        hourly_limit: newHourly === "" ? 0 : newHourly,
        max_tasks: newMax === "" ? 0 : newMax,
      });
      notifyOk("План добавлен");
      setNewName("");
      setNewHourly(0);
      setNewMax(0);
      await load();
    } catch (err) {
      handleApiError(err, reportError);
    } finally {
      setCreating(false);
    }
  }

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>Планы</Title>
        <ActionIcon variant="subtle" onClick={() => void load()} aria-label="Обновить">
          <IconRefresh size={18} />
        </ActionIcon>
      </Group>

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
        <Table.ScrollContainer minWidth={560}>
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>ID</Table.Th>
                <Table.Th>Название</Table.Th>
                <Table.Th>Лимит/час</Table.Th>
                <Table.Th>Макс. задач</Table.Th>
                <Table.Th ta="right">Действия</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {plans.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={5}>
                    <Text c="dimmed">Планов пока нет.</Text>
                  </Table.Td>
                </Table.Tr>
              ) : (
                plans.map((p) => {
                  const d = drafts[p.id] ?? draftOf(p);
                  const dirty = draftDirty(p, d);
                  return (
                    <Table.Tr key={p.id}>
                      <Table.Td>{p.id}</Table.Td>
                      <Table.Td>
                        <TextInput
                          value={d.name}
                          onChange={(e) => patchDraft(p.id, { name: e.currentTarget.value })}
                          size="xs"
                        />
                      </Table.Td>
                      <Table.Td>
                        <NumberInput
                          value={d.hourlyLimit}
                          onChange={(v) =>
                            patchDraft(p.id, { hourlyLimit: v === "" ? "" : Number(v) })
                          }
                          min={0}
                          size="xs"
                          w={110}
                        />
                      </Table.Td>
                      <Table.Td>
                        <NumberInput
                          value={d.maxTasks}
                          onChange={(v) =>
                            patchDraft(p.id, { maxTasks: v === "" ? "" : Number(v) })
                          }
                          min={0}
                          size="xs"
                          w={110}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} justify="flex-end" wrap="nowrap">
                          <ActionIcon
                            variant="subtle"
                            color="blue"
                            disabled={!dirty}
                            loading={savingId === p.id}
                            onClick={() => void saveRow(p)}
                            aria-label="Сохранить"
                            title="Сохранить"
                          >
                            <IconDeviceFloppy size={16} />
                          </ActionIcon>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            loading={deletingId === p.id}
                            onClick={() => void deleteRow(p)}
                            aria-label="Удалить"
                            title="Удалить"
                          >
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      <Card withBorder padding="md" radius="md">
        <Text fw={600} mb="sm">
          Добавить план
        </Text>
        <Group align="flex-end" wrap="wrap">
          <TextInput
            label="Название"
            placeholder="например, pro"
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
          />
          <NumberInput
            label="Лимит/час"
            value={newHourly}
            onChange={(v) => setNewHourly(v === "" ? "" : Number(v))}
            min={0}
            w={130}
          />
          <NumberInput
            label="Макс. задач"
            value={newMax}
            onChange={(v) => setNewMax(v === "" ? "" : Number(v))}
            min={0}
            w={130}
          />
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={() => void createPlan()}
            loading={creating}
            disabled={newName.trim() === ""}
          >
            Добавить план
          </Button>
        </Group>
        <Text size="xs" c="dimmed" mt="xs">
          0 = без ограничения.
        </Text>
      </Card>
    </Stack>
  );
}
