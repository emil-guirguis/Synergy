import axios from 'axios';
import type { AxiosResponse } from 'axios';
import type { Favorite } from '../components/sidebar-meters/types';
import apiClient from './apiClient';

class FavoritesService {
  private apiClient = apiClient;

  /**
   * Get all meters with their elements and favorite status for the sidebar
   * @param tenantId - The tenant ID
   * @param userId - The user ID
   * @returns Promise<any[]> - Array of meters with nested elements
   */
  async getMetersWithElements(tenantId: number, userId: number): Promise<any[]> {
    try {
      const response: AxiosResponse<{ success: boolean; data: any[] }> = await this.apiClient.get(
        `/favorites/meters`,
        { params: { tenant_id: tenantId, users_id: userId } }
      );
      return response.data.data || [];
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Failed to fetch meters';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  /**
   * Get all favorites for a specific user and tenant
   * @param tenantId - The tenant ID
   * @param userId - The user ID
   * @param tableName - Optional table name filter
   * @returns Promise<Favorite[]> - Array of favorites
   */
  async getFavorites(tenantId: number, userId: number, tableName?: string): Promise<Favorite[]> {
    try {
      const params: any = { tenant_id: tenantId, users_id: userId };
      if (tableName) {
        params.table_name = tableName;
      }
      
      const response: AxiosResponse<{ success: boolean; data: Favorite[] }> = await this.apiClient.get(
        `/favorites`,
        { params }
      );
      return response.data.data || [];
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Failed to fetch favorites';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  /**
   * Add a favorite for an entity
   * @param tenantId - The tenant ID
   * @param userId - The user ID
   * @param tableName - The table name (e.g., 'meter', 'meter_element')
   * @param meterId - The meter ID (id1)
   * @param meterElementId - Optional meter element ID (id2, defaults to 0)
   * @returns Promise<Favorite> - The created favorite record
   */
  async addFavorite(
    tenantId: number | string,
    userId: number | string,
    tableName: string,
    meterId: number | string,
    meterElementId?: number | string
  ): Promise<Favorite> {
    try {
      const payload = {
        tenant_id: typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId,
        users_id: typeof userId === 'string' ? parseInt(userId, 10) : userId,
        table_name: tableName,
        id1: typeof meterId === 'string' ? parseInt(meterId, 10) : meterId,
        id2: meterElementId ? (typeof meterElementId === 'string' ? parseInt(meterElementId, 10) : meterElementId) : 0,
      };


      const response: AxiosResponse<{ success: boolean; data: Favorite }> = await this.apiClient.post(
        `/favorites`,
        payload
      );
      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Failed to add favorite';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  /**
   * Remove a favorite by ID
   * @param favoriteId - The favorite ID
   * @param tenantId - The tenant ID
   * @returns Promise<void>
   */
  async removeFavoriteById(favoriteId: number, tenantId: number): Promise<void> {
    try {
      await this.apiClient.delete(
        `/favorites/${favoriteId}`,
        {
          params: {
            tenant_id: tenantId,
          },
        }
      );
    } catch (error) {
      if (axios.isAxiosError(error)) {
        // Handle 404 gracefully - if favorite is not found, it's already deleted
        // so we treat it as a success
        if (error.response?.status === 404) {
          return;
        }
        const message = error.response?.data?.message || 'Failed to remove favorite';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  /**
   * Remove a favorite for an entity
   * @param tenantId - The tenant ID
   * @param userId - The user ID
   * @param tableName - The table name (e.g., 'meter', 'meter_element')
   * @param meterId - The meter ID (id1)
   * @param meterElementId - Optional meter element ID (id2, defaults to 0)
   * @returns Promise<void>
   */
  async removeFavorite(
    tenantId: number,
    userId: number,
    tableName: string,
    meterId: number,
    meterElementId?: number
  ): Promise<void> {
    try {
      await this.apiClient.delete(
        `/favorites`,
        {
          params: {
            tenant_id: typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId,
            users_id: typeof userId === 'string' ? parseInt(userId, 10) : userId,
            table_name: tableName,
            id1: typeof meterId === 'string' ? parseInt(meterId, 10) : meterId,
            id2: meterElementId ? (typeof meterElementId === 'string' ? parseInt(meterElementId, 10) : meterElementId) : 0,
          },
        }
      );
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Failed to remove favorite';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  /**
   * Update the order of favorites
   * @param tenantId - The tenant ID
   * @param userId - The user ID
   * @param orderedIds - Array of { favorite_id, order_by } pairs
   */
  async updateFavoriteOrder(
    tenantId: number,
    userId: number,
    orderedIds: { favorite_id: number; order_by: number }[]
  ): Promise<void> {
    try {
      await this.apiClient.put(`/favorites/order`, {
        tenant_id: tenantId,
        users_id: userId,
        order: orderedIds,
      });
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Failed to update favorite order';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  /**
   * Check if an entity is favorited
   * @param favorites - Array of favorite records
   * @param meterId - The meter ID (id1)
   * @param meterElementId - Optional meter element ID (id2)
   * @returns boolean - True if the item is favorited
   */
  isFavorite(favorites: Favorite[], meterId: number | string, meterElementId?: number | string): boolean {
    const meterIdNum = typeof meterId === 'string' ? parseInt(meterId, 10) : meterId;
    const meterElementIdNum = meterElementId ? (typeof meterElementId === 'string' ? parseInt(meterElementId, 10) : meterElementId) : 0;
    
    return favorites.some(
      (fav) =>
        fav.id1 === meterIdNum &&
        (meterElementId === undefined ? fav.id2 === 0 : fav.id2 === meterElementIdNum)
    );
  }
}

// Export singleton instance
export const favoritesService = new FavoritesService();
export default favoritesService;
