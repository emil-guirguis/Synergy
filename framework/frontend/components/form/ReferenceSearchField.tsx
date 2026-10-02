import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Autocomplete, CircularProgress, TextField } from '@mui/material';

export interface ReferenceSearchOption {
  value: string | number;
  label: string;
}

export interface ReferenceSearchConfig {
  endpoint: string;
  valueField?: string;
  labelField?: string;
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
  label, placeholder, value, valueLabel, disabled, error, config, search, onChange,
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
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          placeholder={placeholder}
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
