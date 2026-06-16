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
  Select,
  Stack,
  Switch,
  Table,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import {
  IconEdit,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import type { ModelRow, Skill } from "../lib/types.js";
import { apiDelete, apiGet, apiPost, apiPut } from "../lib/api.js";
import { useAuthGate } from "../components/AuthGate.js";
import { ModelRefSelect } from "../components/ModelRefSelect.js";
import { fmtCost, handleApiError, notifyOk } from "./_adminHelpers.js";

/** API shape of a skill (the wire allows a null model, unlike the strict type). */
type SkillApi = Omit<Skill, "model"> & { model: string | null };

/** Tri-state reasoning <-> Select value mapping. */
type ReasoningValue = "inherit" | "on" | "off";
function reasoningToValue(r: boolean | null): ReasoningValue {
  if (r === true) return "on";
  if (r === false) return "off";
  return "inherit";
}
function valueToReasoning(v: ReasoningValue): boolean | null {
  if (v === "on") return true;
  if (v === "off") return false;
  return null;
}

interface SkillFormValues {
  name: string;
  description: string;
  model: string;
  allowedTools: string[];
  temperature: number | "";
  reasoning: ReasoningValue;
  routable: boolean;
  prompt: string;
}

function emptyForm(): SkillFormValues {
  return {
    name: "",
    description: "",
    model: "",
    allowedTools: [],
    temperature: "",
    reasoning: "inherit",
    routable: true,
    prompt: "",
  };
}

function formFromSkill(s: SkillApi): SkillFormValues {
  return {
    name: s.name,
    description: s.description,
    model: s.model ?? "",
    allowedTools: s.allowedTools ?? [],
    temperature: s.temperature ?? "",
    reasoning: reasoningToValue(s.reasoning),
    routable: s.routable,
    prompt: s.prompt,
  };
}

export function SkillsScreen() {
  const { reportError } = useAuthGate();
  const [skills, setSkills] = useState<SkillApi[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // editor modal state: null = closed; { editing } = open
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null); // null = create
  const [saving, setSaving] = useState(false);

  // delete / test modal state
  const [deleteTarget, setDeleteTarget] = useState<SkillApi | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [testTarget, setTestTarget] = useState<SkillApi | null>(null);

  const form = useForm<SkillFormValues>({
    initialValues: emptyForm(),
    validate: {
      name: (v) => (v.trim().length === 0 ? "Укажите имя" : null),
    },
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Models feed the "Модель" Select in the editor — load them alongside skills.
      const [skillRows, modelRows] = await Promise.all([
        apiGet<SkillApi[]>("/skills"),
        apiGet<ModelRow[]>("/models"),
      ]);
      setSkills(skillRows);
      setModels(modelRows);
    } catch (err) {
      setError(handleApiError(err, reportError));
    } finally {
      setLoading(false);
    }
  }, [reportError]);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditingName(null);
    form.setValues(emptyForm());
    form.resetDirty(emptyForm());
    setEditorOpen(true);
  }

  function openEdit(s: SkillApi) {
    setEditingName(s.name);
    const v = formFromSkill(s);
    form.setValues(v);
    form.resetDirty(v);
    setEditorOpen(true);
  }

  async function submit(values: SkillFormValues) {
    setSaving(true);
    const body = {
      description: values.description,
      model: values.model.trim() === "" ? null : values.model.trim(),
      allowedTools: values.allowedTools,
      temperature: values.temperature === "" ? null : values.temperature,
      reasoning: valueToReasoning(values.reasoning),
      routable: values.routable,
      prompt: values.prompt,
    };
    try {
      if (editingName === null) {
        await apiPost<SkillApi>("/skills", { name: values.name.trim(), ...body });
        notifyOk("Скил создан");
      } else {
        await apiPut<SkillApi>(`/skills/${encodeURIComponent(editingName)}`, body);
        notifyOk("Скил сохранён");
      }
      setEditorOpen(false);
      await load();
    } catch (err) {
      handleApiError(err, reportError);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiDelete<{ ok: boolean }>(`/skills/${encodeURIComponent(deleteTarget.name)}`);
      notifyOk("Скил удалён");
      setDeleteTarget(null);
      await load();
    } catch (err) {
      handleApiError(err, reportError);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>Скилы</Title>
        <Group gap="xs">
          <ActionIcon variant="subtle" onClick={() => void load()} aria-label="Обновить">
            <IconRefresh size={18} />
          </ActionIcon>
          <Button leftSection={<IconPlus size={16} />} onClick={openCreate}>
            Новый скил
          </Button>
        </Group>
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
      ) : skills.length === 0 ? (
        <Text c="dimmed">Скилов пока нет.</Text>
      ) : (
        <Table.ScrollContainer minWidth={640}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Имя</Table.Th>
                <Table.Th>Описание</Table.Th>
                <Table.Th>Модель</Table.Th>
                <Table.Th>Роутинг</Table.Th>
                <Table.Th>Инструменты</Table.Th>
                <Table.Th ta="right">Действия</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {skills.map((s) => (
                <Table.Tr key={s.name}>
                  <Table.Td>
                    <Text fw={600}>{s.name}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed" lineClamp={2}>
                      {s.description || "—"}
                    </Text>
                  </Table.Td>
                  <Table.Td>{s.model ?? <Text c="dimmed">по умолчанию</Text>}</Table.Td>
                  <Table.Td>
                    {s.routable ? (
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
                    <Text size="sm">{s.allowedTools.length}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      <ActionIcon
                        variant="subtle"
                        color="blue"
                        onClick={() => setTestTarget(s)}
                        aria-label="Тест-прогон"
                        title="Тест-прогон"
                      >
                        <IconPlayerPlay size={16} />
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        onClick={() => openEdit(s)}
                        aria-label="Редактировать"
                        title="Редактировать"
                      >
                        <IconEdit size={16} />
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        onClick={() => setDeleteTarget(s)}
                        aria-label="Удалить"
                        title="Удалить"
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      {/* ── editor modal ─────────────────────────────────────────────── */}
      <Modal
        opened={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editingName === null ? "Новый скил" : `Скил: ${editingName}`}
        size="xl"
      >
        <form onSubmit={form.onSubmit(submit)}>
          <Stack gap="sm">
            <TextInput
              label="Имя"
              placeholder="например, weather"
              required
              disabled={editingName !== null}
              {...form.getInputProps("name")}
            />
            <TextInput
              label="Описание"
              placeholder="Что делает этот скил (видит роутер)"
              {...form.getInputProps("description")}
            />
            <Group grow align="flex-start">
              <ModelRefSelect
                label="Модель"
                description="Пусто = модель по умолчанию"
                placeholder="по умолчанию"
                value={form.values.model}
                models={models}
                onChange={(ref) => form.setFieldValue("model", ref)}
              />
              <NumberInput
                label="Температура"
                placeholder="по умолчанию"
                min={0}
                max={2}
                step={0.1}
                decimalScale={2}
                {...form.getInputProps("temperature")}
              />
            </Group>
            <Group grow align="flex-start">
              <Select
                label="Reasoning"
                data={[
                  { value: "inherit", label: "По умолчанию провайдера" },
                  { value: "on", label: "Включён" },
                  { value: "off", label: "Выключен" },
                ]}
                allowDeselect={false}
                {...form.getInputProps("reasoning")}
              />
              <Switch
                label="Доступен роутеру (routable)"
                mt="lg"
                {...form.getInputProps("routable", { type: "checkbox" })}
              />
            </Group>
            <TagsInput
              label="Разрешённые инструменты"
              description="Введите имя инструмента и нажмите Enter"
              placeholder="remember, search_memories, ..."
              {...form.getInputProps("allowedTools")}
            />
            <Textarea
              label="Промпт"
              placeholder="Системные инструкции скила"
              autosize
              minRows={6}
              maxRows={16}
              {...form.getInputProps("prompt")}
            />
            {form.values.prompt.trim() !== "" && (
              <Card withBorder padding="sm" radius="sm">
                <Text size="xs" c="dimmed" mb={4}>
                  Предпросмотр промпта
                </Text>
                <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                  {form.values.prompt}
                </Text>
              </Card>
            )}
            <Group justify="flex-end" mt="sm">
              <Button variant="default" onClick={() => setEditorOpen(false)} disabled={saving}>
                Отмена
              </Button>
              <Button type="submit" loading={saving}>
                Сохранить
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      {/* ── delete confirm ──────────────────────────────────────────── */}
      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Удалить скил?"
        size="sm"
      >
        <Stack gap="md">
          <Text>
            Скил <b>{deleteTarget?.name}</b> будет удалён без возможности восстановления.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Отмена
            </Button>
            <Button color="red" onClick={() => void confirmDelete()} loading={deleting}>
              Удалить
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* ── test-run modal ──────────────────────────────────────────── */}
      <TestRunModal target={testTarget} onClose={() => setTestTarget(null)} reportError={reportError} />
    </Stack>
  );
}

interface TestRunResult {
  text: string;
  usage: { cost?: number };
}

function TestRunModal({
  target,
  onClose,
  reportError,
}: {
  target: SkillApi | null;
  onClose: () => void;
  reportError: (e: unknown) => void;
}) {
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestRunResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // reset state whenever a new target is opened
  useEffect(() => {
    if (target) {
      setMessage("");
      setResult(null);
      setErr(null);
      setRunning(false);
    }
  }, [target]);

  async function run() {
    if (!target || message.trim() === "") return;
    setRunning(true);
    setResult(null);
    setErr(null);
    try {
      const res = await apiPost<TestRunResult>(
        `/skills/${encodeURIComponent(target.name)}/test`,
        { message: message.trim() },
      );
      setResult(res);
    } catch (e) {
      setErr(handleApiError(e, reportError));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Modal opened={target !== null} onClose={onClose} title={`Тест-прогон: ${target?.name ?? ""}`} size="lg">
      <Stack gap="sm">
        <Textarea
          label="Сообщение"
          placeholder="Введите тестовое сообщение для скила"
          autosize
          minRows={3}
          maxRows={8}
          value={message}
          onChange={(e) => setMessage(e.currentTarget.value)}
          disabled={running}
        />
        <Group justify="flex-end">
          <Button
            leftSection={<IconPlayerPlay size={16} />}
            onClick={() => void run()}
            loading={running}
            disabled={message.trim() === ""}
          >
            Запустить
          </Button>
        </Group>

        {running && (
          <Group gap="xs">
            <Loader size="sm" />
            <Text c="dimmed" size="sm">
              Скил выполняется, это может занять несколько секунд…
            </Text>
          </Group>
        )}

        {err && (
          <Alert color="red" title="Ошибка прогона">
            {err}
          </Alert>
        )}

        {result && (
          <Card withBorder padding="sm" radius="sm">
            <Group justify="space-between" mb="xs">
              <Text size="xs" c="dimmed">
                Ответ
              </Text>
              <Badge variant="light" color="grape">
                Стоимость: {fmtCost(result.usage?.cost)}
              </Badge>
            </Group>
            <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
              {result.text || "(пустой ответ)"}
            </Text>
          </Card>
        )}
      </Stack>
    </Modal>
  );
}
