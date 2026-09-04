import {parsePaginationQuery, parseFilters} from "../../../src/lib/http/pagination/parse-query";

describe("parsePaginationQuery", () => {
    it("applies defaults for an empty query", () => {
        const result = parsePaginationQuery({});
        expect(result).toEqual({
            cursor: undefined,
            limit: 20,
            sortBy: "createdAt",
            sortOrder: "desc",
        });
    });

    it("accepts a sortBy present in the allow-list", () => {
        const result = parsePaginationQuery({sortBy: "total"}, ["createdAt", "total"]);
        expect(result.sortBy).toBe("total");
    });

    it("falls back to the default sortBy when not in the allow-list", () => {
        const result = parsePaginationQuery({sortBy: "secretColumn"}, ["createdAt", "total"]);
        expect(result.sortBy).toBe("createdAt");
    });

    it("passes the cursor through untouched", () => {
        const result = parsePaginationQuery({cursor: "abc||1"});
        expect(result.cursor).toBe("abc||1");
    });

    it.each([
        [50, 50],
        ["50", 50],
        [1, 1],
    ])("accepts a positive numeric limit (%p)", (input, expected) => {
        const result = parsePaginationQuery({limit: input});
        expect(result.limit).toBe(expected);
    });

    it("caps a limit above the maximum (100)", () => {
        const result = parsePaginationQuery({limit: 500});
        expect(result.limit).toBe(100);
    });

    it.each([0, -5, "not-a-number", undefined, null])(
        "falls back to the default limit (20) for an invalid value (%p)",
        (input) => {
            const result = parsePaginationQuery({limit: input});
            expect(result.limit).toBe(20);
        },
    );

    it("only accepts the literal string 'asc' for sortOrder", () => {
        expect(parsePaginationQuery({sortOrder: "asc"}).sortOrder).toBe("asc");
        expect(parsePaginationQuery({sortOrder: "ASC"}).sortOrder).toBe("desc");
        expect(parsePaginationQuery({sortOrder: "desc"}).sortOrder).toBe("desc");
        expect(parsePaginationQuery({sortOrder: undefined}).sortOrder).toBe("desc");
    });
});

describe("parseFilters", () => {
    const allowedFields = ["status", "total"];

    it("returns an empty array when filter is absent", () => {
        expect(parseFilters({}, allowedFields)).toEqual([]);
    });

    it.each([null, undefined, "string", 42])(
        "returns an empty array when filter is not an object (%p)",
        (filter) => {
            expect(parseFilters({filter}, allowedFields)).toEqual([]);
        },
    );

    it("extracts one FilterParams per allowed operator on an allowed field", () => {
        const result = parseFilters(
            {filter: {status: {eq: "placed"}, total: {gte: "100", lte: "500"}}},
            allowedFields,
        );
        expect(result).toEqual(
            expect.arrayContaining([
                {field: "status", operator: "eq", value: "placed"},
                {field: "total", operator: "gte", value: "100"},
                {field: "total", operator: "lte", value: "500"},
            ]),
        );
        expect(result).toHaveLength(3);
    });

    it("ignores fields not in the allow-list", () => {
        const result = parseFilters(
            {filter: {status: {eq: "placed"}, secretField: {eq: "x"}}},
            allowedFields,
        );
        expect(result).toEqual([{field: "status", operator: "eq", value: "placed"}]);
    });

    it("ignores operators not in the allowed-operator set", () => {
        const result = parseFilters(
            {filter: {status: {eq: "placed", ne: "cancelled"}}},
            allowedFields,
        );
        expect(result).toEqual([{field: "status", operator: "eq", value: "placed"}]);
    });

    it("skips an allowed field whose value is not an object", () => {
        const result = parseFilters({filter: {status: "placed"}}, allowedFields);
        expect(result).toEqual([]);
    });

    it("preserves an array value for the 'in' operator", () => {
        const result = parseFilters(
            {filter: {status: {in: ["placed", "accepted"]}}},
            allowedFields,
        );
        expect(result).toEqual([
            {field: "status", operator: "in", value: ["placed", "accepted"]},
        ]);
    });
});
