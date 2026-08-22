'use client';

// THE MEASURE — a scroll indicator that is the product's own metaphor.
//
// components/mark.tsx is a vessel with a graduation line, and its comment
// sets the rule the whole page follows: the name gets ONE gesture, drawn as
// something you read a level off rather than as decoration. This extends that
// gesture to the page itself. A thin measuring column sits in the left
// margin, graduated at each section boundary, and fills as you read — so
// scrolling the page is filling the flask, and progress is something you
// MEASURE rather than a progress bar you watch.
//
// The engineering is deliberately invisible: section marks are derived from
// the live DOM rather than hardcoded (so the rail cannot drift from the page
// when a section is added), the fill is driven by a rAF-coalesced scroll
// listener that never lays out during a frame, and every read is passive.
// Under prefers-reduced-motion the fill still tracks position — it just does
// not animate between values, because the rail is orientation, not ornament.
import { useEffect, useRef, useState } from 'react';

export function ScrollRail() {
  const [pct, setPct] = useState(0);
  const [marks, setMarks] = useState<number[]>([]);
  const frame = useRef(0);

  useEffect(() => {
    const measure = (): void => {
      const doc = document.documentElement;
      const total = doc.scrollHeight - window.innerHeight;
      setPct(total > 0 ? Math.min(1, Math.max(0, window.scrollY / total)) : 0);
    };
    // Graduations come from the real section boundaries, so the rail cannot
    // fall out of step with the page it is measuring.
    const readMarks = (): void => {
      const h = document.documentElement.scrollHeight;
      if (h <= 0) return;
      setMarks(
        [...document.querySelectorAll('section')]
          .map((s) => (s.getBoundingClientRect().top + window.scrollY) / h)
          .filter((v) => v > 0.02 && v < 0.98),
      );
    };
    const onScroll = (): void => {
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        measure();
      });
    };
    measure();
    readMarks();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', readMarks, { passive: true });
    const settle = setTimeout(readMarks, 800); // after fonts/reveals settle
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', readMarks);
      clearTimeout(settle);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, []);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed left-6 top-1/2 z-30 hidden h-[46vh] -translate-y-1/2 xl:block"
    >
      <div className="relative h-full w-px bg-line">
        {/* graduations */}
        {marks.map((m, i) => (
          <div
            key={i}
            className="absolute -left-[3px] h-px w-[7px] bg-line"
            style={{ top: `${m * 100}%` }}
          />
        ))}
        {/* the level */}
        <div
          className="absolute left-0 top-0 w-px bg-accent transition-[height] duration-150 ease-out motion-reduce:transition-none"
          style={{ height: `${pct * 100}%` }}
        />
        {/* the meniscus — a wider tick at the current level, the thing you read */}
        <div
          className="absolute -left-[4px] h-px w-[9px] bg-accent transition-[top] duration-150 ease-out motion-reduce:transition-none"
          style={{ top: `${pct * 100}%` }}
        />
      </div>
    </div>
  );
}
