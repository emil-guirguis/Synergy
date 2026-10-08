import React from 'react';
import { Modal } from './Modal';
import { getIconElement } from '../../utils/iconHelper';

export interface FormModalProps<T = any> {
  isOpen: boolean;
  title: string;
  data?: T;
  loading?: boolean;
  error?: string;
  onClose: () => void;
  onSubmit?: (data: T) => void | Promise<void>;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  fullScreen?: boolean;
  showSaveButton?: boolean;
  saveLabel?: string;
  /** Explicit icon node — use this OR schemaName, not both */
  titleIcon?: React.ReactNode;
  crumb?: string;
  /** Module/schema name — auto-resolves icon from the app icon registry */
  moduleIcon?: string;
  /** Share icon shown to the left of Cancel/Close — omit to hide it. */
  onShare?: () => void;
}

/**
 * FormModal - A specialized modal component for forms
 * Wraps the framework Modal component with form-specific props
 * Provides consistent modal behavior for all forms in the application
 */
export function FormModal<T = any>({
  isOpen,
  title,
  loading = false,
  error,
  onClose,
  children,
  size = 'md',
  fullScreen = false,
  showSaveButton = false,
  saveLabel = 'Save',
  titleIcon,
  crumb,
  moduleIcon,
  onShare,
}: FormModalProps<T>) {
  const resolvedIcon = titleIcon ?? (moduleIcon ? getIconElement(moduleIcon) : undefined);
  // Wrapper to handle form submission from modal save button
  const handleSave = () => {
    // Find all forms on the page and submit the last one (most recently added)
    const forms = document.querySelectorAll('form');
    if (forms.length > 0) {
      const form = forms[forms.length - 1] as HTMLFormElement;
      form.requestSubmit();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      title={title}
      onClose={onClose}
      size={size}
      fullScreen={fullScreen}
      loading={loading}
      error={error}
      onSave={handleSave}
      showSaveButton={showSaveButton}
      saveLabel={saveLabel}
      titleIcon={resolvedIcon}
      crumb={crumb}
      onShare={onShare}
    >
      {children}
    </Modal>
  );
}
