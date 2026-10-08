import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert, Box, Button, Card, CardContent, Chip, CircularProgress,
  Divider, FormControl, Grid, InputLabel, MenuItem, Rating, Select,
  Tab, Tabs, TextField, Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SaveIcon from '@mui/icons-material/Save';
import type { SupportTicket, TicketType, UpdateTicketPayload, SupportTicketService, AssignableUser } from './types';

const TICKET_TYPE_LABELS: Record<TicketType, string> = {
  bug:             'Bug',
  feature_request: 'Feature Request',
  billing:         'Billing',
  account:         'Account',
  technical:       'Technical',
  general:         'General',
};

const STATUS_COLORS: Record<string, 'default' | 'info' | 'warning' | 'success' | 'error'> = {
  open: 'info', in_progress: 'warning', resolved: 'success', closed: 'default',
};

const PRIORITY_COLORS: Record<string, 'default' | 'info' | 'warning' | 'error'> = {
  low: 'default', medium: 'info', high: 'warning', urgent: 'error',
};

export interface TicketDetailPageProps {
  ticketService: SupportTicketService;
  isAdminSupport: boolean;
  /** Route prefix the "Back to Tickets" button returns to. */
  basePath?: string;
  /** Users the ticket can be assigned to (admin only — ignored otherwise). */
  assignableUsers?: AssignableUser[];
  /** Renders the Documents tab's content (the app wires its own DocumentsGrid
   *  instance — this module stays storage/API-agnostic). Omit to hide the tab. */
  renderDocuments?: (ticketId: number) => React.ReactNode;
}

export const TicketDetailPage: React.FC<TicketDetailPageProps> = ({ ticketService, isAdminSupport, basePath = '/support/tickets', assignableUsers = [], renderDocuments }) => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [ticket, setTicket]   = useState<SupportTicket | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');
  const [form, setForm]       = useState<UpdateTicketPayload>({ title: '' });
  const [tab, setTab]         = useState(0);
  const [csatSubmitting, setCsatSubmitting] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    ticketService.getById(Number(id))
      .then(t => {
        setTicket(t);
        setForm({
          title: t.title,
          description: t.description ?? '',
          type: t.type,
          status: t.status,
          priority: t.priority,
          assigned_to_users_id: t.assigned_to_users_id ?? undefined,
          client_tenant_id: t.client_tenant_id ?? undefined,
          serial_number: t.serial_number ?? '',
        });
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load ticket'))
      .finally(() => setLoading(false));
  }, [id, ticketService]);

  const handleSave = async () => {
    if (!ticket) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const updated = await ticketService.update(ticket.support_ticket_id, form);
      setTicket(updated);
      setSuccess('Ticket updated');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update ticket');
    } finally {
      setSaving(false);
    }
  };

  const handleCsat = async (value: number) => {
    if (!ticket) return;
    setCsatSubmitting(true);
    setError('');
    try {
      setTicket(await ticketService.submitCsat(ticket.support_ticket_id, value));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to submit rating');
    } finally {
      setCsatSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="60vh">
        <CircularProgress />
      </Box>
    );
  }

  if (!ticket) {
    return (
      <Box p={3}>
        <Alert severity="error">{error || 'Ticket not found'}</Alert>
        <Button startIcon={<ArrowBackIcon />} onClick={() => navigate(basePath)} sx={{ mt: 2 }}>
          Back to Tickets
        </Button>
      </Box>
    );
  }

  return (
    <Box p={3} maxWidth={900} mx="auto">
      <Button startIcon={<ArrowBackIcon />} onClick={() => navigate(basePath)} sx={{ mb: 2 }}>
        Back to Tickets
      </Button>

      <Box display="flex" alignItems="center" gap={2} mb={3}>
        <Typography variant="h5" fontWeight="bold">Ticket #{ticket.support_ticket_id}</Typography>
        <Chip label={TICKET_TYPE_LABELS[ticket.type] ?? ticket.type} size="small" variant="outlined" />
        <Chip label={ticket.status.replace('_', ' ')} color={STATUS_COLORS[ticket.status] ?? 'default'} />
        <Chip label={ticket.priority} color={PRIORITY_COLORS[ticket.priority] ?? 'default'} variant="outlined" />
      </Box>

      {error   && <Alert severity="error"   sx={{ mb: 2 }}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }}>{success}</Alert>}

      {renderDocuments && (
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
          <Tab label="General" />
          <Tab label="Documents" />
        </Tabs>
      )}

      {tab !== 0 ? (
        renderDocuments?.(ticket.support_ticket_id)
      ) : (
      <>
      <Card>
        <CardContent>
          <Grid container spacing={3}>
            <Grid item xs={12}>
              <TextField
                label="Title"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                fullWidth
                required
                disabled={!isAdminSupport}
              />
            </Grid>
            <Grid item xs={12} sm={4}>
              <TextField
                label="Serial Number"
                value={form.serial_number ?? ''}
                onChange={e => setForm(f => ({ ...f, serial_number: e.target.value }))}
                fullWidth
                disabled={!isAdminSupport}
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                label="Description"
                value={form.description ?? ''}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                fullWidth
                multiline
                rows={5}
                disabled={!isAdminSupport}
              />
            </Grid>

            {isAdminSupport && (
              <>
                <Grid item xs={12} sm={3}>
                  <FormControl fullWidth>
                    <InputLabel>Type</InputLabel>
                    <Select
                      value={form.type ?? 'general'}
                      label="Type"
                      onChange={e => setForm(f => ({ ...f, type: e.target.value as any }))}
                    >
                      <MenuItem value="bug">Bug</MenuItem>
                      <MenuItem value="feature_request">Feature Request</MenuItem>
                      <MenuItem value="billing">Billing</MenuItem>
                      <MenuItem value="account">Account</MenuItem>
                      <MenuItem value="technical">Technical</MenuItem>
                      <MenuItem value="general">General</MenuItem>
                    </Select>
                  </FormControl>
                </Grid>
                <Grid item xs={12} sm={3}>
                  <FormControl fullWidth>
                    <InputLabel>Status</InputLabel>
                    <Select
                      value={form.status ?? 'open'}
                      label="Status"
                      onChange={e => setForm(f => ({ ...f, status: e.target.value as any }))}
                    >
                      <MenuItem value="open">Open</MenuItem>
                      <MenuItem value="in_progress">In Progress</MenuItem>
                      <MenuItem value="resolved">Resolved</MenuItem>
                      <MenuItem value="closed">Closed</MenuItem>
                    </Select>
                  </FormControl>
                </Grid>
                <Grid item xs={12} sm={3}>
                  <FormControl fullWidth>
                    <InputLabel>Priority</InputLabel>
                    <Select
                      value={form.priority ?? 'medium'}
                      label="Priority"
                      onChange={e => setForm(f => ({ ...f, priority: e.target.value as any }))}
                    >
                      <MenuItem value="low">Low</MenuItem>
                      <MenuItem value="medium">Medium</MenuItem>
                      <MenuItem value="high">High</MenuItem>
                      <MenuItem value="urgent">Urgent</MenuItem>
                    </Select>
                  </FormControl>
                </Grid>
                <Grid item xs={12} sm={3}>
                  <FormControl fullWidth>
                    <InputLabel>Assigned To</InputLabel>
                    <Select
                      value={form.assigned_to_users_id ?? ''}
                      label="Assigned To"
                      onChange={e => setForm(f => ({ ...f, assigned_to_users_id: e.target.value || null }))}
                    >
                      <MenuItem value="">Unassigned</MenuItem>
                      {assignableUsers.map(u => (
                        <MenuItem key={u.id} value={u.id}>{u.name}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Grid>
              </>
            )}
          </Grid>

          {!isAdminSupport && (
            <Box mt={3}>
              <Divider sx={{ mb: 2 }} />
              <Typography variant="body2" color="text.secondary">
                Contact support to update the status or priority of this ticket.
              </Typography>
            </Box>
          )}
        </CardContent>
      </Card>

      {!isAdminSupport && ['resolved', 'closed'].includes(ticket.status) && (
        <Card sx={{ mt: 2 }}>
          <CardContent>
            {ticket.csat_rating ? (
              <>
                <Typography variant="subtitle2" gutterBottom>Thanks for your feedback</Typography>
                <Rating value={ticket.csat_rating} readOnly />
              </>
            ) : (
              <>
                <Typography variant="subtitle2" gutterBottom>How did we do?</Typography>
                <Rating
                  value={null}
                  disabled={csatSubmitting}
                  onChange={(_, value) => { if (value) void handleCsat(value); }}
                />
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Metadata row */}
      <Card sx={{ mt: 2 }}>
        <CardContent>
          <Grid container spacing={2}>
            <Grid item xs={6} sm={3}>
              <Typography variant="caption" color="text.secondary">Created by</Typography>
              <Typography variant="body2">{ticket.created_by_name ?? '—'}</Typography>
            </Grid>
            <Grid item xs={6} sm={3}>
              <Typography variant="caption" color="text.secondary">Assigned to</Typography>
              <Typography variant="body2">{ticket.assigned_to_name ?? 'Unassigned'}</Typography>
            </Grid>
            <Grid item xs={6} sm={3}>
              <Typography variant="caption" color="text.secondary">Client</Typography>
              <Typography variant="body2">{ticket.client_tenant_name ?? '—'}</Typography>
            </Grid>
            <Grid item xs={6} sm={3}>
              <Typography variant="caption" color="text.secondary">Created</Typography>
              <Typography variant="body2">{new Date(ticket.created_at).toLocaleString()}</Typography>
            </Grid>
            {ticket.resolved_at && (
              <Grid item xs={6} sm={3}>
                <Typography variant="caption" color="text.secondary">Resolved</Typography>
                <Typography variant="body2">{new Date(ticket.resolved_at).toLocaleString()}</Typography>
              </Grid>
            )}
          </Grid>
        </CardContent>
      </Card>

      {isAdminSupport && (
        <Box display="flex" justifyContent="flex-end" mt={2}>
          <Button
            variant="contained"
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
            onClick={handleSave}
            disabled={saving}
          >
            Save Changes
          </Button>
        </Box>
      )}
      </>
      )}
    </Box>
  );
};

export default TicketDetailPage;
