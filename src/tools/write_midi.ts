import { writeFileSync } from 'fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Midi } from './midi-loader.js';
import type { MidiFileData } from './midi-types.js';

/**
 * Serialize a MidiFileData structure back to a .mid file.
 * beatPosition and durationBeats are the canonical source of truth;
 * raw tick fields from read_midi are ignored (recomputed internally by @tonejs/midi).
 */
export function writeMidiFile(data: MidiFileData, outputPath: string): void {
  const secondsPerBeat = 60 / data.bpm;

  const midi = new Midi();
  midi.header.tempos = [{ ticks: 0, bpm: data.bpm }];
  midi.header.timeSignatures = [
    {
      ticks: 0,
      timeSignature: [data.timeSignature.numerator, data.timeSignature.denominator],
    },
  ];
  midi.header.update();

  for (const trackData of data.tracks) {
    const track = midi.addTrack();
    if (trackData.name) track.name = trackData.name;
    track.instrument.number = trackData.instrument;
    track.channel = trackData.id % 16;

    for (const note of trackData.notes) {
      track.addNote({
        midi: note.pitch,
        time: note.beatPosition * secondsPerBeat,
        duration: note.durationBeats * secondsPerBeat,
        velocity: Math.min(1, Math.max(0, note.velocity / 127)),
      });
    }
  }

  writeFileSync(outputPath, Buffer.from(midi.toArray()));
}

function resolveOutputPath(inputPath: string, overwrite: boolean): string {
  if (overwrite) return inputPath;
  // Insert "_edited" before the final extension, or append if no extension.
  return inputPath.replace(/(\.[^./\\]+)$/, '_edited$1') || `${inputPath}_edited`;
}

export function registerWriteMidi(server: McpServer): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    'write_midi',
    {
      description:
        'Write MIDI note data to disk as a .mid file. Accepts the same data structure returned by read_midi or edit_notes. By default writes to a new file with "_edited" appended to avoid overwriting the source; pass overwrite: true to write in place.',
      inputSchema: {
        path: z.string().describe('Absolute path for the output .mid file'),
        data: z
          .any()
          .describe('MIDI data object in the same schema as read_midi output (MidiFileData)'),
        overwrite: z
          .boolean()
          .optional()
          .describe('Write to the exact path given instead of creating a new file (default: false)'),
      },
    },
    async ({
      path: filePath,
      data,
      overwrite = false,
    }: {
      path: string;
      data: MidiFileData;
      overwrite?: boolean;
    }) => {
      try {
        const outputPath = resolveOutputPath(filePath, overwrite);
        writeMidiFile(data, outputPath);

        const totalNotes = data.tracks.reduce((sum, t) => sum + t.notes.length, 0);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  path: outputPath,
                  totalNotes,
                  durationSeconds: data.durationSeconds,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: `Error writing MIDI: ${(error as Error).message}` },
          ],
          isError: true,
        };
      }
    }
  );
}
