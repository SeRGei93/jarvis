import { Select } from "@mantine/core";
import type { ModelRow } from "../lib/types.js";

/**
 * A model-ref Select. Options are the enabled model refs (shown with their
 * labels); the empty option clears the value (the backend stores ""). If the
 * current value points at a now-missing/disabled ref we still show it so the
 * operator can see (and fix) the stale assignment. Reused by the ModelsScreen
 * roles panel and the skill editor's "Модель" field.
 */
export function ModelRefSelect({
  label,
  description,
  placeholder = "— не задано —",
  value,
  models,
  onChange,
}: {
  label: string;
  description?: string;
  placeholder?: string;
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
    const labelText = row && row.label ? `${ref} — ${row.label}` : ref;
    return { value: ref, label: stale ? `${labelText} (выключена)` : labelText };
  });

  return (
    <Select
      label={label}
      description={description}
      placeholder={placeholder}
      data={data}
      value={value || null}
      onChange={(v) => onChange(v ?? "")}
      clearable
      searchable
      nothingFoundMessage="Нет включённых моделей"
    />
  );
}
