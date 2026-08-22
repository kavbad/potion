'use client';

// The evidence strip's numbers count up on first view — the one place motion
// carries meaning here, because these figures were accumulated, not declared.
// Skipped entirely under prefers-reduced-motion.
import { useEffect, useRef, useState } from 'react';

export function CountUp({ value, format }: { value: number; format?: 'plain' | 'comma' }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [n, setN] = useState(0);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setN(value);
      return;
    }
    // SAFETY NET — and note what the FIRST version of this got wrong, because
    // it is the subtle half. Guarding on `done` meant the observer firing
    // disarmed the failsafe, and the observer only STARTS the animation: the
    // count itself runs on requestAnimationFrame. Anywhere rAF does not run —
    // a background tab, a throttled embed, a headless capture — the number
    // then sat at 0 forever with nothing left to rescue it. A landing page
    // reading "0 answers graded" is worse than one with no animation at all.
    //
    // So the deadline now settles the value UNCONDITIONALLY. It is idempotent
    // when the animation did run, because the animation lands on exactly
    // `value`.
    const failsafe = setTimeout(() => {
      done.current = true;
      setN(value);
    }, 1500);
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || done.current) return;
      done.current = true;
      io.disconnect();
      const t0 = performance.now();
      const dur = 900;
      const tick = (t: number) => {
        const p = Math.min(1, (t - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        setN(Math.round(value * eased));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    io.observe(el);
    return () => {
      clearTimeout(failsafe);
      io.disconnect();
    };
  }, [value]);

  return <span ref={ref}>{format === 'comma' ? n.toLocaleString('en-US') : String(n)}</span>;
}
