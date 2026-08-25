import {Request, Response, NextFunction} from "express";
import {injectable, inject} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {sendSuccess} from "../../../lib/http/response";
import {validateBody} from "../../../lib/validation/validate";
import {RegionNotResolvedError} from "../../../lib/sharding/errors";
import {FinanceService} from "../service/finance.service";
import {CreatePayoutRequestDTO} from "../dto/finance.request.dto";

const PAYOUT_LIST_LIMIT = 50;

@injectable()
export class FinanceController {
    constructor(@inject(TOKENS.FinanceService) private readonly finance: FinanceService) {}

    getBalance = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;
            const restaurantId = Number(req.params.restaurantId);
            const dto = await this.finance.getBalance(restaurantId, req.region);
            sendSuccess(res, dto);
        } catch (err) {
            next(err);
        }
    };

    listPayouts = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;
            const restaurantId = Number(req.params.restaurantId);
            const now = new Date();
            const defaultFrom = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
            const from = req.query.from ? new Date(String(req.query.from)) : defaultFrom;
            const to = req.query.to ? new Date(String(req.query.to)) : now;
            const items = await this.finance.listPayouts(restaurantId, req.region, from, to, PAYOUT_LIST_LIMIT);
            sendSuccess(res, items);
        } catch (err) {
            next(err);
        }
    };

    /** POST /admin/restaurants/:restaurantId/payouts */
    createPayout = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;
            const body = await validateBody(CreatePayoutRequestDTO, {
                ...req.body,
                restaurantId: Number(req.params.restaurantId),
            });
            const idempotencyKey = String(req.headers["idempotency-key"] ?? "");
            const dto = await this.finance.recordPayout(body, req.region, idempotencyKey);
            sendSuccess(res, dto, 201);
        } catch (err) {
            next(err);
        }
    };
}
