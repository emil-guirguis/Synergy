/**
 * Dashboard card: public.users data-hygiene gaps.
 *
 * Admin-only. Counts users missing a role and/or a linked QB sales rep —
 * both silently break permission checks and commission attribution. Hidden
 * when there's nothing to flag. Clicking opens the Users list.
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
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { formatNumber } from '@meterit/framework-frontend/utils';
import { getUserRoleRepCounts } from '../users/usersStore';
import CardInfoTooltip from '../../components/common/CardInfoTooltip';

export default function UserDataGapsCard() {
  const navigate = useNavigate();
  const [noRole, setNoRole] = useState(0);
  const [noQbRep, setNoQbRep] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const counts = await getUserRoleRepCounts();
        if (!active) return;
        setNoRole(counts.noRole);
        setNoQbRep(counts.noQbRep);
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

  if (!loaded || (noRole === 0 && noQbRep === 0)) return null;

  return (
    <Card variant="outlined" sx={{ mt: 3, minWidth: 240, maxWidth: 480, borderColor: 'error.main' }}>
      <CardActionArea onClick={() => navigate('/users')}>
        <CardContent sx={{ position: 'relative', pr: 5 }}>
          <CardInfoTooltip title="Users missing a role and/or a linked QB sales rep — both silently break permission checks and commission attribution." />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <WarningAmberIcon color="error" />
            <Typography variant="h6" fontWeight={700}>
              User data gaps
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {noRole > 0 && (
              <Chip label={`${formatNumber(noRole)} ${noRole === 1 ? 'user' : 'users'} missing role`} color="error" size="small" />
            )}
            {noQbRep > 0 && (
              <Chip label={`${formatNumber(noQbRep)} ${noQbRep === 1 ? 'user' : 'users'} missing QB sales rep`} color="error" size="small" />
            )}
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}
