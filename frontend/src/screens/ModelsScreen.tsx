import { useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Modal,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { IconAlertCircle, IconCheck, IconPencil, IconPlus, IconTrash, IconX } from "@tabler/icons-react";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, ApiError } from "../lib/api.js";
import type { ModelRoles, ModelRow, MutationResult } from "../lib/types.js";
import { useAuthGate } from "../components/AuthGate.js";
import { ModelRefSelect } from "../components/ModelRefSelect.js";
import { errorMessage, handleError, notifySaved } from "./_configCommon.js";

/** Wrapped write envelope returned by models POST/PATCH ({ ok, value: row }). */
type ModelMutation = MutationResult<ModelRow>;

const ROLE_FIELDS: { key: keyof ModelRoles; label: string }[] = [
  { key: "default", label: "По умолчанию (default)" },
  { key: "router", label: "Маршрутизатор (router)" },
  { key: "error_correction", label: "Исправление ошибок (error_correction)" },
  { key: "speech", label: "Речь (speech)" },
  { key: "synthesizer", label: "Синтезатор (synthesizer)" },
];

const EMPTY_ROLES: ModelRoles = {
  default: "",
  router: "",
  error_correction: "",
  speech: "",
  synthesizer: "",
};

/**
 * Models admin: a CRUD table (enable/disable, edit label/flags/notes, delete),
 * an "add model" form, and a roles panel mapping each role slot to an enabled
 * model ref. The backend write endpoints take snake_case flags but return the
 * camelCase row; we just refetch the list after every mutation to stay in sync.
 */
export function ModelsScreen() {
  const { reportError } = useAuthGate();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);

  // Per-row inline busy state (enable Switch / delete) keyed by model id.
  const [busyId, setBusyId] = useState<number | null>(null);

  // Edit modal.
  const [editTarget, setEditTarget] = useState<ModelRow | null>(null);
  // Delete confirm modal.
  const [deleteTarget, setDeleteTarget] = useState<ModelRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function reloadModels(): Promise<ModelRow[]> {
    const rows = await apiGet<ModelRow[]>("/models");
    setModels(rows);
    return rows;
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    Promise.all([apiGet<ModelRow[]>("/models"), apiGet<ModelRoles>("/models/roles")])
      .then(([rows, roleVals]) => {
        if (!alive) return;
        setModels(rows);
        setRoles({ ...EMPTY_ROLES, ...roleVals });
      })
      .catch((err) => {
        if (!alive) return;
        setLoadError(errorMessage(err));
        handleError(err, reportError);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Roles panel state ──────────────────────────────────────────────────────
  const [roles, setRoles] = useState<ModelRoles>(EMPTY_ROLES);
  const [savingRoles, setSavingRoles] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);

  async function toggleEnabled(row: ModelRow, enabled: boolean) {
    setBusyId(row.id);
    try {
      await apiPatch<ModelMutation>(`/models/${row.id}`, { enabled });
      await reloadModels();
    } catch (err) {
      handleError(err, reportError);
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiDelete<MutationResult>(`/models/${deleteTarget.id}`);
      await reloadModels();
      notifySaved("Модель удалена");
      setDeleteTarget(null);
    } catch (err) {
      handleError(err, reportError);
    } finally {
      setDeleting(false);
    }
  }

  async function saveRoles() {
    setSavingRoles(true);
    setRoleError(null);
    try {
      await apiPut<MutationResult>("/models/roles", roles);
      notifySaved("Роли сохранены");
    } catch (err) {
      // The backend returns { error, refs } for unknown/disabled refs.
      if (err instanceof ApiError && !err.isAuth) {
        setRoleError(err.message);
      }
      handleError(err, reportError);
    } finally {
      setSavingRoles(false);
    }
  }

  if (loading) {
    return (
      <Center mih={240}>
        <Loader />
      </Center>
    );
  }

  return (
    <Stack gap="lg">
      <Title order={2}>Модели</Title>

      {loadError && (
        <Alert color="red" icon={<IconAlertCircle size={18} />} title="Ошибка загрузки">
          {loadError}
        </Alert>
      )}

      <AddModelForm reportError={reportError} onAdded={reloadModels} />

      <Card withBorder padding="lg" radius="md">
        <Stack gap="md">
          <Title order={4}>Список моделей</Title>
          {models.length === 0 ? (
            <Text c="dimmed" size="sm">
              Нет моделей. Добавьте первую выше.
            </Text>
          ) : (
            <Table.ScrollContainer minWidth={720}>
              <Table striped highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Включена</Table.Th>
                    <Table.Th>Ref</Table.Th>
                    <Table.Th>Метка</Table.Th>
                    <Table.Th>Tools</Table.Th>
                    <Table.Th>Reasoning</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {models.map((m) => (
                    <Table.Tr key={m.id}>
                      <Table.Td>
                        <Switch
                          checked={m.enabled}
                          disabled={busyId === m.id}
                          onChange={(e) => toggleEnabled(m, e.currentTarget.checked)}
                          aria-label="Включить/выключить модель"
                        />
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" ff="monospace">
                          {m.ref}
                        </Text>
                      </Table.Td>
                      <Table.Td>{m.label || <Text c="dimmed">—</Text>}</Table.Td>
                      <Table.Td>{m.supportsTools ? <BoolYes /> : <BoolNo />}</Table.Td>
                      <Table.Td>{m.supportsReasoning ? <BoolYes /> : <BoolNo />}</Table.Td>
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap" justify="flex-end">
                          <Tooltip label="Редактировать">
                            <ActionIcon
                              variant="subtle"
                              onClick={() => setEditTarget(m)}
                              aria-label="Редактировать модель"
                            >
                              <IconPencil size={16} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Удалить">
                            <ActionIcon
                              variant="subtle"
                              color="red"
                              disabled={busyId === m.id}
                              onClick={() => setDeleteTarget(m)}
                              aria-label="Удалить модель"
                            >
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Stack>
      </Card>

      <Card withBorder padding="lg" radius="md">
        <Stack gap="md">
          <Title order={4}>Роли моделей</Title>
          <Text size="sm" c="dimmed">
            Каждая роль ссылается на включённую модель. Пустое значение очищает роль.
          </Text>
          {roleError && (
            <Alert color="red" icon={<IconAlertCircle size={18} />} title="Ошибка сохранения ролей">
              {roleError}
            </Alert>
          )}
          {ROLE_FIELDS.map((f) => (
            <ModelRefSelect
              key={f.key}
              label={f.label}
              value={roles[f.key]}
              models={models}
              onChange={(ref) => setRoles((r) => ({ ...r, [f.key]: ref }))}
            />
          ))}
          <Group justify="flex-end">
            <Button onClick={saveRoles} loading={savingRoles}>
              Сохранить роли
            </Button>
          </Group>
        </Stack>
      </Card>

      <EditModelModal
        target={editTarget}
        reportError={reportError}
        onClose={() => setEditTarget(null)}
        onSaved={async () => {
          await reloadModels();
          setEditTarget(null);
        }}
      />

      <Modal
        opened={deleteTarget !== null}
        onClose={() => (deleting ? undefined : setDeleteTarget(null))}
        title="Удалить модель?"
        centered
      >
        <Stack gap="md">
          <Text>
            Модель <Text span ff="monospace">{deleteTarget?.ref}</Text> будет удалена.
            Действие необратимо.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Отмена
            </Button>
            <Button color="red" onClick={confirmDelete} loading={deleting}>
              Удалить
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

function BoolYes() {
  return <IconCheck size={16} color="var(--mantine-color-green-6)" />;
}
function BoolNo() {
  return <IconX size={16} color="var(--mantine-color-gray-5)" />;
}

// ── Add model form ────────────────────────────────────────────────────────────

interface AddModelValues {
  ref: string;
  label: string;
  enabled: boolean;
  supports_tools: boolean;
  supports_reasoning: boolean;
  notes: string;
}

function AddModelForm({
  reportError,
  onAdded,
}: {
  reportError: (e: unknown) => void;
  onAdded: () => Promise<unknown>;
}) {
  const [saving, setSaving] = useState(false);
  const form = useForm<AddModelValues>({
    initialValues: {
      ref: "",
      label: "",
      enabled: true,
      supports_tools: true,
      supports_reasoning: false,
      notes: "",
    },
    validate: {
      ref: (v) =>
        /^[^:\s]+:[^:\s].*$/.test(v.trim()) ? null : "Формат provider:model (напр. openai:gpt-4o)",
      label: (v) => (v.trim() ? null : "Обязательное поле"),
    },
  });

  async function submit(values: AddModelValues) {
    setSaving(true);
    try {
      await apiPost<ModelMutation>("/models", {
        ref: values.ref.trim(),
        label: values.label.trim(),
        enabled: values.enabled,
        supports_tools: values.supports_tools,
        supports_reasoning: values.supports_reasoning,
        notes: values.notes.trim() || undefined,
      });
      await onAdded();
      notifySaved("Модель добавлена");
      form.reset();
    } catch (err) {
      handleError(err, reportError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card withBorder padding="lg" radius="md">
      <form onSubmit={form.onSubmit(submit)}>
        <Stack gap="md">
          <Title order={4}>Добавить модель</Title>
          <TextInput
            label="Ref (provider:model)"
            description="Провайдер берётся из префикса ref (часть до «:»)"
            placeholder="openai:gpt-4o"
            {...form.getInputProps("ref")}
          />
          <TextInput label="Метка" required {...form.getInputProps("label")} />
          <TextInput label="Заметки (необязательно)" {...form.getInputProps("notes")} />
          <Group>
            <Switch
              label="Включена"
              checked={form.values.enabled}
              {...form.getInputProps("enabled", { type: "checkbox" })}
            />
            <Switch
              label="Поддержка tools"
              checked={form.values.supports_tools}
              {...form.getInputProps("supports_tools", { type: "checkbox" })}
            />
            <Switch
              label="Поддержка reasoning"
              checked={form.values.supports_reasoning}
              {...form.getInputProps("supports_reasoning", { type: "checkbox" })}
            />
          </Group>
          <Group justify="flex-end">
            <Button type="submit" loading={saving} leftSection={<IconPlus size={16} />}>
              Добавить модель
            </Button>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}

// ── Edit model modal ──────────────────────────────────────────────────────────

interface EditModelValues {
  label: string;
  supports_tools: boolean;
  supports_reasoning: boolean;
  notes: string;
}

function EditModelModal({
  target,
  reportError,
  onClose,
  onSaved,
}: {
  target: ModelRow | null;
  reportError: (e: unknown) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const form = useForm<EditModelValues>({
    initialValues: {
      label: "",
      supports_tools: true,
      supports_reasoning: false,
      notes: "",
    },
    validate: {
      label: (v) => (v.trim() ? null : "Обязательное поле"),
    },
  });

  // Re-seed the form whenever a new row is opened.
  useEffect(() => {
    if (target) {
      form.setValues({
        label: target.label,
        supports_tools: target.supportsTools,
        supports_reasoning: target.supportsReasoning,
        notes: target.notes,
      });
      form.resetDirty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id]);

  async function submit(values: EditModelValues) {
    if (!target) return;
    setSaving(true);
    try {
      await apiPatch<ModelMutation>(`/models/${target.id}`, {
        label: values.label.trim(),
        supports_tools: values.supports_tools,
        supports_reasoning: values.supports_reasoning,
        notes: values.notes.trim(),
      });
      notifySaved("Модель обновлена");
      await onSaved();
    } catch (err) {
      handleError(err, reportError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      opened={target !== null}
      onClose={() => (saving ? undefined : onClose())}
      title={target ? `Редактировать ${target.ref}` : "Редактировать модель"}
      centered
    >
      <form onSubmit={form.onSubmit(submit)}>
        <Stack gap="md">
          <TextInput label="Метка" required {...form.getInputProps("label")} />
          <TextInput label="Заметки" {...form.getInputProps("notes")} />
          <Switch
            label="Поддержка tools"
            checked={form.values.supports_tools}
            {...form.getInputProps("supports_tools", { type: "checkbox" })}
          />
          <Switch
            label="Поддержка reasoning"
            checked={form.values.supports_reasoning}
            {...form.getInputProps("supports_reasoning", { type: "checkbox" })}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={saving}>
              Отмена
            </Button>
            <Button type="submit" loading={saving}>
              Сохранить
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
