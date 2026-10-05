/** Settings > AI Memory client (see MeterItPro/api/worker/routes/aiMemory.ts). Read-only. */
import apiClient from './apiClient';
import type { AiMemoryFile } from '@meterit/framework-frontend/components/settings';

export async function getMemoryFiles(): Promise<AiMemoryFile[]> {
  const { data } = await apiClient.get('/ai/memory');
  return data.data.files;
}
