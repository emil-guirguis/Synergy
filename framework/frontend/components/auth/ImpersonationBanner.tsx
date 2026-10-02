import React from 'react';
import { Box, Typography, Button } from '@mui/material';

export interface ImpersonationBannerProps {
  /** Who you're currently viewing as. */
  label: string;
  onExit: () => void;
}

/** Sticky dev-mode indicator — mirrors the shape of a tenant-admin-view banner. */
export const ImpersonationBanner: React.FC<ImpersonationBannerProps> = ({ label, onExit }) => (
  <Box
    sx={{
      backgroundColor: 'warning.main',
      color: 'warning.contrastText',
      px: 3,
      py: 0.75,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 2,
      zIndex: 1300,
      position: 'sticky',
      top: 0,
    }}
  >
    <Typography variant="body2" fontWeight="medium">
      Dev mode — logged in as: <strong>{label}</strong>
    </Typography>
    <Button
      size="small"
      variant="outlined"
      onClick={onExit}
      sx={{
        color: 'inherit',
        borderColor: 'currentColor',
        '&:hover': { backgroundColor: 'rgba(0,0,0,0.1)' },
      }}
    >
      Exit impersonation
    </Button>
  </Box>
);

export default ImpersonationBanner;
