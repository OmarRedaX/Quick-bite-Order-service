import "reflect-metadata";
import {Type} from "class-transformer";
import {IsInt, IsOptional, IsString, Min, ValidateNested} from "class-validator";
import {AppError} from "../../../src/lib/error/AppError";
import {isUuidLike, validateBody} from "../../../src/lib/validation/validate";

class AddressDTO {
    @IsString()
    street!: string;
}

class SampleDTO {
    @IsString()
    name!: string;

    @IsInt()
    @Min(1)
    age!: number;

    @IsOptional()
    @ValidateNested()
    @Type(() => AddressDTO)
    address?: AddressDTO;
}

describe("isUuidLike", () => {
    it("accepts a well-formed UUID regardless of case", () => {
        expect(isUuidLike("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
        expect(isUuidLike("123E4567-E89B-12D3-A456-426614174000")).toBe(true);
    });

    it.each([
        "not-a-uuid",
        "123e4567-e89b-12d3-a456-42661417400", // one char short
        "123e4567-e89b-12d3-a456-4266141740000", // one char long
        "",
        "123e4567e89b12d3a456426614174000", // missing dashes
    ])("rejects a malformed value (%p)", (value) => {
        expect(isUuidLike(value)).toBe(false);
    });
});

describe("validateBody", () => {
    it("returns an instance of the target class for a valid body", async () => {
        const result = await validateBody(SampleDTO, {name: "Pizza", age: 3});
        expect(result).toBeInstanceOf(SampleDTO);
        expect(result.name).toBe("Pizza");
        expect(result.age).toBe(3);
    });

    it("strips properties not declared on the DTO (whitelist)", async () => {
        const result = await validateBody(SampleDTO, {
            name: "Pizza",
            age: 3,
            internalSecret: "leak-me",
        });
        expect((result as unknown as Record<string, unknown>).internalSecret).toBeUndefined();
    });

    it("throws an AppError(400) when a required field is missing", async () => {
        await expect(validateBody(SampleDTO, {age: 3})).rejects.toMatchObject({
            statusCode: 400,
        });
        await expect(validateBody(SampleDTO, {age: 3})).rejects.toBeInstanceOf(AppError);
    });

    it("throws an AppError(400) when a field fails its constraint", async () => {
        await expect(validateBody(SampleDTO, {name: "Pizza", age: 0})).rejects.toMatchObject({
            statusCode: 400,
        });
    });

    it("flattens nested validation errors into the message", async () => {
        try {
            await validateBody(SampleDTO, {name: "Pizza", age: 3, address: {}});
            throw new Error("expected validateBody to reject");
        } catch (err) {
            expect(err).toBeInstanceOf(AppError);
            expect((err as AppError).message).toMatch(/street/i);
        }
    });
});
