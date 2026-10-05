import React, { useState } from 'react';
import {
  Alert, Box, Button, Collapse, IconButton, Paper, Table, TableBody, TableCell,
  TableHead, TableRow, Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import './SettingsForm.css';

export interface AiMemoryFile {
  path: string;
  content: string;
  updatedAt: string;
}

export interface AiMemoryPanelProps {
  files: AiMemoryFile[];
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
}

/**
 * Settings > AI Memory — read-only viewer over the shared public.ai_memory
 * table. Claude owns writes via the memory_20250818 tool (see
 * framework/backend/api/base/aiMemory.ts); this panel is look-only, same
 * pattern as TBWC's Customers viewer over a QB staging table.
 */
export const AiMemoryPanel: React.FC<AiMemoryPanelProps> = ({ files, loading, error, onRefresh }) => {
  const [openPath, setOpenPath] = useState<string | null>(null);

  return (
    <Box className="settings-form">
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Facts the AI chat has saved to its persistent memory. It reads these back at the start of every
          conversation — edit or delete by asking it in chat, not here.
        </Typography>
        {onRefresh && (
          <Button size="small" startIcon={<RefreshIcon />} onClick={onRefresh} disabled={loading}>
            Refresh
          </Button>
        )}
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {!error && files.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {loading ? 'Loading…' : 'Nothing saved yet.'}
        </Typography>
      )}

      {files.length > 0 && (
        <Paper variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 40 }} />
                <TableCell>Path</TableCell>
                <TableCell>Size</TableCell>
                <TableCell>Updated</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {files.map((f) => {
                const open = openPath === f.path;
                return (
                  <React.Fragment key={f.path}>
                    <TableRow hover onClick={() => setOpenPath(open ? null : f.path)} sx={{ cursor: 'pointer' }}>
                      <TableCell>
                        <IconButton size="small">
                          {open ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
                        </IconButton>
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{f.path}</TableCell>
                      <TableCell>{f.content.length < 1024 ? `${f.content.length} B` : `${(f.content.length / 1024).toFixed(1)} KB`}</TableCell>
                      <TableCell>{new Date(f.updatedAt).toLocaleString()}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell colSpan={4} sx={{ p: 0, border: 0 }}>
                        <Collapse in={open} unmountOnExit>
                          <Box
                            component="pre"
                            sx={{
                              m: 0,
                              p: 2,
                              bgcolor: 'action.hover',
                              fontFamily: 'monospace',
                              fontSize: '0.8rem',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              maxHeight: 400,
                              overflow: 'auto',
                            }}
                          >
                            {f.content}
                          </Box>
                        </Collapse>
                      </TableCell>
                    </TableRow>
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        </Paper>
      )}
    </Box>
  );
};

export default AiMemoryPanel;
