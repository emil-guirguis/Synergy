import React, { useEffect } from 'react';
import { useResponsive } from '../../hooks/useResponsive';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import ShareRoundedIcon from '@mui/icons-material/ShareRounded';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import './Modal.css';

export interface ModalProps {
  isOpen: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  fullScreen?: boolean;
  loading?: boolean;
  error?: string;
  footer?: React.ReactNode;
  onSave?: () => void;
  saveLabel?: string;
  showSaveButton?: boolean;
  /** Optional leading icon shown beside the title */
  titleIcon?: React.ReactNode;
  /** Optional muted breadcrumb after the title, e.g. "Edit Meter" */
  crumb?: string;
  /** Share icon shown to the left of Cancel/Close — omit to hide it. */
  onShare?: () => void;
}

/**
 * Modal dialog component
 * 
 * A reusable modal dialog with responsive behavior and accessibility features.
 * 
 * @example
 * ```tsx
 * <Modal
 *   isOpen={showModal}
 *   title="Edit Item"
 *   onClose={() => setShowModal(false)}
 *   size="md"
 * >
 *   <p>Modal content goes here</p>
 * </Modal>
 * ```
 */
export const Modal: React.FC<ModalProps> = ({
  isOpen,
  title,
  onClose,
  children,
  size = 'md',
  fullScreen = false,
  loading = false,
  error,
  footer,
  onSave,
  saveLabel = 'Save',
  showSaveButton = false,
  titleIcon,
  crumb,
  onShare,
}) => {
  const { isMobile } = useResponsive();

  // Auto full screen on mobile
  const shouldFullScreen = fullScreen || isMobile;

  // Handle escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen && !loading) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      // Prevent body scroll when modal is open
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, loading, onClose]);

  if (!isOpen) return null;

  // Default save handler when none is provided:
  // Submit the last form on the page (most recently added), same behavior as FormModal.
  const handleDefaultSave = () => {
    const forms = document.querySelectorAll('form');
    if (forms.length > 0) {
      const form = forms[forms.length - 1] as HTMLFormElement;
      form.requestSubmit();
    }
  };

  return (
    <div 
      className={`
        modal__backdrop
        ${shouldFullScreen ? 'modal__backdrop--fullscreen' : ''}
      `.trim()}
    >
      <div 
        className={`
          modal
          modal--${size}
          ${shouldFullScreen ? 'modal--fullscreen' : ''}
          ${loading ? 'modal--loading' : ''}
        `.trim()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="modal__header">
          <div className="modal__title-wrap">
            {titleIcon && <span className="modal__title-icon">{titleIcon}</span>}
            <h2 className="modal__title">
              {title}
              {crumb && <span className="modal__crumb"> / {crumb}</span>}
            </h2>
          </div>
          <div className="modal__header-actions">
            {onShare && (
              <Tooltip title="Share">
                <IconButton
                  type="button"
                  className="modal__share-btn"
                  onClick={onShare}
                  disabled={loading}
                  size="small"
                  aria-label="Share"
                >
                  <ShareRoundedIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
            )}
            {showSaveButton && (
              <button
                type="button"
                className="modal__cancel-btn"
                onClick={onClose}
                disabled={loading}
              >
                Cancel
              </button>
            )}
            {showSaveButton && (
              <button
                type="button"
                className="modal__save-btn"
                onClick={onSave ?? handleDefaultSave}
                disabled={loading}
              >
                <CheckRoundedIcon sx={{ fontSize: 18 }} />
                {saveLabel}
              </button>
            )}
            {!showSaveButton && (
            <button
              type="button"
              className="modal__close"
              onClick={onClose}
              disabled={loading}
              aria-label="Close modal"
            >
              ✕
            </button>
            )}
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="modal__error">
            <span className="modal__error-icon">⚠️</span>
            <span className="modal__error-message">{error}</span>
          </div>
        )}

        {/* Content */}
        <div className="modal__content">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="modal__footer">
            {footer}
          </div>
        )}

        {/* Loading Overlay */}
        {loading && (
          <div className="modal__loading-overlay">
            <div className="modal__loading-content">
              <div className="modal__spinner"></div>
              <p>Loading...</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Modal;
