import { useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconAlertCircle, IconCheck, IconRefresh, IconSearch, IconX } from "@tabler/icons-react";
import { apiGet, apiPut, ApiError } from "../lib/api.js";
import type { CatalogProvider } from "../lib/catalog.js";
import { catalogSubtitle, loadCatalog, searchCatalog } from "../lib/catalog.js";
import type { CatalogRow, ModelRoles } from "../lib/types.js";
import { useAuthGate } from "../components/AuthGate.js";
import { ModelRefPicker } from "../components/ModelRefPicker.js";
import { errorMessage, handleError, notifySaved } from "./_configCommon.js";

const ROLE_FIELDS: { key: keyof ModelRoles; label: string; description?: string }[] = [
  { key: "default", label: "По умолчанию (default)" },
  { key: "router", label: "Маршрутизатор (router)" },
  { key: "error_correction", label: "Исправление ошибок (error_correction)" },
  { key: "speech", label: "Речь (speech)" },
  { key: "synthesizer", label: "Синтезатор (synthesizer)" },
  {
    key: "decision",
    label: "Решения (decision)",
    description:
      "Быстрые типизированные решения перед агентом. Пусто = decision-слой выключен.",
  },
];

const EMPTY_ROLES: ModelRoles = {
  default: "",
  router: "",
  error_correction: "",
  speech: "",
  synthesizer: "",
  decision: "",
};

/** Roles that pick from the curated System One list instead of OpenRouter. */
const decisionProvider = (key: keyof ModelRoles): CatalogProvider =>
  key === "decision" ? "decision" : "openrouter";

/**
 * Models admin: model roles (6 slots) + a read-only browser over the live
 * OpenRouter catalog. There is no registry any more — a role is a free-form ref,
 * and the picker searches the catalog by name on the client.
 */
export function ModelsScreen() {
  const { reportError } = useAuthGate();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [roles, setRoles] = useState<ModelRoles>(EMPTY_ROLES);
  const [savingRoles, setSavingRoles] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);

  const [catalogs, setCatalogs] = useState<Record<CatalogProvider, CatalogRow[]>>({
    openrouter: [],
    decision: [],
  });
  const [stale, setStale] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<string>("openrouter");

  async function loadAll(force = false) {
    const [openrouter, decision, roleVals] = await Promise.all([
      loadCatalog("openrouter", force),
      loadCatalog("decision", force),
      apiGet<ModelRoles>("/models/roles"),
    ]);
    setCatalogs({ openrouter: openrouter.items, decision: decision.items });
    setStale(openrouter.stale);
    setRoles({ ...EMPTY_ROLES, ...roleVals });
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    loadAll()
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

  async function refreshCatalog() {
    setReloading(true);
    try {
      await loadAll(true);
      notifySaved("Каталог обновлён");
    } catch (err) {
      handleError(err, reportError);
    } finally {
      setReloading(false);
    }
  }

  async function saveRoles() {
    setSavingRoles(true);
    setRoleError(null);
    try {
      await apiPut<{ ok: boolean; warnings?: string[] }>("/models/roles", roles);
      notifySaved("Роли сохранены");
    } catch (err) {
      // 400 from PUT /roles carries a human message (unknown decision ref, bad shape).
      if (err instanceof ApiError && !err.isAuth) setRoleError(err.message);
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

  const activeItems = catalogs[tab === "decision" ? "decision" : "openrouter"];
  const visible = searchCatalog(activeItems, query).slice(0, 100);

  return (
    <Stack gap="lg">
      <Title order={2}>Модели</Title>

      {loadError && (
        <Alert color="red" icon={<IconAlertCircle size={18} />} title="Ошибка загрузки">
          {loadError}
        </Alert>
      )}
      {stale && (
        <Alert color="yellow" icon={<IconAlertCircle size={18} />} title="Каталог устарел">
          OpenRouter недоступен — показан последний загруженный список. Роли можно ввести вручную.
        </Alert>
      )}

      <Card withBorder padding="lg" radius="md">
        <Stack gap="md">
          <Title order={4}>Роли моделей</Title>
          <Text size="sm" c="dimmed">
            Роль — свободный ref <Text span ff="monospace">provider:model</Text>. Модели выбираются
            из живого каталога OpenRouter (поиск по названию), ручной ввод тоже возможен. Пустое
            значение очищает роль.
          </Text>
          {roleError && (
            <Alert color="red" icon={<IconAlertCircle size={18} />} title="Ошибка сохранения ролей">
              {roleError}
            </Alert>
          )}
          {ROLE_FIELDS.map((f) => (
            <ModelRefPicker
              key={f.key}
              label={f.label}
              description={f.description}
              value={roles[f.key] ?? ""}
              items={catalogs[decisionProvider(f.key)]}
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

      <Card withBorder padding="lg" radius="md">
        <Stack gap="md">
          <Group justify="space-between">
            <Title order={4}>Каталог</Title>
            <Button
              variant="default"
              size="xs"
              leftSection={<IconRefresh size={14} />}
              loading={reloading}
              onClick={refreshCatalog}
            >
              Обновить
            </Button>
          </Group>
          <Tabs value={tab} onChange={(v) => setTab(v ?? "openrouter")}>
            <Tabs.List>
              <Tabs.Tab value="openrouter">
                OpenRouter ({catalogs.openrouter.length})
              </Tabs.Tab>
              <Tabs.Tab value="decision">Решения ({catalogs.decision.length})</Tabs.Tab>
            </Tabs.List>
          </Tabs>
          <TextInput
            placeholder="Поиск по названию модели…"
            leftSection={<IconSearch size={16} />}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          {activeItems.length === 0 ? (
            <Text c="dimmed" size="sm">
              Каталог пуст — проверьте доступность OpenRouter или введите ref вручную в роли.
            </Text>
          ) : (
            <Table.ScrollContainer minWidth={720}>
              <Table striped highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Название</Table.Th>
                    <Table.Th>Ref</Table.Th>
                    <Table.Th>Контекст</Table.Th>
                    <Table.Th>$ / 1M (in / out)</Table.Th>
                    <Table.Th>Tools</Table.Th>
                    <Table.Th>Reasoning</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {visible.map((row) => (
                    <Table.Tr key={row.ref}>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <Text size="sm">{row.name}</Text>
                          {row.aliased && (
                            <Badge size="xs" variant="light">
                              алиас
                            </Badge>
                          )}
                        </Group>
                        {row.note && (
                          <Text size="xs" c="dimmed">
                            {row.note}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" ff="monospace">
                          {row.ref}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {row.contextLength ? `${Math.round(row.contextLength / 1000)}K` : "—"}
                      </Table.Td>
                      <Table.Td>
                        {catalogSubtitle(row).includes("за 1M")
                          ? catalogSubtitle(row).split(" · ").pop()?.replace(" за 1M", "")
                          : "—"}
                      </Table.Td>
                      <Table.Td>{row.supportsTools ? <BoolYes /> : <BoolNo />}</Table.Td>
                      <Table.Td>{row.supportsReasoning ? <BoolYes /> : <BoolNo />}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
          {activeItems.length > visible.length && (
            <Text size="xs" c="dimmed">
              Показаны первые {visible.length} из {activeItems.length} — уточните поиск.
            </Text>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}

function BoolYes() {
  return <IconCheck size={16} color="var(--mantine-color-green-6)" />;
}
function BoolNo() {
  return <IconX size={16} color="var(--mantine-color-gray-5)" />;
}
