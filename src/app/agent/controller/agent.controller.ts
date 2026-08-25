import {Request, Response, NextFunction} from "express";
import {injectable, inject} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {sendSuccess} from "../../../lib/http/response";
import {validateBody, isUuidLike} from "../../../lib/validation/validate";
import {RegionNotResolvedError} from "../../../lib/sharding/errors";
import {OrderStatus} from "../../order/enums";
import {OrderNotFoundError} from "../../order/errors";
import {PresenceLocationRequestDTO} from "../dto/agent.request.dto";
import {PresenceService} from "../service/presence.service";
import {AgentService} from "../service/agent.service";

@injectable()
export class AgentController {
    constructor(
        @inject(TOKENS.PresenceService) private readonly presence: PresenceService,
        @inject(TOKENS.AgentService) private readonly agent: AgentService,
    ) {}

    /**
     * Online and ping share the same write — UPSERT presence + extend TTL.
     * Both /agents/presence/online and /agents/presence/ping route here.
     */
    presenceUpsert = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;
            const data = await validateBody(PresenceLocationRequestDTO, req.body);
            await this.presence.upsert(req.region, req.user!.userId, data.lat, data.lng);
            sendSuccess(res, {ok: true});
        } catch (err) {
            next(err);
        }
    };

    offline = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;
            await this.presence.goOffline(req.region, req.user!.userId);
            sendSuccess(res, {ok: true});
        } catch (err) {
            next(err);
        }
    };

    accept = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;
            const dto = await this.agent.accept(String(req.params.publicId), req.user!.userId, req.region);
            sendSuccess(res, dto);
        } catch (err) {
            next(err);
        }
    };

    reject = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;
            await this.agent.reject(String(req.params.publicId), req.user!.userId);
            sendSuccess(res, {ok: true});
        } catch (err) {
            next(err);
        }
    };

    /** Body: { status: 'picked' | 'delivered' } */
    transition = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;
            if (!isUuidLike(String(req.params.publicId))) throw OrderNotFoundError;
            const target = String((req.body ?? {}).status) as OrderStatus;
            if (target !== OrderStatus.PICKED && target !== OrderStatus.DELIVERED) {
                return res.status(400).json({error: "status must be 'picked' or 'delivered'"});
            }
            const dto = await this.agent.transition(String(req.params.publicId), req.user!.userId, req.region, target);
            sendSuccess(res, dto);
        } catch (err) {
            next(err);
        }
    };

    tasks = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;
            const status = req.query.status ? String(req.query.status) : undefined;
            const list = await this.agent.listTasks(req.user!.userId, req.region, status);
            sendSuccess(res, list);
        } catch (err) {
            next(err);
        }
    };

    earnings = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;
            const now = new Date();
            const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
            const from = req.query.from ? new Date(String(req.query.from)) : defaultFrom;
            const to = req.query.to ? new Date(String(req.query.to)) : now;
            const dto = await this.agent.earnings(req.user!.userId, req.region, from, to);
            sendSuccess(res, dto);
        } catch (err) {
            next(err);
        }
    };
}
