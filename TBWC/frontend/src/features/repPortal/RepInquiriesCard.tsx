/**
 * Dashboard card: rep inquiries summary.
 *
 * Always shown (admin-only — reps can't see inquiries). Displays the total
 * inquiry count, with outstanding (not-yet-invited) broken out. Clicking the
 * card opens the Rep Portal, which defaults to the Rep Inquiries tab.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Typography,
} from '@mui/material';
import PersonIcon from '@mui/icons-material/Person';
import { listLeads } from '../../services/repLeadsService';
import CardInfoTooltip from '../../components/common/CardInfoTooltip';

export default function RepInquiriesCard() {
  const navigate = useNavigate();
  const [total, setTotal] = useState(0);
  const [outstanding, setOutstanding] = useState(0);
  const [readyToApprove, setReadyToApprove] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const leads = await listLeads();
        if (!active) return;
        const pending = leads.filter((l) => !l.invited_at);
        setTotal(leads.length);
        setOutstanding(pending.length);
        setReadyToApprove(pending.filter((l) => l.email_verified).length);
      } catch {
        /* leave counts at zero on error */
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const hasOutstanding = outstanding > 0;

  return (
    <Card
      variant="outlined"
      sx={{
        mt: 3,
        minWidth: 240,
        maxWidth: 480,
        borderColor: hasOutstanding ? 'warning.main' : 'divider',
      }}
    >
      <CardActionArea onClick={() => navigate('/rep-portal')}>
        <CardContent sx={{ position: 'relative', pr: 5 }}>
          <CardInfoTooltip title="Total rep inquiries (public sign-up form). Outstanding = not yet invited. Ready to approve = outstanding and email verified." />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <PersonIcon color={hasOutstanding ? 'warning' : 'action'} />
            <Typography variant="h6" fontWeight={700}>
              {total} rep {total === 1 ? 'inquiry' : 'inquiries'}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {!loaded ? (
              <Typography variant="body2" color="text.secondary">
                Loading…
              </Typography>
            ) : hasOutstanding ? (
              <>
                <Chip label={`${outstanding} outstanding`} color="warning" size="small" />
                {readyToApprove > 0 && (
                  <Chip label={`${readyToApprove} ready to approve`} color="success" size="small" />
                )}
              </>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Nothing outstanding
              </Typography>
            )}
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}
