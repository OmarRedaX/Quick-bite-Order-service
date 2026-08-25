import {coreClient} from "./core-client";
import {CoreEnvelope, RolePermissionsResponse} from "./types";

export async function getPermissionsByRole(role: string, correlationId?: string): Promise<string[]> {
    const res = await coreClient.request<CoreEnvelope<RolePermissionsResponse>>({
        method: "GET",
        path: `/api/internal/rbac/permissions?role=${encodeURIComponent(role)}`,
        correlationId,
    });
    return res.data?.permissions ?? [];
}
