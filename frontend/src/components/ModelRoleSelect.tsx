import { Select } from "@mantine/core";
import type { ModelRow } from "../lib/types.js";

/**
 * One role → model-ref Select for the ModelsScreen roles panel. Options are the
 * enabled model refs; the empty option clears the role (the backend stores "").
 * If the current value points at a now-missing/disabled ref we still show it so
 * the operator can see (and fix) the stale assignment.
 */
export function ModelRoleSelect({
  label,
  description,
  value,
  models,
  onChange,
}: {
  label: string;
  description?: string;
  value: string;
  models: ModelRow[];
  onChange: (ref: string) => void;
}) {
  const enabledRefs = models.filter((m) => m.enabled).map((m) => m.ref);
  // Surface a stale (disabled/removed) current value so it isn't silently dropped.
  const refs = value && !enabledRefs.includes(value) ? [value, ...enabledRefs] : enabledRefs;

  const data = refs.map((ref) => {
    const row = models.find((m) => m.ref === ref);
    const stale = row ? !row.enabled : true;
    const labelText =
      row && row.label ? `${ref} — ${row.label}` : ref;
    return { value: ref, label: stale ? `${labelText} (выключена)` : labelText };
  });

  return (
    <Select
      label={label}
      description={description}
      placeholder="— не задано —"
      data={data}
      value={value || null}
      onChange={(v) => onChange(v ?? "")}
      clearable
      searchable
      nothingFoundMessage="Нет включённых моделей"
    />
  );
}
