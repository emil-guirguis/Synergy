import { Box, Typography } from '@mui/material';
import DocumentsTab from '../features/repPortal/DocumentsTab';
import { useAuth } from '../hooks/useAuth';

export default function DocumentsPage() {
  const { isAdmin } = useAuth();
  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" fontWeight={700} gutterBottom>
        Documents
      </Typography>
      <DocumentsTab readOnly={!isAdmin} />
    </Box>
  );
}
