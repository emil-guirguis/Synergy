import { Box, Typography } from '@mui/material';
import ResourcesTab from '../features/repPortal/ResourcesTab';
import { useAuth } from '../hooks/useAuth';

export default function ResourcesPage() {
  const { isAdmin } = useAuth();
  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" fontWeight={700} gutterBottom>
        Resources
      </Typography>
      <ResourcesTab readOnly={!isAdmin} />
    </Box>
  );
}
