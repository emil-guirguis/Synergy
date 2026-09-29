import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExpandedCardModal } from './ExpandedCardModal';
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('ExpandedCardModal', () => {
  const mockOnClose = vi.fn();
  const mockOnRefresh = vi.fn();
  const mockRenderVisualization = vi.fn(() => <div>Mock Visualization</div>);

  const mockCard = {
    card_name: 'Test Card',
    card_description: 'Test Description',
    time_frame_type: 'last_month',
    visualization_type: 'line',
    selected_columns: ['active_energy', 'power'],
    custom_start_date: null,
    custom_end_date: null,
  };

  const mockData = {
    card_id: 1,
    aggregated_values: {
      active_energy: 1000,
      power: 500,
    },
    grouped_data: [
      { date: '2024-01-01', active_energy: 100, power: 50 },
      { date: '2024-01-02', active_energy: 110, power: 55 },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render modal with card title', () => {
    render(
      <ExpandedCardModal
        card={mockCard}
        data={mockData}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    expect(screen.getByText('Test Card')).toBeInTheDocument();
  });

  it('should render card description', () => {
    render(
      <ExpandedCardModal
        card={mockCard}
        data={mockData}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    expect(screen.getByText('Test Description')).toBeInTheDocument();
  });

  it('should not render description if not provided', () => {
    const cardWithoutDescription = { ...mockCard, card_description: null };
    render(
      <ExpandedCardModal
        card={cardWithoutDescription}
        data={mockData}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    expect(screen.queryByText('Test Description')).not.toBeInTheDocument();
  });

  it('should display time frame information', () => {
    render(
      <ExpandedCardModal
        card={mockCard}
        data={mockData}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    expect(screen.getByText(/Last Month/i)).toBeInTheDocument();
  });

  it('should display visualization type', () => {
    render(
      <ExpandedCardModal
        card={mockCard}
        data={mockData}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    expect(screen.getByText(/line/i)).toBeInTheDocument();
  });

  it('should format custom date range correctly', () => {
    const cardWithCustomDates = {
      ...mockCard,
      time_frame_type: 'custom',
      custom_start_date: '2024-01-01',
      custom_end_date: '2024-01-31',
    };

    render(
      <ExpandedCardModal
        card={cardWithCustomDates}
        data={mockData}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    expect(screen.getByText(/1\/1\/2024 - 1\/31\/2024/i)).toBeInTheDocument();
  });

  it('should call onClose when close button is clicked', async () => {
    const user = userEvent.setup();
    render(
      <ExpandedCardModal
        card={mockCard}
        data={mockData}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    const closeButton = screen.getByLabelText(/Close/i);
    await user.click(closeButton);

    expect(mockOnClose).toHaveBeenCalled();
  });

  it('should call onClose when overlay is clicked', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ExpandedCardModal
        card={mockCard}
        data={mockData}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    const overlay = container.querySelector('.expanded-card-modal__overlay');
    if (overlay) {
      await user.click(overlay);
      expect(mockOnClose).toHaveBeenCalled();
    }
  });

  it('should call onClose when Escape key is pressed', async () => {
    render(
      <ExpandedCardModal
        card={mockCard}
        data={mockData}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    const event = new KeyboardEvent('keydown', { key: 'Escape' });
    window.dispatchEvent(event);

    await waitFor(() => {
      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  it('should render visualization when data is provided', () => {
    render(
      <ExpandedCardModal
        card={mockCard}
        data={mockData}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    expect(screen.getByText('Mock Visualization')).toBeInTheDocument();
  });

  it('should show loading state when loading is true', () => {
    render(
      <ExpandedCardModal
        card={mockCard}
        data={null}
        loading={true}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    expect(screen.getByText(/Loading data/i)).toBeInTheDocument();
  });

  it('should show error message when error is provided', () => {
    const errorMessage = 'Failed to load data';
    render(
      <ExpandedCardModal
        card={mockCard}
        data={null}
        error={errorMessage}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    expect(screen.getByText(errorMessage)).toBeInTheDocument();
  });

  it('should show no data message when data is null and not loading', () => {
    render(
      <ExpandedCardModal
        card={mockCard}
        data={null}
        loading={false}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    expect(screen.getByText(/No data available/i)).toBeInTheDocument();
  });

  it('should call renderVisualization with grouped data when available', () => {
    render(
      <ExpandedCardModal
        card={mockCard}
        data={mockData}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    expect(mockRenderVisualization).toHaveBeenCalledWith(
      mockData.grouped_data,
      mockCard.selected_columns,
      600,
      undefined
    );
  });

  it('should call renderVisualization with aggregated values when grouped data is not available', () => {
    const dataWithoutGrouped = {
      card_id: 1,
      aggregated_values: {
        active_energy: 1000,
        power: 500,
      },
    };

    render(
      <ExpandedCardModal
        card={mockCard}
        data={dataWithoutGrouped}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    expect(mockRenderVisualization).toHaveBeenCalledWith(
      dataWithoutGrouped.aggregated_values,
      mockCard.selected_columns,
      600,
      undefined
    );
  });

  it('should display refresh button when onRefresh is provided', () => {
    render(
      <ExpandedCardModal
        card={mockCard}
        data={mockData}
        onClose={mockOnClose}
        onRefresh={mockOnRefresh}
        renderVisualization={mockRenderVisualization}
      />
    );

    const refreshButton = screen.getByLabelText(/Refresh/i);
    expect(refreshButton).toBeInTheDocument();
  });

  it('should call onRefresh when refresh button is clicked', async () => {
    const user = userEvent.setup();
    render(
      <ExpandedCardModal
        card={mockCard}
        data={mockData}
        onClose={mockOnClose}
        onRefresh={mockOnRefresh}
        renderVisualization={mockRenderVisualization}
      />
    );

    const refreshButton = screen.getByLabelText(/Refresh/i);
    await user.click(refreshButton);

    expect(mockOnRefresh).toHaveBeenCalled();
  });

  it('should disable refresh button when loading', () => {
    render(
      <ExpandedCardModal
        card={mockCard}
        data={mockData}
        loading={true}
        onClose={mockOnClose}
        onRefresh={mockOnRefresh}
        renderVisualization={mockRenderVisualization}
      />
    );

    const refreshButton = screen.getByLabelText(/Refresh/i) as HTMLButtonElement;
    expect(refreshButton.disabled).toBe(true);
  });

  it('should show no renderer message when renderVisualization is not provided', () => {
    render(
      <ExpandedCardModal
        card={mockCard}
        data={mockData}
        onClose={mockOnClose}
      />
    );

    expect(screen.getByText(/Visualization renderer not provided/i)).toBeInTheDocument();
  });

  it('should use card.title as fallback for card name', () => {
    const cardWithTitle = {
      ...mockCard,
      card_name: undefined,
      title: 'Fallback Title',
    };

    render(
      <ExpandedCardModal
        card={cardWithTitle}
        data={mockData}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    expect(screen.getByText('Fallback Title')).toBeInTheDocument();
  });

  it('should use card.description as fallback for description', () => {
    const cardWithDescription = {
      ...mockCard,
      card_description: undefined,
      description: 'Fallback Description',
    };

    render(
      <ExpandedCardModal
        card={cardWithDescription}
        data={mockData}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    expect(screen.getByText('Fallback Description')).toBeInTheDocument();
  });

  it('should handle since_installation time frame', () => {
    const cardWithSinceInstallation = {
      ...mockCard,
      time_frame_type: 'since_installation',
    };

    render(
      <ExpandedCardModal
        card={cardWithSinceInstallation}
        data={mockData}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    expect(screen.getByText(/Since Installation/i)).toBeInTheDocument();
  });

  it('should handle this_month_to_date time frame', () => {
    const cardWithThisMonth = {
      ...mockCard,
      time_frame_type: 'this_month_to_date',
    };

    render(
      <ExpandedCardModal
        card={cardWithThisMonth}
        data={mockData}
        onClose={mockOnClose}
        renderVisualization={mockRenderVisualization}
      />
    );

    expect(screen.getByText(/This Month to Date/i)).toBeInTheDocument();
  });
});
