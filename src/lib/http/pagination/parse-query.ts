import {PaginationParams, FilterParams} from "./cursor-pagination";

const DEFAULT_SORT_BY = "createdAt";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function parsePaginationQuery(
    query: Record<string, unknown>,
    allowedSortBy: string[] = ["createdAt"],
): PaginationParams {
    const sortBy = allowedSortBy.includes(query.sortBy as string)
        ? (query.sortBy as string)
        : DEFAULT_SORT_BY;

    const parsedLimit = Number(query.limit);
    const limit =
        Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.min(MAX_LIMIT, parsedLimit)
            : DEFAULT_LIMIT;

    return {
        cursor: query.cursor as string | undefined,
        limit,
        sortBy,
        sortOrder: query.sortOrder === "asc" ? "asc" : "desc",
    };
}

export function parseFilters(
    query: Record<string, unknown>,
    allowedFields: string[],
): FilterParams[] {
    const filter = query.filter;
    if (!filter || typeof filter !== "object") return [];

    const allowedOps = new Set(["eq", "gt", "lt", "gte", "lte", "like", "in"]);

    return allowedFields.flatMap((field) => {
        const fieldFilters = (filter as Record<string, unknown>)[field];
        if (!fieldFilters || typeof fieldFilters !== "object") return [];

        return Object.entries(fieldFilters as Record<string, unknown>)
            .filter(([op]) => allowedOps.has(op))
            .map(([operator, value]) => ({
                field,
                operator: operator as FilterParams["operator"],
                value: value as string | string[],
            }));
    });
}
