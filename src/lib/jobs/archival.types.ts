/**
 * Types for the cold archival worker (`archival.worker.ts`). Kept separate
 * from `job.types.ts` (the generic scheduler contract) since these are
 * specific to how the archival run walks tables and reports what it moved.
 */

/** Static description of one hot table the archival worker walks. */
export interface ArchivalTableSpec {
    /** Table name — identical on the hot and archive cluster. */
    table: string;
    /** Column the "prior year" cutoff is evaluated against. */
    timestampColumn: string;
    /** Columns forming the archive table's conflict target (its PK). */
    conflictColumns: string[];
    /** Full column list to SELECT / INSERT, in `<TABLE>_COLUMNS` order. */
    columns: readonly string[];
    /** JSONB columns that need `JSON.stringify` before re-insertion. */
    jsonColumns?: string[];
}

export interface ArchivalTableResult {
    table: string;
    moved: number;
    batches: number;
}

export interface ArchivalRunResult {
    region: string;
    startedAt: string;
    durationMs: number;
    totalMoved: number;
    perTable: ArchivalTableResult[];
    timedOut: boolean;
}
