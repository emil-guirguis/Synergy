/**
 * Small "i" icon for a dashboard Card, explaining exactly what it counts —
 * the counting logic lives in each card's own component/comments; this just
 * surfaces it to the user without needing to read source. Defaults to
 * absolute top-right of CardContent (needs sx={{ position: 'relative' }} on
 * CardContent itself) — same spot InvoiceTotalsPage.tsx uses for its own
 * per-card icon button. Pass sx to reposition inline instead, for cards whose
 * top-right corner is already taken by a year Select (YearlyOrderTotalCard,
 * ReceivablesCard).
 */
import { IconButton, Tooltip, type SxProps, type Theme } from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

export default function CardInfoTooltip({ title, sx }: { title: string; sx?: SxProps<Theme> }) {
  return (
    <Tooltip title={title}>
      <IconButton
        size="small"
        onClick={(e) => e.stopPropagation()}
        aria-label="What this card counts"
        sx={sx ?? { position: 'absolute', top: 4, right: 4 }}
      >
        <InfoOutlinedIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}
