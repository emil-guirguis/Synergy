/**
 * DashboardCard Component
 *
 * Generic dashboard card component that displays aggregated meter data with controls.
 * This component is framework-level and contains no API calls or business logic.
 * All data and callbacks are provided through props.
 */

import React, { useState, useEffect } from 'react';
import type { DashboardCard as DashboardCardType, AggregatedData, VisualizationType } from '../types';
import {
  TIME_FRAME_OPTIONS,
  VISUALIZATION_OPTIONS,
  GROUPING_OPTIONS,
  AGGREGATION_OPTIONS,
  normaliseAggregation,
} from '../dashboardOptions';
import {
  Card,
  CardContent,
  Box,
  Typography,
  Select,
  MenuItem,
  CircularProgress,
  Divider,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import EmailIcon from '@mui/icons-material/Email';
import './DashboardCard.css';

export interface DashboardCardProps {
  card: DashboardCardType;
  data: AggregatedData | null;
  loading?: boolean;
  error?: string | null;
  onEdit?: (card: DashboardCardType) => void;
  onDelete?: (cardId: string | number) => void;
  onRefresh?: (cardId: string | number) => void;
  onExpand?: (card: DashboardCardType) => void;
  onVisualizationChange?: (cardId: string | number, newType: VisualizationType) => void;
  onGroupingChange?: (cardId: string | number, newGrouping: string) => void;
  onTimeFrameChange?: (cardId: string | number, newTimeFrame: string) => void;
  onAggregationChange?: (cardId: string | number, aggregationType: string) => void;
  VisualizationComponent?: React.ComponentType<any>;
  className?: string;
  isSaving?: boolean;
}

// Small icon-button helper — avoids MUI Button overhead for icon-only actions
const IconBtn: React.FC<{
  onClick: (e: React.MouseEvent) => void;
  title: string;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}> = ({ onClick, title, disabled, danger, children }) => (
  <Box
    component="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    aria-label={title}
    className={`dashboard-card__icon-btn${danger ? ' dashboard-card__icon-btn--danger' : ''}`}
    sx={{ p: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
  >
    {children}
  </Box>
);

export const DashboardCard: React.FC<DashboardCardProps> = ({
  card,
  data,
  loading = false,
  error = null,
  onEdit,
  onDelete,
  onRefresh,
  onExpand,
  onVisualizationChange,
  onGroupingChange,
  onTimeFrameChange,
  onAggregationChange,
  VisualizationComponent,
  className = '',
  isSaving = false,
}) => {
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  useEffect(() => {
    if (data && !loading) {
      setLastRefreshed(new Date());
    }
  }, [data, loading]);

  const handleRefresh = (e: React.MouseEvent) => { e.preventDefault(); onRefresh?.(card.id); };
  const handleEdit = (e: React.MouseEvent) => { e.preventDefault(); onEdit?.(card); };
  const handleExpand = (e: React.MouseEvent) => { e.preventDefault(); onExpand?.(card); };

  const handleDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    if (window.confirm(`Delete "${cardTitle}"?`)) onDelete?.(card.id);
  };

  const handleExportClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!data?.aggregated_values) { alert('No data available to export'); return; }
    try {
      const headers = Object.keys(data.aggregated_values);
      const csvContent = [headers.join(','), headers.map(h => data.aggregated_values[h]).join(',')].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute('download', `${(card as any).card_name || card.title || 'export'}-${new Date().toISOString().split('T')[0]}.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch { alert('Failed to export data'); }
  };

  const handleEmailClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!data?.aggregated_values) { alert('No data available to email'); return; }
    try {
      const headers = Object.keys(data.aggregated_values);
      const csvContent = [headers.join(','), headers.map(h => data.aggregated_values[h]).join(',')].join('\n');
      const fileBase64 = btoa(unescape(encodeURIComponent(csvContent)));
      const timestamp = new Date().toISOString().split('T')[0];
      const cardName = (card as any).card_name || card.title || 'export';
      const filename = `${cardName}-${timestamp}.csv`;
      const token = localStorage.getItem('token');
      fetch('/api/emails/send-with-attachment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ subject: `Dashboard Export - ${cardName} (${timestamp})`, body: `Attached: ${filename}`, filename, fileBase64 }),
      })
        .then(r => r.json())
        .then(result => alert(result.success ? 'Email sent successfully' : 'Failed: ' + (result.message || 'Unknown error')))
        .catch(() => alert('Failed to send email'));
    } catch { alert('Failed to prepare email'); }
  };

  const handleVisualizationChange = (e: any) => {
    console.log('[DashboardCard] visualization changed - card.id:', card.id, 'value:', e.target.value);
    onVisualizationChange?.(card.id, e.target.value as VisualizationType);
  };
  const handleGroupingChange = (e: any) => {
    console.log('[DashboardCard] grouping changed - card.id:', card.id, 'value:', e.target.value);
    onGroupingChange?.(card.id, e.target.value);
  };
  const handleTimeFrameChange = (e: any) => {
    const newTimeFrame = e.target.value;
    console.log('[DashboardCard] timeFrame changed - card.id:', card.id, 'value:', newTimeFrame);
    onTimeFrameChange?.(card.id, newTimeFrame);
  };
  const handleAggregationChange = (e: any) => {
    console.log('[DashboardCard] aggregation changed - card.id:', card.id, 'value:', e.target.value);
    onAggregationChange?.(card.id, e.target.value);
  };

  const formatNumber = (value: number | null | undefined | string | object): string => {
    if (value === null || value === undefined) return '--';
    let n: number;
    if (typeof value === 'string') n = parseFloat(value);
    else if (typeof value === 'number') n = value;
    else return '--';
    if (isNaN(n)) return '--';
    return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  const formatColumnLabel = (column: string): string =>
    column.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const formatLastRefreshed = (): string => {
    if (!lastRefreshed) return '';
    const diffMs = Date.now() - lastRefreshed.getTime();
    const s = Math.floor(diffMs / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  const currentVisualization = (card.visualization_type || 'line') as VisualizationType;
  const groupingType = (card as any).grouping_type || 'daily';
  const timeFrameType = (card as any).time_frame_type || 'last_month';
  const aggregationType = normaliseAggregation((card as any).aggregation_type);
  // Prefer the mapped column names returned by the API in data.selected_columns,
  // which match the keys inside grouped_data. Fall back to the card's stored raw names.
  const selectedColumns: string[] = (data as any)?.selected_columns || (card as any).selected_columns || [];
  const cardTitle = (card as any).card_name || card.title || 'Untitled Card';
  const cardDescription = (card as any).card_description || card.description;

  // Compact select shared styles
  const selectSx = {
    flex: 1,
    minWidth: 0,
    fontSize: '0.8rem',
    height: '36px',
    color: '#475569',
    fontWeight: 500,
    background: '#f8fafc',
    borderRadius: '6px',
    '& .MuiOutlinedInput-notchedOutline': { border: '1px solid #e2e8f0' },
    '&:hover .MuiOutlinedInput-notchedOutline': { border: '1px solid #94a3b8' },
    '&.Mui-focused .MuiOutlinedInput-notchedOutline': { border: '2px solid #2563eb' },
    '& .MuiSelect-select': { py: 0, px: '10px !important', lineHeight: '36px' },
    '& .MuiSelect-icon': { fontSize: '1.1rem', color: '#94a3b8' },
    '&.Mui-disabled': { background: '#f1f5f9', opacity: 0.6 },
  };

  const menuItemSx = { fontSize: '0.85rem', py: 0.75 };

  return (
    <Card
      className={`dashboard-card ${className}`}
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '12px',
        border: '1px solid #e2e8f0',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06)',
        transition: 'box-shadow 0.2s ease, transform 0.18s ease',
        overflow: 'hidden',
        background: '#fff',
        '&:hover': {
          boxShadow: '0 4px 20px rgba(37,99,235,0.1), 0 1px 4px rgba(0,0,0,0.08)',
          transform: 'translateY(-1px)',
        },
      }}
    >
      {/* Accent stripe */}
      <Box sx={{ height: '3px', background: 'linear-gradient(90deg, #2563eb 0%, #7c3aed 100%)', flexShrink: 0 }} />

      {/* Card Header */}
      <Box sx={{ px: 2, pt: 1.75, pb: 1.25, display: 'flex', alignItems: 'center', gap: 1, minHeight: 0 }}>
        {/* Drag Handle */}
        <Box
          className="dashboard-card__drag-handle dashboard-page__drag-handle"
          sx={{
            cursor: 'grab',
            color: '#cbd5e1',
            display: 'flex',
            alignItems: 'center',
            mt: '2px',
            flexShrink: 0,
            '&:hover': { color: '#64748b' },
            '&:active': { cursor: 'grabbing' },
          }}
        >
          <DragIndicatorIcon sx={{ fontSize: '1rem' }} />
        </Box>

        {/* Title + Description */}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{
            fontWeight: 700,
            fontSize: '1rem',
            color: '#1e293b',
            lineHeight: 1.3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {cardTitle}
          </Typography>
          {cardDescription && (
            <Typography sx={{
              color: '#94a3b8',
              fontSize: '0.8rem',
              display: 'block',
              mt: '2px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {cardDescription}
            </Typography>
          )}
        </Box>

        {/* Action Icons */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '1px', flexShrink: 0 }}>
          {lastRefreshed && (
            <Typography sx={{ fontSize: '0.72rem', color: '#94a3b8', mr: 0.5, whiteSpace: 'nowrap' }}>
              {formatLastRefreshed()}
            </Typography>
          )}
          <IconBtn onClick={handleRefresh} title="Refresh" disabled={loading || isSaving}>
            <RefreshIcon sx={{ fontSize: '1.1rem' }} />
          </IconBtn>
          <IconBtn onClick={handleEdit} title="Edit">
            <EditIcon sx={{ fontSize: '1.1rem' }} />
          </IconBtn>
          <IconBtn onClick={handleExportClick} title="Export CSV">
            <FileDownloadIcon sx={{ fontSize: '1.1rem' }} />
          </IconBtn>
          <IconBtn onClick={handleEmailClick} title="Email">
            <EmailIcon sx={{ fontSize: '1.1rem' }} />
          </IconBtn>
          <IconBtn onClick={handleExpand} title="Expand">
            <FullscreenIcon sx={{ fontSize: '1.1rem' }} />
          </IconBtn>
          <IconBtn onClick={handleDelete} title="Delete" danger>
            <DeleteIcon sx={{ fontSize: '1.1rem' }} />
          </IconBtn>
        </Box>
      </Box>

      {/* Filter Bar */}
      <Box sx={{ px: 2, pb: 1.5, display: 'flex', gap: 1 }}>
        {onTimeFrameChange && (
          <Select value={timeFrameType} onChange={handleTimeFrameChange} disabled={isSaving || loading} size="small" sx={selectSx}>
            {TIME_FRAME_OPTIONS.map(o => <MenuItem key={o.value} value={o.value} sx={menuItemSx}>{o.label}</MenuItem>)}
          </Select>
        )}
        {onVisualizationChange && (
          <Select value={currentVisualization} onChange={handleVisualizationChange} disabled={isSaving || loading} size="small" sx={selectSx}>
            {VISUALIZATION_OPTIONS.map(o => <MenuItem key={o.value} value={o.value} sx={menuItemSx}>{o.label}</MenuItem>)}
          </Select>
        )}
        {onGroupingChange && (
          <Select value={groupingType} onChange={handleGroupingChange} disabled={isSaving || loading} size="small" sx={selectSx}>
            {GROUPING_OPTIONS.map(o => <MenuItem key={o.value} value={o.value} sx={menuItemSx}>{o.label}</MenuItem>)}
          </Select>
        )}
        {onAggregationChange && (
          <Select value={aggregationType} onChange={handleAggregationChange} disabled={isSaving || loading} size="small" sx={selectSx}>
            {AGGREGATION_OPTIONS.map(o => <MenuItem key={o.value} value={o.value} sx={menuItemSx}>{o.label}</MenuItem>)}
          </Select>
        )}
      </Box>

      <Divider sx={{ borderColor: '#f1f5f9' }} />

      {/* Content */}
      <CardContent sx={{ flex: 1, display: 'flex', flexDirection: 'column', p: '12px !important', minHeight: 0 }}>
        {loading ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 1.5 }}>
            <CircularProgress size={28} thickness={3} sx={{ color: '#2563eb' }} />
            <Typography sx={{ fontSize: '0.8rem', color: '#94a3b8' }}>Loading data...</Typography>
          </Box>
        ) : error ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 1.5, p: 2 }}>
            <Box sx={{
              width: 40, height: 40, borderRadius: '50%',
              background: '#fef2f2', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Typography sx={{ fontSize: '1.2rem' }}>⚠</Typography>
            </Box>
            <Typography sx={{ fontSize: '0.8rem', color: '#ef4444', textAlign: 'center' }}>{error}</Typography>
            <Box
              component="button"
              onClick={handleRefresh}
              sx={{
                px: 2, py: 0.75, border: '1px solid #2563eb', borderRadius: '6px',
                background: 'transparent', color: '#2563eb', cursor: 'pointer',
                fontSize: '0.8rem', fontWeight: 500,
                '&:hover': { background: '#eff6ff' },
              }}
            >
              Retry
            </Box>
          </Box>
        ) : data ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 1, minHeight: 0 }}>
            {/* Stat tiles — one per selected column */}
            {selectedColumns.length > 0 && (
              <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                {selectedColumns.map((column) => (
                  <Box key={column} sx={{ minWidth: 0 }}>
                    <Typography sx={{ fontSize: '1.1rem', fontWeight: 700, color: '#1e293b', lineHeight: 1.2 }}>
                      {formatNumber(data.aggregated_values?.[column])}
                    </Typography>
                    <Typography sx={{ fontSize: '0.72rem', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                      {formatColumnLabel(column)}
                    </Typography>
                  </Box>
                ))}
              </Box>
            )}

            {/* Chart — click to expand */}
            {VisualizationComponent && (
              <Box
                sx={{ flex: 1, minHeight: 0, cursor: 'pointer' }}
                onClick={onExpand ? (e) => { e.stopPropagation(); onExpand(card); } : undefined}
                title="Click to expand"
              >
                <VisualizationComponent
                  type={currentVisualization}
                  data={
                    data.grouped_data && Array.isArray(data.grouped_data) && data.grouped_data.length > 0
                      ? data.grouped_data
                      : data.aggregated_values
                  }
                  columns={selectedColumns}
                  seriesLabels={(data as any).series_labels}
                />
              </Box>
            )}

          </Box>
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
            <Typography sx={{ fontSize: '0.8rem', color: '#94a3b8' }}>No data available</Typography>
          </Box>
        )}
      </CardContent>
    </Card>
  );
};
