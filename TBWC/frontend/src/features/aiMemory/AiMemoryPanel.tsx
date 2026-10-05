import React, { useCallback, useEffect, useState } from 'react';
import { AiMemoryPanel as BaseAiMemoryPanel, type AiMemoryFile } from '@meterit/framework-frontend/components/settings';
import { getMemoryFiles } from '../../services/aiMemoryService';

/** Settings > AI Memory. Owns its own data the way DocumentImportPanel does. */
const AiMemoryPanel: React.FC = () => {
  const [files, setFiles] = useState<AiMemoryFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setFiles(await getMemoryFiles());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load memory');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return <BaseAiMemoryPanel files={files} loading={loading} error={error} onRefresh={load} />;
};

export default AiMemoryPanel;
