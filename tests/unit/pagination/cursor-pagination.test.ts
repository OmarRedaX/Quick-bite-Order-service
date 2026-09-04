import knexFactory, {Knex} from "knex";
import {
    applyCursorPagination,
    applyFilters,
    buildPaginationResult,
    PaginationParams,
    FilterParams,
} from "../../../src/lib/http/pagination/cursor-pagination";

// A real knex instance with no connection config — this only ever builds SQL
// (`.toSQL()`), it never dials a database. Using the real query builder here
// (instead of a hand-rolled chainable-methods stub) means the assertions
// exercise knex's actual grouped-where/orderBy/limit behavior, not a mock's
// guess at it.
const knex = knexFactory({client: "pg"});

function qb(): Knex.QueryBuilder {
    return knex("orders").select("*");
}

describe("applyCursorPagination", () => {
    it("no-ops when sortBy is empty", () => {
        const query = qb();
        const result = applyCursorPagination(query, {
            limit: 20,
            sortBy: "",
            sortOrder: "desc",
        });
        expect(result).toBe(query);
        expect(result.toSQL().sql).toBe('select * from "orders"');
    });

    it("converts camelCase sortBy to a snake_case column", () => {
        const {sql} = applyCursorPagination(qb(), {
            limit: 20,
            sortBy: "createdAt",
            sortOrder: "desc",
        }).toSQL();
        expect(sql).toContain('"created_at"');
    });

    it("orders desc and requests limit+1 rows when there is no cursor", () => {
        const {sql, bindings} = applyCursorPagination(qb(), {
            limit: 20,
            sortBy: "createdAt",
            sortOrder: "desc",
        }).toSQL();
        expect(sql).toBe(
            'select * from "orders" order by "created_at" desc, "id" desc limit ?',
        );
        expect(bindings).toEqual([21]);
    });

    it("orders asc with '>' comparison when sortOrder is asc", () => {
        const params: PaginationParams = {
            cursor: "2026-01-01 00:00:00.000",
            limit: 10,
            sortBy: "createdAt",
            sortOrder: "asc",
        };
        const {sql, bindings} = applyCursorPagination(qb(), params).toSQL();
        expect(sql).toBe(
            'select * from "orders" where "created_at" > ? order by "created_at" asc, "id" asc limit ?',
        );
        expect(bindings).toEqual(["2026-01-01 00:00:00.000", 11]);
    });

    it("applies a plain comparison when the cursor has no id tiebreaker", () => {
        const params: PaginationParams = {
            cursor: "2026-01-01 00:00:00.000",
            limit: 10,
            sortBy: "createdAt",
            sortOrder: "desc",
        };
        const {sql, bindings} = applyCursorPagination(qb(), params).toSQL();
        expect(sql).toBe(
            'select * from "orders" where "created_at" < ? order by "created_at" desc, "id" desc limit ?',
        );
        expect(bindings).toEqual(["2026-01-01 00:00:00.000", 11]);
    });

    it("builds a keyset (sortColumn, id) comparison when the cursor carries a tiebreaker id", () => {
        const params: PaginationParams = {
            cursor: "2026-01-01 00:00:00.000||42",
            limit: 10,
            sortBy: "createdAt",
            sortOrder: "desc",
        };
        const {sql, bindings} = applyCursorPagination(qb(), params).toSQL();
        expect(sql).toBe(
            'select * from "orders" where ("created_at" < ? or ("created_at" = ? and "id" < ?)) order by "created_at" desc, "id" desc limit ?',
        );
        expect(bindings).toEqual([
            "2026-01-01 00:00:00.000",
            "2026-01-01 00:00:00.000",
            "42",
            11,
        ]);
    });

    it("splits the cursor on the last separator so a value containing '||' is not mis-parsed", () => {
        const params: PaginationParams = {
            cursor: "a||b||7",
            limit: 5,
            sortBy: "createdAt",
            sortOrder: "asc",
        };
        const {bindings} = applyCursorPagination(qb(), params).toSQL();
        expect(bindings).toEqual(["a||b", "a||b", "7", 6]);
    });
});

describe("applyFilters", () => {
    function filtersSql(filters: FilterParams[]) {
        return applyFilters(qb(), filters).toSQL();
    }

    it("applies an eq filter", () => {
        const {sql, bindings} = filtersSql([
            {field: "status", operator: "eq", value: "placed"},
        ]);
        expect(sql).toBe('select * from "orders" where "status" = ?');
        expect(bindings).toEqual(["placed"]);
    });

    it.each([
        ["gt", ">"],
        ["lt", "<"],
        ["lte", "<="],
        ["gte", ">="],
    ] as const)("applies a %s filter as SQL '%s'", (operator, sqlOp) => {
        const {sql, bindings} = filtersSql([
            {field: "total", operator, value: "100"},
        ]);
        expect(sql).toBe(`select * from "orders" where "total" ${sqlOp} ?`);
        expect(bindings).toEqual(["100"]);
    });

    it("wraps a like filter's value in wildcards", () => {
        const {sql, bindings} = filtersSql([
            {field: "name", operator: "like", value: "pizza"},
        ]);
        expect(sql).toContain("like");
        expect(bindings).toEqual(["%pizza%"]);
    });

    it("wraps a scalar value into a single-element array for 'in'", () => {
        const {sql, bindings} = filtersSql([
            {field: "status", operator: "in", value: "placed"},
        ]);
        expect(sql).toBe('select * from "orders" where "status" in (?)');
        expect(bindings).toEqual(["placed"]);
    });

    it("passes an array value through as-is for 'in'", () => {
        const {bindings} = filtersSql([
            {field: "status", operator: "in", value: ["placed", "accepted"]},
        ]);
        expect(bindings).toEqual(["placed", "accepted"]);
    });

    it("combines multiple filters with AND", () => {
        const {sql} = filtersSql([
            {field: "status", operator: "eq", value: "placed"},
            {field: "total", operator: "gte", value: "100"},
        ]);
        expect(sql).toBe(
            'select * from "orders" where "status" = ? and "total" >= ?',
        );
    });

    it("ignores an unrecognized operator", () => {
        const {sql, bindings} = filtersSql([
            {field: "status", operator: "bogus" as FilterParams["operator"], value: "x"},
        ]);
        expect(sql).toBe('select * from "orders"');
        expect(bindings).toEqual([]);
    });

    it("returns the query untouched for an empty filter list", () => {
        const {sql} = filtersSql([]);
        expect(sql).toBe('select * from "orders"');
    });
});

describe("buildPaginationResult", () => {
    it("reports hasMore=false and returns every row when under the limit", () => {
        const rows = [{id: 1}, {id: 2}];
        const result = buildPaginationResult(rows, 20, "id");
        expect(result.meta.hasMore).toBe(false);
        expect(result.data).toEqual(rows);
        expect(result.meta.count).toBe(2);
    });

    it("trims the lookahead row and reports hasMore=true when over the limit", () => {
        const rows = [{id: 1}, {id: 2}, {id: 3}];
        const result = buildPaginationResult(rows, 2, "id");
        expect(result.meta.hasMore).toBe(true);
        expect(result.data).toEqual([{id: 1}, {id: 2}]);
        expect(result.meta.count).toBe(2);
    });

    it("returns a null cursor for an empty result set", () => {
        const result = buildPaginationResult([], 20, "createdAt");
        expect(result.meta.nextCursor).toBeNull();
        expect(result.meta.hasMore).toBe(false);
    });

    it("encodes the next cursor from a snake_case DB row plus its id (cursor describes the last item of the returned page)", () => {
        // limit=1 against 2 rows -> hasMore=true, page keeps only rows[0];
        // the cursor is derived from that kept row, not the lookahead row.
        const rows = [
            {id: 10, created_at: "row-0-value"},
            {id: 11, created_at: "row-1-value"},
        ];
        const result = buildPaginationResult(rows, 1, "createdAt");
        expect(result.meta.hasMore).toBe(true);
        expect(result.meta.nextCursor).toBe("row-0-value||10");
    });

    it("falls back to the camelCase field when the snake_case column is absent", () => {
        const rows = [
            {id: 5, createdAt: "camel-value"},
            {id: 6, createdAt: "other"},
        ];
        const result = buildPaginationResult(rows, 1, "createdAt");
        expect(result.meta.hasMore).toBe(true);
        expect(result.meta.nextCursor).toBe("camel-value||5");
    });

    it("formats a Date sort value using local wall-clock digits, not toISOString", () => {
        const date = new Date(2026, 0, 15, 9, 5, 3, 7); // local Jan 15 2026 09:05:03.007
        const rows = [{id: 1, created_at: date}, {id: 2, created_at: date}];
        const result = buildPaginationResult(rows, 1, "createdAt");
        expect(result.meta.nextCursor).toBe("2026-01-15 09:05:03.007||1");
    });

    it("omits the tiebreaker when the row has no id", () => {
        const rows = [{total: 500}, {total: 600}];
        const result = buildPaginationResult(rows, 1, "total");
        expect(result.meta.hasMore).toBe(true);
        expect(result.meta.nextCursor).toBe("500");
    });

    it("never returns a cursor when the page is not truncated (hasMore=false), even with more than one row", () => {
        const rows = [
            {id: 1, created_at: "a"},
            {id: 2, created_at: "b"},
        ];
        const result = buildPaginationResult(rows, 2, "createdAt");
        expect(result.meta.hasMore).toBe(false);
        expect(result.meta.nextCursor).toBeNull();
    });

    it("keeps nextCursor null when hasMore is true but the sort value is missing", () => {
        const rows = [{id: 1}, {id: 2}];
        const result = buildPaginationResult(rows, 1, "createdAt");
        expect(result.meta.hasMore).toBe(true);
        expect(result.meta.nextCursor).toBeNull();
    });
});
