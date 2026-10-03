import React, { useState } from 'react';
import {
  Alert, Box, Button, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, FormControl, InputLabel, MenuItem,
  Select, TextField,
} from '@mui/material';
import { SupportTicketList } from './SupportTicketList';
import type { SupportTicketListProps } from './SupportTicketList';
import type { CreateTicketPayload, SupportTicketService } from './types';

export interface SupportTicketsPageProps extends Pick<SupportTicketListProps, 'useStore' | 'isAdminSupport' | 'showClientColumn' | 'basePath'> {
  ticketService: SupportTicketService;
}

export const SupportTicketsPage: React.FC<SupportTicketsPageProps> = ({ useStore, isAdminSupport, showClientColumn, basePath, ticketService }) => {
  const store = useStore();

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating]     = useState(false);
  const [createError, setCreateError] = useState('');
  const [form, setForm] = useState<CreateTicketPayload>({
    title: '', description: '', type: 'general', priority: 'medium',
  });

  const handleCreate = async () => {
    if (!form.title.trim()) { setCreateError('Title is required'); return; }
    setCreating(true);
    setCreateError('');
    try {
      await ticketService.create(form);
      setCreateOpen(false);
      setForm({ title: '', description: '', type: 'general', priority: 'medium' });
      store.fetchItems({ _bypassCache: true });
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create ticket');
    } finally {
      setCreating(false);
    }
  };

  const openCreate = () => {
    setForm({ title: '', description: '', type: 'general', priority: 'medium' });
    setCreateError('');
    setCreateOpen(true);
  };

  return (
    <Box p={3}>
      <SupportTicketList useStore={useStore} isAdminSupport={isAdminSupport} showClientColumn={showClientColumn} basePath={basePath} onCreate={openCreate} />

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New Support Ticket</DialogTitle>
        <DialogContent>
          {createError && <Alert severity="error" sx={{ mb: 2 }}>{createError}</Alert>}
          <TextField
            label="Title"
            value={form.title}
            onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            fullWidth required margin="normal" autoFocus
          />
          <TextField
            label="Description"
            value={form.description ?? ''}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            fullWidth multiline rows={4} margin="normal"
          />
          <FormControl fullWidth margin="normal">
            <InputLabel>Type</InputLabel>
            <Select
              value={form.type ?? 'general'}
              label="Type"
              onChange={e => setForm(f => ({ ...f, type: e.target.value as CreateTicketPayload['type'] }))}
            >
              <MenuItem value="bug">Bug</MenuItem>
              <MenuItem value="feature_request">Feature Request</MenuItem>
              <MenuItem value="billing">Billing</MenuItem>
              <MenuItem value="account">Account</MenuItem>
              <MenuItem value="technical">Technical</MenuItem>
              <MenuItem value="general">General</MenuItem>
            </Select>
          </FormControl>
          <FormControl fullWidth margin="normal">
            <InputLabel>Priority</InputLabel>
            <Select
              value={form.priority ?? 'medium'}
              label="Priority"
              onChange={e => setForm(f => ({ ...f, priority: e.target.value as CreateTicketPayload['priority'] }))}
            >
              <MenuItem value="low">Low</MenuItem>
              <MenuItem value="medium">Medium</MenuItem>
              <MenuItem value="high">High</MenuItem>
              <MenuItem value="urgent">Urgent</MenuItem>
            </Select>
          </FormControl>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</Button>
          <Button variant="contained" onClick={handleCreate} disabled={creating}>
            {creating ? <CircularProgress size={18} /> : 'Submit Ticket'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default SupportTicketsPage;
