import React from 'react';
import { Chip } from '@mui/material';

export interface StatusChipProps {
  label: string;
  color: 'success' | 'default' | 'error' | 'warning' | 'info';
}

/** Small/outlined by construction — cheap enough for hundreds of table rows. */
export const StatusChip: React.FC<StatusChipProps> = ({ label, color }) => (
  <Chip label={label} color={color} variant="outlined" size="small" />
);

export default StatusChip;
