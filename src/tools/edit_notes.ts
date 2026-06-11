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
  edits: NoteEdit[],
  removals: string[] = []
): { edited: number; removed: number; skipped: number; skippedDetails: SkippedNote[]; preview: MidiNoteData[]; data: MidiFileData } {
  const removalSet = new Set(removals);

  // Build a flat note index: id → {trackIdx, noteIdx}
  const noteIndex = new Map<string, { trackIdx: number; noteIdx: number }>();
  data.tracks.forEach((track, ti) => {
    track.notes.forEach((note, ni) => {
      noteIndex.set(note.id, { trackIdx: ti, noteIdx: ni });
    });
  });

  // Deep-clone so original is untouched, then filter removals
  const result: MidiFileData = JSON.parse(JSON.stringify(data));
  result.tracks = result.tracks.map((track) => ({
    ...track,
    notes: track.notes.filter((n) => !removalSet.has(n.id)),
  }));
  result.totalNotes = result.tracks.reduce((s, t) => s + t.notes.length, 0);

  let edited = 0;
  const skippedDetails: SkippedNote[] = [];
  const preview: MidiNoteData[] = [];

  for (const edit of edits) {
    if (removalSet.has(edit.id)) {
      skippedDetails.push({ id: edit.id, reason: 'Note was in removals list — skipped edit' });
      continue;
    }
    const loc = noteIndex.get(edit.id);
    if (!loc) {
      skippedDetails.push({ id: edit.id, reason: 'Note ID not found' });
      continue;
    }

    // Find the note in the (already-filtered) result tracks
    const note = result.tracks[loc.trackIdx]?.notes.find((n) => n.id === edit.id);
    if (!note) {
      skippedDetails.push({ id: edit.id, reason: 'Note not found after removal filter' });
      continue;
    }

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
    removed: removalSet.size,
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
        removals: z
          .array(z.string())
          .optional()
          .describe(
            'List of note IDs to remove entirely (e.g. duplicates from analyze_midi). Removals are applied before edits.'
          ),
      },
    },
    async ({ path: filePath, edits, removals = [] }: { path: string; edits: NoteEdit[]; removals?: string[] }) => {
      try {
        const source = parseMidiFile(filePath);
        const result = applyEdits(source, edits, removals);
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
