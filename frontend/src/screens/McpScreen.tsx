import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Textarea,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconBraces,
  IconInfoCircle,
  IconPlugConnected,
  IconRefresh,
} from "@tabler/icons-react";
import { apiGet, apiPost, apiPut } from "../lib/api.js";
import type {
  McpConfig,
  McpSaveResponse,
  McpServerStatus,
  McpStatusResponse,
  McpTestResponse,
} from "../lib/types.js";
import { useAuthGate } from "../components/AuthGate.js";
import { handleApiError, notifyOk } from "./_adminHelpers.js";

/** Config copied by «Вставить пример» — HTTP only, secret stays in `.env`. */
const EXAMPLE_CONFIG: McpConfig = {
  mcpServers: {
    example: {
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer ${MCP_EXAMPLE_TOKEN}" },
      enabled: true,
      timeoutMs: 60000,
    },
  },
};

/** Pretty-print a config for the textarea. */
function toText(config: McpConfig): string {
  return JSON.stringify(config, null, 2);
}

/** Short status label + colour for one server row. */
function statusBadge(s: McpServerStatus) {
  if (!s.enabled) return <Badge color="gray">выключен</Badge>;
  if (s.connected) {
    return (
      <Badge color="green" leftSection={<IconPlugConnected size={12} />}>
        подключён
      </Badge>
    );
  }
  return <Badge color="red">ошибка</Badge>;
}

/** Tool list as a tooltip (the namespaced names can be long). */
function toolsCell(s: McpServerStatus) {
  if (!s.enabled) return <Text size="sm" c="dimmed">—</Text>;
  if (s.toolCount === 0) return <Text size="sm" c="dimmed">0</Text>;
  return (
    <Tooltip
      multiline
      withArrow
      maw={420}
      label={s.tools.map((t) => (
        <Text key={t} size="xs" ff="monospace">
          {t}
        </Text>
      ))}
    >
      <Text size="sm" style={{ cursor: "help", textDecoration: "underline dotted" }}>
        {s.toolCount}
      </Text>
    </Tooltip>
  );
}

/** One status table (live refresh or probe result). */
function StatusTable({ servers, caption }: { servers: McpServerStatus[]; caption: string }) {
  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        {caption}
      </Text>
      <Table.ScrollContainer minWidth={640}>
        <Table striped highlightOnHover verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Сервер</Table.Th>
              <Table.Th>Статус</Table.Th>
              <Table.Th>Инструменты</Table.Th>
              <Table.Th>Ошибка</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {servers.length === 0 ? (
              <Table.Tr>
                <Table.Td colSpan={4}>
                  <Text c="dimmed" size="sm">
                    Серверов нет.
                  </Text>
                </Table.Td>
              </Table.Tr>
            ) : (
              servers.map((s) => (
                <Table.Tr key={s.name}>
                  <Table.Td>
                    <Text size="sm" ff="monospace">
                      {s.name}
                    </Text>
                  </Table.Td>
                  <Table.Td>{statusBadge(s)}</Table.Td>
                  <Table.Td>{toolsCell(s)}</Table.Td>
                  <Table.Td>
                    {s.error ? (
                      <Text size="xs" c="red">
                        {s.error}
                      </Text>
                    ) : (
                      <Text size="xs" c="dimmed">
                        —
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}

/**
 * MCP section: a JSON editor for admin-managed HTTP MCP servers.
 *
 * The admin pastes a Claude-Desktop-style `{ "mcpServers": { ... } }` object,
 * optionally probes it («Проверить»), saves it («Сохранить» → backend stores +
 * reconnects), and sees per-server status. `${VAR}` placeholders are resolved
 * from the backend's `process.env`, so secrets need not live in the DB.
 */
export function McpScreen() {
  const { reportError } = useAuthGate();
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [status, setStatus] = useState<McpStatusResponse | null>(null);
  const [testStatus, setTestStatus] = useState<McpServerStatus[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | "refresh" | null>(null);

  const dirty = text !== savedText;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet<McpStatusResponse>("/mcp");
      setStatus(res);
      const next = toText(res.config);
      setText(next);
      setSavedText(next);
      setWarnings([]);
      setTestStatus(null);
    } catch (err) {
      handleApiError(err, reportError);
    } finally {
      setLoading(false);
    }
  }, [reportError]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Parse the textarea; returns null (and shows an inline error) when invalid. */
  function readConfig(): McpConfig | null {
    setInlineError(null);
    let value: unknown;
    try {
      value = text.trim() ? JSON.parse(text) : { mcpServers: {} };
    } catch (e) {
      setInlineError(`Некорректный JSON: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      setInlineError('Ожидается объект вида { "mcpServers": { ... } }');
      return null;
    }
    const servers = (value as { mcpServers?: unknown }).mcpServers;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
      setInlineError('Ожидается объект вида { "mcpServers": { ... } }');
      return null;
    }
    return value as McpConfig;
  }

  async function save() {
    const config = readConfig();
    if (!config) return;
    setBusy("save");
    try {
      const res = await apiPut<McpSaveResponse>("/mcp", config);
      setStatus(res);
      const next = toText(res.config);
      setText(next);
      setSavedText(next);
      setWarnings(res.warnings ?? []);
      setTestStatus(null);
      notifyOk("MCP-конфиг сохранён");
    } catch (err) {
      handleApiError(err, reportError);
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    const config = readConfig();
    if (!config) return;
    setBusy("test");
    try {
      const res = await apiPost<McpTestResponse>("/mcp/test", config);
      setTestStatus(res.status);
      setWarnings(res.warnings ?? []);
      notifyOk("Проверка выполнена");
    } catch (err) {
      handleApiError(err, reportError);
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    setBusy("refresh");
    try {
      // `/refresh` returns status only (no config) — keep the textarea/config state.
      const res = await apiPost<{
        ok: boolean;
        ready: boolean;
        refreshing: boolean;
        status: McpServerStatus[];
      }>("/mcp/refresh", {});
      setStatus((prev) => ({
        config: prev?.config ?? { mcpServers: {} },
        ready: res.ready,
        refreshing: res.refreshing,
        status: res.status,
      }));
      notifyOk("Статус обновлён");
    } catch (err) {
      handleApiError(err, reportError);
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );
  }

  const refreshing = status?.refreshing === true || busy === "refresh";

  return (
    <Stack gap="md">
      <Title order={2}>MCP</Title>
      <Text size="sm" c="dimmed">
        HTTP MCP-серверы, инструменты которых доступны ассистенту. Конфиг хранится в БД и
        применяется сразу после сохранения; инструменты называются{" "}
        <code>&lt;server&gt;_&lt;tool&gt;</code> и активны на каждом ходу.
      </Text>

      {status && !status.ready && (
        <Alert color="blue" icon={<IconInfoCircle size={18} />}>
          Статус ещё собирается — серверы подключаются в фоне. Обновите статус через несколько секунд.
        </Alert>
      )}

      <Alert color="yellow" icon={<IconAlertTriangle size={18} />} title="Секреты в заголовках">
        Значения <code>headers</code> хранятся в БД открытым текстом. Держите токены в{" "}
        <code>.env</code> и подставляйте через <code>{"${VAR}"}</code> — в БД останется
        placeholder. stdio-серверы (<code>command</code>/<code>args</code>) не поддерживаются.
      </Alert>

      <Card withBorder padding="lg" radius="md">
        <Stack gap="md">
          <Group justify="space-between">
            <Text fw={600}>JSON-конфиг</Text>
            <Button
              variant="subtle"
              size="xs"
              leftSection={<IconBraces size={16} />}
              onClick={() => setText(toText(EXAMPLE_CONFIG))}
            >
              Вставить пример
            </Button>
          </Group>

          <Textarea
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            autosize
            minRows={10}
            maxRows={24}
            spellCheck={false}
            styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
            aria-label="MCP JSON config"
          />

          {inlineError && (
            <Alert color="red" icon={<IconAlertCircle size={18} />}>
              {inlineError}
            </Alert>
          )}

          <Group justify="space-between">
            <Button
              variant="default"
              leftSection={<IconRefresh size={16} />}
              onClick={() => void refresh()}
              loading={busy === "refresh"}
              disabled={refreshing || busy !== null}
            >
              Обновить статус
            </Button>
            <Group gap="xs">
              <Button
                variant="light"
                onClick={() => void test()}
                loading={busy === "test"}
                disabled={busy !== null}
              >
                Проверить
              </Button>
              <Button onClick={() => void save()} loading={busy === "save"} disabled={!dirty || busy !== null}>
                Сохранить
              </Button>
            </Group>
          </Group>
          {refreshing && (
            <Text size="xs" c="dimmed">
              Идёт переподключение серверов…
            </Text>
          )}
        </Stack>
      </Card>

      {warnings.length > 0 && (
        <Alert color="yellow" icon={<IconAlertTriangle size={18} />} title="Предупреждения">
          <Stack gap={4}>
            {warnings.map((w) => (
              <Text key={w} size="sm">
                {w}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}

      <Card withBorder padding="lg" radius="md">
        <StatusTable servers={status?.status ?? []} caption="Подключённые серверы" />
      </Card>

      {testStatus && (
        <Card withBorder padding="lg" radius="md">
          <Stack gap="md">
            <StatusTable servers={testStatus} caption="Результат проверки (не сохранено)" />
            <Group justify="flex-end">
              <Button variant="subtle" size="xs" onClick={() => setTestStatus(null)}>
                Скрыть
              </Button>
            </Group>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
