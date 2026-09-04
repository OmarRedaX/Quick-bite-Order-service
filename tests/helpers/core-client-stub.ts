import {AppError} from "../../src/lib/error/AppError"
import {CoreClientRequest} from "../../src/lib/core-client/types"

// The load-bearing stub for this whole service's integration suite —
// core-service is a separate deployable network dependency (a true
// external, same category as core-service's own Mailjet/EmailStub), and
// every read/write to branch/product/stock/address/RBAC data funnels
// through the single `coreClient.request(...)` call. Mocked in via:
//
//   jest.mock("../../../src/lib/core-client/core-client", () => ({coreClient: coreClientStub}))
//
// ...before importing createApp(), same pattern as core-service's EmailStub.
export class CoreClientStub {
    calls: CoreClientRequest[] = []

    private branches = new Map<number, unknown>()
    private branchProducts = new Map<string, unknown>() // `${branchId}:${productId}`
    private addresses = new Map<number, unknown>()
    private permissions = new Map<string, string[]>()

    /** When set, every request() rejects with this error instead of routing. */
    failNextRequestWith: AppError | null = null

    seedBranch(id: number, data: unknown): void {
        this.branches.set(id, data)
    }

    seedBranchProduct(branchId: number, productId: number, data: unknown): void {
        this.branchProducts.set(`${branchId}:${productId}`, data)
    }

    seedAddress(id: number, data: unknown): void {
        this.addresses.set(id, data)
    }

    seedPermissions(role: string, permissions: string[]): void {
        this.permissions.set(role, permissions)
    }

    async request<T>(req: CoreClientRequest): Promise<T> {
        this.calls.push(req)

        if (this.failNextRequestWith) {
            const err = this.failNextRequestWith
            this.failNextRequestWith = null
            throw err
        }

        const {method, path} = req
        const [pathname, query] = path.split("?")
        const params = new URLSearchParams(query ?? "")

        // GET /api/internal/branches/:id
        let m = pathname.match(/^\/api\/internal\/branches\/(\d+)$/)
        if (method === "GET" && m) {
            const branch = this.branches.get(Number(m[1]))
            if (!branch) throw notFound(`branch ${m[1]}`)
            return {success: true, data: branch} as T
        }

        // GET /api/internal/branches?ids=1,2,3
        if (method === "GET" && pathname === "/api/internal/branches" && params.has("ids")) {
            const ids = params.get("ids")!.split(",").map(Number)
            const data = ids.map((id) => this.branches.get(id)).filter(Boolean)
            return {success: true, data} as T
        }

        // GET /api/internal/branches/:id/products?ids=1,2,3
        m = pathname.match(/^\/api\/internal\/branches\/(\d+)\/products$/)
        if (method === "GET" && m && params.has("ids")) {
            const branchId = Number(m[1])
            const ids = params.get("ids")!.split(",").map(Number)
            const data = ids.map((pid) => this.branchProducts.get(`${branchId}:${pid}`)).filter(Boolean)
            return {success: true, data} as T
        }

        // POST /api/internal/branches/:id/reserve-stock | /release-stock
        m = pathname.match(/^\/api\/internal\/branches\/(\d+)\/(reserve|release)-stock$/)
        if (method === "POST" && m) {
            const items = (req.body as {items: Array<{productId: number; quantity: number}>}).items
            return {success: true, data: {ok: true, applied: items.map((i) => ({productId: i.productId, newStock: 0}))}} as T
        }

        // GET /api/customer/addresses/internal/:id
        m = pathname.match(/^\/api\/customer\/addresses\/internal\/(\d+)$/)
        if (method === "GET" && m) {
            const address = this.addresses.get(Number(m[1]))
            if (!address) throw notFound(`address ${m[1]}`)
            return {success: true, data: address} as T
        }

        // GET /api/internal/rbac/permissions?role=...
        if (method === "GET" && pathname === "/api/internal/rbac/permissions" && params.has("role")) {
            const role = params.get("role")!
            return {success: true, data: {role, permissions: this.permissions.get(role) ?? []}} as T
        }

        throw new Error(`CoreClientStub: no route registered for ${method} ${path}`)
    }

    reset(): void {
        this.calls = []
        this.branches.clear()
        this.branchProducts.clear()
        this.addresses.clear()
        this.permissions.clear()
        this.failNextRequestWith = null
    }
}

function notFound(what: string): AppError {
    return new AppError(`${what} not found`, 404)
}

export const coreClientStub = new CoreClientStub()
