import {Knex} from "knex";

export interface PaginationParams {
    cursor?: string;
    limit: number;
    sortBy: string;
    sortOrder: "asc" | "desc";
}

export interface FilterParams {
    field: string;
    operator: "eq" | "gt" | "lt" | "lte" | "gte" | "in" | "like";
    value: string | string[];
}

export interface PaginationMeta {
    nextCursor: string | null;
    hasMore: boolean;
    count: number;
}

function camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// Every `timestamp` column paginated here (created_at, ...) is `timestamp
// WITHOUT time zone` — Postgres stores it as naive wall-clock digits with no
// offset. node-postgres's default OID-1114 parser turns those naive digits
// into a Date by treating them as being in the *process's local* zone (dev:
// GMT+0300, matching Postgres's own `TimeZone` session setting, Africa/Cairo
// — by design, so this round-trips correctly in this environment). So
// `date.toISOString()` is the wrong cursor format here: it converts to UTC
// first, and Postgres's cast back to `timestamp without time zone` ignores
// any zone marker in the input and takes the digits literally — a
// `.toISOString()` cursor is silently off by the local UTC offset (found
// live: it made every row compare as "greater than", so page two returned
// page one's rows again, verbatim). Using the *local* getters instead
// reproduces the exact naive digits Postgres already has, with no
// conversion in either direction.
function formatNaiveTimestampCursor(date: Date): string {
    const pad = (n: number, len = 2) => String(n).padStart(len, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

// Separates the sort column's value from its `id` tiebreaker inside one
// opaque cursor string. `sortBy` (createdAt, ...) is never unique on its own
// — found live: 14 seeded orders sharing one exact `created_at`, where a
// plain `created_at > cursor` silently dropped every one of them that
// landed after the page boundary but tied with it, since `>` (not `>=`)
// excludes ties outright. `id` (bigserial PK, present on every table this
// helper is used against) is unique and insertion-ordered, so pairing it
// with the sort column turns the comparison into a proper keyset cursor:
// `(sortColumn, id) > (cursorValue, cursorId)`, which can neither skip nor
// repeat a tied row.
const CURSOR_TIEBREAKER_SEP = "||";

function encodeCursor(sortValue: string, id: unknown): string {
    if (id === undefined || id === null) return sortValue;
    return `${sortValue}${CURSOR_TIEBREAKER_SEP}${String(id)}`;
}

function decodeCursor(cursor: string): {sortValue: string; id?: string} {
    const idx = cursor.lastIndexOf(CURSOR_TIEBREAKER_SEP);
    if (idx === -1) return {sortValue: cursor};
    return {sortValue: cursor.slice(0, idx), id: cursor.slice(idx + CURSOR_TIEBREAKER_SEP.length)};
}

export function applyCursorPagination(
    query: Knex.QueryBuilder,
    params: PaginationParams,
): Knex.QueryBuilder {
    if (!params.sortBy) return query;
    const dbColumn = camelToSnake(params.sortBy);
    const op = params.sortOrder === "asc" ? ">" : "<";
    if (params.cursor) {
        const {sortValue, id} = decodeCursor(params.cursor);
        if (id !== undefined) {
            query = query.where(function () {
                this.where(dbColumn, op, sortValue).orWhere(function () {
                    this.where(dbColumn, "=", sortValue).andWhere("id", op, id);
                });
            });
        } else {
            query = query.where(dbColumn, op, sortValue);
        }
    }
    return query
        .orderBy(dbColumn, params.sortOrder)
        .orderBy("id", params.sortOrder)
        .limit(params.limit + 1);
}

export function applyFilters(
    query: Knex.QueryBuilder,
    filters: FilterParams[],
): Knex.QueryBuilder {
    for (const filter of filters) {
        switch (filter.operator) {
            case "eq":
                query.where(filter.field, filter.value);
                break;
            case "gt":
                query.where(filter.field, ">", filter.value);
                break;
            case "lt":
                query.where(filter.field, "<", filter.value);
                break;
            case "lte":
                query.where(filter.field, "<=", filter.value);
                break;
            case "gte":
                query.where(filter.field, ">=", filter.value);
                break;
            case "like":
                query.whereLike(filter.field, `%${filter.value}%`);
                break;
            case "in":
                query.whereIn(
                    filter.field,
                    Array.isArray(filter.value) ? filter.value : [filter.value],
                );
                break;
        }
    }
    return query;
}

export function buildPaginationResult<T>(
    rows: T[],
    limit: number,
    sortBy: string,
): {data: T[]; meta: PaginationMeta} {
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    let nextCursor: string | null = null;

    if (data.length > 0) {
        const lastItem = data[data.length - 1] as Record<string, unknown>;
        // Callers pass either raw DB rows (snake_case columns, before
        // toEntity mapping — every repo.ts caller) or already-mapped
        // entities (camelCase — the in-memory cross-cluster merge in
        // order.service.ts). Try both so `hasMore` never silently produces
        // a null cursor just because the caller hadn't mapped yet.
        const raw = lastItem[sortBy] ?? lastItem[camelToSnake(sortBy)];
        const sortValue = raw instanceof Date ? formatNaiveTimestampCursor(raw) : raw !== undefined && raw !== null ? String(raw) : null;
        // "id" is spelled the same in both raw DB rows and toEntity-mapped
        // entities, so no camelCase/snake_case fallback is needed here.
        nextCursor = hasMore && sortValue !== null ? encodeCursor(sortValue, lastItem["id"]) : null;
    }
    return {
        data,
        meta: {nextCursor, hasMore, count: data.length},
    };
}
