import { writeFileSync, readFileSync } from 'fs';
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
        'Write MIDI note data to disk as a .mid file. Accepts either an inline data object (same schema as read_midi) or a dataPath pointing to a saved JSON file — useful for large files that exceed inline size limits. By default writes to a new file with "_edited" appended; pass overwrite: true to write in place.',
      inputSchema: {
        path: z.string().describe('Absolute path for the output .mid file'),
        data: z
          .any()
          .optional()
          .describe('MIDI data object in the same schema as read_midi output (MidiFileData). Use this or dataPath, not both.'),
        dataPath: z
          .string()
          .optional()
          .describe('Absolute path to a JSON file containing MidiFileData (alternative to inline data, for large files).'),
        overwrite: z
          .boolean()
          .optional()
          .describe('Write to the exact path given instead of creating a new file (default: false)'),
      },
    },
    async ({
      path: filePath,
      data: inlineData,
      dataPath,
      overwrite = false,
    }: {
      path: string;
      data?: MidiFileData;
      dataPath?: string;
      overwrite?: boolean;
    }) => {
      try {
        if (!inlineData && !dataPath) {
          return {
            content: [{ type: 'text' as const, text: 'Error: provide either data or dataPath.' }],
            isError: true,
          };
        }
        const data: MidiFileData = dataPath
          ? (JSON.parse(readFileSync(dataPath, 'utf-8')) as MidiFileData)
          : inlineData!;

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
