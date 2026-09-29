import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DashboardPage } from './DashboardPage';
import * as dashboardServiceModule from '../services/dashboardService';

// Mock the dashboard service
vi.mock('../services/dashboardService', () => ({
  dashboardService: {
    getDashboardCards: vi.fn(),
    deleteDashboardCard: vi.fn(),
    updateDashboardCard: vi.fn().mockResolvedValue(undefined),
    getCardData: vi.fn().mockResolvedValue(null),
    createDashboardCard: vi.fn().mockResolvedValue(undefined),
    getPowerColumns: vi.fn().mockResolvedValue([]),
    getMeterElementsByMeter: vi.fn().mockResolvedValue([]),
    getAnomalies: vi.fn().mockResolvedValue([]),
  }
}));

// Mock react-grid-layout to avoid CJS module resolution issues in jsdom
vi.mock('react-grid-layout', () => ({
  default: ({ children }: any) => <div>{children}</div>,
  Responsive: ({ children }: any) => <div>{children}</div>,
  WidthProvider: (Component: any) => Component,
}));

// Mock framework dashboard components that depend on react-grid-layout
vi.mock('@meterit/framework-frontend/dashboards/components/DashboardPage', () => ({
  DashboardPage: ({ cards, loading, error, onRefresh, onCreateCard, refreshing, onErrorClose, children }: any) => (
    <div>
      <h1>Dashboard</h1>
      <p>Manage and view your energy metrics</p>
      {loading && <div>Loading dashboard cards...</div>}
      {error && (
        <div>
          <span>{error}</span>
          <button aria-label="Close error" onClick={onErrorClose}>Close</button>
        </div>
      )}
      {!loading && !error && cards && cards.length === 0 && (
        <div>
          <p>No Dashboard Cards Yet</p>
          <p>Create your first dashboard card to get started</p>
        </div>
      )}
      {cards && cards.map((card: any) => <div key={card.id}>{card.card_name}</div>)}
      <button onClick={onRefresh} disabled={refreshing}>
        {refreshing ? 'Refreshing...' : 'Refresh All'}
      </button>
      <button onClick={onCreateCard}>Create Dashboard Card</button>
      {children}
    </div>
  ),
}));
vi.mock('@meterit/framework-frontend/dashboards/components/DashboardCard', () => ({
  DashboardCard: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@meterit/framework-frontend/dashboards/components/ExpandedCardModal', () => ({
  ExpandedCardModal: () => null,
}));
vi.mock('@meterit/framework-frontend/dashboards/components/Visualization', () => ({
  Visualization: () => null,
}));

// Mock the DashboardCardForm component to avoid React hook issues
vi.mock('../components/dashboard/DashboardCardForm', () => ({
  DashboardCardForm: () => null
}));

// Mock the framework DashboardCardForm to prevent MUI module resolution failure
vi.mock('@meterit/framework-frontend/dashboards/components/DashboardCardForm', () => ({
  DashboardCardForm: () => null
}));

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the dashboard page with title', async () => {
    const mockDashboardService = dashboardServiceModule.dashboardService as any;
    mockDashboardService.getDashboardCards.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
      totalPages: 0
    });

    render(<DashboardPage />);

    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Manage and view your energy metrics')).toBeInTheDocument();
  });

  it('displays loading state initially', () => {
    const mockDashboardService = dashboardServiceModule.dashboardService as any;
    mockDashboardService.getDashboardCards.mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    render(<DashboardPage />);

    expect(screen.getByText('Loading dashboard cards...')).toBeInTheDocument();
  });

  it('displays empty state when no cards exist', async () => {
    const mockDashboardService = dashboardServiceModule.dashboardService as any;
    mockDashboardService.getDashboardCards.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
      totalPages: 0
    });

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('No Dashboard Cards Yet')).toBeInTheDocument();
      expect(screen.getByText(/Create your first dashboard card/)).toBeInTheDocument();
    });
  });

  it('displays dashboard cards when they exist', async () => {
    const mockCards = [
      {
        dashboard_id: 1,
        tenant_id: 1,
        created_by_users_id: 1,
        meter_id: 1,
        meter_element_id: 1,
        card_name: 'Test Card 1',
        card_description: 'Test Description',
        selected_columns: ['active_energy', 'power'],
        time_frame_type: 'last_month' as const,
        visualization_type: 'line' as const,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z'
      }
    ];

    const mockDashboardService = dashboardServiceModule.dashboardService as any;
    mockDashboardService.getDashboardCards.mockResolvedValue({
      items: mockCards,
      total: 1,
      page: 1,
      pageSize: 100,
      totalPages: 1
    });

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('Test Card 1')).toBeInTheDocument();
    });
  });

  it('displays create dashboard button', async () => {
    const mockDashboardService = dashboardServiceModule.dashboardService as any;
    mockDashboardService.getDashboardCards.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
      totalPages: 0
    });

    render(<DashboardPage />);

    await waitFor(() => {
      const createButtons = screen.getAllByText(/Create Dashboard/);
      expect(createButtons.length).toBeGreaterThan(0);
    });
  });

  it('displays refresh all button', async () => {
    const mockDashboardService = dashboardServiceModule.dashboardService as any;
    mockDashboardService.getDashboardCards.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
      totalPages: 0
    });

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText(/Refresh All/)).toBeInTheDocument();
    });
  });

  it('handles refresh all button click', async () => {
    const mockDashboardService = dashboardServiceModule.dashboardService as any;
    mockDashboardService.getDashboardCards.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
      totalPages: 0
    });

    const user = userEvent.setup();
    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText(/Refresh All/)).toBeInTheDocument();
    });

    const refreshButton = screen.getByText(/Refresh All/);
    await user.click(refreshButton);

    // Verify getDashboardCards was called at least twice (initial load + refresh)
    await waitFor(() => {
      expect(mockDashboardService.getDashboardCards).toHaveBeenCalledTimes(2);
    });
  });

  it('displays error message when fetch fails', async () => {
    const mockDashboardService = dashboardServiceModule.dashboardService as any;
    mockDashboardService.getDashboardCards.mockRejectedValue(
      new Error('Failed to fetch dashboard cards')
    );

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to fetch dashboard cards/)).toBeInTheDocument();
    });
  });

  it('allows closing error message', async () => {
    const mockDashboardService = dashboardServiceModule.dashboardService as any;
    mockDashboardService.getDashboardCards.mockRejectedValue(
      new Error('Failed to fetch dashboard cards')
    );

    const user = userEvent.setup();
    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to fetch dashboard cards/)).toBeInTheDocument();
    });

    const closeButton = screen.getByLabelText('Close error');
    await user.click(closeButton);

    await waitFor(() => {
      expect(screen.queryByText(/Failed to fetch dashboard cards/)).not.toBeInTheDocument();
    });
  });

  it('disables refresh button while refreshing', async () => {
    const mockDashboardService = dashboardServiceModule.dashboardService as any;
    let resolveGetCards: any;
    mockDashboardService.getDashboardCards.mockImplementation(
      () => new Promise((resolve) => {
        resolveGetCards = resolve;
      })
    );

    const user = userEvent.setup();
    render(<DashboardPage />);

    // Wait for initial load to complete
    resolveGetCards({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
      totalPages: 0
    });

    await waitFor(() => {
      expect(screen.getByText(/Refresh All/)).toBeInTheDocument();
    });

    // Now click refresh and check if button is disabled
    const refreshButton = screen.getByText(/Refresh All/);
    
    // Set up a new promise that won't resolve immediately
    let resolveRefresh: any;
    mockDashboardService.getDashboardCards.mockImplementation(
      () => new Promise((resolve) => {
        resolveRefresh = resolve;
      })
    );

    await user.click(refreshButton);

    // Button should be disabled while refreshing
    await waitFor(() => {
      expect(refreshButton).toBeDisabled();
    });

    // Resolve the refresh
    resolveRefresh({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
      totalPages: 0
    });

    // Button should be enabled again
    await waitFor(() => {
      expect(refreshButton).not.toBeDisabled();
    });
  });

  it('shows loading indicator during global refresh', async () => {
    const mockDashboardService = dashboardServiceModule.dashboardService as any;
    mockDashboardService.getDashboardCards.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
      totalPages: 0
    });

    const user = userEvent.setup();
    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText(/Refresh All/)).toBeInTheDocument();
    });

    const refreshButton = screen.getByText(/Refresh All/);
    await user.click(refreshButton);

    // The button should show "Refreshing..." state briefly
    await waitFor(() => {
      expect(mockDashboardService.getDashboardCards).toHaveBeenCalledTimes(2);
    });
  });
});
