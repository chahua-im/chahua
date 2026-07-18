import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';
import styles from './ChatVirtualScroll.module.scss';

interface MeasuredRowProps {
  rowKey: string;
  hidden?: boolean;
  onMeasure: (rowKey: string, height: number) => void;
  registerRow?: (rowKey: string, node: HTMLDivElement | null) => void;
  children: ReactNode;
}

export function MeasuredRow({ rowKey, hidden = false, onMeasure, registerRow, children }: MeasuredRowProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Register the row DOM node in useLayoutEffect so it's available to the
  // parent's useLayoutEffect (which may need to scrollToKey on this node).
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    registerRow?.(rowKey, node);
    return () => {
      registerRow?.(rowKey, null);
    };
  }, [rowKey, registerRow]);

  // ResizeObserver for height measurement stays in useEffect (doesn't need
  // to run before paint, and avoids triggering flushSync-in-lifecycle errors).
  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const ro = new ResizeObserver(() => {
      const height = Math.round(node.getBoundingClientRect().height);
      if (height > 0) {
        onMeasure(rowKey, height);
      }
    });

    ro.observe(node);
    return () => {
      ro.disconnect();
    };
  }, [rowKey, onMeasure]);

  return (
    <div ref={ref} className={hidden ? styles.stagingItem : styles.flowItem} aria-hidden={hidden || undefined}>
      {children}
    </div>
  );
}
