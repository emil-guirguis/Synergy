import React, { useState } from 'react';
import { Alert, Button } from '@mui/material';
import type { MeterElementItemProps } from './types';
import { StarIcon } from './StarIcon';
import './MeterElementItem.css';

/**
 * MeterElementItem Component
 * Renders a single meter element with favorite toggle via StarIcon
 * 
 * Requirements: 1.1, 2.6, 5.2
 */
export const MeterElementItem: React.FC<MeterElementItemProps> = ({
  element,
  meterId,
  isFavorite,
  isSelected,
  onSelect,
  onFavoriteToggle,
  id1,
  id2,
  is_favorited,
  on_star_click,
}) => {
  const [isHovering, setIsHovering] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use new props if provided, otherwise fall back to old props for backward compatibility
  const meterIdForStar = id1 || meterId;
  const elementIdForStar = id2 || element.meter_element_id;
  // Use is_favorited from element data if available, otherwise use prop
  const isFavoritedForStar = element.is_favorited !== undefined ? element.is_favorited : (is_favorited !== undefined ? is_favorited : isFavorite);
  
  // Use favorite_name if available, otherwise fall back to element properties
  const formattedElementName = element.favorite_name || 'Unknown Element';

  /**
   * Handle star icon click - toggles favorite status with comprehensive error handling
   * Requirements: 2.1, 2.3, 2.5, 3.1, 3.2, 3.3
   * 
   * If element is not favorited: call add_favorite() and update state to filled
   * If element is favorited: call remove_favorite() and update state to outlined
   * Set is_loading to true during operation
   * Set is_loading to false after operation completes
   * 
   * Error Handling:
   * - Catch errors from add_favorite() and remove_favorite() calls
   * - Display user-friendly error message
   * - Keep star icon in previous state if operation fails
   * - Provide retry option
   * - Log error details for debugging
   */
  const handleStarClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    
    // Clear any previous errors
    setError(null);
    
    
    if (on_star_click) {
      setIsLoading(true);
      
      try {
        // on_star_click is a closure that already has meterId and elementId captured
        // Call it with just the event
        await on_star_click(e);
      } catch (err) {
        // Log error details for debugging
        console.error(
          `[MeterElementItem] Error toggling favorite for element ${elementIdForStar} in meter ${meterIdForStar}:`,
          err
        );
        
        // Display user-friendly error message
        const userFriendlyMessage = isFavoritedForStar
          ? 'Failed to remove from favorites. Please try again.'
          : 'Failed to add to favorites. Please try again.';
        
        setError(userFriendlyMessage);
        // Keep star icon in previous state (no state change needed as we didn't update it)
      } finally {
        setIsLoading(false);
      }
    } else {
      // Fall back to old callback for backward compatibility
      setIsLoading(true);
      
      try {
        onFavoriteToggle();
      } catch (err) {
        console.error(
          `[MeterElementItem] Error toggling favorite for element ${elementIdForStar}:`,
          err
        );
        
        const userFriendlyMessage = isFavoritedForStar
          ? 'Failed to remove from favorites. Please try again.'
          : 'Failed to add to favorites. Please try again.';
        
        setError(userFriendlyMessage);
      } finally {
        setIsLoading(false);
      }
    }
  };

  /**
   * Handle retry - attempts the operation again
   * Requirements: 3.3
   */
  const handleRetry = async () => {
    setError(null);
    await handleStarClick({ stopPropagation: () => {} } as React.MouseEvent<HTMLButtonElement>);
  };

  return (
    <div
      className={`meter-element-item ${isSelected ? 'selected' : ''}`}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      {/* Error Alert with Retry Option */}
      {error && (
        <Alert
          severity="error"
          onClose={() => setError(null)}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={handleRetry}
              disabled={isLoading}
            >
              Retry
            </Button>
          }
          sx={{ mb: 1 }}
        >
          {error}
        </Alert>
      )}

      <div className="meter-element-content" onClick={onSelect}>
        {/* Element Name - formatted as "element-element_name" */}
        <span className="element-name">{formattedElementName}</span>
      </div>

      {/* StarIcon Component */}
      {on_star_click && (
        <StarIcon
          id1={meterIdForStar}
          id2={elementIdForStar}
          is_favorited={isFavoritedForStar}
          is_loading={isLoading}
          on_click={handleStarClick}
        />
      )}

      {/* Fallback: Favorite Toggle Button (visible on hover) - for backward compatibility */}
      {!on_star_click && isHovering && (
        <button
          type="button"
          className={`favorite-button ${isFavorite ? 'favorited' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onFavoriteToggle();
          }}
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        >
          {isFavorite ? '★' : '☆'}
        </button>
      )}
    </div>
  );
};
