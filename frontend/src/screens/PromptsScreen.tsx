import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Stack,
  Tabs,
  Text,
  Textarea,
  Title,
} from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { apiGet, apiPut } from "../lib/api.js";
import type { Prompt } from "../lib/types.js";
import { useAuthGate } from "../components/AuthGate.js";
import { errorMessage, handleError, notifySaved } from "./_configCommon.js";

/** Canonical key order surfaced by the backend. */
const PROMPT_KEYS = ["SOUL", "FORMAT", "INTEGRITY", "SYNTHESIZER", "WELCOME", "MONITORING"];

/**
 * System-prompt editor. One tab per known key with a plain-text Textarea (raw
 * preview — no markdown rendering) and a per-key Save that PUTs the body. The
 * backend treats admin input as trusted (no promptguard), so we only guard UX.
 */
export function PromptsScreen() {
  const { reportError } = useAuthGate();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState<string>(PROMPT_KEYS[0]);
  // Saved server value + the current draft, keyed by prompt key.
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    apiGet<Prompt[]>("/prompts")
      .then((rows) => {
        if (!alive) return;
        const byKey: Record<string, string> = {};
        for (const key of PROMPT_KEYS) byKey[key] = "";
        for (const row of rows) byKey[row.key] = row.body ?? "";
        setSaved(byKey);
        setDrafts(byKey);
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

  async function save(key: string) {
    setSavingKey(key);
    try {
      const body = drafts[key] ?? "";
      await apiPut<Prompt>(`/prompts/${encodeURIComponent(key)}`, { body });
      setSaved((s) => ({ ...s, [key]: body }));
      notifySaved(`Промпт ${key} сохранён`);
    } catch (err) {
      handleError(err, reportError);
    } finally {
      setSavingKey(null);
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
      <Title order={2}>Промпты</Title>

      {loadError && (
        <Alert color="red" icon={<IconAlertCircle size={18} />} title="Ошибка загрузки">
          {loadError}
        </Alert>
      )}

      <Tabs value={active} onChange={(v) => setActive(v ?? PROMPT_KEYS[0])} keepMounted={false}>
        <Tabs.List>
          {PROMPT_KEYS.map((key) => (
            <Tabs.Tab key={key} value={key}>
              {key}
            </Tabs.Tab>
          ))}
        </Tabs.List>

        {PROMPT_KEYS.map((key) => (
          <Tabs.Panel key={key} value={key} pt="md">
            <PromptPanel
              promptKey={key}
              draft={drafts[key] ?? ""}
              dirty={(drafts[key] ?? "") !== (saved[key] ?? "")}
              saving={savingKey === key}
              onChange={(body) => setDrafts((d) => ({ ...d, [key]: body }))}
              onSave={() => save(key)}
            />
          </Tabs.Panel>
        ))}
      </Tabs>
    </Stack>
  );
}

function PromptPanel({
  promptKey,
  draft,
  dirty,
  saving,
  onChange,
  onSave,
}: {
  promptKey: string;
  draft: string;
  dirty: boolean;
  saving: boolean;
  onChange: (body: string) => void;
  onSave: () => void;
}) {
  const charCount = useMemo(() => draft.length, [draft]);

  return (
    <Card withBorder padding="lg" radius="md">
      <Stack gap="md">
        <Textarea
          label={`Тело промпта (${promptKey})`}
          description="Сырой текст — без разметки. Используется системой как есть."
          value={draft}
          onChange={(e) => onChange(e.currentTarget.value)}
          autosize
          minRows={10}
          maxRows={28}
          styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
        />
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {charCount} симв.
          </Text>
          <Button onClick={onSave} loading={saving} disabled={!dirty}>
            Сохранить
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
