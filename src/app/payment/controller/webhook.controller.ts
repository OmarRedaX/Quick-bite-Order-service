import {Request, Response, NextFunction} from "express";
import {injectable, inject} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {KashierWebhookService} from "../service/kashier-webhook.service";
import {MalformedWebhookError} from "../errors";

@injectable()
export class WebhookController {
    constructor(@inject(TOKENS.KashierWebhookService) private readonly kashierWebhook: KashierWebhookService) {}

    kashier = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.rawBody) throw MalformedWebhookError;

            const sigHeader = req.headers["x-kashier-signature"];
            const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;

            await this.kashierWebhook.processKashierWebhook(req.rawBody, signature, req.region!);
            // Per Kashier docs: any 200 acknowledges receipt. We always 200 on
            // successful (or duplicate) processing.
            res.status(200).json({success: true});
        } catch (err) {
            next(err);
        }
    };
}
