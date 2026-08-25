import {Request, Response, NextFunction} from "express";
import {injectable, inject} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {sendSuccess, sendPaginated} from "../../../lib/http/response";
import {validateBody, isUuidLike} from "../../../lib/validation/validate";
import {parsePaginationQuery} from "../../../lib/http/pagination/parse-query";
import {RegionNotResolvedError} from "../../../lib/sharding/errors";
import {OrderService} from "../service/order.service";
import {CreateOrderRequestDTO, UpdateOrderStatusRequestDTO} from "../dto/order.request.dto";
import {OrderStatus} from "../enums";
import {OrderNotFoundError} from "../errors";

@injectable()
export class OrderController {
    constructor(@inject(TOKENS.OrderService) private readonly orderService: OrderService) {}

    placeOrder = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(CreateOrderRequestDTO, req.body);
            const result = await this.orderService.placeOrder(
                {
                    userId: req.user!.userId,
                    role: req.user!.role,
                    restaurantId: req.user!.restaurantId,
                    restaurantRole: req.user!.restaurantRole,
                    branchIds: req.user!.branchIds,
                },
                data,
                req.region,
                req.correlationId,
            );
            sendSuccess(res, result, 201);
        } catch (err) {
            next(err);
        }
    };

    getOrder = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;
            if (!isUuidLike(String(req.params.publicId))) throw OrderNotFoundError;
            const result = await this.orderService.getOrder(
                {
                    userId: req.user!.userId,
                    role: req.user!.role,
                    restaurantId: req.user!.restaurantId,
                    restaurantRole: req.user!.restaurantRole,
                    branchIds: req.user!.branchIds,
                },
                req.region,
                String(req.params.publicId),
            );
            sendSuccess(res, result);
        } catch (err) {
            next(err);
        }
    };

    listCustomerOrders = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;
            const year = Number(req.query.year) || new Date().getUTCFullYear();
            const pagination = parsePaginationQuery(req.query as Record<string, unknown>, ["createdAt"]);
            const result = await this.orderService.listCustomerOrders(
                {userId: req.user!.userId, role: req.user!.role},
                req.region,
                year,
                pagination,
            );
            sendPaginated(res, result.data, result.meta as never);
        } catch (err) {
            next(err);
        }
    };

    listRestaurantOrders = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;
            const restaurantId = Number(req.params.restaurantId);
            const branchId = Number(req.params.branchId);
            const pagination = parsePaginationQuery(req.query as Record<string, unknown>, ["createdAt"]);
            const status = req.query.status as OrderStatus | undefined;
            const from = req.query.from ? new Date(String(req.query.from)) : undefined;
            const to = req.query.to ? new Date(String(req.query.to)) : undefined;
            const result = await this.orderService.listRestaurantOrders(
                {
                    userId: req.user!.userId,
                    role: req.user!.role,
                    restaurantId: req.user!.restaurantId,
                    restaurantRole: req.user!.restaurantRole,
                    branchIds: req.user!.branchIds,
                },
                req.region,
                restaurantId,
                branchId,
                status,
                from,
                to,
                [],
                pagination,
            );
            sendPaginated(res, result.data, result.meta as never);
        } catch (err) {
            next(err);
        }
    };

    updateStatus = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;
            if (!isUuidLike(String(req.params.publicId))) throw OrderNotFoundError;
            const data = await validateBody(UpdateOrderStatusRequestDTO, req.body);
            const result = await this.orderService.updateStatus(
                {
                    userId: req.user!.userId,
                    role: req.user!.role,
                    restaurantId: req.user!.restaurantId,
                    restaurantRole: req.user!.restaurantRole,
                    branchIds: req.user!.branchIds,
                },
                req.region,
                String(req.params.publicId),
                data,
            );
            sendSuccess(res, result);
        } catch (err) {
            next(err);
        }
    };
}
