import { readFileSync } from 'fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Midi } from './midi-loader.js';
import { midiNumberToNoteName } from '../chord-utils.js';
import type { MidiFileData } from './midi-types.js';

/**
 * Parse a MIDI file into the canonical MidiFileData structure.
 * No filtering, sorting, or modification — exact representation of file contents.
 */
export function parseMidiFile(filePath: string): MidiFileData {
  const buffer = readFileSync(filePath);
  const midi = new Midi(new Uint8Array(buffer));

  const bpm = midi.header.tempos[0]?.bpm ?? 120;
  const timeSig = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4];
  const ppq = midi.header.ppq;
  const secondsPerBeat = 60 / bpm;

  let totalNotes = 0;
  let maxEndTimeSec = 0;

  // Only include tracks that have notes; preserve original track ordering for stable IDs.
  const tracks = midi.tracks
    .map((track, trackIdx) => {
      const notes = track.notes.map((note, noteIdx) => {
        const endTime = note.time + note.duration;
        if (endTime > maxEndTimeSec) maxEndTimeSec = endTime;

        return {
          id: `t${trackIdx}_n${noteIdx}`,
          pitch: note.midi,
          noteName: midiNumberToNoteName(note.midi),
          beatPosition: note.time / secondsPerBeat,
          ticks: note.ticks,
          durationBeats: note.duration / secondsPerBeat,
          durationTicks: note.durationTicks,
          velocity: Math.round(note.velocity * 127),
          channel: track.channel ?? 0,
        };
      });

      totalNotes += notes.length;

      return {
        id: trackIdx,
        name: track.name ?? '',
        instrument: track.instrument.number,
        notes,
      };
    })
    .filter((t) => t.notes.length > 0);

  return {
    bpm,
    timeSignature: { numerator: timeSig[0], denominator: timeSig[1] },
    ppq,
    totalNotes,
    durationSeconds: maxEndTimeSec,
    tracks,
  };
}

export function registerReadMidi(server: McpServer): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    'read_midi',
    {
      description:
        'Read a MIDI file and return its complete note data. Does zero modification — returns exactly what is in the file. Note IDs use the format t{trackIndex}_n{noteIndex} and are stable within a session.',
      inputSchema: {
        path: z.string().describe('Absolute path to the MIDI file'),
      },
    },
    async ({ path: filePath }: { path: string }) => {
      try {
        const data = parseMidiFile(filePath);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: `Error reading MIDI: ${(error as Error).message}` },
          ],
          isError: true,
        };
      }
    }
  );
}
