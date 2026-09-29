import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { HeaderProps } from '../types';
import { HamburgerIcon } from './HamburgerIcon';
import { getIconElement } from '../../utils/iconHelper';
import { getAppVersion, formatVersion } from '../../utils/version';

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
  sidebarCollapsed = false
}) => {
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  // Documents matched by name/type are already in searchResults; documentsTotal
  // is how many documents exist at all, so "search file contents" can be
  // offered even when nothing matched by name. Content search is a separate,
  // slower opt-in call (see handleSearchContent).
  const [documentsTotal, setDocumentsTotal] = useState(0);
  const [isSearchingContent, setIsSearchingContent] = useState(false);
  const [contentSearched, setContentSearched] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
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
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowSearchResults(false);
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
        if (showSearchResults) setShowSearchResults(false);
        if (isListening) stopListening();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [userMenuOpen, notificationsOpen, showSearchResults, isListening]);

  const unreadNotifications = notifications.filter(n => !n.id.includes('read')).length;

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
            handleSearch(transcript);
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
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      searchAbortRef.current?.abort();
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

  const handleSearch = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }

    setDocumentsTotal(0);
    setContentSearched(false);

    // Cancel any still-in-flight search so an earlier (slower) response can't
    // land after this one and stomp its results — that race was the flashing.
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;

    try {
      setIsSearching(true);

      // Get auth token from storage
      const authToken = localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');

      if (!authToken) {
        console.warn('⚠️ [SEARCH] No authentication token found in storage');
        setSearchResults([]);
        setIsSearching(false);
        return;
      }

      console.log('🔍 [SEARCH] Searching for:', query);

      // Call AI search endpoint with timeout
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      const response = await fetch('/api/ai/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({ query }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      // A newer keystroke may have already superseded this request — its abort()
      // reaches here as a resolved-but-stale response too, not just a thrown
      // AbortError, so drop it before touching state either way.
      if (searchAbortRef.current !== controller) return;

      if (response.ok) {
        const data = await response.json();
        console.log('✅ [SEARCH] Results received:', data.data?.results?.length || 0, 'items');
        setSearchResults(data.data?.results || []);
        setDocumentsTotal(data.data?.documentsTotal || 0);
        setShowSearchResults(true);
      } else if (response.status === 401 || response.status === 403) {
        console.error('❌ [SEARCH] Authentication failed:', response.status, response.statusText);
        setSearchResults([]);
      } else {
        const errorData = await response.json();
        console.error('❌ [SEARCH] Search failed:', response.status, errorData.error?.message || response.statusText);
        setSearchResults([]);
      }
    } catch (error) {
      if (searchAbortRef.current !== controller) return; // superseded, not a real failure
      if (error instanceof Error && error.name === 'AbortError') {
        console.error('❌ [SEARCH] Search timeout');
      } else {
        console.error('❌ [SEARCH] Network error:', error instanceof Error ? error.message : String(error));
      }
      setSearchResults([]);
    } finally {
      if (searchAbortRef.current === controller) setIsSearching(false);
    }
  };

  const handleSearchContent = async () => {
    if (!searchQuery.trim() || isSearchingContent) return;
    const authToken = localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
    if (!authToken) return;

    setIsSearchingContent(true);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const response = await fetch('/api/ai/search/content', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ query: searchQuery }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        const contentResults = data.data?.results || [];
        // Merge in file-content matches that weren't already found by name/type.
        setSearchResults((prev) => {
          const existingIds = new Set(prev.map((r) => `${r.type}:${r.id}`));
          const merged = [...prev];
          for (const r of contentResults) {
            if (!existingIds.has(`${r.type}:${r.id}`)) merged.push(r);
          }
          return merged;
        });
      } else {
        console.error('❌ [SEARCH] Content search failed:', response.status, response.statusText);
      }
    } catch (error) {
      console.error('❌ [SEARCH] Content search error:', error instanceof Error ? error.message : String(error));
    } finally {
      setIsSearchingContent(false);
      setContentSearched(true);
    }
  };

  const handleSearchInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchQuery(value);

    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);

    if (!value.trim()) {
      searchAbortRef.current?.abort();
      setSearchResults([]);
      setDocumentsTotal(0);
      setContentSearched(false);
      setShowSearchResults(false);
      return;
    }

    // Debounced so search fires once typing pauses, not on every keystroke —
    // firing per-keystroke was spamming requests whose out-of-order responses
    // caused the results dropdown to flash/flicker while typing.
    searchDebounceRef.current = setTimeout(() => handleSearch(value), 300);
  };

  // Enter hands off to the full AI chat page rather than answering inline —
  // the inline dropdown couldn't show tool results/follow-ups the chat page can.
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const query = searchQuery.trim();
      if (!query) return;
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      setShowSearchResults(false);
      navigate('/ai-chat', { state: { autoQuery: query } });
    }
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
        <div className="app-header__search" ref={searchRef}>
          <div className="search-container">
            {getIconElement('search', 'search-icon')}
            <input
              type="search"
              className="search-input"
              placeholder="Search or ask SI — press Enter"
              aria-label="Search or ask SI"
              value={searchQuery}
              onChange={handleSearchInputChange}
              onKeyDown={handleSearchKeyDown}
              onFocus={() => searchQuery && setShowSearchResults(true)}
              disabled={isSearching}
            />
            {isSearching && (
              <div className="search-loading" aria-label="Searching...">
                <span className="loading-spinner"></span>
              </div>
            )}
            <button
              className={`mic-button ${isListening ? 'listening' : ''}`}
              onClick={isListening ? stopListening : startListening}
              aria-label={isListening ? 'Stop listening' : 'Start voice search'}
              title={isListening ? 'Stop listening' : 'Start voice search'}
              type="button"
              disabled={isSearching}
            >
              {getIconElement('mic', 'mic-icon')}
            </button>

            {/* Search Results Dropdown */}
            {showSearchResults && searchResults.length > 0 && (
              <div className="search-results-dropdown" role="region" aria-label="Search results">
                {/* Device / meter / document quick results */}
                {searchResults.length > 0 && (
                  <div className="search-results-list">
                    {searchResults.slice(0, 5).map((result) => (
                      result.type === 'document' ? (
                        <div key={`document:${result.id}`} className="search-result-item">
                          <div className="result-icon">
                            {getIconElement('description', 'result-icon')}
                          </div>
                          <div className="result-content">
                            <div className="result-name">{result.name}</div>
                            <div className="result-meta">
                              {result.docType && <span className="result-type">{result.docType}</span>}
                              {result.mimeType && <span className="result-location">{result.mimeType}</span>}
                            </div>
                            {result.snippet && (
                              <div className="result-consumption">&hellip;{result.snippet}&hellip;</div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div key={`device:${result.id}`} className="search-result-item">
                          <div className="result-icon">
                            {getIconElement('electric_bolt', 'result-icon')}
                          </div>
                          <div className="result-content">
                            <div className="result-name">{result.name}</div>
                            <div className="result-meta">
                              <span className="result-type">{result.type}</span>
                              <span className="result-location">{result.location}</span>
                            </div>
                            <div className="result-consumption">
                              {result.currentConsumption} {result.unit}
                            </div>
                          </div>
                          <div className={`result-status ${result.status}`}>
                            {result.status}
                          </div>
                        </div>
                      )
                    ))}
                    {searchResults.length > 5 && (
                      <div className="search-results-footer">
                        <button type="button" className="view-all-button">
                          View all {searchResults.length} results
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Content search is slow (downloads + parses each file), so it's
                    offered only after the fast metadata pass, and only when
                    documents exist at all. */}
                {documentsTotal > 0 && !contentSearched && (
                  <div className="search-results-footer">
                    <button
                      type="button"
                      className="view-all-button"
                      onClick={handleSearchContent}
                      disabled={isSearchingContent}
                    >
                      {isSearchingContent
                        ? 'Searching file contents…'
                        : `Search inside ${documentsTotal} document${documentsTotal === 1 ? '' : 's'}?`}
                    </button>
                  </div>
                )}

              </div>
            )}

            {showSearchResults && searchQuery && searchResults.length === 0 && (
              <div className="search-results-dropdown" role="region" aria-label="Search results">
                <div className="no-results">
                  <p>No matches found for "{searchQuery}"</p>
                  <p className="no-results-hint">Press <kbd>Enter</kbd> to ask the AI</p>
                </div>
                {documentsTotal > 0 && !contentSearched && (
                  <div className="search-results-footer">
                    <button
                      type="button"
                      className="view-all-button"
                      onClick={handleSearchContent}
                      disabled={isSearchingContent}
                    >
                      {isSearchingContent
                        ? 'Searching file contents…'
                        : `Search inside ${documentsTotal} document${documentsTotal === 1 ? '' : 's'}?`}
                    </button>
                  </div>
                )}
                {contentSearched && searchResults.length === 0 && (
                  <div className="no-results">
                    <p className="no-results-hint">No matches in file contents either.</p>
                  </div>
                )}
              </div>
            )}
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
                  <button className="user-menu-item" type="button" role="menuitem">
                    {getIconElement('person', 'icon')}
                    Profile
                  </button>
                  <button className="user-menu-item" type="button" role="menuitem">
                    {getIconElement('settings', 'icon')}
                    Settings
                  </button>
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
    </header>
  );
};
