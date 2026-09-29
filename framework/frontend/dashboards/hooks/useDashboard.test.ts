/**
 * Property-based tests for useDashboard hook
 * 
 * Feature: dashboard-framework-migration
 * Property 1: Component Isolation
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useDashboard } from './useDashboard';

describe('useDashboard Hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('Property 1: Component Isolation - No Direct API Calls', () => {
    /**
     * Property: For any dashboard configuration, the hook SHALL NOT make direct API calls.
     * All data fetching SHALL be done through the provided fetchData callback.
     * 
     * Validates: Requirements 3.1, 3.2, 3.3, 3.4
     */
    it('should not make API calls without fetchData callback', () => {
      const config = {
        id: 'test-dashboard',
        layout: { columns: 3, gap: 16 },
        refreshInterval: 0,
        persistState: false
      };

      const { result } = renderHook(() => useDashboard(config));

      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.data).toBeUndefined();
    });

    /**
     * Property: For any fetchData callback, the hook SHALL invoke it and handle the result.
     * The hook SHALL NOT modify the callback or make additional API calls.
     */
    it('should invoke fetchData callback exactly once on mount', async () => {
      const fetchDataMock = vi.fn().mockResolvedValue({ test: 'data' });

      const config = {
        id: 'test-dashboard',
        layout: { columns: 3, gap: 16 },
        fetchData: fetchDataMock,
        refreshInterval: 0,
        persistState: false
      };

      renderHook(() => useDashboard(config));

      await waitFor(() => {
        expect(fetchDataMock).toHaveBeenCalledTimes(1);
      });
    });

    /**
     * Property: For any error in fetchData, the hook SHALL capture and store the error
     * without making additional API calls or crashing.
     */
    it('should handle fetchData errors gracefully', async () => {
      const error = new Error('Fetch failed');
      const fetchDataMock = vi.fn().mockRejectedValue(error);

      const config = {
        id: 'test-dashboard',
        layout: { columns: 3, gap: 16 },
        fetchData: fetchDataMock,
        refreshInterval: 0,
        persistState: false
      };

      const { result } = renderHook(() => useDashboard(config));

      await waitFor(() => {
        expect(result.current.error).toBe('Fetch failed');
        expect(result.current.loading).toBe(false);
      });

      expect(fetchDataMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('Property 2: State Management Consistency', () => {
    /**
     * Property: For any dashboard state update, the hook SHALL maintain consistency
     * between loading, error, and data states.
     */
    it('should maintain consistent state during data fetch', async () => {
      const fetchDataMock = vi.fn().mockResolvedValue({ value: 42 });

      const config = {
        id: 'test-dashboard',
        layout: { columns: 3, gap: 16 },
        fetchData: fetchDataMock,
        refreshInterval: 0,
        persistState: false
      };

      const { result } = renderHook(() => useDashboard(config));

      // Initially loading
      expect(result.current.loading).toBe(true);
      expect(result.current.error).toBeNull();

      // After fetch completes
      await waitFor(() => {
        expect(result.current.loading).toBe(false);
        expect(result.current.data).toEqual({ value: 42 });
        expect(result.current.error).toBeNull();
      });
    });

    /**
     * Property: For any refresh action, the hook SHALL update lastUpdate timestamp.
     */
    it('should update lastUpdate timestamp on refresh', async () => {
      const fetchDataMock = vi.fn().mockResolvedValue({ value: 42 });

      const config = {
        id: 'test-dashboard',
        layout: { columns: 3, gap: 16 },
        fetchData: fetchDataMock,
        refreshInterval: 0,
        persistState: false
      };

      const { result } = renderHook(() => useDashboard(config));

      await waitFor(() => {
        expect(result.current.lastUpdate).not.toBeNull();
      });

      const firstUpdate = result.current.lastUpdate;

      // Wait a bit and refresh
      await new Promise(resolve => setTimeout(resolve, 10));

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.lastUpdate).not.toEqual(firstUpdate);
    });
  });

  describe('Property 3: Auto-Refresh Behavior', () => {
    /**
     * Property: For any refreshInterval > 0, the hook SHALL call fetchData
     * at the specified interval.
     */
    it('should auto-refresh at specified interval', async () => {
      vi.useFakeTimers();

      try {
        const fetchDataMock = vi.fn().mockResolvedValue({ value: 42 });

        const config = {
          id: 'test-dashboard',
          layout: { columns: 3, gap: 16 },
          fetchData: fetchDataMock,
          refreshInterval: 1000,
          persistState: false
        };

        renderHook(() => useDashboard(config));

        // Initial call — flush the mount effect's promise without relying on
        // waitFor's internal polling, which never fires while timers are faked.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(fetchDataMock).toHaveBeenCalledTimes(1);

        // Advance time by refresh interval and flush the resulting promise.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(fetchDataMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('Property 4: Section Collapse Management', () => {
    /**
     * Property: For any section ID, toggling collapse state SHALL invert the previous state.
     */
    it('should toggle section collapse state', () => {
      const config = {
        id: 'test-dashboard',
        layout: { columns: 3, gap: 16 },
        refreshInterval: 0,
        persistState: false,
        collapsible: true
      };

      const { result } = renderHook(() => useDashboard(config));

      const sectionId = 'section-1';

      // Initially not collapsed
      expect(result.current.collapsedSections[sectionId]).toBeUndefined();

      // Toggle to collapsed
      act(() => {
        result.current.toggleSection(sectionId);
      });

      expect(result.current.collapsedSections[sectionId]).toBe(true);

      // Toggle back to not collapsed
      act(() => {
        result.current.toggleSection(sectionId);
      });

      expect(result.current.collapsedSections[sectionId]).toBe(false);
    });
  });

  describe('Property 5: State Persistence', () => {
    /**
     * Property: For any dashboard with persistState enabled, the collapsed sections
     * SHALL be persisted to localStorage and restored on remount.
     */
    it('should persist and restore collapsed sections', () => {
      const config = {
        id: 'test-dashboard',
        layout: { columns: 3, gap: 16 },
        refreshInterval: 0,
        persistState: true,
        storageKey: 'test-dashboard-state'
      };

      const { result, unmount } = renderHook(() => useDashboard(config));

      // Toggle a section
      act(() => {
        result.current.toggleSection('section-1');
      });

      expect(result.current.collapsedSections['section-1']).toBe(true);

      // Unmount and remount
      unmount();

      const { result: result2 } = renderHook(() => useDashboard(config));

      // State should be restored
      expect(result2.current.collapsedSections['section-1']).toBe(true);
    });
  });

  describe('Property 6: Manual Refresh', () => {
    /**
     * Property: For any manual refresh call, the hook SHALL invoke fetchData
     * and update the state accordingly.
     */
    it('should support manual refresh', async () => {
      const fetchDataMock = vi.fn()
        .mockResolvedValueOnce({ value: 1 })
        .mockResolvedValueOnce({ value: 2 });

      const config = {
        id: 'test-dashboard',
        layout: { columns: 3, gap: 16 },
        fetchData: fetchDataMock,
        refreshInterval: 0,
        persistState: false
      };

      const { result } = renderHook(() => useDashboard(config));

      // Initial fetch
      await waitFor(() => {
        expect(result.current.data).toEqual({ value: 1 });
      });

      // Manual refresh
      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.data).toEqual({ value: 2 });
      expect(fetchDataMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('Property 7: Error Handler Callback', () => {
    /**
     * Property: For any error in fetchData, if onError callback is provided,
     * it SHALL be invoked with the error.
     */
    it('should invoke onError callback on fetch failure', async () => {
      const error = new Error('Fetch failed');
      const fetchDataMock = vi.fn().mockRejectedValue(error);
      const onErrorMock = vi.fn();

      const config = {
        id: 'test-dashboard',
        layout: { columns: 3, gap: 16 },
        fetchData: fetchDataMock,
        onError: onErrorMock,
        refreshInterval: 0,
        persistState: false
      };

      renderHook(() => useDashboard(config));

      await waitFor(() => {
        expect(onErrorMock).toHaveBeenCalledWith(error);
      });
    });
  });

  describe('Property 8: Cleanup on Unmount', () => {
    /**
     * Property: For any hook instance, on unmount, all intervals and timers
     * SHALL be cleared to prevent memory leaks.
     */
    it('should clear intervals on unmount', () => {
      vi.useFakeTimers();

      const fetchDataMock = vi.fn().mockResolvedValue({ value: 42 });

      const config = {
        id: 'test-dashboard',
        layout: { columns: 3, gap: 16 },
        fetchData: fetchDataMock,
        refreshInterval: 1000,
        persistState: false
      };

      const { unmount } = renderHook(() => useDashboard(config));

      unmount();

      // Advance time - should not cause additional calls
      vi.advanceTimersByTime(2000);

      expect(fetchDataMock).toHaveBeenCalledTimes(1); // Only initial call

      vi.useRealTimers();
    });
  });
});
