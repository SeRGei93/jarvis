import { Select } from "@mantine/core";
import type { ModelRow } from "../lib/types.js";

/**
 * A model-ref Select. The stored value is always the `ref` (e.g.
 * `openrouter:openai/gpt-4o`), but each option is shown by its human label
 * (falling back to the ref only when a model has no label). The empty option
 * clears the value (the backend stores ""). If the current value points at a
 * now-missing/disabled ref we still show it so the operator can see (and fix)
 * the stale assignment. Reused by the ModelsScreen roles panel, the skill
 * editor's "Модель" field, and the inline model picker in the skills list
 * (pass `size`/no `label` for a compact in-table control).
 */
export function ModelRefSelect({
  label,
  description,
  placeholder = "— не задано —",
  value,
  models,
  onChange,
  size,
  disabled,
}: {
  label?: string;
  description?: string;
  placeholder?: string;
  value: string;
  models: ModelRow[];
  onChange: (ref: string) => void;
  size?: string;
  disabled?: boolean;
}) {
  const enabledRefs = models.filter((m) => m.enabled).map((m) => m.ref);
  // Surface a stale (disabled/removed) current value so it isn't silently dropped.
  const refs = value && !enabledRefs.includes(value) ? [value, ...enabledRefs] : enabledRefs;

  const data = refs.map((ref) => {
    const row = models.find((m) => m.ref === ref);
    const stale = row ? !row.enabled : true;
    // Show the label as the model's name; fall back to the ref only if unlabelled.
    const labelText = row && row.label ? row.label : ref;
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
      size={size}
      disabled={disabled}
      nothingFoundMessage="Нет включённых моделей"
    />
  );
}
