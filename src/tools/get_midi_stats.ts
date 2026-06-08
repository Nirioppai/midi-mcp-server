import { readFileSync } from 'fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Midi } from './midi-loader.js';
import { midiNumberToNoteName } from '../chord-utils.js';

/**
 * Rubato heuristic: compute the average absolute deviation of each note's start time
 * from the nearest 16th-note grid position. If the average exceeds 10ms, flag as true.
 */
function detectRubato(noteTimes: number[], bpm: number): boolean {
  if (noteTimes.length < 2) return false;
  const sixteenthSec = (60 / bpm) / 4;
  const deviations = noteTimes.map((t) => {
    const snapped = Math.round(t / sixteenthSec) * sixteenthSec;
    return Math.abs(t - snapped);
  });
  const avgDeviation = deviations.reduce((a, b) => a + b, 0) / deviations.length;
  return avgDeviation > 0.010; // 10ms threshold
}

export function registerGetMidiStats(server: McpServer): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    'get_midi_stats',
    {
      description:
        'Return a statistical summary of a MIDI file without modifying it. Useful for the model to reason about velocity range, pitch range, note density, rubato, and duration before deciding what to edit.',
      inputSchema: {
        path: z.string().describe('Absolute path to the MIDI file'),
      },
    },
    async ({ path: filePath }: { path: string }) => {
      try {
        const buffer = readFileSync(filePath);
        const midi = new Midi(new Uint8Array(buffer));

        const bpm = midi.header.tempos[0]?.bpm ?? 120;
        const timeSig = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4];
        const secondsPerBeat = 60 / bpm;

        let totalNotes = 0;
        let maxEndTimeSec = 0;

        const tracks = midi.tracks
          .filter((t) => t.notes.length > 0)
          .map((track, trackIdx) => {
            const notes = track.notes;

            const velocities = notes.map((n) => Math.round(n.velocity * 127));
            const pitches = notes.map((n) => n.midi);
            const durationsSeconds = notes.map((n) => n.duration);
            const startTimes = notes.map((n) => n.time);

            const velocityMin = Math.min(...velocities);
            const velocityMax = Math.max(...velocities);
            const velocityAvg = Math.round(velocities.reduce((a, b) => a + b, 0) / velocities.length);

            const shortestNoteSec = Math.min(...durationsSeconds);
            const longestNoteSec = Math.max(...durationsSeconds);

            notes.forEach((n) => {
              const end = n.time + n.duration;
              if (end > maxEndTimeSec) maxEndTimeSec = end;
            });

            totalNotes += notes.length;

            return {
              id: trackIdx,
              name: track.name ?? '',
              instrument: track.instrument.number,
              noteCount: notes.length,
              velocityMin,
              velocityMax,
              velocityAvg,
              pitchMin: midiNumberToNoteName(Math.min(...pitches)),
              pitchMax: midiNumberToNoteName(Math.max(...pitches)),
              shortestNoteSec: Math.round(shortestNoteSec * 1000) / 1000,
              longestNoteSec: Math.round(longestNoteSec * 1000) / 1000,
              avgBeatsBetweenNotes:
                notes.length > 1
                  ? Math.round(
                      ((startTimes[startTimes.length - 1] - startTimes[0]) /
                        secondsPerBeat /
                        (notes.length - 1)) *
                        1000
                    ) / 1000
                  : 0,
              hasRubato: detectRubato(startTimes, bpm),
            };
          });

        const result = {
          bpm,
          timeSignature: { numerator: timeSig[0], denominator: timeSig[1] },
          totalNotes,
          durationSeconds: Math.round(maxEndTimeSec * 1000) / 1000,
          tracks,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error reading MIDI stats: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
