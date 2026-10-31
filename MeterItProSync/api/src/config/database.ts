/**
 * Database Configuration for Sync Backend API
 *
 * Sync database: local SQLite file (shared with MeterItProSync/mcp via SQLITE_SYNC_PATH).
 * Remote database: PostgreSQL (client database) — unchanged.
 */

import { Pool } from 'pg';
import {
  SqlitePool,
  ensureSyncSchema,
  resolveSyncDbPath,
} from '@meterit/framework-backend/shared/helpers/sqlite-pool';
// Note: dotenv is loaded by server.ts before this module is imported
export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

// Database pools
export let syncPool: SqlitePool;
export let remotePool: Pool;

/**
 * Initialize the sync SQLite database and the remote Postgres pool
 */
export async function initializePools(): Promise<void> {
  // Initialize sync database (SQLite)
  const syncDbPath = resolveSyncDbPath();


  syncPool = new SqlitePool(syncDbPath);
  ensureSyncSchema(syncPool);

  // Initialize remote database pool
  const remoteConfig: DatabaseConfig = {
    host: process.env.POSTGRES_CLIENT_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_CLIENT_PORT || '5432', 10),
    database: process.env.POSTGRES_CLIENT_DB || 'postgres',
    user: process.env.POSTGRES_CLIENT_USER || 'postgres',
    password: process.env.POSTGRES_CLIENT_PASSWORD || '',
  };


  remotePool = new Pool({
    host: remoteConfig.host,
    port: remoteConfig.port,
    database: remoteConfig.database,
    user: remoteConfig.user,
    password: remoteConfig.password,
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  });

  remotePool.on('error', (err) => {
    console.error('❌ [Database] Unexpected error on remote pool:', err);
  });

  // Test connections
  try {
    const syncResult = await syncPool.query('SELECT NOW()');
  } catch (err) {
    console.error('❌ [Database] Failed to connect to sync database:', err);
  }

  try {
    const remoteResult = await remotePool.query('SELECT NOW()');
  } catch (err) {
    console.warn('⚠️  [Database] Failed to connect to remote database:', err);
    // Don't throw - remote connection is optional for some operations
  }
}

/**
 * Close both database pools
 */
export async function closePools(): Promise<void> {
  if (syncPool) {
    await syncPool.end();
  }
  if (remotePool) {
    await remotePool.end();
  }
}

/**
 * Health check for sync database
 */
export async function healthCheckSync(): Promise<{ status: string; timestamp?: string; error?: string }> {
  try {
    const result = await syncPool.query('SELECT NOW()');
    return { status: 'healthy', timestamp: result.rows[0].now };
  } catch (err) {
    return { status: 'unhealthy', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Health check for remote database
 */
export async function healthCheckRemote(): Promise<{ status: string; timestamp?: string; error?: string }> {
  try {
    const result = await remotePool.query('SELECT NOW()');
    return { status: 'healthy', timestamp: result.rows[0].now };
  } catch (err) {
    return { status: 'unhealthy', error: err instanceof Error ? err.message : String(err) };
  }
}
