import { useCallback, useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { IconCheck, IconEdit, IconPlus, IconRefresh, IconX } from "@tabler/icons-react";
import type { AccessMode, AccessRequest, Plan } from "../lib/types.js";
import { apiGet, apiPatch, apiPost, apiPut } from "../lib/api.js";
import { useAuthGate } from "../components/AuthGate.js";
import { handleApiError, notifyOk } from "./_adminHelpers.js";

/** Channel as returned by GET /users (provider + externalId). */
interface UserChannel {
  id?: number;
  provider: string;
  externalId: string;
}

/** The plan summary embedded on a user row. */
interface UserPlan {
  id: number;
  name: string;
}

/** A user as returned by GET /users — superset of the strict User type. */
interface AdminUser {
  id: number;
  name: string;
  displayName: string;
  city: string;
  timezone: string;
  language: string;
  onboarded: boolean;
  channels: UserChannel[];
  plan: UserPlan | null;
}

interface UserFormValues {
  displayName: string;
  city: string;
  timezone: string;
  language: string;
  onboarded: boolean;
}

export function UsersScreen() {
  const { reportError } = useAuthGate();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [saving, setSaving] = useState(false);
  const [assigningId, setAssigningId] = useState<number | null>(null);

  const form = useForm<UserFormValues>({
    initialValues: { displayName: "", city: "", timezone: "", language: "", onboarded: false },
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [usersRes, plansRes] = await Promise.all([
        apiGet<{ users: AdminUser[] }>("/users"),
        apiGet<{ plans: Plan[] }>("/plans"),
      ]);
      setUsers(usersRes.users);
      setPlans(plansRes.plans);
    } catch (err) {
      setError(handleApiError(err, reportError));
    } finally {
      setLoading(false);
    }
  }, [reportError]);

  useEffect(() => {
    void load();
  }, [load]);

  function openEdit(u: AdminUser) {
    setEditing(u);
    form.setValues({
      displayName: u.displayName,
      city: u.city,
      timezone: u.timezone,
      language: u.language,
      onboarded: u.onboarded,
    });
  }

  async function saveUser(values: UserFormValues) {
    if (!editing) return;
    setSaving(true);
    try {
      await apiPatch<AdminUser>(`/users/${editing.id}`, {
        display_name: values.displayName,
        city: values.city,
        timezone: values.timezone,
        language: values.language,
        onboarded: values.onboarded,
      });
      notifyOk("Пользователь сохранён");
      setEditing(null);
      await load();
    } catch (err) {
      handleApiError(err, reportError);
    } finally {
      setSaving(false);
    }
  }

  async function assignPlan(userId: number, planId: number) {
    setAssigningId(userId);
    try {
      await apiPut<{ ok: boolean }>("/plans/assign", { userId, planId });
      notifyOk("План назначен");
      await load();
    } catch (err) {
      handleApiError(err, reportError);
    } finally {
      setAssigningId(null);
    }
  }

  const planOptions = plans.map((p) => ({ value: String(p.id), label: p.name }));

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>Пользователи</Title>
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
        <Table.ScrollContainer minWidth={760}>
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>ID</Table.Th>
                <Table.Th>Имя</Table.Th>
                <Table.Th>Каналы</Table.Th>
                <Table.Th>Онбординг</Table.Th>
                <Table.Th>План</Table.Th>
                <Table.Th ta="right">Действия</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {users.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <Text c="dimmed">Пользователей пока нет.</Text>
                  </Table.Td>
                </Table.Tr>
              ) : (
                users.map((u) => (
                  <Table.Tr key={u.id}>
                    <Table.Td>{u.id}</Table.Td>
                    <Table.Td>
                      <Text fw={600}>{u.displayName || u.name || "—"}</Text>
                      {u.city && (
                        <Text size="xs" c="dimmed">
                          {u.city}
                          {u.timezone ? ` · ${u.timezone}` : ""}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {u.channels.length === 0 ? (
                          <Text size="xs" c="dimmed">
                            —
                          </Text>
                        ) : (
                          u.channels.map((ch, i) => (
                            <Badge key={`${ch.provider}-${ch.externalId}-${i}`} variant="light" size="sm">
                              {ch.provider}:{ch.externalId}
                            </Badge>
                          ))
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      {u.onboarded ? (
                        <Badge color="green" variant="light">
                          да
                        </Badge>
                      ) : (
                        <Badge color="gray" variant="light">
                          нет
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Select
                        placeholder="Назначить план"
                        data={planOptions}
                        value={u.plan ? String(u.plan.id) : null}
                        onChange={(v) => {
                          if (v) void assignPlan(u.id, Number(v));
                        }}
                        disabled={assigningId === u.id || planOptions.length === 0}
                        size="xs"
                        w={160}
                        comboboxProps={{ withinPortal: true }}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Group justify="flex-end">
                        <ActionIcon
                          variant="subtle"
                          onClick={() => openEdit(u)}
                          aria-label="Редактировать"
                          title="Редактировать"
                        >
                          <IconEdit size={16} />
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

      <AccessRequestsPanel reportError={reportError} />

      <AllowlistEditor reportError={reportError} />

      {/* ── edit user modal ─────────────────────────────────────────── */}
      <Modal
        opened={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `Пользователь #${editing.id}` : ""}
        size="md"
      >
        <form onSubmit={form.onSubmit(saveUser)}>
          <Stack gap="sm">
            <TextInput label="Отображаемое имя" {...form.getInputProps("displayName")} />
            <Group grow>
              <TextInput label="Город" {...form.getInputProps("city")} />
              <TextInput label="Часовой пояс" placeholder="Europe/Minsk" {...form.getInputProps("timezone")} />
            </Group>
            <TextInput label="Язык" placeholder="ru" {...form.getInputProps("language")} />
            <Switch
              label="Онбординг пройден"
              {...form.getInputProps("onboarded", { type: "checkbox" })}
            />
            <Group justify="flex-end" mt="sm">
              <Button variant="default" onClick={() => setEditing(null)} disabled={saving}>
                Отмена
              </Button>
              <Button type="submit" loading={saving}>
                Сохранить
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}

/** Format an epoch-ms / ISO timestamp for the requests list. */
function fmtWhen(ts: number | string): string {
  const d = new Date(typeof ts === "number" ? ts : Date.parse(ts));
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("ru-RU");
}

/**
 * Inbox of pending bot-access requests (M17). Approve → the user's tg id is added
 * to the allowlist and they get an "access granted" message; Reject → terminal.
 */
function AccessRequestsPanel({ reportError }: { reportError: (e: unknown) => void }) {
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ requests: AccessRequest[] }>("/users/requests");
      setRequests(res.requests);
    } catch (err) {
      setError(handleApiError(err, reportError));
    } finally {
      setLoading(false);
    }
  }, [reportError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(id: number, action: "approve" | "reject") {
    setActingId(id);
    try {
      await apiPost<{ ok: boolean }>(`/users/requests/${id}/${action}`, {});
      notifyOk(action === "approve" ? "Доступ выдан" : "Заявка отклонена");
      await load();
    } catch (err) {
      handleApiError(err, reportError);
    } finally {
      setActingId(null);
    }
  }

  return (
    <Card withBorder padding="md" radius="md">
      <Group justify="space-between" mb="xs">
        <Text fw={600}>Заявки на доступ</Text>
        <Group gap="xs">
          {loading && <Loader size="xs" />}
          <ActionIcon variant="subtle" onClick={() => void load()} aria-label="Обновить">
            <IconRefresh size={16} />
          </ActionIcon>
        </Group>
      </Group>
      <Text size="xs" c="dimmed" mb="sm">
        Люди, написавшие боту в режиме «только по заявке». Одобрите — и человек получит доступ.
      </Text>

      {error && (
        <Alert color="red" mb="sm">
          {error}
        </Alert>
      )}

      {requests.length === 0 ? (
        <Text size="sm" c="dimmed">
          Нет новых заявок.
        </Text>
      ) : (
        <Stack gap="xs">
          {requests.map((req) => (
            <Group key={req.id} justify="space-between" wrap="nowrap">
              <div>
                <Text fw={600} size="sm">
                  {req.name || "—"}
                  {req.username && (
                    <Text span c="dimmed" fw={400}>
                      {" "}
                      @{req.username}
                    </Text>
                  )}
                </Text>
                <Text size="xs" c="dimmed">
                  id {req.tgUserId}
                  {fmtWhen(req.createdAt) ? ` · ${fmtWhen(req.createdAt)}` : ""}
                </Text>
              </div>
              <Group gap="xs" wrap="nowrap">
                <Button
                  size="xs"
                  variant="light"
                  color="green"
                  leftSection={<IconCheck size={14} />}
                  loading={actingId === req.id}
                  onClick={() => void decide(req.id, "approve")}
                >
                  Одобрить
                </Button>
                <Button
                  size="xs"
                  variant="subtle"
                  color="gray"
                  leftSection={<IconX size={14} />}
                  disabled={actingId === req.id}
                  onClick={() => void decide(req.id, "reject")}
                >
                  Отклонить
                </Button>
              </Group>
            </Group>
          ))}
        </Stack>
      )}
    </Card>
  );
}

/** Editor for the chat allowlist (telegram_allowed_users): add/remove ids, Save. */
function AllowlistEditor({ reportError }: { reportError: (e: unknown) => void }) {
  const [ids, setIds] = useState<number[]>([]);
  const [mode, setMode] = useState<AccessMode>("open");
  const [savingMode, setSavingMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<number | "">("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ userIds: number[]; mode: AccessMode }>("/users/allowlist");
      setIds(res.userIds);
      setMode(res.mode);
    } catch (err) {
      setError(handleApiError(err, reportError));
    } finally {
      setLoading(false);
    }
  }, [reportError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function changeMode(next: AccessMode) {
    if (next === mode) return;
    const prev = mode;
    setMode(next); // optimistic
    setSavingMode(true);
    try {
      await apiPut<{ ok: boolean }>("/users/access-mode", { mode: next });
      notifyOk(next === "approval" ? "Режим: доступ по заявке" : "Режим: открыт всем");
    } catch (err) {
      setMode(prev); // revert on failure
      handleApiError(err, reportError);
    } finally {
      setSavingMode(false);
    }
  }

  function addId() {
    if (draft === "" || !Number.isInteger(draft)) return;
    if (ids.includes(draft)) {
      setDraft("");
      return;
    }
    setIds((prev) => [...prev, draft as number]);
    setDraft("");
  }

  function removeId(id: number) {
    setIds((prev) => prev.filter((x) => x !== id));
  }

  async function save() {
    setSaving(true);
    try {
      await apiPut<{ ok: boolean }>("/users/allowlist", { userIds: ids });
      notifyOk("Список доступа сохранён");
      await load();
    } catch (err) {
      handleApiError(err, reportError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card withBorder padding="md" radius="md">
      <Group justify="space-between" mb="xs">
        <Text fw={600}>Список доступа к боту (Telegram)</Text>
        {loading && <Loader size="xs" />}
      </Group>

      <Group justify="space-between" align="center" mb="sm" wrap="nowrap">
        <Text size="sm">Режим доступа</Text>
        <SegmentedControl
          value={mode}
          onChange={(v) => void changeMode(v as AccessMode)}
          disabled={savingMode || loading}
          data={[
            { label: "Открыт всем", value: "open" },
            { label: "Только по заявке", value: "approval" },
          ]}
        />
      </Group>
      <Text size="xs" c="dimmed" mb="sm">
        {mode === "approval"
          ? "Доступ только из списка ниже; незнакомцы попадают в «Заявки на доступ» выше."
          : "Пустой список = доступ всем. Непустой = только перечисленные id."}
      </Text>

      <Text size="xs" c="dimmed" mb="sm">
        Telegram user id, которым разрешено общаться с ботом. Это не доступ к админке.
      </Text>

      {error && (
        <Alert color="red" mb="sm">
          {error}
        </Alert>
      )}

      <Group gap="xs" mb="sm" align="flex-end">
        <NumberInput
          label="Telegram user id"
          placeholder="123456789"
          value={draft}
          onChange={(v) => setDraft(v === "" ? "" : Number(v))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addId();
            }
          }}
          hideControls
          allowDecimal={false}
          w={200}
        />
        <Button
          variant="light"
          leftSection={<IconPlus size={16} />}
          onClick={addId}
          disabled={draft === ""}
        >
          Добавить
        </Button>
      </Group>

      <Group gap={6} mb="md">
        {ids.length === 0 ? (
          <Text size="sm" c="dimmed">
            Список пуст.
          </Text>
        ) : (
          ids.map((id) => (
            <Badge
              key={id}
              variant="light"
              size="lg"
              rightSection={
                <ActionIcon
                  size="xs"
                  variant="transparent"
                  color="gray"
                  onClick={() => removeId(id)}
                  aria-label={`Удалить ${id}`}
                >
                  <IconX size={12} />
                </ActionIcon>
              }
            >
              {id}
            </Badge>
          ))
        )}
      </Group>

      <Group justify="flex-end">
        <Button onClick={() => void save()} loading={saving} disabled={loading}>
          Сохранить
        </Button>
      </Group>
    </Card>
  );
}
