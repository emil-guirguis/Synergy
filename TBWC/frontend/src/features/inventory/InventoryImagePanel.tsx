import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Link, Stack, TextField, Typography } from '@mui/material';
import { setItemImageStatus } from '../../services/itemImageService';
import type { ImageStatus, Inventory } from '../../types/inventory';

interface InventoryImagePanelProps {
  item?: Inventory;
  /** Verdict buttons are admin-only; everyone else sees the picture and its provenance. */
  canReview: boolean;
}

const STATUS_COLOR: Record<ImageStatus, 'default' | 'warning' | 'success' | 'error'> = {
  pending: 'default',
  auto: 'warning',
  approved: 'success',
  rejected: 'error',
  none: 'default',
};

const STATUS_HELP: Record<ImageStatus, string> = {
  pending: 'No image has been fetched for this item yet.',
  auto: 'Machine-picked and NOT yet checked by a person. Approve it or reject it.',
  approved: 'Checked by a person — safe for the printed sheet.',
  rejected: 'Marked wrong. The image was cleared and the fetch script will not retry it.',
  none: 'This line type has no product photo to find (freight, labour, licences).',
};

/**
 * Catalog thumbnail + its review verdict, rendered in place of the schema's
 * `image_url` field on the Inventory form.
 *
 * The thumbnails come from an automated web-image sweep
 * (TBWC/api/scripts/fetch-item-images.cjs), which is right often enough to be
 * worth running and wrong often enough that nothing it picks should reach a
 * customer-facing printout unchecked. Hence: the picture is shown large enough
 * to actually judge, next to the description it is supposed to match, with the
 * source page one click away.
 */
export const InventoryImagePanel: React.FC<InventoryImagePanelProps> = ({ item, canReview }) => {
  const [status, setStatus] = useState<ImageStatus>(item?.image_status ?? 'pending');
  const [imageUrl, setImageUrl] = useState<string | null>(item?.image_url ?? null);
  const [manualUrl, setManualUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The form is reused across records (row click -> same component instance),
  // so local state has to follow the item rather than only the first mount.
  useEffect(() => {
    setStatus(item?.image_status ?? 'pending');
    setImageUrl(item?.image_url ?? null);
    setManualUrl('');
    setError(null);
  }, [item?.qb_item_id, item?.image_url, item?.image_status]);

  if (!item?.qb_item_id) {
    return <Typography variant="body2" color="text.secondary">Save the item before adding an image.</Typography>;
  }

  const apply = async (next: ImageStatus, url?: string) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await setItemImageStatus(item.qb_item_id, next, url);
      setStatus(saved.image_status);
      setImageUrl(saved.image_url);
      if (url) setManualUrl('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the image verdict');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box data-testid="inventory-image-panel">
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <Box
          sx={{
            width: 160,
            height: 160,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
            bgcolor: '#fff',
            overflow: 'hidden',
          }}
        >
          {imageUrl ? (
            <Box component="img" src={imageUrl} alt={item.name ?? ''} sx={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          ) : (
            <Typography variant="caption" color="text.disabled">No image</Typography>
          )}
        </Box>

        <Stack spacing={1} sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            <Chip size="small" label={status} color={STATUS_COLOR[status]} />
            {item.image_confidence != null && status !== 'none' && (
              <Chip size="small" variant="outlined" label={`${item.image_confidence}% match`} />
            )}
            {item.image_source && <Chip size="small" variant="outlined" label={`picked by ${item.image_source}`} />}
          </Stack>

          <Typography variant="caption" color="text.secondary">{STATUS_HELP[status]}</Typography>

          {item.image_source_url && (
            <Typography variant="caption" noWrap>
              <Link href={item.image_source_url} target="_blank" rel="noopener noreferrer">
                Where this came from
              </Link>
            </Typography>
          )}

          {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}

          {canReview && (
            <>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Button size="small" variant="contained" color="success" disabled={busy || !imageUrl} onClick={() => apply('approved')}>
                  Approve
                </Button>
                <Button size="small" variant="outlined" color="error" disabled={busy || !imageUrl} onClick={() => apply('rejected')}>
                  Reject
                </Button>
                <Button size="small" variant="text" disabled={busy} onClick={() => apply('none')}>
                  No image needed
                </Button>
              </Stack>

              {/* The escape hatch that makes the whole thing usable: when the
                  sweep gets one wrong, pasting the right picture is faster than
                  tuning a rule and re-running. */}
              <Stack direction="row" spacing={1} alignItems="flex-start">
                <TextField
                  size="small"
                  fullWidth
                  label="Replace with image URL"
                  placeholder="https://…"
                  value={manualUrl}
                  onChange={(e) => setManualUrl(e.target.value)}
                  disabled={busy}
                />
                <Button
                  size="small"
                  sx={{ mt: 0.5 }}
                  disabled={busy || !manualUrl.trim().startsWith('https://')}
                  onClick={() => apply('approved', manualUrl.trim())}
                >
                  Use
                </Button>
              </Stack>
            </>
          )}
        </Stack>
      </Stack>
    </Box>
  );
};

export default InventoryImagePanel;
