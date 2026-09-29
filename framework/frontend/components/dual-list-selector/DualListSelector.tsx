import React, { useState, useCallback, useMemo } from 'react';
import './DualListSelector.css';

export interface DualListSelectorProps<T> {
  availableItems: T[];
  selectedItems: T[];
  onItemMove: (item: T, direction: 'left' | 'right') => void;
  onItemsReorder?: (items: T[], side: 'left' | 'right') => void;
  searchQuery: string;
  emptyStateMessage: string;
  renderItem?: (item: T) => React.ReactNode;
  getItemId?: (item: T) => string;
  getItemLabel?: (item: T) => string;
}

/**
 * DualListSelector Component
 * 
 * A reusable dual-list selector component that displays two side-by-side lists
 * (available items on left, selected items on right) with support for:
 * - Search filtering on both lists
 * - Double-click to move items between lists
 * - Drag-and-drop support
 * - Delete key to remove from selected list
 * - Keyboard navigation
 * - Material Design styling
 * 
 * @example
 * ```tsx
 * <DualListSelector
 *   availableItems={meters}
 *   selectedItems={selectedMeters}
 *   onItemMove={handleItemMove}
 *   searchQuery={search}
 *   emptyStateMessage="No meters available"
 *   getItemId={(meter) => meter.id}
 *   getItemLabel={(meter) => `${meter.name} (${meter.identifier})`}
 * />
 * ```
 */
export const DualListSelector = React.forwardRef<
  HTMLDivElement,
  DualListSelectorProps<any>
>(
  (
    {
      availableItems,
      selectedItems,
      onItemMove,
      searchQuery,
      emptyStateMessage,
      renderItem,
      getItemId = (item) => item.id,
      getItemLabel = (item) => item.name,
    },
    ref
  ) => {
    const [draggedItem, setDraggedItem] = useState<any | null>(null);
    const [dragSource, setDragSource] = useState<'left' | 'right' | null>(null);
    const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
    const [focusedSide, setFocusedSide] = useState<'left' | 'right' | null>(null);

    // Filter items based on search query and exclude selected items
    const filteredAvailable = useMemo(() => {
      const selectedIds = new Set(selectedItems.map((item) => getItemId(item)));
      let filtered = availableItems.filter((item) => !selectedIds.has(getItemId(item)));
      
      if (!searchQuery.trim()) return filtered;
      const query = searchQuery.toLowerCase();
      return filtered.filter((item) => {
        const label = getItemLabel(item).toLowerCase();
        return label.includes(query);
      });
    }, [availableItems, selectedItems, searchQuery, getItemId, getItemLabel]);

    const filteredSelected = useMemo(() => {
      if (!searchQuery.trim()) return selectedItems;
      const query = searchQuery.toLowerCase();
      return selectedItems.filter((item) => {
        const label = getItemLabel(item).toLowerCase();
        return label.includes(query);
      });
    }, [selectedItems, searchQuery, getItemLabel]);

    // Handle double-click to move items
    const handleDoubleClick = useCallback(
      (item: any, side: 'left' | 'right') => {
        onItemMove(item, side === 'left' ? 'right' : 'left');
      },
      [onItemMove]
    );

    // Handle drag start
    const handleDragStart = useCallback(
      (e: React.DragEvent<HTMLDivElement>, item: any, side: 'left' | 'right') => {
        setDraggedItem(item);
        setDragSource(side);
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', getItemId(item));
        }
      },
      [getItemId]
    );

    // Handle drag end
    const handleDragEnd = useCallback(() => {
      setDraggedItem(null);
      setDragSource(null);
    }, []);

    // Handle drag over
    const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
    }, []);

    // Handle drop
    const handleDrop = useCallback(
      (e: React.DragEvent<HTMLDivElement>, targetSide: 'left' | 'right') => {
        e.preventDefault();
        if (draggedItem && dragSource && dragSource !== targetSide) {
          onItemMove(draggedItem, dragSource === 'left' ? 'right' : 'left');
        }
        setDraggedItem(null);
        setDragSource(null);
      },
      [draggedItem, dragSource, onItemMove]
    );

    // Handle keyboard events
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>, item: any, side: 'left' | 'right') => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleDoubleClick(item, side);
        } else if (e.key === 'Delete' && side === 'right') {
          e.preventDefault();
          onItemMove(item, 'left');
        } else if (e.key === 'Tab') {
          // Tab navigation is handled by browser
          setFocusedItemId(null);
          setFocusedSide(null);
        }
      },
      [handleDoubleClick, onItemMove]
    );

    // Handle focus
    const handleFocus = useCallback(
      (itemId: string, side: 'left' | 'right') => {
        setFocusedItemId(itemId);
        setFocusedSide(side);
      },
      []
    );

    // Render a single list item
    const renderListItem = (item: any, side: 'left' | 'right') => {
      const itemId = getItemId(item);
      const isDragging = draggedItem && getItemId(draggedItem) === itemId;
      const isFocused = focusedItemId === itemId && focusedSide === side;
      const isSelected = side === 'right';

      return (
        <div
          key={itemId}
          className={`dual-list-selector__item ${isDragging ? 'dual-list-selector__item--dragging' : ''} ${
            isFocused ? 'dual-list-selector__item--focused' : ''
          }`}
          draggable
          onDragStart={(e) => handleDragStart(e, item, side)}
          onDragEnd={handleDragEnd}
          onDoubleClick={() => handleDoubleClick(item, side)}
          onKeyDown={(e) => handleKeyDown(e, item, side)}
          onFocus={() => handleFocus(itemId, side)}
          tabIndex={0}
          role="option"
          aria-selected={isSelected ? 'true' : 'false'}
        >
          {renderItem ? renderItem(item) : getItemLabel(item)}
        </div>
      );
    };

    // Render a list container
    const renderList = (items: any[], side: 'left' | 'right') => {
      const isEmpty = items.length === 0;
      const ariaLabel = side === 'left' ? 'Available items' : 'Selected items';

      return (
        <div
          className="dual-list-selector__list-container"
          onDragOver={handleDragOver}
          onDrop={(e) => handleDrop(e, side)}
          role="listbox"
          aria-label={ariaLabel}
        >
          {isEmpty ? (
            <div className="dual-list-selector__empty-state">
              {emptyStateMessage}
            </div>
          ) : (
            items.map((item) => renderListItem(item, side))
          )}
        </div>
      );
    };

    return (
      <div ref={ref} className="dual-list-selector">
        <div className="dual-list-selector__wrapper">
          {/* Available items list */}
          <div className="dual-list-selector__column">
            <div className="dual-list-selector__header">
              Available Items
            </div>
            {renderList(filteredAvailable, 'left')}
          </div>

          {/* Selected items list */}
          <div className="dual-list-selector__column">
            <div className="dual-list-selector__header">
              Selected Items
            </div>
            {renderList(filteredSelected, 'right')}
          </div>
        </div>
      </div>
    );
  }
);

DualListSelector.displayName = 'DualListSelector';
