import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { HeaderProps } from '../types';
import { HamburgerIcon } from './HamburgerIcon';
import { getIconElement } from '../../utils/iconHelper';
import { getAppVersion, formatVersion } from '../../utils/version';
import { useSystemConfig } from '../../utils/systemConfig';
import { FormModal } from '../../components/modal';
import UserPreferencesForm, { type UserPreferencesValues } from '../../components/settings/UserPreferencesForm';

import './Header.css';

// Speech Recognition API types
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  isFinal: boolean;
}

interface SpeechRecognitionResultList {
  [index: number]: SpeechRecognitionResult;
  length: number;
}

interface SpeechRecognitionResult {
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
  length: number;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

/**
 * Header Component
 * 
 * Framework-provided header component with:
 * - Responsive layout
 * - User menu dropdown
 * - Notifications dropdown
 * - Sidebar toggle button
 * - Branding display
 */
export const Header: React.FC<HeaderProps> = ({
  user,
  notifications = [],
  notificationComponent,
  onLogout,
  isMobile,
  showSidebarElements = false,
  sidebarBrand,
  onToggleSidebar,
  sidebarCollapsed = false,
  onSavePreferences
}) => {
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferencesValues, setPreferencesValues] = useState<UserPreferencesValues>({});
  const [preferencesSaving, setPreferencesSaving] = useState(false);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const systemConfig = useSystemConfig();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isListening, setIsListening] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const navigate = useNavigate();

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
      if (notificationsRef.current && !notificationsRef.current.contains(event.target as Node)) {
        setNotificationsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Keyboard navigation support
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (userMenuOpen) setUserMenuOpen(false);
        if (notificationsOpen) setNotificationsOpen(false);
        if (isListening) stopListening();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [userMenuOpen, notificationsOpen, isListening]);

  const unreadNotifications = notifications.filter(n => !n.id.includes('read')).length;

  const openPreferences = () => {
    setUserMenuOpen(false);
    setPreferencesError(null);
    setPreferencesValues({
      timezone: systemConfig.timezone ?? null,
      date_format: systemConfig.date_format ?? null,
      time_format: systemConfig.time_format ?? null,
      default_page_size: systemConfig.default_page_size ?? null,
    });
    setPreferencesOpen(true);
  };

  const handlePreferencesChange = (field: keyof UserPreferencesValues, value: any) => {
    setPreferencesValues((prev) => ({ ...prev, [field]: value }));
  };

  const savePreferences = async () => {
    if (!onSavePreferences) return;
    setPreferencesSaving(true);
    setPreferencesError(null);
    try {
      await onSavePreferences(preferencesValues);
      setPreferencesOpen(false);
    } catch (err) {
      setPreferencesError(err instanceof Error ? err.message : 'Failed to save preferences');
    } finally {
      setPreferencesSaving(false);
    }
  };

  // Initialize speech recognition
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = true;
      recognitionRef.current.lang = 'en-US';

      recognitionRef.current.onstart = () => {
        setIsListening(true);
      };

      recognitionRef.current.onresult = (event: SpeechRecognitionEvent) => {
        let interimTranscript = '';
        for (let i = event.results.length - 1; i >= 0; --i) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            setSearchQuery(transcript);
          } else {
            interimTranscript += transcript;
          }
        }
      };

      recognitionRef.current.onerror = (event: any) => {
        console.error('Speech recognition error:', event.error);
        setIsListening(false);
      };

      recognitionRef.current.onend = () => {
        setIsListening(false);
      };
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }
    };
  }, []);

  const startListening = () => {
    if (recognitionRef.current && !isListening) {
      recognitionRef.current.start();
    }
  };

  const stopListening = () => {
    if (recognitionRef.current && isListening) {
      recognitionRef.current.abort();
      setIsListening(false);
    }
  };

  const handleSearchInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  };

  // Typing here does nothing but fill the box — Enter is the only trigger,
  // and it always hands off to the AI chat page rather than searching inline.
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;
    setSearchQuery('');
    navigate('/ai-chat', { state: { autoQuery: query } });
  };

  return (
    <header
      className={`app-header ${showSidebarElements ? 'show-sidebar-elements' : ''}`}
      role="banner"
      aria-label="Main application header"
    >
      {/* Left side - Sidebar elements when needed */}
      {showSidebarElements && (
        <div className="app-header__left" role="navigation" aria-label="Primary navigation">
          <button
            className="app-header__menu-toggle"
            onClick={onToggleSidebar}
            aria-label={sidebarCollapsed ? 'Open navigation menu' : 'Close navigation menu'}
            {...(!sidebarCollapsed ? { 'aria-expanded': 'true' } : { 'aria-expanded': 'false' })}
            aria-controls="main-navigation"
            aria-haspopup="menu"
            type="button"
          >
            <HamburgerIcon isOpen={!sidebarCollapsed} />
          </button>

          {sidebarBrand && (
            <div className="app-header__brand" role="img" aria-label={`${sidebarBrand.text} application`}>
              {sidebarBrand.logoUrl ? (
                <img className="brand-logo" src={sidebarBrand.logoUrl} alt={sidebarBrand.text} />
              ) : (
                <span className="brand-text">{sidebarBrand.text}</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Center - Page title when sidebar elements are shown */}
      {showSidebarElements && (
        <div className="app-header__center">
          {/* Title can be added here when needed */}
        </div>
      )}

      {/* Right side - Search, User menu and notifications */}
      <div className="app-header__right">
        {/* Search Bar */}
        <div className="app-header__search">
          <div className="search-container">
            {getIconElement('search', 'search-icon')}
            <input
              type="search"
              className="search-input"
              placeholder="Ask AI — press Enter"
              aria-label="Ask AI"
              value={searchQuery}
              onChange={handleSearchInputChange}
              onKeyDown={handleSearchKeyDown}
            />
            <button
              className={`mic-button ${isListening ? 'listening' : ''}`}
              onClick={isListening ? stopListening : startListening}
              aria-label={isListening ? 'Stop listening' : 'Start voice search'}
              title={isListening ? 'Stop listening' : 'Start voice search'}
              type="button"
            >
              {getIconElement('mic', 'mic-icon')}
            </button>
          </div>
        </div>

        {/* Notifications */}
        <div className="app-header__notifications" ref={notificationsRef}>
          {notificationComponent ?? (
            <>
              <button
                className={`notification-button ${unreadNotifications > 0 ? 'has-notifications' : ''}`}
                onClick={() => setNotificationsOpen(!notificationsOpen)}
                aria-label={`Notifications ${unreadNotifications > 0 ? `(${unreadNotifications} unread)` : ''}`}
                {...(notificationsOpen ? { 'aria-expanded': 'true' } : { 'aria-expanded': 'false' })}
                aria-controls="notifications-dropdown"
                aria-haspopup="menu"
                type="button"
              >
                {getIconElement('notifications', 'icon notification-icon')}
                {unreadNotifications > 0 && (
                  <span className="notification-badge" aria-hidden="true">{unreadNotifications}</span>
                )}
              </button>

              {notificationsOpen && (
                <div
                  className="notifications-dropdown"
                  id="notifications-dropdown"
                  role="region"
                  aria-label="Notifications menu"
                >
                  <div className="notifications-header">
                    <h3>Notifications</h3>
                    {unreadNotifications > 0 && (
                      <span className="unread-count">{unreadNotifications} unread</span>
                    )}
                  </div>
                  <div className="notifications-list">
                    {notifications.length > 0 ? (
                      notifications.slice(0, 5).map((notification) => (
                        <div key={notification.id} className="notification-item">
                          <div className={`notification-type ${notification.type}`}>
                            {notification.type === 'success' && getIconElement('check_circle', 'notification-icon')}
                            {notification.type === 'error' && getIconElement('error', 'notification-icon')}
                            {notification.type === 'warning' && getIconElement('warning', 'notification-icon')}
                            {notification.type === 'info' && getIconElement('info', 'notification-icon')}
                          </div>
                          <div className="notification-content">
                            <div className="notification-title">{notification.title}</div>
                            {notification.message && (
                              <div className="notification-message">{notification.message}</div>
                            )}
                            <div className="notification-time">
                              {notification.createdAt.toLocaleTimeString()}
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="no-notifications">
                        {getIconElement('notifications', 'icon')}
                        <p>No notifications</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* User Menu */}
        {user && (
          <div className="app-header__user-menu" ref={userMenuRef}>
            <button
              className="user-menu-trigger"
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              aria-label={`User menu for ${user.name}`}
              {...(userMenuOpen ? { 'aria-expanded': 'true' } : { 'aria-expanded': 'false' })}
              aria-controls="user-menu-dropdown"
              aria-haspopup="menu"
              type="button"
            >
              <div className="user-avatar">
                {user.avatar ? (
                  <img src={user.avatar} alt={user.name} />
                ) : (
                  <span className="avatar-initials">
                    {user.name.split(' ').map(n => n[0]).join('').toUpperCase()}
                  </span>
                )}
              </div>
              {!isMobile && (
                <div className="user-info">
                  <div className="user-name">{user.name}</div>
                  <div className="user-email">{user.email}</div>
                </div>
              )}
              <span className={`dropdown-arrow ${userMenuOpen ? 'open' : ''}`}>▼</span>
            </button>

            {userMenuOpen && (
              <div
                className="user-menu-dropdown"
                id="user-menu-dropdown"
                role="region"
                aria-label="User account menu"
              >
                <div className="user-menu-header">
                  <div className="user-avatar-large">
                    {user.avatar ? (
                      <img src={user.avatar} alt={user.name} />
                    ) : (
                      <span className="avatar-initials">
                        {user.name.split(' ').map(n => n[0]).join('').toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="user-details">
                    <div className="user-name">{user.name}</div>
                    <div className="user-email">{user.email}</div>
                  </div>
                </div>
                <div className="user-menu-divider"></div>
                <div className="user-menu-items" role="menu">
                  {onSavePreferences && (
                    <button className="user-menu-item" type="button" role="menuitem" onClick={openPreferences}>
                      {getIconElement('person', 'icon')}
                      Preferences
                    </button>
                  )}
                  <button className="user-menu-item" type="button" role="menuitem">
                    {getIconElement('info', 'icon')}
                    Help
                  </button>
                  <div className="user-menu-divider" role="separator"></div>
                  <button
                    className="user-menu-item logout-item"
                    onClick={onLogout}
                    type="button"
                    role="menuitem"
                  >
                    {getIconElement('lock', 'icon')}
                    Log Out
                  </button>
                </div>
                <div className="user-menu-divider" role="separator"></div>
                <div className="user-menu-footer">
                  <div className="app-version">
                    <span className="version-number">{formatVersion(getAppVersion())}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Portaled to document.body — this header has an ancestor with `transform`
          (translateZ(0), for sidebar-collapse performance), which makes the
          modal's `position: fixed` resolve against the header's own box
          instead of the viewport, and it opens clipped near the top of the
          page instead of centered over it. */}
      {onSavePreferences && preferencesOpen && createPortal(
        <FormModal
          isOpen={preferencesOpen}
          title="Preferences"
          size="sm"
          loading={preferencesSaving}
          error={preferencesError ?? undefined}
          onClose={() => setPreferencesOpen(false)}
        >
          <UserPreferencesForm
            values={preferencesValues}
            onChange={handlePreferencesChange}
            onSubmit={savePreferences}
            onCancel={() => setPreferencesOpen(false)}
            loading={preferencesSaving}
            error={preferencesError}
          />
        </FormModal>,
        document.body
      )}
    </header>
  );
};
