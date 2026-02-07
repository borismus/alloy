import { RefObject, useEffect, useState, useCallback, UIEvent } from 'react';

interface UseAutoScrollOptions {
  endRef: RefObject<HTMLElement | null>;
  dependencies: unknown[];
  threshold?: number;
}

interface UseAutoScrollReturn {
  shouldAutoScroll: boolean;
  setShouldAutoScroll: (value: boolean) => void;
  handleScroll: (e: UIEvent<HTMLDivElement>) => void;
}

export function useAutoScroll(options: UseAutoScrollOptions): UseAutoScrollReturn {
  const { endRef, dependencies, threshold = 50 } = options;
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);

  const handleScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const element = e.currentTarget;
      const isNearBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight < threshold;
      setShouldAutoScroll(isNearBottom);
    },
    [threshold]
  );

  useEffect(() => {
    if (shouldAutoScroll && endRef.current) {
      endRef.current.scrollIntoView({ behavior: 'smooth' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAutoScroll, ...dependencies]);

  return { shouldAutoScroll, setShouldAutoScroll, handleScroll };
}
