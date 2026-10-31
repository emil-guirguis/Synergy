import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import * as reportingService from '../../services/reportingService';
import type { Report } from './types';
import type { EnhancedStore } from '@meterit/framework-frontend/components/list/types/list';

export type { Report };

interface ReportsState {
  items: Report[];
  list: {
    loading: boolean;
    error: string | null;
    page: number;
    pageSize: number;
    total: number;
  };
  filters: Record<string, any>;
  searchQuery: string;
}

interface ReportsActions {
  // Framework-required methods
  fetchItems: () => Promise<void>;
  setSearch: (query: string) => void;
  setFilters: (filters: Record<string, any>) => void;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  deleteItem: (id: string | number) => Promise<void>;
  updateItemInList: (report: Report) => void;
  
  // Legacy methods for backward compatibility
  fetchReports: (page?: number, limit?: number) => Promise<void>;
  fetchReport: (id: number) => Promise<Report | null>;
  createReport: (data: Omit<Report, 'report_id' | 'created_at' | 'updated_at'>) => Promise<Report>;
  updateReport: (id: number, data: Partial<Omit<Report, 'report_id' | 'created_at' | 'updated_at'>>) => Promise<Report>;
  deleteReport: (id: number) => Promise<void>;
  toggleReportStatus: (id: number) => Promise<void>;
  clearFilters: () => void;
}

type ReportsStore = ReportsState & ReportsActions;

const initialState: ReportsState = {
  items: [],
  list: {
    loading: false,
    error: null,
    page: 1,
    pageSize: 10,
    total: 0,
  },
  filters: {},
  searchQuery: '',
};

export const useReportsStore = create<ReportsStore>()(
  devtools(
    (set, get) => ({
      ...initialState,

      // Framework-required methods
      fetchItems: async () => {
        if (get().list.loading) return; // in-flight guard
        const state = get();
        set(s => ({
          list: { ...s.list, loading: true, error: null }
        }));
        try {
          const response = await reportingService.getReports(state.list.page, state.list.pageSize);
          
          // Handle both direct response and wrapped response
          const data = (response as any).data || response;
          const items = data.items || data.data || [];
          const total = data.pagination?.total || data.total || 0;
          
          set(s => ({
            items,
            list: {
              ...s.list,
              loading: false,
              total,
            },
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to fetch reports';
          set(s => ({
            list: { ...s.list, error: message, loading: false }
          }));
          console.error('[reportsStore] Error fetching reports:', error);
        }
      },

      setSearch: (query: string) => {
        set({ searchQuery: query });
        // Trigger fetch with new search
        get().fetchItems();
      },

      setFilters: (filters: Record<string, any>) => {
        set({ filters });
        // Reset to page 1 when filters change
        set(s => ({ list: { ...s.list, page: 1 } }));
      },

      setPage: (page: number) => {
        set(s => ({ list: { ...s.list, page } }));
        get().fetchItems();
      },

      setPageSize: (size: number) => {
        set(s => ({ list: { ...s.list, pageSize: size, page: 1 } }));
        get().fetchItems();
      },

      deleteItem: async (id: string | number) => {
        await get().deleteReport(Number(id));
      },

      updateItemInList: (report: Report) => {
        set(s => ({
          items: s.items.map(r => r.report_id === report.report_id ? report : r),
        }));
      },

      // Legacy methods
      fetchReports: async (page = 1, limit = 10) => {
        set(s => ({
          list: { ...s.list, loading: true, error: null, page, pageSize: limit }
        }));
        try {
          const response = await reportingService.getReports(page, limit);
          
          // Handle both direct response and wrapped response
          const data = (response as any).data || response;
          const items = data.items || data.data || [];
          const total = data.pagination?.total || data.total || 0;
          
          set(s => ({
            items,
            list: {
              ...s.list,
              loading: false,
              page,
              pageSize: limit,
              total,
            },
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to fetch reports';
          set(s => ({
            list: { ...s.list, error: message, loading: false }
          }));
          console.error('[reportsStore] Error fetching reports:', error);
        }
      },

      fetchReport: async (id: number) => {
        set(s => ({
          list: { ...s.list, loading: true, error: null }
        }));
        try {
          const report = await reportingService.getReport(id);
          set(s => ({
            list: { ...s.list, loading: false }
          }));
          return report;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to fetch report';
          set(s => ({
            list: { ...s.list, error: message, loading: false }
          }));
          console.error('[reportsStore] Error fetching report:', error);
          return null;
        }
      },

      createReport: async (data) => {
        set(s => ({
          list: { ...s.list, loading: true, error: null }
        }));
        try {
          const newReport = await reportingService.createReport(data);
          const state = get();
          set({
            items: [newReport, ...state.items],
            list: { ...state.list, loading: false },
          });
          return newReport;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to create report';
          set(s => ({
            list: { ...s.list, error: message, loading: false }
          }));
          console.error('[reportsStore] Error creating report:', error);
          throw error;
        }
      },

      updateReport: async (id, data) => {
        set(s => ({
          list: { ...s.list, loading: true, error: null }
        }));
        try {
          const updatedReport = await reportingService.updateReport(id, data);
          const state = get();
          set({
            items: state.items.map(r => r.report_id === id ? updatedReport : r),
            list: { ...state.list, loading: false },
          });
          return updatedReport;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to update report';
          set(s => ({
            list: { ...s.list, error: message, loading: false }
          }));
          console.error('[reportsStore] Error updating report:', error);
          throw error;
        }
      },

      deleteReport: async (id) => {
        set(s => ({
          list: { ...s.list, loading: true, error: null }
        }));
        try {
          await reportingService.deleteReport(id);
          const state = get();
          set({
            items: state.items.filter(r => r.report_id !== id),
            list: { ...state.list, loading: false },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to delete report';
          set(s => ({
            list: { ...s.list, error: message, loading: false }
          }));
          console.error('[reportsStore] Error deleting report:', error);
          throw error;
        }
      },

      toggleReportStatus: async (id) => {
        set(s => ({
          list: { ...s.list, loading: true, error: null }
        }));
        try {
          const result = await reportingService.toggleReportStatus(id);
          const state = get();
          set({
            items: state.items.map(r => 
              r.report_id === id ? { ...r, active: result.active } : r
            ),
            list: { ...state.list, loading: false },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to toggle report status';
          set(s => ({
            list: { ...s.list, error: message, loading: false }
          }));
          console.error('[reportsStore] Error toggling report status:', error);
          throw error;
        }
      },

      clearFilters: () => set({ filters: {}, searchQuery: '' }),
    }),
    { name: 'ReportsStore' }
  )
);

export const useReportsEnhanced = (): EnhancedStore<Report> => {
  const store = useReportsStore();
  
  return {
    items: store.items,
    list: store.list,
    fetchItems: store.fetchItems,
    setSearch: store.setSearch,
    setFilters: store.setFilters,
    setPage: store.setPage,
    setPageSize: store.setPageSize,
    deleteItem: store.deleteItem,
    updateItemInList: store.updateItemInList,
    // Legacy methods for backward compatibility
    fetchReports: store.fetchReports,
    fetchReport: store.fetchReport,
    createReport: store.createReport,
    updateReport: store.updateReport,
    deleteReport: store.deleteReport,
    toggleReportStatus: store.toggleReportStatus,
    clearFilters: store.clearFilters,
  };
};
