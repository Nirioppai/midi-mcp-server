// @tonejs/midi is CJS-only; use createRequire so Node.js ESM can load it at runtime.
import { createRequire } from 'module';
import type { Midi as MidiType } from '@tonejs/midi';

const _require = createRequire(import.meta.url);
export const { Midi } = _require('@tonejs/midi') as { Midi: typeof MidiType };
