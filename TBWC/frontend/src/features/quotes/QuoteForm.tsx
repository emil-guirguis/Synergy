import React, { useEffect, useMemo, useState } from 'react';
import {
  Box, Grid, TextField, MenuItem, Autocomplete, Button, IconButton,
  Table, TableBody, TableCell, TableHead, TableRow, Typography, Divider,
  CircularProgress, Alert,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import { useQuotesEnhanced } from './quotesStore';
import { tokenStorage } from '../../utils/tokenStorage';
import { API_BASE_URL } from '../../config/api';
import type { Quote, QuoteLine } from '../../types/quote';
import type { Inventory } from '../../types/inventory';

interface QuoteFormProps {
  quote?: Quote;
  onCancel: () => void;
}

interface LineRow {
  key: string;
  qb_item_id: number | null;
  part_number: string;
  description: string;
  qty: number;
  unit_price: number;
}

const STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
];

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const t = tokenStorage.getToken();
  if (t) h['Authorization'] = `Bearer ${t}`;
  return h;
}

const money = (n: number) =>
  n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });

const num = (v: any) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

let keySeq = 0;
const newKey = () => `line-${keySeq++}`;

export const QuoteForm: React.FC<QuoteFormProps> = ({ quote, onCancel }) => {
  const quotes = useQuotesEnhanced();
  const isEdit = !!(quote && (quote.quote_id ?? quote.id));
  const quoteId = quote ? (quote.quote_id ?? quote.id) : undefined;

  const [header, setHeader] = useState({
    quote_number: quote?.quote_number ?? '',
    project_name: quote?.project_name ?? '',
    customer: quote?.customer ?? '',
    poc: quote?.poc ?? '',
    cc_email: quote?.cc_email ?? '',
    street_address: quote?.street_address ?? '',
    city_state_zip: quote?.city_state_zip ?? '',
    status: quote?.status ?? 'draft',
    notes: quote?.notes ?? '',
    tax: quote?.tax ?? 0,
    freight: quote?.freight ?? 0,
  });
  const [lines, setLines] = useState<LineRow[]>([]);
  const [options, setOptions] = useState<Inventory[]>([]);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load inventory options for the line picker.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/inventory?limit=1000`, { headers: authHeaders() });
        const data = await res.json();
        if (!cancelled) setOptions(data.data?.items || []);
      } catch { /* picker stays empty; manual entry still works */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // On edit, load the full quote (with its line items).
  useEffect(() => {
    let cancelled = false;
    if (!isEdit || quoteId == null) { setLines([{ key: newKey(), qb_item_id: null, part_number: '', description: '', qty: 1, unit_price: 0 }]); return; }
    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/quotes/${quoteId}`, { headers: authHeaders() });
        const data = await res.json();
        if (cancelled) return;
        const q: Quote = data.data;
        setHeader((h) => ({
          ...h,
          quote_number: q.quote_number ?? '', project_name: q.project_name ?? '', customer: q.customer ?? '',
          poc: q.poc ?? '', cc_email: q.cc_email ?? '', street_address: q.street_address ?? '',
          city_state_zip: q.city_state_zip ?? '', status: q.status ?? 'draft', notes: q.notes ?? '',
          tax: num(q.tax), freight: num(q.freight),
        }));
        const rows = (q.lines || []).map((l: QuoteLine) => ({
          key: newKey(),
          qb_item_id: l.qb_item_id ?? null,
          part_number: l.part_number ?? '',
          description: l.description ?? '',
          qty: num(l.qty),
          unit_price: num(l.unit_price),
        }));
        setLines(rows.length ? rows : [{ key: newKey(), qb_item_id: null, part_number: '', description: '', qty: 1, unit_price: 0 }]);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load quote');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isEdit, quoteId]);

  const setField = (k: keyof typeof header) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setHeader((h) => ({ ...h, [k]: e.target.value }));

  const updateLine = (key: string, patch: Partial<LineRow>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const addLine = () =>
    setLines((ls) => [...ls, { key: newKey(), qb_item_id: null, part_number: '', description: '', qty: 1, unit_price: 0 }]);

  const removeLine = (key: string) =>
    setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls));

  const pickInventory = (key: string, item: Inventory | null) => {
    if (!item) { updateLine(key, { qb_item_id: null }); return; }
    updateLine(key, {
      qb_item_id: item.qb_item_id,
      part_number: item.name ?? '',
      description: item.sales_desc ?? '',
      unit_price: num(item.base_price),
    });
  };

  const subtotal = useMemo(
    () => Math.round(lines.reduce((s, l) => s + num(l.qty) * num(l.unit_price), 0) * 100) / 100,
    [lines]
  );
  const total = useMemo(
    () => Math.round((subtotal + num(header.tax) + num(header.freight)) * 100) / 100,
    [subtotal, header.tax, header.freight]
  );

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const payload = {
      ...header,
      tax: num(header.tax),
      freight: num(header.freight),
      lines: lines
        .filter((l) => l.qb_item_id != null || l.part_number.trim() !== '' || num(l.qty) > 0)
        .map((l) => ({
          qb_item_id: l.qb_item_id,
          part_number: l.part_number || null,
          description: l.description || null,
          qty: num(l.qty),
          unit_price: num(l.unit_price),
        })),
    };
    try {
      if (isEdit && quoteId != null) {
        await quotes.updateQuote(String(quoteId), payload as any);
      } else {
        await quotes.createQuote(payload as any);
      }
      onCancel(); // closes the modal; the shared store already reflects the change
    } catch (e: any) {
      setError(e?.message || 'Failed to save quote');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>;
  }

  return (
    <Box className="quote-form" sx={{ display: 'flex', flexDirection: 'column', gap: 2 }} data-testid="quote-form">
      {error && <Alert severity="error">{error}</Alert>}

      <Grid container spacing={2}>
        <Grid item xs={12} sm={4}>
          <TextField fullWidth size="small" label="Quote #" value={header.quote_number} onChange={setField('quote_number')} />
        </Grid>
        <Grid item xs={12} sm={5}>
          <TextField fullWidth size="small" label="Project" value={header.project_name} onChange={setField('project_name')} />
        </Grid>
        <Grid item xs={12} sm={3}>
          <TextField fullWidth size="small" select label="Status" value={header.status} onChange={setField('status')}>
            {STATUS_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
        </Grid>
        <Grid item xs={12} sm={6}>
          <TextField fullWidth size="small" label="Customer" value={header.customer} onChange={setField('customer')} />
        </Grid>
        <Grid item xs={12} sm={6}>
          <TextField fullWidth size="small" label="POC" value={header.poc} onChange={setField('poc')} />
        </Grid>
        <Grid item xs={12} sm={6}>
          <TextField fullWidth size="small" label="Street Address" value={header.street_address} onChange={setField('street_address')} />
        </Grid>
        <Grid item xs={12} sm={6}>
          <TextField fullWidth size="small" label="City, State ZIP" value={header.city_state_zip} onChange={setField('city_state_zip')} />
        </Grid>
      </Grid>

      <Divider textAlign="left"><Typography variant="subtitle2">Line Items</Typography></Divider>

      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={{ minWidth: 260 }}>Item</TableCell>
            <TableCell>Description</TableCell>
            <TableCell align="right" sx={{ width: 90 }}>Qty</TableCell>
            <TableCell align="right" sx={{ width: 130 }}>Unit Price</TableCell>
            <TableCell align="right" sx={{ width: 130 }}>Ext.</TableCell>
            <TableCell sx={{ width: 48 }} />
          </TableRow>
        </TableHead>
        <TableBody>
          {lines.map((l) => {
            const selected = options.find((o) => o.qb_item_id === l.qb_item_id) || null;
            return (
              <TableRow key={l.key}>
                <TableCell>
                  <Autocomplete<Inventory>
                    size="small"
                    options={options}
                    value={selected}
                    onChange={(_e, v) => pickInventory(l.key, v)}
                    getOptionLabel={(o) => o.name || ''}
                    renderOption={(props, o) => (
                      <li {...props} key={o.qb_item_id}>
                        <Box>
                          <Typography variant="body2">{o.name}</Typography>
                          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', maxWidth: 360 }}>
                            {o.sales_desc}
                          </Typography>
                        </Box>
                      </li>
                    )}
                    isOptionEqualToValue={(o, v) => o.qb_item_id === v.qb_item_id}
                    renderInput={(params) => (
                      <TextField {...params} placeholder={l.qb_item_id == null && l.part_number ? l.part_number : 'Part # / search'} />
                    )}
                  />
                </TableCell>
                <TableCell>
                  <TextField fullWidth size="small" variant="standard" value={l.description}
                    onChange={(e) => updateLine(l.key, { description: e.target.value })} />
                </TableCell>
                <TableCell align="right">
                  <TextField size="small" variant="standard" type="number" value={l.qty}
                    onChange={(e) => updateLine(l.key, { qty: num(e.target.value) })}
                    inputProps={{ min: 0, style: { textAlign: 'right' } }} sx={{ width: 70 }} />
                </TableCell>
                <TableCell align="right">
                  <TextField size="small" variant="standard" type="number" value={l.unit_price}
                    onChange={(e) => updateLine(l.key, { unit_price: num(e.target.value) })}
                    inputProps={{ min: 0, step: '0.01', style: { textAlign: 'right' } }} sx={{ width: 110 }} />
                </TableCell>
                <TableCell align="right">{money(num(l.qty) * num(l.unit_price))}</TableCell>
                <TableCell>
                  <IconButton size="small" onClick={() => removeLine(l.key)} aria-label="remove line" disabled={lines.length <= 1}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <Box>
        <Button startIcon={<AddIcon />} onClick={addLine} size="small" data-testid="quote-add-line">Add line</Button>
      </Box>

      <Divider />

      <Grid container spacing={2} justifyContent="flex-end">
        <Grid item xs={12} sm={8}>
          <TextField fullWidth size="small" multiline minRows={2} label="Notes" value={header.notes} onChange={setField('notes')} />
        </Grid>
        <Grid item xs={12} sm={4}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
              <Typography variant="body2">Subtotal</Typography>
              <Typography variant="body2" data-testid="quote-subtotal">{money(subtotal)}</Typography>
            </Box>
            <TextField size="small" type="number" label="Tax" value={header.tax}
              onChange={(e) => setHeader((h) => ({ ...h, tax: num(e.target.value) }))}
              inputProps={{ min: 0, step: '0.01' }} />
            <TextField size="small" type="number" label="Freight" value={header.freight}
              onChange={(e) => setHeader((h) => ({ ...h, freight: num(e.target.value) }))}
              inputProps={{ min: 0, step: '0.01' }} />
            <Box sx={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid', borderColor: 'divider', pt: 1 }}>
              <Typography variant="subtitle1">Total</Typography>
              <Typography variant="subtitle1" data-testid="quote-total">{money(total)}</Typography>
            </Box>
          </Box>
        </Grid>
      </Grid>

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1 }}>
        <Button onClick={onCancel} disabled={saving} data-testid="quote-cancel">Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={saving} data-testid="quote-save">
          {saving ? 'Saving…' : isEdit ? 'Save Quote' : 'Create Quote'}
        </Button>
      </Box>
    </Box>
  );
};

export default QuoteForm;
