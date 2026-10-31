import React from 'react';
import type { MetersListProps } from './types';
import { MeterItem } from './MeterItem';
import { MeterElementItem } from './MeterElementItem';
import { favoritesService } from '../../services/favoritesService';
import './MetersList.css';

/**
 * MetersList Component
 * Renders a list of meters with their elements in a tree structure
 * Handles expand/collapse, selection, and favorite toggling
 */
export const MetersList: React.FC<MetersListProps> = ({
  meters,
  favorites,
  meterElements,
  expandedMeters,
  selectedItem,
  onMeterExpand,
  onMeterSelect,
  onMeterElementSelect,
  onFavoriteToggle,
}) => {
  /**
   * Create a click handler for star icon that toggles favorite status
   * Requirements: 2.1, 2.3, 2.5
   * 
   * If element is not favorited: call add_favorite() and update state to filled
   * If element is favorited: call remove_favorite() and update state to outlined
   * Set is_loading to true during operation (handled by caller)
   * Set is_loading to false after operation completes (handled by caller)
   */
  const createStarClickHandler = (meterId: string, elementId: string) => {
    return async () => {
      await onFavoriteToggle(meterId, elementId);
    };
  };

  /**
   * Handle meter expand/collapse
   */
  const handleMeterExpand = (meterId: string) => {
    onMeterExpand(meterId);
  };

  // Use meters as-is without sorting by favorites
  const sortedMeters = meters;

  return (
    <div className="meters-list">
      {sortedMeters.length === 0 ? (
        <div className="empty-state">No meters available</div>
      ) : (
        sortedMeters.map((meter) => {
              const isVirtual = !!meter.is_virtual;
              const isExpanded = expandedMeters.has(meter.id);
              const elements = meterElements[meter.id] || [];

              // Virtual meters are selected when the sidebar navigated to them as elementId='0'
              const isMeterSelected = isVirtual
                ? (selectedItem?.type === 'element' && selectedItem?.meterId === meter.id && selectedItem?.elementId === '0')
                : (selectedItem?.type === 'meter' && selectedItem?.meterId === meter.id);

              // Physical: star filled when ALL elements are favorited
              // Virtual: star filled based on meter's own is_favorited flag
              const isMeterFavorite = isVirtual
                ? !!(meter as any).is_favorited
                : elements.length > 0 && elements.every((el: any) => el.is_favorited);

              const handleMeterStarClick = () => {
                if (isVirtual) {
                  // Toggle the virtual meter favorite using '0' as element sentinel
                  onFavoriteToggle(meter.id, '0');
                } else if (isMeterFavorite) {
                  elements.forEach((el: any) => {
                    onFavoriteToggle(meter.id, String(el.meter_element_id));
                  });
                } else {
                  elements.forEach((el: any) => {
                    if (!el.is_favorited) {
                      onFavoriteToggle(meter.id, String(el.meter_element_id));
                    }
                  });
                }
              };

              return (
                <div key={meter.id} className="meter-group">
                  <MeterItem
                    meter={meter}
                    isFavorite={isMeterFavorite}
                    isExpanded={isExpanded}
                    isSelected={isMeterSelected}
                    isVirtual={isVirtual}
                    onExpand={() => handleMeterExpand(meter.id)}
                    onSelect={() => isVirtual
                      ? onMeterElementSelect(meter.id, '0', meter.name, undefined)
                      : onMeterSelect(meter.id, meter.name)
                    }
                    onFavoriteToggle={handleMeterStarClick}
                  />

                  {/* Meter Elements (shown when expanded — virtual meters have no elements) */}
                  {!isVirtual && isExpanded && (
                    <div className="meter-elements">
                      {elements.length === 0 ? (
                        <div className="no-elements">No elements</div>
                      ) : (
                        elements.map((element) => {
                          
                          const elementId = String(element.meter_element_id);
                          
                          // Use is_favorited from element data if available, otherwise fall back to favorites check
                          const isElementFavorite = element.is_favorited !== undefined 
                            ? element.is_favorited
                            : favoritesService.isFavorite(
                                favorites,
                                parseInt(meter.id),
                                parseInt(elementId)
                              );
                          const isElementSelected =
                            selectedItem?.type === 'element' &&
                            selectedItem?.meterId === meter.id &&
                            selectedItem?.elementId === elementId;

                          return (
                            <MeterElementItem
                              key={elementId}
                              element={element}
                              meterId={meter.id}
                              isFavorite={isElementFavorite}
                              isSelected={isElementSelected}
                              onSelect={() => onMeterElementSelect(meter.id, elementId, element.name, parseInt(element.meter_element_id))}
                              onFavoriteToggle={() => onFavoriteToggle(meter.id, elementId)}
                              id1={meter.id}
                              id2={elementId}
                              is_favorited={isElementFavorite}
                              on_star_click={createStarClickHandler(meter.id, elementId)}
                            />
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })
      )}
    </div>
  );
};
