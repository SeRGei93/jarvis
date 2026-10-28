import { useMemo, useState } from "react";
import {
  ActionIcon,
  Box,
  Combobox,
  InputBase,
  ScrollArea,
  Text,
  useCombobox,
} from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import type { CatalogRow } from "../lib/types.js";
import { catalogSubtitle, searchCatalog } from "../lib/catalog.js";

/** Max options rendered at once — the catalog has ~460 rows, the DOM should not. */
const MAX_OPTIONS = 80;
/** A free-typed value is offered as a manual ref only when it looks like one. */
const MANUAL_REF = /^[^\s:]+[:/][^\s]*$/;

/**
 * Model-ref picker backed by a catalog.
 *
 * The stored value is the `ref` (`provider:model`), the visible label is the
 * model's human name, and search is a plain case-insensitive substring match on
 * that name — all client-side, no request per keystroke. A ref that is not in the
 * catalog (a `:nitro` suffix, a non-OpenRouter provider, or a model that appeared
 * after the catalog was cached) can still be typed by hand and is labelled
 * «нет в каталоге». Reused by the roles panel, the skill editor and the inline
 * picker in the skills list.
 */
export function ModelRefPicker({
  label,
  description,
  placeholder = "— не задано —",
  value,
  items,
  onChange,
  disabled,
  size,
  error,
}: {
  label?: string;
  description?: string;
  placeholder?: string;
  value: string;
  items: CatalogRow[];
  onChange: (ref: string) => void;
  disabled?: boolean;
  size?: string;
  error?: string | null;
}) {
  const [search, setSearch] = useState("");
  const [opened, setOpened] = useState(false);

  const combobox = useCombobox({
    onDropdownClose: () => {
      combobox.resetSelectedOption();
      setOpened(false);
      setSearch("");
    },
    onDropdownOpen: () => setOpened(true),
  });

  const filtered = useMemo(() => searchCatalog(items, search), [items, search]);
  const selected = items.find((i) => i.ref === value) ?? null;
  const shown = search.trim();
  const exactMatch = filtered.some((i) => i.ref === shown || i.id === shown);
  const manualRef = shown && !exactMatch && MANUAL_REF.test(shown) ? shown : null;

  const displayValue = opened ? search : (selected?.name ?? value);

  function pick(ref: string) {
    onChange(ref);
    combobox.closeDropdown();
  }

  return (
    <Combobox
      store={combobox}
      onOptionSubmit={pick}
      withinPortal
      shadow="md"
      disabled={disabled}
    >
      <Combobox.Target>
        <InputBase
          label={label}
          description={description}
          placeholder={placeholder}
          value={displayValue}
          error={error}
          size={size}
          disabled={disabled}
          rightSectionWidth={value && !disabled ? 64 : 32}
          rightSection={
            <Box style={{ display: "flex", alignItems: "center", gap: 2 }}>
              {value && !disabled && (
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="gray"
                  aria-label="Очистить"
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange("");
                    setSearch("");
                  }}
                >
                  <IconX size={12} />
                </ActionIcon>
              )}
              <Combobox.Chevron />
            </Box>
          }
          onChange={(e) => {
            setSearch(e.currentTarget.value);
            combobox.openDropdown();
            combobox.updateSelectedOptionIndex();
          }}
          onClick={() => combobox.openDropdown()}
          onFocus={() => combobox.openDropdown()}
          onBlur={() => combobox.closeDropdown()}
          rightSectionPointerEvents="all"
        />
      </Combobox.Target>

      <Combobox.Dropdown>
        <Combobox.Options>
          <ScrollArea.Autosize mah={280} type="scroll">
            {manualRef && (
              <Combobox.Option value={manualRef}>
                <Text size="sm">Использовать «{manualRef}»</Text>
                <Text size="xs" c="dimmed">
                  нет в каталоге — ручной ref
                </Text>
              </Combobox.Option>
            )}
            {filtered.slice(0, MAX_OPTIONS).map((row) => (
              <Combobox.Option value={row.ref} key={row.ref}>
                <Text size="sm" fw={row.ref === value ? 600 : undefined}>
                  {row.name}
                  {row.aliased ? " · алиас" : ""}
                </Text>
                <Text size="xs" c="dimmed">
                  {row.note || catalogSubtitle(row) || row.ref}
                </Text>
              </Combobox.Option>
            ))}
            {filtered.length > MAX_OPTIONS && (
              <Combobox.Empty>
                …и ещё {filtered.length - MAX_OPTIONS} — уточните запрос
              </Combobox.Empty>
            )}
            {filtered.length === 0 && !manualRef && (
              <Combobox.Empty>Ничего не найдено</Combobox.Empty>
            )}
          </ScrollArea.Autosize>
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}
