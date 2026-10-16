/**
 * Share menu for a document/resource row — Open / Email / Copy link / Download.
 * Shared by DocumentsGrid (per-record documents) and any project-level resource
 * browser (e.g. TBWC's ResourcesTab) so the menu's items, order and labels stay
 * one thing to edit rather than drifting between copies.
 *
 * Callers own the anchor/open state and what each action actually does (e.g.
 * DocumentsGrid's "Open" opens an xlsx editor tab for tabular files instead of
 * a plain new tab) — this component is just the Menu shell.
 */
import React from 'react';
import { Menu, MenuItem, ListItemIcon, ListItemText } from '@mui/material';
import IosShareIcon from '@mui/icons-material/IosShare';
import EmailIcon from '@mui/icons-material/Email';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';

export interface ShareMenuProps {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  onOpen: () => void;
  /** Emails the file itself — the OS share sheet hands it to the chosen mail app. */
  onEmail: () => void;
  onCopyLink: () => void;
  onDownload: () => void;
  /** True once the row's share link has resolved — items are disabled until then. */
  ready: boolean;
}

export const ShareMenu: React.FC<ShareMenuProps> = ({
  anchorEl,
  onClose,
  onOpen,
  onEmail,
  onCopyLink,
  onDownload,
  ready,
}) => (
  <Menu anchorEl={anchorEl} open={!!anchorEl} onClose={onClose}>
    <MenuItem onClick={onOpen} disabled={!ready}>
      <ListItemIcon>
        <IosShareIcon fontSize="small" />
      </ListItemIcon>
      <ListItemText>Open</ListItemText>
    </MenuItem>
    <MenuItem onClick={onEmail} disabled={!ready}>
      <ListItemIcon>
        <EmailIcon fontSize="small" />
      </ListItemIcon>
      <ListItemText>Email</ListItemText>
    </MenuItem>
    <MenuItem onClick={onCopyLink} disabled={!ready}>
      <ListItemIcon>
        <ContentCopyIcon fontSize="small" />
      </ListItemIcon>
      <ListItemText>Copy link</ListItemText>
    </MenuItem>
    <MenuItem onClick={onDownload} disabled={!ready}>
      <ListItemIcon>
        <DownloadIcon fontSize="small" />
      </ListItemIcon>
      <ListItemText>Download</ListItemText>
    </MenuItem>
  </Menu>
);

export default ShareMenu;
