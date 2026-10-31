// Synchronization Manager for Offline Support

import React from 'react';

export interface SyncOperation {
  id: string;
  type: 'create' | 'update' | 'delete';
  entityType: string;
  entityId?: string;
  data?: any;
  timestamp: number;
  retryCount: number;
  maxRetries: number;
  status: 'pending' | 'syncing' | 'completed' | 'failed';
  error?: string;
}

export interface SyncConfig {
  maxRetries: number;
  retryDelay: number;
  batchSize: number;
  syncInterval: number;
  enableAutoSync: boolean;
}

export interface SyncStats {
  pendingOperations: number;
  completedOperations: number;
  failedOperations: number;
  lastSyncTime: number | null;
  isOnline: boolean;
}

// Offline storage for sync operations
class SyncStorage {
  private storageKey = 'sync_operations';

  getOperations(): SyncOperation[] {
    try {
      const stored = localStorage.getItem(this.storageKey);
      return stored ? JSON.parse(stored) : [];
    } catch (error) {
      console.warn('Error reading sync operations:', error);
      return [];
    }
  }

  saveOperations(operations: SyncOperation[]): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(operations));
    } catch (error) {
      console.warn('Error saving sync operations:', error);
    }
  }

  addOperation(operation: SyncOperation): void {
    const operations = this.getOperations();
    operations.push(operation);
    this.saveOperations(operations);
  }

  updateOperation(id: string, updates: Partial<SyncOperation>): void {
    const operations = this.getOperations();
    const index = operations.findIndex(op => op.id === id);
    
    if (index !== -1) {
      operations[index] = { ...operations[index], ...updates };
      this.saveOperations(operations);
    }
  }

  removeOperation(id: string): void {
    const operations = this.getOperations();
    const filtered = operations.filter(op => op.id !== id);
    this.saveOperations(filtered);
  }

  clearCompleted(): void {
    const operations = this.getOperations();
    const pending = operations.filter(op => op.status !== 'completed');
    this.saveOperations(pending);
  }

  clear(): void {
    localStorage.removeItem(this.storageKey);
  }
}

// Main sync manager
export class SyncManager {
  private storage: SyncStorage;
  private config: SyncConfig;
  private syncInterval: any = null;
  private isOnline = navigator.onLine;
  private listeners: Array<(stats: SyncStats) => void> = [];

  constructor(config: Partial<SyncConfig> = {}) {
    this.config = {
      maxRetries: 3,
      retryDelay: 1000,
      batchSize: 10,
      syncInterval: 30000, // 30 seconds
      enableAutoSync: true,
      ...config,
    };

    this.storage = new SyncStorage();

    // Listen for online/offline events
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline.bind(this));
      window.addEventListener('offline', this.handleOffline.bind(this));
    }

    // Start auto sync if enabled
    if (this.config.enableAutoSync) {
      this.startAutoSync();
    }
  }

  // Add operation to sync queue
  addOperation(
    type: SyncOperation['type'],
    entityType: string,
    entityId?: string,
    data?: any
  ): string {
    const operation: SyncOperation = {
      id: this.generateId(),
      type,
      entityType,
      entityId,
      data,
      timestamp: Date.now(),
      retryCount: 0,
      maxRetries: this.config.maxRetries,
      status: 'pending',
    };

    this.storage.addOperation(operation);
    this.notifyListeners();

    // Try to sync immediately if online
    if (this.isOnline) {
      this.syncPendingOperations();
    }

    return operation.id;
  }

  // Sync all pending operations
  async syncPendingOperations(): Promise<void> {
    if (!this.isOnline) {
      return;
    }

    const operations = this.storage.getOperations();
    const pendingOperations = operations.filter(op => op.status === 'pending');

    if (pendingOperations.length === 0) {
      return;
    }


    // Process operations in batches
    const batches = this.chunkArray(pendingOperations, this.config.batchSize);

    for (const batch of batches) {
      await this.processBatch(batch);
    }

    this.notifyListeners();
  }

  // Process a batch of operations
  private async processBatch(operations: SyncOperation[]): Promise<void> {
    const promises = operations.map(operation => this.processOperation(operation));
    await Promise.allSettled(promises);
  }

  // Process a single operation
  private async processOperation(operation: SyncOperation): Promise<void> {
    try {
      // Mark as syncing
      this.storage.updateOperation(operation.id, { status: 'syncing' });

      // Simulate API call based on operation type
      await this.executeOperation(operation);

      // Mark as completed
      this.storage.updateOperation(operation.id, { 
        status: 'completed',
        error: undefined,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Increment retry count
      const newRetryCount = operation.retryCount + 1;
      
      if (newRetryCount >= operation.maxRetries) {
        // Max retries reached, mark as failed
        this.storage.updateOperation(operation.id, {
          status: 'failed',
          error: errorMessage,
          retryCount: newRetryCount,
        });
        
        console.error(`Sync failed permanently for operation ${operation.id}:`, errorMessage);
      } else {
        // Schedule retry
        this.storage.updateOperation(operation.id, {
          status: 'pending',
          error: errorMessage,
          retryCount: newRetryCount,
        });
        
        console.warn(`Sync failed for operation ${operation.id}, will retry (${newRetryCount}/${operation.maxRetries}):`, errorMessage);
        
        // Exponential backoff
        const delay = this.config.retryDelay * Math.pow(2, newRetryCount - 1);
        setTimeout(() => {
          if (this.isOnline) {
            this.processOperation(operation);
          }
        }, delay);
      }
    }
  }

  // Execute the actual operation (to be implemented with real API calls)
  private async executeOperation(_operation: SyncOperation): Promise<void> {
    // Integrate with real API layer for each entity type.
    // This placeholder intentionally performs no mock behavior.
    return;
  }

  // Get sync statistics
  getStats(): SyncStats {
    const operations = this.storage.getOperations();
    
    return {
      pendingOperations: operations.filter(op => op.status === 'pending').length,
      completedOperations: operations.filter(op => op.status === 'completed').length,
      failedOperations: operations.filter(op => op.status === 'failed').length,
      lastSyncTime: this.getLastSyncTime(),
      isOnline: this.isOnline,
    };
  }

  // Get all operations
  getOperations(): SyncOperation[] {
    return this.storage.getOperations();
  }

  // Clear completed operations
  clearCompleted(): void {
    this.storage.clearCompleted();
    this.notifyListeners();
  }

  // Clear all operations
  clearAll(): void {
    this.storage.clear();
    this.notifyListeners();
  }

  // Retry failed operations
  async retryFailed(): Promise<void> {
    const operations = this.storage.getOperations();
    const failedOperations = operations.filter(op => op.status === 'failed');
    
    // Reset failed operations to pending
    failedOperations.forEach(op => {
      this.storage.updateOperation(op.id, {
        status: 'pending',
        retryCount: 0,
        error: undefined,
      });
    });

    // Sync if online
    if (this.isOnline) {
      await this.syncPendingOperations();
    }
  }

  // Start auto sync
  startAutoSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }

    this.syncInterval = setInterval(() => {
      if (this.isOnline) {
        this.syncPendingOperations();
      }
    }, this.config.syncInterval);
  }

  // Stop auto sync
  stopAutoSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  // Add listener for sync stats changes
  addListener(listener: (stats: SyncStats) => void): () => void {
    this.listeners.push(listener);
    
    // Return unsubscribe function
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  // Handle online event
  private handleOnline(): void {
    this.isOnline = true;
    this.syncPendingOperations();
    this.notifyListeners();
  }

  // Handle offline event
  private handleOffline(): void {
    this.isOnline = false;
    this.notifyListeners();
  }

  // Notify all listeners
  private notifyListeners(): void {
    const stats = this.getStats();
    this.listeners.forEach(listener => {
      try {
        listener(stats);
      } catch (error) {
        console.error('Error in sync listener:', error);
      }
    });
  }

  // Get last sync time
  private getLastSyncTime(): number | null {
    const operations = this.storage.getOperations();
    const completedOperations = operations.filter(op => op.status === 'completed');
    
    if (completedOperations.length === 0) {
      return null;
    }

    return Math.max(...completedOperations.map(op => op.timestamp));
  }

  // Utility: chunk array into smaller arrays
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  // Generate unique ID
  private generateId(): string {
    // Deterministic timestamp-based ID without random component
    return `sync_${Date.now()}`;
  }

  // Cleanup
  destroy(): void {
    this.stopAutoSync();
    
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline.bind(this));
      window.removeEventListener('offline', this.handleOffline.bind(this));
    }
    
    this.listeners = [];
  }
}

// Global sync manager instance
export const globalSyncManager = new SyncManager();

// React hook for sync stats
export const useSyncStats = () => {
  const [stats, setStats] = React.useState<SyncStats>(globalSyncManager.getStats());

  React.useEffect(() => {
    const unsubscribe = globalSyncManager.addListener(setStats);
    return unsubscribe;
  }, []);

  return stats;
};

// Sync decorators for store operations
export const withOfflineSupport = <T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options: {
    entityType: string;
    operationType: SyncOperation['type'];
    getEntityId?: (...args: Parameters<T>) => string;
    getData?: (...args: Parameters<T>) => any;
  }
): T => {
  return (async (...args: Parameters<T>) => {
    try {
      // Try to execute online first
      if (navigator.onLine) {
        const result = await fn(...args);
        return result;
      } else {
        throw new Error('Offline');
      }
    } catch (error) {
      // If offline or network error, queue for sync
      const entityId = options.getEntityId ? options.getEntityId(...args) : undefined;
      const data = options.getData ? options.getData(...args) : args[0];
      
      globalSyncManager.addOperation(
        options.operationType,
        options.entityType,
        entityId,
        data
      );
      
      // For offline operations, return a placeholder result
      if (options.operationType === 'create') {
        return {
          id: `temp_${Date.now()}`,
          ...data,
          _isOffline: true,
        };
      }
      
      throw error;
    }
  }) as T;
};