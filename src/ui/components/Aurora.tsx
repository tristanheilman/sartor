import { useEffect, useRef } from 'react';

/**
 * The haze behind everything.
 *
 * Four soft, heavily blurred washes of colour that drift on long loops and lean
 * a little towards the cursor. The palette is deliberately desaturated — this
 * sits underneath body text and a strong colour here would either fight the
 * type or force the type to get heavier to compete.
 *
 * Performance matters more than it looks: a full-screen `filter: blur()` is
 * expensive to recompute, so the blur is applied once and only `transform` is
 * animated, which the compositor can handle without repainting. The pointer
 * writes into CSS custom properties on a `requestAnimationFrame`, so a fast
 * mouse cannot queue up more work than the screen can draw.
 *
 * Decorative and inert: `aria-hidden`, no pointer events, and it stops moving
 * entirely when the person has asked for reduced motion.
 */
export function Aurora() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;

    // Decoration must never be able to take the page down. `matchMedia` is
    // missing in jsdom and in older embedded browsers, and this component sits
    // in the shell — an exception here would blank the whole app rather than
    // lose a background.
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (reduced) return;

    let frame = 0;
    let targetX = 0.5;
    let targetY = 0.4;
    let x = 0.5;
    let y = 0.4;

    const draw = () => {
      // Ease towards the pointer rather than tracking it exactly, so the haze
      // trails behind the cursor instead of snapping to it.
      x += (targetX - x) * 0.045;
      y += (targetY - y) * 0.045;
      el.style.setProperty('--px', x.toFixed(4));
      el.style.setProperty('--py', y.toFixed(4));
      frame = requestAnimationFrame(draw);
    };

    const onMove = (e: PointerEvent) => {
      targetX = e.clientX / window.innerWidth;
      targetY = e.clientY / window.innerHeight;
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    frame = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={root} className="aurora" aria-hidden="true">
      <span className="aurora-blob aurora-1" />
      <span className="aurora-blob aurora-2" />
      <span className="aurora-blob aurora-3" />
      <span className="aurora-blob aurora-4" />
      <span className="aurora-veil" />
    </div>
  );
}
