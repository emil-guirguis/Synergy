import React, { useState, useEffect, useCallback, useContext, createContext, useRef, useMemo } from 'react';
import type { Layout } from 'react-grid-layout';
import { DashboardPage as FrameworkDashboardPage } from '@meterit/framework-frontend/dashboards/components/DashboardPage';
import { DashboardCard as FrameworkDashboardCard } from '@meterit/framework-frontend/dashboards/components/DashboardCard';
import { DashboardCardForm as FrameworkDashboardCardForm } from '@meterit/framework-frontend/dashboards/components/DashboardCardForm';
import { ExpandedCardModal as FrameworkExpandedCardModal } from '@meterit/framework-frontend/dashboards/components/ExpandedCardModal';
import { Visualization } from '@meterit/framework-frontend/dashboards/components/Visualization';
import type { DashboardCard as FrameworkDashboardCardType } from '@meterit/framework-frontend/dashboards/types';
import { dashboardService, type DashboardCard as DashboardCardType, type AggregatedData } from '../services/dashboardService';
import { AnomalyInsightsPanel } from '../features/dashboard/AnomalyInsightsPanel';
// import { DashboardBanner } from '../features/dashboard/DashboardBanner';
import './DashboardPage.css';

/** Pivot grouped_data rows by meter_element_id so each time bucket becomes one row with per-element columns. */
/** Build a display label for a column, appending unit in parentheses if available. */
function colLabel(col: string, units?: Record<string, string>): string {
  const unit = units?.[col];
  const name = col.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return unit ? `${name} (${unit})` : name;
}

function pivotByMeterElement(data: AggregatedData): AggregatedData {
  const { grouped_data, meter_element_labels, selected_columns, column_units } = data;
  if (!grouped_data || !meter_element_labels) return data;
  const elementIds = Object.keys(meter_element_labels).map(Number);
  const cols = selected_columns || [];

  // For single element, still build series_labels with units
  if (elementIds.length <= 1) {
    if (column_units && Object.keys(column_units).length > 0) {
      const series_labels: Record<string, string> = {};
      for (const col of cols) {
        series_labels[col] = colLabel(col, column_units);
      }
      return { ...data, series_labels };
    }
    return data;
  }

  // When rows include peaked_at (MAX aggregation), show one bar per element using the
  // record with the highest value across all time buckets.
  const hasPeakedAt = grouped_data.some(r => 'peaked_at' in r);
  if (hasPeakedAt) {
    const primaryCol = cols[0];
    // For each element, find the row with the highest value for the primary column
    const bestByElement = new Map<number, Record<string, any>>();
    for (const row of grouped_data) {
      const eid = Number(row.meter_element_id);
      const val = typeof row[primaryCol] === 'number' ? row[primaryCol] : parseFloat(String(row[primaryCol] ?? ''));
      const prev = bestByElement.get(eid);
      const prevVal = prev ? (typeof prev[primaryCol] === 'number' ? prev[primaryCol] : parseFloat(String(prev[primaryCol] ?? ''))) : -Infinity;
      if (!prev || val > prevVal) bestByElement.set(eid, row);
    }
    const elementRows: Record<string, any>[] = elementIds.map(eid => {
      const best = bestByElement.get(eid);
      const elementLabel = meter_element_labels[eid] || `Element ${eid}`;
      const peakedAt = best?.peaked_at ? String(best.peaked_at) : '';
      const dateStr = peakedAt
        ? new Date(peakedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';
      const row: Record<string, any> = {
        label_key: dateStr || elementLabel,
        element_name: elementLabel,
      };
      for (const col of cols) {
        row[col] = best?.[col] ?? null;
      }
      return row;
    });
    const newSeriesLabels: Record<string, string> = {};
    for (const col of cols) newSeriesLabels[col] = colLabel(col, column_units);
    return { ...data, grouped_data: elementRows, selected_columns: cols, series_labels: newSeriesLabels };
  }

  const getTimeKey = (row: Record<string, any>): string => {
    const parts: any[] = [];
    if (row.date !== undefined) parts.push(row.date);
    if (row.hour !== undefined) parts.push(row.hour);
    if (row.week_start !== undefined) parts.push(row.week_start);
    if (row.month_start !== undefined) parts.push(row.month_start);
    return parts.length ? parts.join('|') : 'total';
  };

  const pivotMap = new Map<string, Record<string, any>>();
  for (const row of grouped_data) {
    const key = getTimeKey(row);
    if (!pivotMap.has(key)) {
      const base: Record<string, any> = {};
      if (row.date !== undefined) base.date = row.date;
      if (row.hour !== undefined) base.hour = row.hour;
      if (row.week_start !== undefined) base.week_start = row.week_start;
      if (row.month_start !== undefined) base.month_start = row.month_start;
pivotMap.set(key, base);
    }
    const pivotRow = pivotMap.get(key)!;
    for (const col of cols) {
      pivotRow[`${col}_${row.meter_element_id}`] = row[col];
    }
  }

  const pivotedColumns = elementIds.flatMap(id => cols.map(col => `${col}_${id}`));
  const series_labels: Record<string, string> = {};
  for (const id of elementIds) {
    const label = meter_element_labels[id] || `Element ${id}`;
    for (const col of cols) {
      const unit = column_units?.[col];
      series_labels[`${col}_${id}`] = unit ? `${label} (${unit})` : label;
    }
  }

  return { ...data, grouped_data: Array.from(pivotMap.values()), selected_columns: pivotedColumns, series_labels };
}

// Context for passing card data and handlers to ClientDashboardCard.
// This allows ClientDashboardCard to live outside DashboardPage (stable component identity)
// while still accessing up-to-date state.
interface DashboardContextType {
  cardDataMap: Record<number, AggregatedData | null>;
  cardLoadingMap: Record<number, boolean>;
  cardErrorMap: Record<number, string | null>;
  onVisualizationChange: (cardId: number | string, newType: string) => void;
  onGroupingChange: (cardId: number | string, newGrouping: string) => void;
  onTimeFrameChange: (cardId: number | string, newTimeFrame: string) => void;
  onAggregationChange: (cardId: number | string, aggregationType: string) => void;
}

const DashboardContext = createContext<DashboardContextType>({
  cardDataMap: {},
  cardLoadingMap: {},
  cardErrorMap: {},
  onVisualizationChange: () => {},
  onGroupingChange: () => {},
  onTimeFrameChange: () => {},
  onAggregationChange: () => {},
});

/**
 * Stable top-level component for rendering a dashboard card.
 * Defined outside DashboardPage so React never sees a new component type on re-renders,
 * which would cause all cards to unmount/remount and lose chart state.
 */
const ClientDashboardCard: React.FC<any> = ({ card, ...props }) => {
  const ctx = useContext(DashboardContext);

  const cardData = ctx.cardDataMap[card.dashboard_id] || null;
  const cardLoading = ctx.cardLoadingMap[card.dashboard_id] || false;
  const cardError = ctx.cardErrorMap[card.dashboard_id] || null;

  const frameworkCard: FrameworkDashboardCardType = {
    id: card.dashboard_id,
    title: card.card_name,
    description: card.card_description,
    visualization_type: card.visualization_type,
    grid_x: card.grid_x,
    grid_y: card.grid_y,
    grid_w: card.grid_w,
    grid_h: card.grid_h,
    ...card,
  };

  return (
    <FrameworkDashboardCard
      card={frameworkCard}
      data={cardData}
      loading={cardLoading}
      error={cardError}
      VisualizationComponent={Visualization}
      onVisualizationChange={ctx.onVisualizationChange}
      onGroupingChange={ctx.onGroupingChange}
      onTimeFrameChange={ctx.onTimeFrameChange}
      onAggregationChange={ctx.onAggregationChange}
      onEdit={props.onEdit}
      onDelete={props.onDelete}
      onRefresh={props.onRefresh}
      onExpand={props.onExpand}
    />
  );
};

/**
 * Client-specific DashboardPage wrapper
 *
 * This component wraps the framework DashboardPage and provides:
 * - API communication through dashboardService
 * - Client-specific data fetching and state management
 * - Callbacks for card operations
 *
 * The framework DashboardPage handles all UI rendering and layout management.
 */
export const DashboardPage: React.FC = () => {
  const [cards, setCards] = useState<DashboardCardType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingCard, setEditingCard] = useState<DashboardCardType | null>(null);
  const [expandedCard, setExpandedCard] = useState<DashboardCardType | null>(null);
  const [expandedCardData, setExpandedCardData] = useState<AggregatedData | null>(null);
  const [layout, setLayout] = useState<Layout[]>([]);
  const [cardDataMap, setCardDataMap] = useState<Record<number, AggregatedData | null>>({});
  const [cardLoadingMap, setCardLoadingMap] = useState<Record<number, boolean>>({});
  const [cardErrorMap, setCardErrorMap] = useState<Record<number, string | null>>({});
  const [setMeterElements] = useState<Array<{ id: number; name: string; element?: string }>>([]);
  const [powerColumns, setPowerColumns] = useState<Array<{ name: string; label: string; type?: string }>>([]);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const isInitialLoadRef = React.useRef(true);

  // Keep a ref to cards so handlers can read current state without stale closures
  const cardsRef = useRef<DashboardCardType[]>([]);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  // Fetch data for a specific card
  const fetchCardData = useCallback(async (cardId: number) => {
    try {
      setCardLoadingMap(prev => ({ ...prev, [cardId]: true }));
      setCardErrorMap(prev => ({ ...prev, [cardId]: null }));
      const raw = await dashboardService.getCardData(cardId);
      const data = pivotByMeterElement(raw);
      setCardDataMap(prev => ({ ...prev, [cardId]: data }));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to fetch card data';
      setCardErrorMap(prev => ({ ...prev, [cardId]: errorMsg }));
      console.error(`Error fetching data for card ${cardId}:`, err);
    } finally {
      setCardLoadingMap(prev => ({ ...prev, [cardId]: false }));
    }
  }, []);

  // Fetch all dashboard cards
  const fetchCards = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      console.log('📊 [DashboardPage] Fetching dashboard cards...');
      const response = await dashboardService.getDashboardCards({
        page: 1,
        limit: 100
      });
      console.log('📊 [DashboardPage] Cards received:', response.items.length);
      response.items.forEach(c => {
        console.log(`📊 [DashboardPage] Card ${c.dashboard_id}: grid_x=${c.grid_x}, grid_y=${c.grid_y}, grid_w=${c.grid_w}, grid_h=${c.grid_h}`);
      });

      const GRID_COLS = 12;
      const DEFAULT_W = 6;
      const DEFAULT_H = 9;

      // Normalise dimensions — old records may have pixel values (500×500)
      const normalised = response.items.map((card) => ({
        ...card,
        grid_w: (card.grid_w != null && card.grid_w >= 1 && card.grid_w <= 12) ? card.grid_w : DEFAULT_W,
        grid_h: (card.grid_h != null && card.grid_h >= 1 && card.grid_h <= 30) ? card.grid_h : DEFAULT_H,
        grid_x: (card.grid_x != null && card.grid_x >= 0 && card.grid_x <= 11) ? card.grid_x : 0,
        grid_y: (card.grid_y != null && card.grid_y >= 0 && card.grid_y <= 200) ? card.grid_y : -1,
      }));

      // Detect cards with invalid positions that need re-layout
      const needsLayout = normalised.some(c => c.grid_y === -1);
      // Also detect all cards piled at (0,0) — means positions were never set properly
      const allAtOrigin = normalised.length > 1 && normalised.every(c => c.grid_x === 0 && c.grid_y === 0);

      let cardsWithDefaults: typeof normalised;

      if (needsLayout || allAtOrigin) {
        // Auto-arrange: place cards in a grid pattern (left-to-right, top-to-bottom)
        const placed: { x: number; y: number; w: number; h: number }[] = [];
        cardsWithDefaults = normalised.map((card) => {
          const w = card.grid_w;
          const h = card.grid_h;
          let gridX = 0, gridY = 0, found = false;
          for (let tryY = 0; tryY <= 200 && !found; tryY++) {
            for (let tryX = 0; tryX <= GRID_COLS - w && !found; tryX++) {
              const overlaps = placed.some(p =>
                tryX < p.x + p.w && tryX + w > p.x &&
                tryY < p.y + p.h && tryY + h > p.y
              );
              if (!overlaps) {
                gridX = tryX;
                gridY = tryY;
                found = true;
              }
            }
          }
          placed.push({ x: gridX, y: gridY, w, h });
          // Save corrected position to DB
          dashboardService.updateDashboardCard(card.dashboard_id, {
            grid_x: gridX, grid_y: gridY, grid_w: w, grid_h: h,
          }).catch(() => {});
          return { ...card, grid_x: gridX, grid_y: gridY };
        });
      } else {
        cardsWithDefaults = normalised;
      }

      setCards(cardsWithDefaults);

      const newLayout: Layout[] = cardsWithDefaults.map((card) => ({
        i: card.dashboard_id.toString(),
        x: card.grid_x,
        y: card.grid_y,
        w: card.grid_w,
        h: card.grid_h,
        static: false,
      }));
      setLayout(newLayout);

      cardsWithDefaults.forEach((card) => {
        fetchCardData(card.dashboard_id);
      });

      isInitialLoadRef.current = false;
      console.log('✅ [DashboardPage] Initial load complete, cards are now draggable');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to fetch dashboard cards';
      setError(errorMsg);
      console.error('❌ [DashboardPage] Error fetching dashboard cards:', err);
    } finally {
      setLoading(false);
    }
  }, [fetchCardData]);

  // Load cards on mount
  useEffect(() => {
    console.log('📊 [DashboardPage] Component mounted, loading cards...');
    fetchCards();
  }, [fetchCards]);


  // Fetch power columns for the modal
  const fetchPowerColumns = useCallback(async (deviceId: number) => {
    try {
      const columnsData = await dashboardService.getPowerColumns(deviceId);
      setPowerColumns(columnsData);
    } catch (err) {
      console.error('Error fetching power columns:', err);
    }
  }, []);

  // Fetch meter elements for the selected meter
  const fetchMeterElements = useCallback(async (meterId: number) => {
    try {
      const elementsData = await dashboardService.getMeterElementsByMeter(meterId);
      setMeterElements(elementsData);
      await fetchPowerColumns(meterId);
    } catch (err) {
      console.error('Error fetching meter elements:', err);
      setMeterElements([]);
    }
  }, [fetchPowerColumns]);

  // Handle global refresh
  const handleGlobalRefresh = async (e: React.MouseEvent) => {
    e.preventDefault();
    setRefreshing(true);
    try {
      await fetchCards();
    } finally {
      setRefreshing(false);
    }
  };

  // Handle create dashboard button click
  const handleCreateCard = (e: React.MouseEvent) => {
    e.preventDefault();
    setEditingCard(null);
    setShowModal(true);
  };

  // Handle edit card
  const handleEditCard = (card: DashboardCardType) => {
    setEditingCard(card);
    setShowModal(true);
    if (card.meter_id) {
      fetchMeterElements(card.meter_id);
    }
  };

  // Handle modal close
  const handleModalClose = () => {
    setShowModal(false);
    setEditingCard(null);
    setModalError(null);
  };

  // Handle modal success
  const handleModalSuccess = (card: DashboardCardType) => {
    console.log('✅ handleModalSuccess called, editingCard:', !!editingCard, 'card:', card);
    if (editingCard) {
      // Preserve grid layout when updating card
      setCards(prev => prev.map(c => c.dashboard_id === card.dashboard_id ? { ...c, ...card } : c));
    } else {
      // Ensure card has reasonable default dimensions (grid: 12 cols, h: reasonable rows)
      const cardWithDefaults = {
        ...card,
        grid_w: (card.grid_w != null && card.grid_w >= 1 && card.grid_w <= 12) ? card.grid_w : 6,
        grid_h: (card.grid_h != null && card.grid_h >= 1 && card.grid_h <= 30) ? card.grid_h : 9,
      };

      console.log('📝 Creating new card:', cardWithDefaults.dashboard_id, cardWithDefaults.card_name);
      setCards(prev => {
        const updated = [...prev, cardWithDefaults];
        console.log('📍 After setCards, cards count:', updated.length);
        return updated;
      });

      setLayout(prev => {
        const newLayoutItem = {
          i: cardWithDefaults.dashboard_id.toString(),
          x: cardWithDefaults.grid_x ?? 0,
          y: cardWithDefaults.grid_y ?? 0,
          w: cardWithDefaults.grid_w,
          h: cardWithDefaults.grid_h,
          static: false,
        };
        return [...prev, newLayoutItem];
      });

      console.log('🔄 Fetching data for card:', cardWithDefaults.dashboard_id);
      fetchCardData(cardWithDefaults.dashboard_id);
    }
    console.log('🚪 Closing modal');
    handleModalClose();
  };

  // Handle layout change - update local state only (no DB save)
  const handleLayoutChange = (newLayout: Layout[]) => {
    if (isInitialLoadRef.current) return;
    console.log('📐 [handleLayoutChange] called:', newLayout.map(l => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h })));
    setLayout(newLayout);
  };

  // Save position to DB when drag ends
  const handleDragStop = async (newLayout: Layout[]) => {
    for (const layoutItem of newLayout) {
      const cardId = parseInt(layoutItem.i);
      const updates = { grid_x: layoutItem.x, grid_y: layoutItem.y };
      try {
        await dashboardService.updateDashboardCard(cardId, updates);
        setCards(prev => prev.map(c => c.dashboard_id === cardId ? { ...c, ...updates } : c));
      } catch (error) {
        console.error(`❌ [Layout] Failed to save position for card ${cardId}:`, error);
      }
    }
  };

  // Save size to DB when resize ends
  const handleResizeStop = async (newLayout: Layout[]) => {
    console.log('🔧 [ResizeStop] fired, layout items:', newLayout.length, newLayout.map(l => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h })));
    for (const layoutItem of newLayout) {
      const cardId = parseInt(layoutItem.i);
      const updates = { grid_x: layoutItem.x, grid_y: layoutItem.y, grid_w: layoutItem.w, grid_h: layoutItem.h };
      console.log(`🔧 [ResizeStop] Saving card ${cardId}:`, updates);
      try {
        const result = await dashboardService.updateDashboardCard(cardId, updates);
        console.log(`✅ [ResizeStop] Card ${cardId} saved:`, result);
        setCards(prev => prev.map(c => c.dashboard_id === cardId ? { ...c, ...updates } : c));
      } catch (error) {
        console.error(`❌ [ResizeStop] Failed to save size for card ${cardId}:`, error);
      }
    }
  };

  // Handle delete card
  const handleDeleteCard = async (cardId: number | string) => {
    const numCardId = typeof cardId === 'string' ? parseInt(cardId) : cardId;
    const cardIdStr = numCardId.toString();
    console.log(`🗑️ Deleting card ${cardIdStr}`);
    try {
      await dashboardService.deleteDashboardCard(numCardId);
      console.log(`✅ Card ${cardIdStr} deleted from API`);
      setCards(prev => {
        const filtered = prev.filter(c => String(c.dashboard_id) !== cardIdStr);
        console.log(`Cards after filter:`, filtered.length, 'cards remaining');
        return filtered;
      });
      setLayout(prev => {
        const filtered = prev.filter(item => item.i !== cardIdStr);
        console.log(`Layout after filter:`, filtered.length, 'items remaining');
        return filtered;
      });
      setCardDataMap(prev => {
        const newMap = { ...prev };
        delete newMap[numCardId];
        return newMap;
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to delete card';
      setError(errorMsg);
      console.error('❌ Error deleting card:', err);
    }
  };

  // Handle drill-down
  const handleDrillDown = (cardId: number | string) => {
    console.log('Drill down for card:', cardId);
  };

  // Handle card refresh
  const handleCardRefresh = (cardId: number | string) => {
    const numCardId = typeof cardId === 'string' ? parseInt(cardId) : cardId;
    fetchCardData(numCardId);
  };

  // Handle expand card
  const handleExpandCard = async (card: DashboardCardType) => {
    setExpandedCard(card);
    try {
      const raw = await dashboardService.getCardData(card.dashboard_id);
      setExpandedCardData(pivotByMeterElement(raw));
    } catch (err) {
      console.error('Error fetching expanded card data:', err);
      setExpandedCardData(null);
    }
  };

  // Handle close expanded card
  const handleCloseExpandedCard = () => {
    setExpandedCard(null);
    setExpandedCardData(null);
  };

  // Handle date range change in expanded modal
  const handleExpandedDateRangeChange = async (start: string, end: string) => {
    if (!expandedCard) return;
    try {
      const raw = await dashboardService.getCardData(expandedCard.dashboard_id, { start_date: start, end_date: end });
      setExpandedCardData(pivotByMeterElement(raw));
    } catch (err) {
      console.error('Error fetching expanded card data with date range:', err);
    }
  };

  // Handle error close
  const handleErrorClose = () => {
    setError(null);
  };

  // Handle visualization change - stable via useCallback + cardsRef
  const handleVisualizationChange = useCallback(async (cardId: number | string, newType: string) => {
    const numCardId = typeof cardId === 'string' ? parseInt(cardId) : Number(cardId);
    console.log('[Dashboard] handleVisualizationChange - cardId:', cardId, 'numCardId:', numCardId, 'newType:', newType, 'cardsRef len:', cardsRef.current.length);
    const original = cardsRef.current.find(c => Number(c.dashboard_id) === numCardId);
    console.log('[Dashboard] found original?', !!original);
    if (!original) return;
    setCards(prev => prev.map(c => Number(c.dashboard_id) === numCardId ? { ...c, visualization_type: newType as any } : c));
    try {
      await dashboardService.updateDashboardCard(numCardId, { visualization_type: newType as any });
      console.log('[Dashboard] visualization saved OK');
    } catch (err) {
      console.error('[Dashboard] visualization save failed:', err);
      setCards(prev => prev.map(c => Number(c.dashboard_id) === numCardId ? { ...c, visualization_type: original.visualization_type } : c));
      setError(err instanceof Error ? err.message : 'Failed to update visualization');
    }
  }, []);

  // Handle grouping change - stable via useCallback + cardsRef
  const handleGroupingChange = useCallback(async (cardId: number | string, newGrouping: string) => {
    const numCardId = typeof cardId === 'string' ? parseInt(cardId) : Number(cardId);
    console.log('[Dashboard] handleGroupingChange - cardId:', cardId, 'numCardId:', numCardId, 'newGrouping:', newGrouping, 'cardsRef len:', cardsRef.current.length);
    const original = cardsRef.current.find(c => Number(c.dashboard_id) === numCardId);
    console.log('[Dashboard] found original?', !!original);
    if (!original) return;
    setCards(prev => prev.map(c => Number(c.dashboard_id) === numCardId ? { ...c, grouping_type: newGrouping as any } : c));
    try {
      await dashboardService.updateDashboardCard(numCardId, { grouping_type: newGrouping as any });
      console.log('[Dashboard] grouping saved OK');
      fetchCardData(numCardId);
    } catch (err) {
      console.error('[Dashboard] grouping save failed:', err);
      setCards(prev => prev.map(c => Number(c.dashboard_id) === numCardId ? { ...c, grouping_type: original.grouping_type } : c));
      setError(err instanceof Error ? err.message : 'Failed to update grouping');
    }
  }, [fetchCardData]);

  // Handle time frame change - stable via useCallback + cardsRef
  const handleTimeFrameChange = useCallback(async (cardId: number | string, newTimeFrame: string) => {
    const numCardId = typeof cardId === 'string' ? parseInt(cardId) : Number(cardId);
    console.log('[Dashboard] handleTimeFrameChange - cardId:', cardId, 'numCardId:', numCardId, 'newTimeFrame:', newTimeFrame, 'cardsRef len:', cardsRef.current.length);
    const original = cardsRef.current.find(c => Number(c.dashboard_id) === numCardId);
    console.log('[Dashboard] found original?', !!original);
    if (!original) return;
    setCards(prev => prev.map(c => Number(c.dashboard_id) === numCardId ? { ...c, time_frame_type: newTimeFrame as any } : c));
    try {
      await dashboardService.updateDashboardCard(numCardId, { time_frame_type: newTimeFrame as any });
      console.log('[Dashboard] time frame saved OK');
      fetchCardData(numCardId);
    } catch (err) {
      console.error('[Dashboard] time frame save failed:', err);
      setCards(prev => prev.map(c => Number(c.dashboard_id) === numCardId ? { ...c, time_frame_type: original.time_frame_type } : c));
      setError(err instanceof Error ? err.message : 'Failed to update time frame');
    }
  }, [fetchCardData]);

  // Handle aggregation change - stable via useCallback + cardsRef
  const handleAggregationChange = useCallback(async (cardId: number | string, aggregationType: string) => {
    const numCardId = typeof cardId === 'string' ? parseInt(cardId) : Number(cardId);
    console.log('[Dashboard] handleAggregationChange - cardId:', cardId, 'numCardId:', numCardId, 'aggregationType:', aggregationType);
    const original = cardsRef.current.find(c => Number(c.dashboard_id) === numCardId);
    if (!original) return;
    setCards(prev => prev.map(c => Number(c.dashboard_id) === numCardId ? { ...c, aggregation_type: aggregationType as any } : c));
    try {
      await dashboardService.updateDashboardCard(numCardId, { aggregation_type: aggregationType as any });
      console.log('[Dashboard] aggregation saved OK');
      fetchCardData(numCardId);
    } catch (err) {
      console.error('[Dashboard] aggregation save failed:', err);
      setCards(prev => prev.map(c => Number(c.dashboard_id) === numCardId ? { ...c, aggregation_type: (original as any).aggregation_type } : c));
      setError(err instanceof Error ? err.message : 'Failed to update aggregation');
    }
  }, [fetchCardData]);

  // Handle modal form submission
  const handleDirectSubmit = useCallback(async (data: any) => {
    try {
      setModalLoading(true);
      setModalError(null);
      let result;
      if (editingCard) {
        result = await dashboardService.updateDashboardCard(editingCard.dashboard_id, data);
      } else {
        result = await dashboardService.createDashboardCard(data);
      }
      handleModalSuccess(result as any);
    } catch (err) {
      console.error('Error saving card:', err);
      setModalError(err instanceof Error ? err.message : 'Failed to save dashboard card');
    } finally {
      setModalLoading(false);
    }
  }, [editingCard]);

  // Memoized context value - only changes when card data or stable handlers change
  const dashboardContextValue = useMemo<DashboardContextType>(() => ({
    cardDataMap,
    cardLoadingMap,
    cardErrorMap,
    onVisualizationChange: handleVisualizationChange,
    onGroupingChange: handleGroupingChange,
    onTimeFrameChange: handleTimeFrameChange,
    onAggregationChange: handleAggregationChange,
  }), [cardDataMap, cardLoadingMap, cardErrorMap, handleVisualizationChange, handleGroupingChange, handleTimeFrameChange, handleAggregationChange]);

  return (
    <DashboardContext.Provider value={dashboardContextValue}>
      <div className="dashboard-with-banner">
        <AnomalyInsightsPanel />
        <FrameworkDashboardPage
          cards={cards.map(card => ({
            ...card,
            id: card.dashboard_id
          })) as any}
          loading={loading}
          error={error}
          layout={layout}
          onLayoutChange={handleLayoutChange}
          onDragStop={handleDragStop}
          onResizeStop={handleResizeStop}
          onCreateCard={handleCreateCard}
          onRefresh={handleGlobalRefresh}
          onEditCard={handleEditCard as any}
          onDeleteCard={handleDeleteCard as any}
          onExpandCard={handleExpandCard as any}
          onCardRefresh={handleCardRefresh}
          onDrillDown={handleDrillDown}
          onErrorClose={handleErrorClose}
          refreshing={refreshing}
          CardComponent={ClientDashboardCard}
          ExpandedModalComponent={FrameworkExpandedCardModal}
          expandedCardData={expandedCardData}
          expandedCard={expandedCard as any}
          onCloseExpandedCard={handleCloseExpandedCard}
          onExpandedDateRangeChange={handleExpandedDateRangeChange}
          renderVisualization={(data, columns, height, seriesLabels) => (
            <Visualization
              type={(expandedCard as any)?.visualization_type || 'line'}
              data={data}
              columns={columns}
              height={height}
              seriesLabels={seriesLabels}
            />
          )}
        />
        {/* <DashboardBanner
          cardDataMap={cardDataMap}
          cards={cards}
        /> */}
      </div>
      <FrameworkDashboardCardForm
        isOpen={showModal}
        card={editingCard}

        loading={modalLoading}
        error={modalError}
        onClose={handleModalClose}
        onSubmit={handleDirectSubmit}
      />
    </DashboardContext.Provider>
  );
};
