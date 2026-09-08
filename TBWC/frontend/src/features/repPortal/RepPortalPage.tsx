/**
 * Rep Portal — admin hub for rep access requests.
 *
 * Approve/delete applicants who requested rep access. Both talk to the shared
 * Supabase project directly (PostgREST / edge functions) with the admin's
 * access token — see repLeadsService.
 */
import { Box, Typography } from '@mui/material';
import RepInquiriesTab from './RepInquiriesTab';

export default function RepPortalPage() {
  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" fontWeight={700} gutterBottom>
        Rep Approvals
      </Typography>

      <RepInquiriesTab />
    </Box>
  );
}
