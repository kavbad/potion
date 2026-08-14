// The degrade controller (spec §4): a VISIBLE, recorded state — never a
// silent quality drop. full → reduced-30 (sustained <45fps) → static
// (sustained <20fps); prefers-reduced-motion starts static.
import { THEME } from './theme.js';

export type DegradeMode = 'full' | 'reduced-30' | 'static';

export class DegradeController {
  private mode_: DegradeMode;
  private belowSince: number | null = null;

  constructor(reducedMotion: boolean) {
    this.mode_ = reducedMotion ? 'static' : 'full';
  }

  get mode(): DegradeMode {
    return this.mode_;
  }

  /** Feed a 1-second fps sample; returns true when the mode CHANGED (the
   * caller renders the reduced-motion glyph and logs once). Degrade only
   * ratchets down — recovery flapping would itself be motion noise. */
  sample(fps: number, nowMs: number): boolean {
    if (this.mode_ === 'static') return false;
    const threshold = this.mode_ === 'full' ? THEME.degradeFpsReduced : THEME.degradeFpsStatic;
    if (fps < threshold) {
      if (this.belowSince === null) this.belowSince = nowMs;
      if (nowMs - this.belowSince >= THEME.degradeSustainMs) {
        this.mode_ = this.mode_ === 'full' ? 'reduced-30' : 'static';
        this.belowSince = null;
        return true;
      }
    } else {
      this.belowSince = null;
    }
    return false;
  }
}
