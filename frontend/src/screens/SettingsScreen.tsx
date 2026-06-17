import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Center,
  Group,
  Loader,
  NumberInput,
  Stack,
  Switch,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { IconAlertCircle } from "@tabler/icons-react";
import { apiGet, apiPut } from "../lib/api.js";
import type { AgentConfig, MutationResult, SettingsTimeouts } from "../lib/types.js";
import { useAuthGate } from "../components/AuthGate.js";
import { errorMessage, handleError, notifySaved } from "./_configCommon.js";

/** Go-duration like "300s", "1h30m", "500ms" — non-empty, starts with a number. */
const DURATION_RE = /^\d+(\.\d+)?(ns|us|µs|ms|s|m|h)([0-9.]+(ns|us|µs|ms|s|m|h))*$/;

function validateDuration(v: string): string | null {
  if (!v.trim()) return "Обязательное поле";
  if (!DURATION_RE.test(v.trim())) return "Неверный формат (например, 300s, 1h30m)";
  return null;
}

/**
 * Config screen with two independent forms: request/HTTP timeouts (Go-duration
 * strings) and core agent params (history depth, default temperature, RAG topK).
 * Each form loads on mount, validates basic types, and saves via PUT.
 */
export function SettingsScreen() {
  const { reportError } = useAuthGate();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingTimeouts, setSavingTimeouts] = useState(false);
  const [savingAgent, setSavingAgent] = useState(false);

  const timeoutsForm = useForm<SettingsTimeouts>({
    initialValues: { llm_request: "", http_client: "", llm_activity: "" },
    validate: {
      llm_request: validateDuration,
      http_client: validateDuration,
      llm_activity: validateDuration,
    },
  });

  const agentForm = useForm<AgentConfig>({
    initialValues: { max_history: 0, default_temperature: 0, auto_memory: true },
    validate: {
      max_history: (v) =>
        Number.isInteger(v) && v >= 0 ? null : "Целое число ≥ 0",
      default_temperature: (v) =>
        v >= 0 && v <= 2 ? null : "Число от 0 до 2",
    },
  });

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    Promise.all([
      apiGet<SettingsTimeouts>("/settings/timeouts"),
      apiGet<AgentConfig>("/settings/agent"),
    ])
      .then(([timeouts, agent]) => {
        if (!alive) return;
        timeoutsForm.setValues(timeouts);
        timeoutsForm.resetDirty(timeouts);
        agentForm.setValues(agent);
        agentForm.resetDirty(agent);
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

  async function saveTimeouts(values: SettingsTimeouts) {
    setSavingTimeouts(true);
    try {
      await apiPut<MutationResult>("/settings/timeouts", values);
      timeoutsForm.resetDirty(values);
      notifySaved("Таймауты сохранены");
    } catch (err) {
      handleError(err, reportError);
    } finally {
      setSavingTimeouts(false);
    }
  }

  async function saveAgent(values: AgentConfig) {
    setSavingAgent(true);
    try {
      await apiPut<MutationResult>("/settings/agent", values);
      agentForm.resetDirty(values);
      notifySaved("Параметры агента сохранены");
    } catch (err) {
      handleError(err, reportError);
    } finally {
      setSavingAgent(false);
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
      <Title order={2}>Настройки</Title>

      {loadError && (
        <Alert color="red" icon={<IconAlertCircle size={18} />} title="Ошибка загрузки">
          {loadError}
        </Alert>
      )}

      <Card withBorder padding="lg" radius="md">
        <form onSubmit={timeoutsForm.onSubmit(saveTimeouts)}>
          <Stack gap="md">
            <Title order={4}>Таймауты</Title>
            <TextInput
              label="LLM-запрос (llm_request)"
              description="Сторожевой таймер на один LLM-вызов, напр. 300s"
              placeholder="300s"
              {...timeoutsForm.getInputProps("llm_request")}
            />
            <TextInput
              label="HTTP-клиент (http_client)"
              description="Таймаут HTTP-клиента, напр. 30s"
              placeholder="30s"
              {...timeoutsForm.getInputProps("http_client")}
            />
            <TextInput
              label="Активность LLM (llm_activity)"
              description="Таймаут отсутствия активности стрима, напр. 30s"
              placeholder="30s"
              {...timeoutsForm.getInputProps("llm_activity")}
            />
            <Group justify="flex-end">
              <Button
                type="submit"
                loading={savingTimeouts}
                disabled={!timeoutsForm.isDirty()}
              >
                Сохранить
              </Button>
            </Group>
          </Stack>
        </form>
      </Card>

      <Card withBorder padding="lg" radius="md">
        <form onSubmit={agentForm.onSubmit(saveAgent)}>
          <Stack gap="md">
            <Title order={4}>Параметры агента</Title>
            <NumberInput
              label="Глубина истории (max_history)"
              description="Сколько последних сообщений держать в контексте"
              min={0}
              step={1}
              allowDecimal={false}
              {...agentForm.getInputProps("max_history")}
            />
            <NumberInput
              label="Температура по умолчанию (default_temperature)"
              description="От 0 до 2"
              min={0}
              max={2}
              step={0.1}
              decimalScale={2}
              {...agentForm.getInputProps("default_temperature")}
            />
            <Switch
              label="Долгосрочная память (auto_memory)"
              description="Автоматически сохранять важные факты о пользователе из диалога"
              {...agentForm.getInputProps("auto_memory", { type: "checkbox" })}
            />
            <Group justify="flex-end">
              <Button type="submit" loading={savingAgent} disabled={!agentForm.isDirty()}>
                Сохранить
              </Button>
            </Group>
          </Stack>
        </form>
      </Card>
    </Stack>
  );
}
