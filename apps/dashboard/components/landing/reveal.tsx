'use client';

// Scroll reveal: fade + 12px rise, once, on first intersection. The CSS pair
// (.reveal-init/.reveal-in in globals.css) carries the reduced-motion story:
// under prefers-reduced-motion content is simply visible, no animation — so
// this component never needs to ask.
import { useEffect, useRef, useState } from 'react';

export function Reveal({
  children,
  delayMs = 0,
  className = '',
}: {
  children: React.ReactNode;
  delayMs?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // SAFETY NET, learned the hard way: content must never be able to stay
    // invisible because an observer did not fire. Hidden/embedded documents
    // throttle IntersectionObserver, and a page whose sections sit at
    // opacity 0 pending a callback is a blank page there. If the reveal has
    // not fired within 1.2s of mount, show the content plainly.
    const failsafe = setTimeout(() => setShown(true), 1200);
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    io.observe(el);
    return () => {
      clearTimeout(failsafe);
      io.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      className={`${shown ? 'reveal-in' : 'reveal-init'} ${className}`}
      style={delayMs > 0 ? { animationDelay: `${delayMs}ms` } : undefined}
    >
      {children}
    </div>
  );
}
