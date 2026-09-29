/**
 * Shared "plan, review, run" table for bulk import screens (TBWC's Document
 * Import and Commission Import both use this — see their own files for the
 * domain-specific planning/upload logic; this only owns rendering).
 *
 * Extracted after DocumentImportPanel crashed with an out-of-memory error on
 * a large folder: every planned row was a full un-paginated MUI TableRow, so
 * a multi-thousand-file import grew the DOM until the tab died. This
 * component paginates (only `rowsPerPage` rows ever mount at once, so DOM
 * node count is bounded regardless of how many files/rows were planned) and
 * keeps each row cheap — no per-row Tooltip/Popper, a native `title`
 * attribute instead where a caller needs a hover hint.
 *
 * Deliberately dumb: it doesn't know what a "row" means for either import
 * (a file vs. a spreadsheet line) — the caller supplies already-filtered
 * `rows`, column `render`ers, and facet dropdowns (status/type/sheet/etc).
 */
import React, { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  Typography,
} from '@mui/material';

export interface ImportColumn<T> {
  header: string;
  width?: number | string;
  render: (row: T) => React.ReactNode;
}

export interface ImportFacetOption {
  value: string;
  label: string;
  count: number;
}

export interface ImportFacet {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** e.g. "All statuses" — combined with the total count into one option. */
  allLabel: string;
  options: ImportFacetOption[];
  minWidth?: number;
}

export interface ImportProgress {
  done: number;
  total: number;
  label: string;
}

export interface ImportResultAlert {
  severity: 'success' | 'warning' | 'error' | 'info';
  message: React.ReactNode;
}

export interface ImportPanelProps<T> {
  rowKey: (row: T) => string;
  /** Already filtered — this component only paginates, it never filters. */
  rows: T[];
  /** Unfiltered count, for the "Showing X of Y" note. */
  totalCount: number;
  columns: ImportColumn<T>[];
  facets?: ImportFacet[];
  filtersActive?: boolean;
  onClearFilters?: () => void;
  progress?: ImportProgress | null;
  resultAlert?: ImportResultAlert | null;
  emptyMessage?: string;
  minTableWidth?: number;
  maxTableHeight?: number | string;
  rowsPerPageOptions?: number[];
  defaultRowsPerPage?: number;
}

const DEFAULT_ROWS_PER_PAGE_OPTIONS = [25, 50, 100, 250];

export function ImportPanel<T>({
  rowKey,
  rows,
  totalCount,
  columns,
  facets = [],
  filtersActive = false,
  onClearFilters,
  progress,
  resultAlert,
  emptyMessage = 'No rows match the current filter.',
  minTableWidth = 1200,
  maxTableHeight = 720,
  rowsPerPageOptions = DEFAULT_ROWS_PER_PAGE_OPTIONS,
  defaultRowsPerPage = DEFAULT_ROWS_PER_PAGE_OPTIONS[1],
}: ImportPanelProps<T>) {
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(defaultRowsPerPage);

  const pageCount = Math.max(1, Math.ceil(rows.length / rowsPerPage));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(safePage * rowsPerPage, safePage * rowsPerPage + rowsPerPage);

  return (
    <Box>
      {facets.length > 0 && rows.length + totalCount > 0 && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2, flexWrap: 'wrap' }}>
          <Typography variant="body2" color="text.secondary">Filter:</Typography>
          {facets.map((facet) => (
            <Select
              key={facet.id}
              size="small"
              value={facet.value}
              onChange={(e) => facet.onChange(e.target.value)}
              sx={{ minWidth: facet.minWidth ?? 200 }}
            >
              <MenuItem value="all">{facet.allLabel} ({totalCount})</MenuItem>
              {facet.options.map((opt) => (
                <MenuItem key={opt.value} value={opt.value} disabled={opt.count === 0}>
                  {opt.label} ({opt.count})
                </MenuItem>
              ))}
            </Select>
          ))}
          {filtersActive && onClearFilters && (
            <Button size="small" onClick={onClearFilters}>Clear filters</Button>
          )}
          {filtersActive && (
            <Typography variant="body2" color="text.secondary">
              Showing {rows.length} of {totalCount}.
            </Typography>
          )}
        </Box>
      )}

      {progress && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>{progress.label}</Typography>
          <LinearProgress
            variant="determinate"
            value={progress.total ? (progress.done / progress.total) * 100 : 0}
          />
        </Box>
      )}

      {resultAlert && (
        <Alert severity={resultAlert.severity} sx={{ mb: 2 }}>{resultAlert.message}</Alert>
      )}

      {totalCount > 0 && (
        <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: maxTableHeight, overflowX: 'auto' }}>
          <Table
            stickyHeader
            size="small"
            sx={{
              minWidth: minTableWidth,
              tableLayout: 'fixed',
              '& .MuiTableCell-root': { fontSize: '0.9rem', py: 1.25, whiteSpace: 'normal', wordBreak: 'break-word' },
            }}
          >
            <TableHead>
              <TableRow>
                {columns.map((col) => (
                  <TableCell key={col.header} sx={{ fontWeight: 600, width: col.width }}>{col.header}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {pageRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={columns.length} align="center">
                    <Typography variant="body2" color="text.secondary">{emptyMessage}</Typography>
                  </TableCell>
                </TableRow>
              )}
              {pageRows.map((row) => (
                <TableRow key={rowKey(row)} hover>
                  {columns.map((col) => (
                    <TableCell key={col.header}>{col.render(row)}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TablePagination
            component="div"
            count={rows.length}
            page={safePage}
            onPageChange={(_e, newPage) => setPage(newPage)}
            rowsPerPage={rowsPerPage}
            onRowsPerPageChange={(e) => {
              setRowsPerPage(parseInt(e.target.value, 10));
              setPage(0);
            }}
            rowsPerPageOptions={rowsPerPageOptions}
          />
        </TableContainer>
      )}
    </Box>
  );
}

export default ImportPanel;
