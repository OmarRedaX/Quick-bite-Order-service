import {Request, Response, NextFunction} from "express";
import {injectable, inject} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {sendSuccess} from "../../../lib/http/response";
import {isUuidLike} from "../../../lib/validation/validate";
import {RegionNotResolvedError} from "../../../lib/sharding/errors";
import {OrderNotFoundError} from "../../order/errors";
import {AssignmentService} from "../service/assignment.service";

@injectable()
export class AssignmentController {
    constructor(@inject(TOKENS.AssignmentService) private readonly assignment: AssignmentService) {}

    /** POST /admin/orders/:publicId/assign  body: { agentId } */
    adminAssign = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;
            if (!isUuidLike(String(req.params.publicId))) throw OrderNotFoundError;
            const agentId = Number((req.body ?? {}).agentId);
            if (!Number.isFinite(agentId) || agentId <= 0) {
                return res.status(400).json({error: "agentId is required"});
            }
            const dto = await this.assignment.adminAssign(String(req.params.publicId), agentId, req.region);
            sendSuccess(res, dto);
        } catch (err) {
            next(err);
        }
    };
}
