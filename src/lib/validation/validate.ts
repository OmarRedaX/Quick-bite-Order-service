import {plainToInstance} from "class-transformer";
import {validate, ValidationError} from "class-validator";
import {AppError} from "../error/AppError";

function flattenMessages(errors: ValidationError[]): string[] {
    const out: string[] = [];
    for (const e of errors) {
        if (e.constraints) out.push(...Object.values(e.constraints));
        if (e.children && e.children.length > 0) out.push(...flattenMessages(e.children));
    }
    return out;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Syntax-only check matching what Postgres's `uuid` column type accepts.
 * Deliberately not the stricter RFC4122 version/variant check (`uuid.validate`)
 * — a route param that fails this would otherwise reach the DB as a raw
 * "invalid input syntax for type uuid" error and surface as an unhandled 500.
 */
export function isUuidLike(value: string): boolean {
    return UUID_PATTERN.test(value);
}

export async function validateBody<T extends object>(
    cls: new () => T,
    body: unknown,
): Promise<T> {
    const instance = plainToInstance(cls, body);
    const errors = await validate(instance, {whitelist: true});

    if (errors.length > 0) {
        const messages = flattenMessages(errors);
        throw new AppError(messages.join("\n") || "Validation failed", 400);
    }
    return instance;
}
