import React from 'react';
import {
  Box, Button, Card, CardContent, Container,
  Grid, Stack, Typography,
} from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import HtmlIcon from '@mui/icons-material/Html';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import ArticleIcon from '@mui/icons-material/Article';
import NotesIcon from '@mui/icons-material/Notes';

interface DocFormat {
  label: string;
  href: string;
  icon: React.ReactNode;
  /** open in a new tab vs. trigger a download */
  view?: boolean;
}

interface DocItem {
  title: string;
  description: string;
  icon: React.ReactNode;
  formats: DocFormat[];
}

// BASE_URL is '/' in dev and '/Synergy/' on GitHub Pages — keep links correct in both.
const APP_SHEET = `${import.meta.env.BASE_URL}docs/MeterItPro-Application-Sheet`;
const APP_SHEET_REV_B1 = `${APP_SHEET}-RevB1`;

const docs: DocItem[] = [
  {
    title: 'MeterIt Pro — Application Sheet (Rev B1)',
    description: 'Current product cut sheet: features, specs, and deployment overview.',
    icon: <DescriptionIcon color="primary" sx={{ fontSize: 40 }} />,
    formats: [
      { label: 'HTML', href: `${APP_SHEET_REV_B1}.html`, icon: <HtmlIcon />, view: true },
      { label: 'PDF',  href: `${APP_SHEET_REV_B1}.pdf`,  icon: <PictureAsPdfIcon />, view: true },
    ],
  },
  {
    title: 'MeterIt Pro — Application Sheet (Rev A)',
    description: 'Previous revision, kept for reference.',
    icon: <DescriptionIcon color="disabled" sx={{ fontSize: 40 }} />,
    formats: [
      { label: 'HTML', href: `${APP_SHEET}.html`, icon: <HtmlIcon />, view: true },
      { label: 'PDF',  href: `${APP_SHEET}.pdf`,  icon: <PictureAsPdfIcon />, view: true },
      { label: 'Markdown', href: `${APP_SHEET}.md`, icon: <NotesIcon />, view: true },
      { label: 'Word',  href: `${APP_SHEET}.docx`, icon: <ArticleIcon /> },
    ],
  },
];

const DocumentationsPage: React.FC = () => (
  <Container maxWidth="lg" sx={{ py: 6 }}>
    <Typography variant="h4" fontWeight="bold" gutterBottom>
      Documentation
    </Typography>
    <Typography variant="body1" color="text.secondary" mb={4}>
      Guides, cut sheets, and reference material for MeterIt Pro.
    </Typography>

    <Grid container spacing={3}>
      {docs.map((doc) => (
        <Grid item xs={12} md={6} key={doc.title}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Stack direction="row" spacing={2} alignItems="flex-start" mb={2}>
                {doc.icon}
                <Box>
                  <Typography variant="h6" fontWeight="bold">
                    {doc.title}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {doc.description}
                  </Typography>
                </Box>
              </Stack>

              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {doc.formats.map((f) => (
                  <Button
                    key={f.label}
                    size="small"
                    variant="outlined"
                    startIcon={f.icon}
                    component="a"
                    href={f.href}
                    {...(f.view
                      ? { target: '_blank', rel: 'noopener noreferrer' }
                      : { download: '' })}
                  >
                    {f.label}
                  </Button>
                ))}
              </Stack>
            </CardContent>
          </Card>
        </Grid>
      ))}
    </Grid>

    {docs.length === 0 && (
      <Box sx={{ py: 8, textAlign: 'center' }}>
        <Typography color="text.secondary">No documents available yet.</Typography>
      </Box>
    )}
  </Container>
);

export default DocumentationsPage;
