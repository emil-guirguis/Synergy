import React, { useState, useRef } from 'react';
import { Alert, Button } from '@mui/material';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import type { FavoritesSectionProps, FavoriteDisplay } from './types';
import { StarIcon } from './StarIcon';
import './FavoritesSection.css';

export const FavoritesSection: React.FC<FavoritesSectionProps> = ({
  favorites,
  selectedItem,
  onItemClick,
  onStarClick,
  onReorder,
}) => {
  const [loadingStars, setLoadingStars] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragItemRef = useRef<number | null>(null);

  const createStarClickHandler = (favoriteId: number, meterId: number, elementId: number) => {
    return async (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();

      const key = `${meterId}:${elementId}`;
      setLoadingStars((prev) => new Set(prev).add(key));
      setErrors((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });

      try {
        await onStarClick(favoriteId, String(meterId), String(elementId));
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to remove from favorites';
        setErrors((prev) => {
          const next = new Map(prev);
          next.set(key, errorMessage);
          return next;
        });
      } finally {
        setLoadingStars((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    };
  };

  const handleRetry = async (favoriteId: number, meterId: number, elementId: number) => {
    const key = `${meterId}:${elementId}`;
    setErrors((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });

    const handler = createStarClickHandler(favoriteId, meterId, elementId);
    await handler({ stopPropagation: () => {} } as React.MouseEvent<HTMLButtonElement>);
  };

  const handleFavoriteItemClick = (meterId: number, elementId: number, favoriteName: string) => {
    onItemClick(String(meterId), String(elementId), favoriteName, 'simple');
  };

  const handleFavoriteItemDoubleClick = (meterId: number, elementId: number, favoriteName: string) => {
    onItemClick(String(meterId), String(elementId), favoriteName, 'baselist');
  };

  // Drag-and-drop handlers
  const handleDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    dragItemRef.current = index;
    setDragIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    const fromIndex = dragItemRef.current;
    if (fromIndex === null || fromIndex === dropIndex) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }

    // Build reordered list
    const reordered = [...favorites];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(dropIndex, 0, moved);

    setDragIndex(null);
    setDragOverIndex(null);
    dragItemRef.current = null;

    if (onReorder) {
      onReorder(reordered);
    }
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
    dragItemRef.current = null;
  };

  if (favorites.length === 0) {
    return null;
  }

  return (
    <div className="favorites-section">
      <div className="favorites-title">Favorites</div>
      <div className="favorites-list">
          {favorites.map((favorite, index) => {
            const key = `${favorite.id1}:${favorite.id2}`;
            const isLoading = loadingStars.has(key);
            const error = errors.get(key);

            return (
              <div
                key={key}
                className={`favorite-item${dragIndex === index ? ' dragging' : ''}${dragOverIndex === index ? ' drag-over' : ''}${selectedItem?.type === 'element' && selectedItem.meterId === String(favorite.id1) && selectedItem.elementId === String(favorite.id2) ? ' selected' : ''}`}
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, index)}
                onDragEnd={handleDragEnd}
              >
                {error && (
                  <Alert
                    severity="error"
                    onClose={() => {
                      setErrors((prev) => {
                        const next = new Map(prev);
                        next.delete(key);
                        return next;
                      });
                    }}
                    action={
                      <Button
                        color="inherit"
                        size="small"
                        onClick={() => handleRetry(favorite.favorite_id, favorite.id1, favorite.id2)}
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

                <div className="favorite-drag-handle">
                  <DragIndicatorIcon />
                </div>

                <div
                  className="favorite-item-content"
                  onClick={() => handleFavoriteItemClick(favorite.id1, favorite.id2, favorite.favorite_name || '')}
                  onDoubleClick={() => handleFavoriteItemDoubleClick(favorite.id1, favorite.id2, favorite.favorite_name || '')}
                >
                  <span className="favorite-item-text">
                    {favorite.favorite_name || `Meter ${favorite.id1} - Element ${favorite.id2}`}
                  </span>
                </div>

                <StarIcon
                  id1={String(favorite.id1)}
                  id2={String(favorite.id2)}
                  is_favorited={true}
                  is_loading={isLoading}
                  on_click={createStarClickHandler(favorite.favorite_id, favorite.id1, favorite.id2)}
                />
              </div>
            );
          })}
        </div>
    </div>
  );
};
