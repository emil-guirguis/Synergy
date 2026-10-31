import { useEffect, useRef } from 'react';
import { Box } from '@mui/material';

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
const IS_DEV = import.meta.env.DEV;


interface TurnstileProps {
  onVerify: (token: string) => void;
  onExpire?: () => void;
}

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: object) => string;
      reset: (id: string) => void;
      remove: (id: string) => void;
    };
  }
}

export function Turnstile({ onVerify, onExpire }: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const rendered = useRef(false);

  useEffect(() => {
    if (IS_DEV) {
      onVerify('dev-bypass');
      return;
    }

    if (!SITE_KEY) {
      console.error('[Turnstile] VITE_TURNSTILE_SITE_KEY is not set');
      return;
    }

    const renderWidget = () => {
      if (rendered.current || !containerRef.current || !window.turnstile) return;
      rendered.current = true;
      widgetId.current = window.turnstile.render(containerRef.current, {
        sitekey: SITE_KEY,
        callback: onVerify,
        'expired-callback': () => onExpire?.(),
        'error-callback': (code: string) => {
          console.error('[Turnstile] error', code, 'sitekey:', SITE_KEY);
          onExpire?.();
        },
      });
    };

    if (window.turnstile) {
      renderWidget();
      return;
    }

    // Script is loading from index.html — poll until ready
    const interval = setInterval(() => {
      if (window.turnstile) {
        clearInterval(interval);
        renderWidget();
      }
    }, 50);

    return () => {
      clearInterval(interval);
      if (widgetId.current && window.turnstile) {
        window.turnstile.remove(widgetId.current);
        widgetId.current = null;
        rendered.current = false;
      }
    };
  }, [onVerify, onExpire]);

  if (IS_DEV) return null;

  return <Box ref={containerRef} sx={{ mt: 2, display: 'flex', justifyContent: 'center' }} />;
}
