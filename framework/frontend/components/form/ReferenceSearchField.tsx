import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Autocomplete, Box, CircularProgress, TextField } from '@mui/material';

export interface ReferenceSearchOption {
  value: string | number;
  label: string;
  /** Full source row behind this option, when the search impl provides one — lets a picker
   *  default other fields (e.g. a catalog item's description) off the same pick. */
  raw?: Record<string, any>;
}

export interface ReferenceSearchConfig {
  endpoint: string;
  valueField?: string;
  /** Result field shown as the option label — or several, joined with spaces (e.g. first + last name). */
  labelField?: string | string[];
  /** Row column holding the picked value's label (e.g. quote_line.item_name) — used by grids
   *  to show the current label without a lookup. */
  displayField?: string;
  /** Raw source-row field (ReferenceSearchOption.raw) shown alongside the label in the open
   *  dropdown list — e.g. a catalog item's code plus its sales description — so the list reads
   *  "CODE — description" while the field itself still collapses to just the code once picked. */
  descriptionField?: string;
  /** Other columns on the same row to default from the picked option's raw row, as
   *  { targetColumn: rawField } — e.g. { description: 'sales_desc', rate: 'sales_price' } on an
   *  item picker, so Description and Rate stay in sync no matter which column's own search found
   *  the match. Only a target whose raw field actually has a value is written. */
  fillFields?: Record<string, string>;
  /** Narrows the endpoint's own default multi-field search to just these columns — e.g. an item
   *  picker searching only the code, not its description/category too. The endpoint decides which
   *  names it actually honors (typically its own default search fields, for safety). */
  searchFields?: string[];
  /** The row field this picker actually writes the picked value into, when it differs from the
   *  grid column's own name — e.g. a Description column that searches sales_desc but still picks
   *  the same underlying qb_item_id as the Item column. Defaults to the column's own name. */
  valueColumn?: string;
}

export interface ReferenceSearchFieldProps {
  label?: string;
  placeholder?: string;
  value: string | number | null;
  /** Current value's display label, if already known (e.g. loaded with the entity) — shown
   *  immediately instead of an empty field while the user hasn't typed a new search yet. */
  valueLabel?: string | null;
  disabled?: boolean;
  error?: string;
  /** Focus the input on mount — e.g. a grid cell that just entered edit mode. */
  autoFocus?: boolean;
  config: ReferenceSearchConfig;
  /** Performs the actual search — apps supply this (their own API base + auth headers), the
   *  field itself has no idea how to reach the network. Resolve to [] on error or no match. */
  search: (config: ReferenceSearchConfig, query: string) => Promise<ReferenceSearchOption[]>;
  onChange: (option: ReferenceSearchOption | null) => void;
}

/**
 * Async picker for a "reference" field (declared via a schema field's `referenceSearch` option
 * — see SchemaDefinition.js) — e.g. picking a customer onto a new record, instead of a static
 * enumValues dropdown. Browses like QuickBooks' own Customer dropdown: opening it (even with
 * nothing typed) loads a first page immediately, and typing narrows it — not a blank box that
 * only responds once you start typing. Debounces input, shows a spinner while a search is in
 * flight, and always keeps the most recent request's results (a slow earlier response can't
 * clobber a faster later one).
 */
export const ReferenceSearchField: React.FC<ReferenceSearchFieldProps> = ({
  label, placeholder, value, valueLabel, disabled, error, autoFocus, config, search, onChange,
}) => {
  const [inputValue, setInputValue] = useState(valueLabel ?? '');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ReferenceSearchOption[]>([]);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  // A freshly-loaded entity's known label arrives after mount (async fetch) — sync it in
  // once, without clobbering whatever the user has since typed.
  useEffect(() => {
    if (valueLabel != null && value != null) setInputValue(valueLabel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueLabel, value]);

  // Only searches while the dropdown is open — no wasted calls before the user ever interacts
  // with the field. An empty query still searches (server returns its default first page,
  // e.g. alphabetical) so opening the field with nothing typed browses the list immediately,
  // the same way QuickBooks' own Customer dropdown does.
  useEffect(() => {
    if (!open) return;
    const query = inputValue.trim();
    const myId = ++requestId.current;
    setLoading(true);
    const t = setTimeout(() => {
      search(config, query)
        .then((results) => { if (requestId.current === myId) setOptions(results); })
        .catch(() => { if (requestId.current === myId) setOptions([]); })
        .finally(() => { if (requestId.current === myId) setLoading(false); });
    }, query ? 300 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputValue, open, config.endpoint]);

  const selected = useMemo<ReferenceSearchOption | null>(
    () => (value == null ? null : { value, label: valueLabel ?? inputValue }),
    [value, valueLabel, inputValue]
  );

  return (
    <Autocomplete<ReferenceSearchOption>
      value={selected}
      onChange={(_e, next) => onChange(next)}
      inputValue={inputValue}
      onInputChange={(_e, next) => setInputValue(next)}
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      options={options}
      loading={loading}
      disabled={disabled}
      isOptionEqualToValue={(a, b) => a.value === b.value}
      getOptionLabel={(o) => o.label}
      filterOptions={(x) => x} // server already filtered by the search query
      // The dropdown defaults to the input's own width, which crops a code + description
      // option before it's readable. fit-content lets it grow to the longest option instead
      // (capped below) — the documented MUI recipe for a popper wider than its anchor.
      slotProps={{ popper: { style: { width: 'fit-content' } } }}
      renderOption={(liProps, option) => {
        const desc = config.descriptionField ? option.raw?.[config.descriptionField] : null;
        if (!desc) {
          return (
            <li {...liProps} key={option.value} title={option.label}>
              <Box component="span" sx={{ display: 'block', maxWidth: '480px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {option.label}
              </Box>
            </li>
          );
        }
        return (
          <li {...liProps} key={option.value} title={`${option.label} — ${desc}`}>
            <Box sx={{ display: 'flex', width: '480px', gap: 1.5 }}>
              <Box component="span" sx={{ flex: '0 0 120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {option.label}
              </Box>
              <Box component="span" sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'text.secondary', borderLeft: '1px solid', borderColor: 'divider', pl: 1.5 }}>
                {desc}
              </Box>
            </Box>
          </li>
        );
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          placeholder={placeholder}
          autoFocus={autoFocus}
          error={!!error}
          helperText={error}
          size="small"
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <>
                {loading ? <CircularProgress color="inherit" size={16} /> : null}
                {params.InputProps.endAdornment}
              </>
            ),
          }}
        />
      )}
    />
  );
};

export default ReferenceSearchField;
