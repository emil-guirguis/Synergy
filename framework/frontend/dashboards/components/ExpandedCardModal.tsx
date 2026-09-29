import React, { useEffect, useState } from 'react';
import './ExpandedCardModal.css';

export interface ExpandedCardModalProps {
  card: any;
  data: any | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  onRefresh?: () => void;
  onDateRangeChange?: (start: string, end: string) => void;
  renderVisualization?: (data: any, columns: string[], height: number, seriesLabels?: Record<string, string>) => React.ReactNode;
}

function toDateInputValue(iso: string): string {
  return iso ? iso.split('T')[0] : '';
}

// Parse a YYYY-MM-DD date-only string as a local calendar date, not UTC
// midnight — `new Date('2024-01-01')` parses as UTC and can display as the
// previous day in any timezone west of UTC.
function parseLocalDate(dateOnly: string): Date {
  const [year, month, day] = dateOnly.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export const ExpandedCardModal: React.FC<ExpandedCardModalProps> = ({
  card,
  data,
  loading = false,
  error = null,
  onClose,
  onRefresh,
  onDateRangeChange,
  renderVisualization
}) => {
  const [exporting, setExporting] = useState(false);
  const [startInput, setStartInput] = useState('');
  const [endInput, setEndInput] = useState('');

  useEffect(() => {
    if (data?.time_frame) {
      setStartInput(toDateInputValue(data.time_frame.start));
      setEndInput(toDateInputValue(data.time_frame.end));
    }
  }, [data?.time_frame?.start, data?.time_frame?.end]);

  const handleApplyDates = () => {
    if (startInput && endInput && onDateRangeChange) {
      onDateRangeChange(startInput, endInput);
    }
  };

  // Handle Escape key press
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleEscape);
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [onClose]);

  // Handle CSV export
  const handleExport = async () => {
    try {
      setExporting(true);
      // Use detailed readings items if available, otherwise try to generate from aggregated data
      const itemsToExport = data?.items || [];
      
      if (!itemsToExport || itemsToExport.length === 0) {
        alert('No data available to export');
        return;
      }

      // Get column headers from first item
      const firstItem = itemsToExport[0];
      const headers = Object.keys(firstItem).filter(key => key !== 'meter_reading_id');
      
      // Create CSV content
      const csvContent = [
        headers.join(','),
        ...itemsToExport.map((row: any) =>
          headers.map(header => {
            const value = row[header];
            // Escape quotes and wrap in quotes if contains comma
            if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
              return `"${value.replace(/"/g, '""')}"`;
            }
            return value;
          }).join(',')
        )
      ].join('\n');

      // Create blob and download
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      
      const timestamp = new Date().toISOString().split('T')[0];
      const meterElementName = card.meter_element_name || data?.card_info?.meter_element_name || 'readings';
      link.setAttribute('href', url);
      link.setAttribute('download', `${meterElementName}-${timestamp}.csv`);
      link.style.visibility = 'hidden';
      
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export error:', err);
      alert('Failed to export data');
    } finally {
      setExporting(false);
    }
  };

  // Handle email
  const handleEmail = async () => {
    try {
      // Use detailed readings items if available
      const itemsToExport = data?.items || [];
      
      if (!itemsToExport || itemsToExport.length === 0) {
        alert('No data available to email');
        return;
      }

      const timestamp = new Date().toISOString().split('T')[0];
      const meterElementName = card.meter_element_name || data?.card_info?.meter_element_name || 'readings';
      const filename = `${meterElementName}-${timestamp}.csv`;
      
      // Create mailto URL
      const subject = encodeURIComponent(`Meter Readings Export - ${meterElementName} (${timestamp})`);
      const body = encodeURIComponent(`Please find the attached meter readings export file: ${filename}`);
      const mailtoUrl = `mailto:?subject=${subject}&body=${body}`;
      
      // Open email client
      window.location.href = mailtoUrl;
    } catch (err) {
      console.error('Email error:', err);
      alert('Failed to open email client');
    }
  };

  // Format time frame display
  const formatTimeFrame = (): string => {
    switch (card.time_frame_type) {
      case 'last_month':
        return 'Last Month';
      case 'this_month_to_date':
        return 'This Month to Date';
      case 'since_installation':
        return 'Since Installation';
      case 'custom':
        if (card.custom_start_date && card.custom_end_date) {
          const start = parseLocalDate(card.custom_start_date.split('T')[0]);
          const end = parseLocalDate(card.custom_end_date.split('T')[0]);
          return `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;
        }
        return 'Custom Range';
      default:
        return 'Unknown';
    }
  };

  return (
    <div className="expanded-card-modal">
      <div className="expanded-card-modal__overlay" onClick={onClose} />
      <div className="expanded-card-modal__content">
        {/* Header */}
        <div className="expanded-card-modal__header">
          <div className="expanded-card-modal__title-section">
            <h2 className="expanded-card-modal__title">{card.card_name || card.title}</h2>
            {(card.card_description || card.description) && (
              <p className="expanded-card-modal__description">{card.card_description || card.description}</p>
            )}
          </div>
          <button
            type="button"
            className="expanded-card-modal__close-btn"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Metadata */}
        <div className="expanded-card-modal__metadata">
          <span className="expanded-card-modal__visualization">📊 {card.visualization_type || 'Chart'}</span>
          <span className="expanded-card-modal__time-frame">🗓️ {formatTimeFrame()}</span>
          <div className="expanded-card-modal__date-range">
            <label className="expanded-card-modal__date-label">From</label>
            <input
              type="date"
              className="expanded-card-modal__date-input"
              value={startInput}
              onChange={e => setStartInput(e.target.value)}
              title="Start date"
              aria-label="Start date"
            />
            <label className="expanded-card-modal__date-label">To</label>
            <input
              type="date"
              className="expanded-card-modal__date-input"
              value={endInput}
              onChange={e => setEndInput(e.target.value)}
              title="End date"
              aria-label="End date"
            />
            {onDateRangeChange && (
              <button
                type="button"
                className="expanded-card-modal__apply-btn"
                onClick={handleApplyDates}
                disabled={loading || !startInput || !endInput}
              >
                Apply
              </button>
            )}
          </div>
          {onRefresh && (
            <button
              type="button"
              className="expanded-card-modal__refresh-btn"
              onClick={onRefresh}
              disabled={loading}
              title="Refresh data"
              aria-label="Refresh"
            >
              🔄
            </button>
          )}
          <button
            type="button"
            className="expanded-card-modal__export-btn"
            onClick={handleExport}
            disabled={exporting || !data || !data.items || data.items.length === 0}
            title="Export to CSV"
            aria-label="Export to CSV"
          >
            {exporting ? '⬇️ Exporting...' : '⬇️ Export'}
          </button>
          <button
            type="button"
            className="expanded-card-modal__email-btn"
            onClick={handleEmail}
            disabled={!data || !data.items || data.items.length === 0}
            title="Email readings"
            aria-label="Email readings"
          >
            ✉️ Email
          </button>
        </div>

        {/* Visualization */}
        <div className="expanded-card-modal__visualization-container">
          {error ? (
            <div className="expanded-card-modal__error">
              <p>{error}</p>
            </div>
          ) : loading ? (
            <div className="expanded-card-modal__loading">
              <div className="expanded-card-modal__spinner"></div>
              <p>Loading data...</p>
            </div>
          ) : data ? (
            renderVisualization ? (
              renderVisualization(
                data.grouped_data && Array.isArray(data.grouped_data) && data.grouped_data.length > 0
                  ? data.grouped_data
                  : data.aggregated_values,
                data.selected_columns || card.selected_columns || [],
                600,
                data.series_labels
              )
            ) : (
              <div className="expanded-card-modal__no-renderer">
                <p>Visualization renderer not provided</p>
              </div>
            )
          ) : (
            <div className="expanded-card-modal__no-data">
              <p>No data available</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
