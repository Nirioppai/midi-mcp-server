import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseMidiFile } from './read_midi.js';

interface AnalyzeRules {
  velocityFloor?: number;
  velocityCeiling?: number;
  removeDuplicates?: boolean;
  trimBleedMs?: number;
  timingThresholdBeats?: number;
}

interface VelocityEdit {
  id: string;
  velocity: number;
  from: number;
  trackName: string;
  pitch: string;
  beatPosition: number;
}

interface TimingEdit {
  id: string;
  beatPosition: number;
  from: number;
  trackName: string;
  pitch: string;
  deviationBeats: number;
}

interface DurationTrim {
  id: string;
  durationBeats: number;
  from: number;
  trackName: string;
  pitch: string;
  beatPosition: number;
  bleedMs: number;
}

interface DuplicateRemoval {
  id: string;
  trackName: string;
  pitch: string;
  beatPosition: number;
  reason: string;
}

export function registerAnalyzeMidi(server: McpServer): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    'analyze_midi',
    {
      description:
        'Analyze a MIDI file against a set of declarative rules and return only the specific edits needed — never the full note list. Produces an edit payload ready to pass to edit_notes, a removals list for duplicate notes, and a human-readable summary. The model decides which rules to apply and what thresholds to use; the tool does zero musical reasoning.',
      inputSchema: {
        path: z.string().describe('Absolute path to the MIDI file'),
        rules: z
          .object({
            velocityFloor: z
              .number()
              .int()
              .min(0)
              .max(127)
              .optional()
              .describe('Clip any note velocity below this value up to this value'),
            velocityCeiling: z
              .number()
              .int()
              .min(0)
              .max(127)
              .optional()
              .describe('Clip any note velocity above this value down to this value'),
            removeDuplicates: z
              .boolean()
              .optional()
              .describe(
                'Remove genuinely duplicate notes: same pitch, same track, start times within one 32nd note of each other. The first occurrence is kept.'
              ),
            trimBleedMs: z
              .number()
              .min(0)
              .optional()
              .describe(
                'Trim any note that bleeds more than this many milliseconds into the next note of the same pitch on the same track'
              ),
            timingThresholdBeats: z
              .number()
              .min(0)
              .optional()
              .describe(
                'Snap notes whose deviation from the nearest 32nd-note grid position exceeds this many beats. Set conservatively (e.g. 0.125) to avoid touching rubato.'
              ),
          })
          .describe('Rules to evaluate — only include rules you want applied'),
      },
    },
    async ({ path: filePath, rules }: { path: string; rules: AnalyzeRules }) => {
      try {
        const data = parseMidiFile(filePath);
        const spb = 60 / data.bpm;
        const THIRTYSECOND_BEATS = 0.125;

        const velocityEdits: VelocityEdit[] = [];
        const timingEdits: TimingEdit[] = [];
        const durationTrims: DurationTrim[] = [];
        const duplicateRemovals: DuplicateRemoval[] = [];
        const duplicateIds = new Set<string>();

        for (const track of data.tracks) {
          // ── Rule: remove duplicates ────────────────────────────────────────
          if (rules.removeDuplicates) {
            const byPitch = new Map<number, typeof track.notes>();
            for (const note of track.notes) {
              if (!byPitch.has(note.pitch)) byPitch.set(note.pitch, []);
              byPitch.get(note.pitch)!.push(note);
            }
            for (const [, group] of byPitch) {
              for (let i = 1; i < group.length; i++) {
                const prev = group[i - 1];
                const curr = group[i];
                if (Math.abs(curr.beatPosition - prev.beatPosition) < THIRTYSECOND_BEATS) {
                  duplicateIds.add(curr.id);
                  duplicateRemovals.push({
                    id: curr.id,
                    trackName: track.name,
                    pitch: curr.noteName,
                    beatPosition: +curr.beatPosition.toFixed(4),
                    reason: `Duplicate onset with ${prev.id} (${prev.noteName} @ beat ${prev.beatPosition.toFixed(4)})`,
                  });
                }
              }
            }
          }

          for (const note of track.notes) {
            // ── Rule: velocity floor ───────────────────────────────────────
            if (rules.velocityFloor !== undefined && note.velocity < rules.velocityFloor) {
              velocityEdits.push({
                id: note.id,
                velocity: rules.velocityFloor,
                from: note.velocity,
                trackName: track.name,
                pitch: note.noteName,
                beatPosition: +note.beatPosition.toFixed(4),
              });
            }
            // ── Rule: velocity ceiling ─────────────────────────────────────
            else if (
              rules.velocityCeiling !== undefined &&
              note.velocity > rules.velocityCeiling
            ) {
              velocityEdits.push({
                id: note.id,
                velocity: rules.velocityCeiling,
                from: note.velocity,
                trackName: track.name,
                pitch: note.noteName,
                beatPosition: +note.beatPosition.toFixed(4),
              });
            }

            // ── Rule: timing snap ──────────────────────────────────────────
            if (rules.timingThresholdBeats !== undefined) {
              const nearest32nd =
                Math.round(note.beatPosition / THIRTYSECOND_BEATS) * THIRTYSECOND_BEATS;
              const deviation = Math.abs(note.beatPosition - nearest32nd);
              if (deviation > rules.timingThresholdBeats) {
                timingEdits.push({
                  id: note.id,
                  beatPosition: +nearest32nd.toFixed(6),
                  from: +note.beatPosition.toFixed(6),
                  trackName: track.name,
                  pitch: note.noteName,
                  deviationBeats: +deviation.toFixed(6),
                });
              }
            }
          }

          // ── Rule: trim bleed ───────────────────────────────────────────────
          if (rules.trimBleedMs !== undefined) {
            const byPitch = new Map<number, typeof track.notes>();
            for (const note of track.notes) {
              if (!byPitch.has(note.pitch)) byPitch.set(note.pitch, []);
              byPitch.get(note.pitch)!.push(note);
            }
            for (const [, group] of byPitch) {
              for (let i = 0; i < group.length - 1; i++) {
                const curr = group[i];
                const next = group[i + 1];
                if (duplicateIds.has(curr.id) || duplicateIds.has(next.id)) continue;

                const currEndSec = (curr.beatPosition + curr.durationBeats) * spb;
                const nextStartSec = next.beatPosition * spb;
                const bleedSec = currEndSec - nextStartSec;

                if (bleedSec * 1000 > rules.trimBleedMs) {
                  const newDurBeats = (nextStartSec - curr.beatPosition * spb) / spb;
                  durationTrims.push({
                    id: curr.id,
                    durationBeats: +newDurBeats.toFixed(6),
                    from: +curr.durationBeats.toFixed(6),
                    trackName: track.name,
                    pitch: curr.noteName,
                    beatPosition: +curr.beatPosition.toFixed(4),
                    bleedMs: +(bleedSec * 1000).toFixed(2),
                  });
                }
              }
            }
          }
        }

        // ── Build edit payload (compatible with edit_notes) ────────────────
        // Merge velocity + timing + duration edits by note ID
        const editMap = new Map<string, { id: string; velocity?: number; beatPosition?: number; durationBeats?: number }>();
        for (const e of velocityEdits) {
          editMap.set(e.id, { id: e.id, velocity: e.velocity });
        }
        for (const e of timingEdits) {
          const existing = editMap.get(e.id) ?? { id: e.id };
          editMap.set(e.id, { ...existing, beatPosition: e.beatPosition });
        }
        for (const e of durationTrims) {
          const existing = editMap.get(e.id) ?? { id: e.id };
          editMap.set(e.id, { ...existing, durationBeats: e.durationBeats });
        }
        const editPayload = [...editMap.values()];

        const summary = {
          file: filePath,
          bpm: data.bpm,
          totalNotes: data.totalNotes,
          rulesApplied: Object.keys(rules).filter(
            (k) => rules[k as keyof AnalyzeRules] !== undefined
          ),
          velocityEditsCount: velocityEdits.length,
          timingEditsCount: timingEdits.length,
          duplicatesCount: duplicateRemovals.length,
          durationTrimsCount: durationTrims.length,
          totalChanges: editPayload.length + duplicateRemovals.length,
        };

        const result = {
          summary,
          edits: editPayload,
          removals: duplicateRemovals.map((d) => d.id),
          detail: {
            velocityEdits,
            timingEdits,
            duplicateRemovals,
            durationTrims,
          },
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error analyzing MIDI: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
