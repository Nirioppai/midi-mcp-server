export interface MidiNoteData {
  id: string;           // "t{trackIndex}_n{noteIndex}"
  pitch: number;        // MIDI number 0–127
  noteName: string;     // e.g. "E4"
  beatPosition: number; // beats from start (quarter-note = 1 beat)
  ticks: number;        // raw tick offset (read-only reference; recomputed on write)
  durationBeats: number;
  durationTicks: number; // raw tick duration (read-only reference; recomputed on write)
  velocity: number;     // integer 0–127
  channel: number;
}

export interface MidiTrackData {
  id: number;
  name: string;
  instrument: number;
  notes: MidiNoteData[];
}

export interface MidiFileData {
  bpm: number;
  timeSignature: { numerator: number; denominator: number };
  ppq: number;           // ticks per quarter note
  totalNotes: number;
  durationSeconds: number;
  tracks: MidiTrackData[];
}
