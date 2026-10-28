/**
 * Rep Inquiries tab.
 *
 * Ports the tbwc-site admin "Rep Inquiries" card: the register front door for
 * applicants who don't have an account yet. Admin approves (mints an invite +
 * emails a signup link) or deletes. Approve is gated on the applicant having
 * confirmed their email first.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { listLeads, approveLead, deleteLead, type RepLead } from '../../services/repLeadsService';

// Dashboard rep-inquiries card links here with ?filter=outstanding|ready —
// same pending/email_verified predicate RepInquiriesCard.tsx counts with.
type LeadFilter = 'outstanding' | 'ready' | null;
const FILTER_LABEL: Record<Exclude<LeadFilter, null>, string> = {
  outstanding: 'Outstanding',
  ready: 'Ready to approve',
};
function matchesFilter(l: RepLead, filter: LeadFilter): boolean {
  if (!filter) return true;
  if (filter === 'outstanding') return !l.invited_at;
  return !l.invited_at && l.email_verified;
}

type Msg = { text: string; severity: 'success' | 'error' } | null;

function fullName(l: RepLead): string {
  return [l.first_name, l.last_name].filter(Boolean).join(' ') || '—';
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

export default function RepInquiriesTab() {
  const [leads, setLeads] = useState<RepLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = searchParams.get('filter') as LeadFilter;
  const visibleLeads = leads.filter((l) => matchesFilter(l, filter));

  const clearFilter = () =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('filter');
      return next;
    });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLeads(await listLeads());
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Could not load inquiries', severity: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setRowBusy = (id: string, v: boolean) => setBusy((b) => ({ ...b, [id]: v }));

  async function onApprove(l: RepLead) {
    setRowBusy(l.id, true);
    try {
      const { email } = await approveLead(l.id);
      setMsg({ text: `Invited ${email}`, severity: 'success' });
      await load();
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Approve failed', severity: 'error' });
    } finally {
      setRowBusy(l.id, false);
    }
  }

  async function onDelete(l: RepLead) {
    if (!window.confirm('Delete this inquiry?\nThis cannot be undone.')) return;
    setRowBusy(l.id, true);
    try {
      await deleteLead(l.id);
      setMsg({ text: 'Deleted.', severity: 'success' });
      await load();
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Delete failed', severity: 'error' });
      setRowBusy(l.id, false);
    }
  }

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Applicants who requested rep access. Approve to email them a signup link.
      </Typography>

      {filter && (
        <Chip
          label={`Filter: ${FILTER_LABEL[filter]}`}
          size="small"
          onDelete={clearFilter}
          sx={{ mb: 2 }}
        />
      )}

      {msg && (
        <Alert severity={msg.severity} sx={{ mb: 2 }} onClose={() => setMsg(null)}>
          {msg.text}
        </Alert>
      )}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name / Email</TableCell>
              <TableCell>Phone</TableCell>
              <TableCell>About</TableCell>
              <TableCell>Requested</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                  <CircularProgress size={22} />
                </TableCell>
              </TableRow>
            ) : visibleLeads.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} sx={{ color: 'text.secondary', py: 3 }}>
                  {leads.length === 0 ? 'No inquiries yet.' : 'No inquiries match this filter.'}
                </TableCell>
              </TableRow>
            ) : (
              visibleLeads.map((l) => (
                <TableRow key={l.id} hover>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      {!l.email_verified && (
                        <Tooltip title="Applicant hasn't confirmed their email yet">
                          <Chip label="not verified" size="small" color="warning" variant="outlined" />
                        </Tooltip>
                      )}
                      <Typography variant="body2" fontWeight={600}>
                        {fullName(l)}
                      </Typography>
                    </Box>
                    <Typography variant="caption" color="text.secondary">
                      {l.email}
                    </Typography>
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{l.phone || '—'}</TableCell>
                  <TableCell sx={{ maxWidth: 260 }}>
                    <Tooltip title={l.about || ''}>
                      <Typography variant="body2" noWrap>
                        {l.about || '—'}
                      </Typography>
                    </Tooltip>
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
                    {fmtDate(l.created_at)}
                  </TableCell>
                  <TableCell align="right">
                    <Box sx={{ display: 'inline-flex', gap: 1, alignItems: 'center' }}>
                      {l.invited_at ? (
                        <Chip label="invited" size="small" color="success" />
                      ) : (
                        <Tooltip
                          title={
                            l.email_verified
                              ? ''
                              : 'Waiting on the applicant to confirm their email'
                          }
                        >
                          <span>
                            <Button
                              size="small"
                              variant="contained"
                              disabled={!l.email_verified || !!busy[l.id]}
                              onClick={() => onApprove(l)}
                            >
                              Approve
                            </Button>
                          </span>
                        </Tooltip>
                      )}
                      <Button
                        size="small"
                        color="error"
                        variant="text"
                        disabled={!!busy[l.id]}
                        onClick={() => onDelete(l)}
                      >
                        Delete
                      </Button>
                    </Box>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
