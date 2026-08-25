import {Request, Response, NextFunction} from "express";
import {injectable, inject} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {sendSuccess} from "../../../lib/http/response";
import {PaymentService} from "../service/payment.service";

@injectable()
export class PaymentController {
    constructor(@inject(TOKENS.PaymentService) private readonly paymentService: PaymentService) {}

    getById = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const restaurantId = Number(req.params.restaurantId);
            const paymentId = Number(req.params.paymentId);
            if (!Number.isFinite(paymentId) || paymentId <= 0) {
                return res.status(400).json({error: "invalid paymentId"});
            }
            const result = await this.paymentService.getById(paymentId, restaurantId, req.region!);
            sendSuccess(res, result);
        } catch (err) {
            next(err);
        }
    };
}
