import { useCallback, useRef, useState } from 'react';
import type { PendingBatch } from './types';

const debugStagingBatch = import.meta.env.DEV;

function logStagingBatch(event: string, details?: Record<string, unknown>) {
  if (!debugStagingBatch) return;
  if (details) {
    console.debug(`[ChatVirtualScroll][StagingBatch] ${event}`, details);
    return;
  }

  console.debug(`[ChatVirtualScroll][StagingBatch] ${event}`);
}

export interface StagingBatchResult {
  pendingBatch: PendingBatch | null;
  queueBatch: (batch: PendingBatch) => boolean;
  cancelBatch: () => void;
  handleStagingMeasure: (key: string, height: number) => void;
}

/**
 * Manages the hidden staging batch lifecycle:
 * queue -> measure all keys in hidden area -> call onBatchReady with measurements.
 */
export function useStagingBatch(
  onBatchReady: (batch: PendingBatch, heights: Map<string, number>) => void,
): StagingBatchResult {
  const [pendingBatch, setPendingBatch] = useState<PendingBatch | null>(null);
  const pendingBatchRef = useRef<PendingBatch | null>(null);
  const pendingMeasurementsRef = useRef(new Map<string, number>());

  const queueBatch = useCallback((batch: PendingBatch): boolean => {
    if (!batch.keys.length) {
      logStagingBatch('queue-skipped-empty', {
        reason: batch.reason ?? null,
        direction: batch.direction,
      });
      return false;
    }
    if (pendingBatchRef.current) {
      logStagingBatch('queue-skipped-pending-exists', {
        incoming: {
          reason: batch.reason ?? null,
          direction: batch.direction,
          size: batch.keys.length,
          firstKey: batch.keys[0] ?? null,
          lastKey: batch.keys[batch.keys.length - 1] ?? null,
        },
        existing: {
          reason: pendingBatchRef.current.reason ?? null,
          direction: pendingBatchRef.current.direction,
          size: pendingBatchRef.current.keys.length,
          firstKey: pendingBatchRef.current.keys[0] ?? null,
          lastKey: pendingBatchRef.current.keys[pendingBatchRef.current.keys.length - 1] ?? null,
        },
      });
      return false;
    }

    pendingMeasurementsRef.current = new Map();
    pendingBatchRef.current = batch;
    setPendingBatch(batch);
    logStagingBatch('queue', {
      reason: batch.reason ?? null,
      direction: batch.direction,
      size: batch.keys.length,
      firstKey: batch.keys[0] ?? null,
      lastKey: batch.keys[batch.keys.length - 1] ?? null,
    });
    return true;
  }, []);

  const cancelBatch = useCallback(() => {
    if (pendingBatchRef.current) {
      logStagingBatch('cancel', {
        reason: pendingBatchRef.current.reason ?? null,
        direction: pendingBatchRef.current.direction,
        size: pendingBatchRef.current.keys.length,
        measuredCount: pendingMeasurementsRef.current.size,
      });
    }
    pendingMeasurementsRef.current = new Map();
    pendingBatchRef.current = null;
    setPendingBatch(null);
  }, []);

  const handleStagingMeasure = useCallback(
    (key: string, height: number) => {
      const batch = pendingBatchRef.current;
      if (!batch) {
        logStagingBatch('measure-ignored-no-batch', { key, height });
        return;
      }
      if (!batch.keys.includes(key)) {
        logStagingBatch('measure-ignored-not-in-batch', {
          key,
          height,
          reason: batch.reason ?? null,
          direction: batch.direction,
        });
        return;
      }

      pendingMeasurementsRef.current.set(key, height);
      logStagingBatch('measure', {
        key,
        height,
        reason: batch.reason ?? null,
        direction: batch.direction,
        measuredCount: pendingMeasurementsRef.current.size,
        remainingCount: batch.keys.length - pendingMeasurementsRef.current.size,
      });

      if (batch.keys.every((k) => pendingMeasurementsRef.current.has(k))) {
        const heights = pendingMeasurementsRef.current;
        pendingMeasurementsRef.current = new Map();
        pendingBatchRef.current = null;
        setPendingBatch(null);
        logStagingBatch('complete', {
          reason: batch.reason ?? null,
          direction: batch.direction,
          size: batch.keys.length,
        });
        onBatchReady(batch, heights);
      }
    },
    [onBatchReady],
  );

  return { pendingBatch, queueBatch, cancelBatch, handleStagingMeasure };
}
