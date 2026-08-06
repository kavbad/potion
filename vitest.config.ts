// Root vitest config: intentionally empty (vitest defaults).
// Exists so vitest's upward config search stops at the repo boundary and
// never picks up unrelated vite/vitest configs from ancestor directories.
import { defineConfig } from 'vitest/config';

export default defineConfig({});
