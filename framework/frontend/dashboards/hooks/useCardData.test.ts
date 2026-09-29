/**
 * Property-based tests for useCardData hook
 * 
 * Feature: dashboard-framework-migration
 * Property 1: Component Isolation
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useCardData } from './useCardData';
import type { DashboardCard, AggregatedData } from '../types/dashboard';

describe('useCardData Hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Property 1: Component Isolation - Card-Specific Data', () => {
    /**
     * Property: For any card configuration, the hook SHALL manage data specific to that card
     * without making assumptions about other cards or global state.
     * 
     * Validates: Requirements 3.1, 3.2, 3.3, 3.4
     */
    it('should manage card-specific data independently', async () => {
      const card: DashboardCard = {
        id: 1,
        title: 'Sales Card',
        visualization_type: 'line'
      };

      const fetchDataMock = vi.fn().mockResolvedValue({
        card_id: 1,
        aggregated_values: { total: 1000 }
      });

      const config = {
        card,
        fetchData: fetchDataMock,
        refreshInterval: 0
      };

      const { result } = renderHook(() => useCardData(config));

      await waitFor(() => {
        expect(result.current.data?.card_id).toBe(1);
      });

      // Verify fetchData was called with the correct card
      expect(fetchDataMock).toHaveBeenCalledWith(card);
    });

    /**
     * Property: For any card, the hook SHALL pass the card to fetchData callback
     * so the callback can fetch card-specific data.
     */
    it('should pass card to fetchData callback', async () => {
      const card: DashboardCard = {
        id: 42,
        title: 'Test Card',
        visualization_type: 'bar'
      };

      const fetchDataMock = vi.fn().mockResolvedValue({
        card_id: 42,
        aggregated_values: {}
      });

      const config = {
        card,
        fetchData: fetchDataMock,
        refreshInterval: 0
      };

      renderHook(() => useCardData(config));

      await waitFor(() => {
        expect(fetchDataMock).toHaveBeenCalledWith(card);
      });
    });
  });

  describe('Property 2: Data Fetching and State Management', () => {
    /**
     * Property: For any successful data fetch, the hook SHALL update data state
     * and clear any previous errors.
     */
    it('should update data and clear errors on successful fetch', async () => {
      const card: DashboardCard = {
        id: 1,
        title: 'Test Card',
        visualization_type: 'pie'
      };

      const aggregatedData: AggregatedData = {
        card_id: 1,
        aggregated_values: { total: 500 }
      };

      const fetchDataMock = vi.fn().mockResolvedValue(aggregatedData);

      const config = {
        card,
        fetchData: fetchDataMock,
        refreshInterval: 0
      };

      const { result } = renderHook(() => useCardData(config));

      await waitFor(() => {
        expect(result.current.data).toEqual(aggregatedData);
        expect(result.current.error).toBeNull();
        expect(result.current.loading).toBe(false);
      });
    });

    /**
     * Property: For any fetch error, the hook SHALL capture the error message
     * and set loading to false.
     */
    it('should handle fetch errors gracefully', async () => {
      const card: DashboardCard = {
        id: 1,
        title: 'Test Card',
        visualization_type: 'area'
      };

      const error = new Error('Network error');
      const fetchDataMock = vi.fn().mockRejectedValue(error);

      const config = {
        card,
        fetchData: fetchDataMock,
        refreshInterval: 0
      };

      const { result } = renderHook(() => useCardData(config));

      await waitFor(() => {
        expect(result.current.error).toBe('Network error');
        expect(result.current.loading).toBe(false);
      });
    });
  });

  describe('Property 3: Auto-Refresh for Card Data', () => {
    /**
     * Property: For any refreshInterval > 0, the hook SHALL fetch card data
     * at the specified interval.
     */
    it('should auto-refresh card data at specified interval', async () => {
      vi.useFakeTimers();

      try {
        const card: DashboardCard = {
          id: 1,
          title: 'Test Card',
          visualization_type: 'line'
        };

        const fetchDataMock = vi.fn().mockResolvedValue({
          card_id: 1,
          aggregated_values: {}
        });

        const config = {
          card,
          fetchData: fetchDataMock,
          refreshInterval: 5000
        };

        renderHook(() => useCardData(config));

        // Initial call — flush the mount effect's promise without relying on
        // waitFor's internal polling, which never fires while timers are faked.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(fetchDataMock).toHaveBeenCalledTimes(1);

        // Advance time by refresh interval and flush the resulting promise.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        expect(fetchDataMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('Property 4: Manual Refresh', () => {
    /**
     * Property: For any manual refresh call, the hook SHALL fetch fresh data
     * and update the state.
     */
    it('should support manual refresh of card data', async () => {
      const card: DashboardCard = {
        id: 1,
        title: 'Test Card',
        visualization_type: 'bar'
      };

      const fetchDataMock = vi.fn()
        .mockResolvedValueOnce({ card_id: 1, aggregated_values: { total: 100 } })
        .mockResolvedValueOnce({ card_id: 1, aggregated_values: { total: 200 } });

      const config = {
        card,
        fetchData: fetchDataMock,
        refreshInterval: 0
      };

      const { result } = renderHook(() => useCardData(config));

      // Initial fetch
      await waitFor(() => {
        expect(result.current.data?.aggregated_values.total).toBe(100);
      });

      // Manual refresh
      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.data?.aggregated_values.total).toBe(200);
      expect(fetchDataMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('Property 5: Last Update Timestamp', () => {
    /**
     * Property: For any successful data fetch, the hook SHALL update lastUpdate
     * with the current timestamp.
     */
    it('should update lastUpdate timestamp on successful fetch', async () => {
      const card: DashboardCard = {
        id: 1,
        title: 'Test Card',
        visualization_type: 'pie'
      };

      const fetchDataMock = vi.fn().mockResolvedValue({
        card_id: 1,
        aggregated_values: {}
      });

      const config = {
        card,
        fetchData: fetchDataMock,
        refreshInterval: 0
      };

      const { result } = renderHook(() => useCardData(config));

      expect(result.current.lastUpdate).toBeNull();

      await waitFor(() => {
        expect(result.current.lastUpdate).not.toBeNull();
        expect(result.current.lastUpdate).toBeInstanceOf(Date);
      });
    });
  });

  describe('Property 6: Initial Data', () => {
    /**
     * Property: For any initialData provided, the hook SHALL use it as the initial state
     * before fetching fresh data.
     */
    it('should use initialData before fetching', async () => {
      const card: DashboardCard = {
        id: 1,
        title: 'Test Card',
        visualization_type: 'line'
      };

      const initialData: AggregatedData = {
        card_id: 1,
        aggregated_values: { total: 50 }
      };

      const fetchDataMock = vi.fn().mockResolvedValue({
        card_id: 1,
        aggregated_values: { total: 100 }
      });

      const config = {
        card,
        fetchData: fetchDataMock,
        initialData,
        refreshInterval: 0
      };

      const { result } = renderHook(() => useCardData(config));

      // Should have initial data immediately
      expect(result.current.data).toEqual(initialData);

      // After fetch, should have new data
      await waitFor(() => {
        expect(result.current.data?.aggregated_values.total).toBe(100);
      });
    });
  });

  describe('Property 7: Error Handler Callback', () => {
    /**
     * Property: For any fetch error, if onError callback is provided,
     * it SHALL be invoked with the error.
     */
    it('should invoke onError callback on fetch failure', async () => {
      const card: DashboardCard = {
        id: 1,
        title: 'Test Card',
        visualization_type: 'area'
      };

      const error = new Error('Fetch failed');
      const fetchDataMock = vi.fn().mockRejectedValue(error);
      const onErrorMock = vi.fn();

      const config = {
        card,
        fetchData: fetchDataMock,
        onError: onErrorMock,
        refreshInterval: 0
      };

      renderHook(() => useCardData(config));

      await waitFor(() => {
        expect(onErrorMock).toHaveBeenCalledWith(error);
      });
    });
  });

  describe('Property 8: State Setters', () => {
    /**
     * Property: For any state setter (setData, setLoading, setError),
     * the hook SHALL update the corresponding state.
     */
    it('should allow manual state updates', async () => {
      const card: DashboardCard = {
        id: 1,
        title: 'Test Card',
        visualization_type: 'candlestick'
      };

      const config = {
        card,
        refreshInterval: 0
      };

      const { result } = renderHook(() => useCardData(config));

      const newData: AggregatedData = {
        card_id: 1,
        aggregated_values: { total: 999 }
      };

      act(() => {
        result.current.setData(newData);
      });

      expect(result.current.data).toEqual(newData);

      act(() => {
        result.current.setLoading(true);
      });

      expect(result.current.loading).toBe(true);

      act(() => {
        result.current.setError('Custom error');
      });

      expect(result.current.error).toBe('Custom error');
    });
  });

  describe('Property 9: Cleanup on Unmount', () => {
    /**
     * Property: For any hook instance, on unmount, all intervals and timers
     * SHALL be cleared to prevent memory leaks.
     */
    it('should clear intervals on unmount', () => {
      vi.useFakeTimers();

      const card: DashboardCard = {
        id: 1,
        title: 'Test Card',
        visualization_type: 'line'
      };

      const fetchDataMock = vi.fn().mockResolvedValue({
        card_id: 1,
        aggregated_values: {}
      });

      const config = {
        card,
        fetchData: fetchDataMock,
        refreshInterval: 1000
      };

      const { unmount } = renderHook(() => useCardData(config));

      unmount();

      // Advance time - should not cause additional calls
      vi.advanceTimersByTime(2000);

      expect(fetchDataMock).toHaveBeenCalledTimes(1); // Only initial call

      vi.useRealTimers();
    });
  });
});
