import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { midiNumberToNoteName } from '../chord-utils.js';
import { parseMidiFile } from './read_midi.js';
import type { MidiFileData, MidiNoteData } from './midi-types.js';

interface NoteEdit {
  id: string;
  pitch?: number;
  beatPosition?: number;
  durationBeats?: number;
  velocity?: number;
  channel?: number;
}

interface SkippedNote {
  id: string;
  reason: string;
}

export function applyEdits(
  data: MidiFileData,
  edits: NoteEdit[]
): { edited: number; skipped: number; skippedDetails: SkippedNote[]; preview: MidiNoteData[]; data: MidiFileData } {
  // Build a flat note index: id → {trackIdx, noteIdx}
  const noteIndex = new Map<string, { trackIdx: number; noteIdx: number }>();
  data.tracks.forEach((track, ti) => {
    track.notes.forEach((note, ni) => {
      noteIndex.set(note.id, { trackIdx: ti, noteIdx: ni });
    });
  });

  // Deep-clone so original is untouched
  const result: MidiFileData = JSON.parse(JSON.stringify(data));

  let edited = 0;
  const skippedDetails: SkippedNote[] = [];
  const preview: MidiNoteData[] = [];

  for (const edit of edits) {
    const loc = noteIndex.get(edit.id);
    if (!loc) {
      skippedDetails.push({ id: edit.id, reason: 'Note ID not found' });
      continue;
    }

    const note = result.tracks[loc.trackIdx].notes[loc.noteIdx];

    // Apply only explicitly provided fields — never infer or default anything.
    if (edit.pitch !== undefined) {
      note.pitch = edit.pitch;
      note.noteName = midiNumberToNoteName(edit.pitch);
    }
    if (edit.beatPosition !== undefined) note.beatPosition = edit.beatPosition;
    if (edit.durationBeats !== undefined) note.durationBeats = edit.durationBeats;
    if (edit.velocity !== undefined) note.velocity = edit.velocity;
    if (edit.channel !== undefined) note.channel = edit.channel;

    edited++;
    preview.push({ ...note });
  }

  return {
    edited,
    skipped: skippedDetails.length,
    skippedDetails,
    preview,
    data: result,
  };
}

export function registerEditNotes(server: McpServer): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    'edit_notes',
    {
      description:
        'Edit one or more notes in a MIDI file by their ID. Only fields explicitly provided in each edit object are changed — all other fields are left untouched. Does NOT write to disk; returns the patched data for review before saving.',
      inputSchema: {
        path: z.string().describe('Absolute path to the source MIDI file'),
        edits: z
          .array(
            z.object({
              id: z
                .string()
                .describe('Note ID in the format t{trackIndex}_n{noteIndex} (from read_midi)'),
              pitch: z
                .number()
                .int()
                .min(0)
                .max(127)
                .optional()
                .describe('New MIDI pitch number (0–127)'),
              beatPosition: z
                .number()
                .optional()
                .describe('New start position in beats from the beginning'),
              durationBeats: z.number().optional().describe('New duration in beats'),
              velocity: z
                .number()
                .int()
                .min(0)
                .max(127)
                .optional()
                .describe('New velocity (0–127)'),
              channel: z
                .number()
                .int()
                .min(0)
                .max(15)
                .optional()
                .describe('New MIDI channel (0–15)'),
            })
          )
          .describe('List of note edits to apply'),
      },
    },
    async ({ path: filePath, edits }: { path: string; edits: NoteEdit[] }) => {
      try {
        const source = parseMidiFile(filePath);
        const result = applyEdits(source, edits);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: `Error editing notes: ${(error as Error).message}` },
          ],
          isError: true,
        };
      }
    }
  );
}
