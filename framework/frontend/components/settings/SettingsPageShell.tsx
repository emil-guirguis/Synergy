import React, { useState, type ReactNode } from 'react';
import {
  Alert, Box, Typography, Paper,
  List, ListItemButton, ListItemIcon, ListItemText, Divider,
} from '@mui/material';
import './SettingsForm.css';

export interface SettingsSection {
  key: string;
  label: string;
  icon: ReactNode;
  description: string;
  content: ReactNode;
}

export interface SettingsPageShellProps {
  title?: string;
  subtitle?: string;
  sections: SettingsSection[];
  error?: string | null;
  successMessage?: string | null;
}

/**
 * Base Settings page layout: a section nav on the left, the active section's
 * content on the right. Each app builds its own `sections` array — the base
 * "basic settings" sections (org info, system config) plus any app-specific
 * ones (e.g. MeterItPro's Sync Servers) — and renders this shell around it.
 */
const SettingsPageShell: React.FC<SettingsPageShellProps> = ({
  title = 'Settings',
  subtitle,
  sections,
  error,
  successMessage,
}) => {
  const [activeKey, setActiveKey] = useState(sections[0]?.key);
  const active = sections.find((s) => s.key === activeKey) ?? sections[0];

  return (
    <Box className="settings-page">
      <Box className="settings-page__header">
        <Typography variant="overline" className="settings-page__manage-label">
          Manage
        </Typography>
        <Typography variant="h4" className="settings-page__title">
          {title}
        </Typography>
        {subtitle && (
          <Typography variant="body2" className="settings-page__subtitle">
            {subtitle}
          </Typography>
        )}
      </Box>

      {successMessage && <Alert severity="success" sx={{ mb: 2 }}>{successMessage}</Alert>}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <Box className="settings-page__body">
        <Paper className="settings-page__sidebar" elevation={0} variant="outlined">
          <List disablePadding>
            {sections.map((section) => (
              <ListItemButton
                key={section.key}
                selected={activeKey === section.key}
                onClick={() => setActiveKey(section.key)}
                className="settings-page__nav-item"
              >
                <ListItemIcon className="settings-page__nav-icon">
                  {section.icon}
                </ListItemIcon>
                <ListItemText primary={section.label} />
              </ListItemButton>
            ))}
          </List>
        </Paper>

        <Paper className="settings-page__content" elevation={0} variant="outlined">
          {active && (
            <>
              <Box className="settings-page__content-header">
                <Typography variant="h6" className="settings-page__section-title">
                  {active.label}
                </Typography>
                <Typography variant="body2" className="settings-page__section-desc">
                  {active.description}
                </Typography>
              </Box>
              <Divider />
              <Box className="settings-page__content-body">
                {active.content}
              </Box>
            </>
          )}
        </Paper>
      </Box>
    </Box>
  );
};

export default SettingsPageShell;
