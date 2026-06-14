import { useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconAlertCircle, IconPlus, IconTrash } from "@tabler/icons-react";
import { apiGet, apiPut } from "../lib/api.js";
import type { McpServerConfig, McpServers, MutationResult } from "../lib/types.js";
import { useAuthGate } from "../components/AuthGate.js";
import { errorMessage, handleError, notifySaved } from "./_configCommon.js";

/** Only the `search` server is supported by the backend. */
const SERVER_KEY = "search";

interface EnvPair {
  key: string;
  value: string;
}

function toPairs(env: Record<string, string> | undefined): EnvPair[] {
  return Object.entries(env ?? {}).map(([key, value]) => ({ key, value }));
}

/**
 * MCP `search` server editor: command, an ordered args list, and an env
 * key/value map. Saves the whole `{ search: {...} }` record via PUT /mcp; the
 * backend rejects any non-`search` key.
 */
export function McpScreen() {
  const { reportError } = useAuthGate();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [command, setCommand] = useState("");
  const [args, setArgs] = useState<string[]>([]);
  const [env, setEnv] = useState<EnvPair[]>([]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    apiGet<McpServers>("/mcp")
      .then((servers) => {
        if (!alive) return;
        const cfg = servers[SERVER_KEY];
        setCommand(cfg?.command ?? "");
        setArgs(cfg?.args ?? []);
        setEnv(toPairs(cfg?.env));
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

  function setArg(i: number, value: string) {
    setArgs((a) => a.map((x, idx) => (idx === i ? value : x)));
  }
  function removeArg(i: number) {
    setArgs((a) => a.filter((_, idx) => idx !== i));
  }
  function addArg() {
    setArgs((a) => [...a, ""]);
  }

  function setEnvPair(i: number, patch: Partial<EnvPair>) {
    setEnv((e) => e.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }
  function removeEnv(i: number) {
    setEnv((e) => e.filter((_, idx) => idx !== i));
  }
  function addEnv() {
    setEnv((e) => [...e, { key: "", value: "" }]);
  }

  async function save() {
    if (!command.trim()) {
      handleError(new Error("Команда обязательна"), reportError);
      return;
    }
    // Drop fully-empty env rows; collapse to a Record.
    const envRecord: Record<string, string> = {};
    for (const { key, value } of env) {
      const k = key.trim();
      if (k) envRecord[k] = value;
    }
    const cfg: McpServerConfig = {
      command: command.trim(),
      args: args.map((a) => a.trim()).filter((a) => a.length > 0),
    };
    if (Object.keys(envRecord).length > 0) cfg.env = envRecord;

    const payload: McpServers = { [SERVER_KEY]: cfg };
    setSaving(true);
    try {
      await apiPut<MutationResult>("/mcp", payload);
      notifySaved("MCP-сервер сохранён");
    } catch (err) {
      handleError(err, reportError);
    } finally {
      setSaving(false);
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
      <Title order={2}>MCP</Title>

      {loadError && (
        <Alert color="red" icon={<IconAlertCircle size={18} />} title="Ошибка загрузки">
          {loadError}
        </Alert>
      )}

      <Card withBorder padding="lg" radius="md">
        <Stack gap="md">
          <Group justify="space-between" align="center">
            <Title order={4}>Сервер «{SERVER_KEY}»</Title>
            <Text size="sm" c="dimmed">
              Поддерживается только сервер search
            </Text>
          </Group>

          <TextInput
            label="Команда (command)"
            description="Исполняемый файл, напр. npx или uvx"
            placeholder="npx"
            value={command}
            onChange={(e) => setCommand(e.currentTarget.value)}
            required
          />

          <Stack gap="xs">
            <Group justify="space-between">
              <Text fw={500} size="sm">
                Аргументы (args)
              </Text>
              <Button
                size="xs"
                variant="light"
                leftSection={<IconPlus size={14} />}
                onClick={addArg}
              >
                Добавить аргумент
              </Button>
            </Group>
            {args.length === 0 && (
              <Text size="sm" c="dimmed">
                Нет аргументов
              </Text>
            )}
            {args.map((arg, i) => (
              <Group key={i} gap="xs" wrap="nowrap">
                <TextInput
                  style={{ flex: 1 }}
                  placeholder={`Аргумент ${i + 1}`}
                  value={arg}
                  onChange={(e) => setArg(i, e.currentTarget.value)}
                />
                <ActionIcon
                  color="red"
                  variant="subtle"
                  onClick={() => removeArg(i)}
                  aria-label="Удалить аргумент"
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
            ))}
          </Stack>

          <Stack gap="xs">
            <Group justify="space-between">
              <Text fw={500} size="sm">
                Переменные окружения (env)
              </Text>
              <Button
                size="xs"
                variant="light"
                leftSection={<IconPlus size={14} />}
                onClick={addEnv}
              >
                Добавить переменную
              </Button>
            </Group>
            {env.length === 0 && (
              <Text size="sm" c="dimmed">
                Нет переменных
              </Text>
            )}
            {env.map((pair, i) => (
              <Group key={i} gap="xs" wrap="nowrap">
                <TextInput
                  style={{ flex: 1 }}
                  placeholder="KEY"
                  value={pair.key}
                  onChange={(e) => setEnvPair(i, { key: e.currentTarget.value })}
                />
                <TextInput
                  style={{ flex: 1 }}
                  placeholder="значение"
                  value={pair.value}
                  onChange={(e) => setEnvPair(i, { value: e.currentTarget.value })}
                />
                <ActionIcon
                  color="red"
                  variant="subtle"
                  onClick={() => removeEnv(i)}
                  aria-label="Удалить переменную"
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
            ))}
          </Stack>

          <Group justify="flex-end">
            <Button onClick={save} loading={saving}>
              Сохранить
            </Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  );
}
