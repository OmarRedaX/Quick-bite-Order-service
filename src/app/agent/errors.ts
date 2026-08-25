import {AppError} from "../../lib/error/AppError";

export const AgentRoleRequiredError       = new AppError("AgentRoleRequired", 403);
export const OfflineWhilePickedForbidden  = new AppError("OfflineWhilePickedForbidden", 409);
export const OfferNotFoundOrExpiredError  = new AppError("OfferNotFoundOrExpired", 404);
export const NotInCandidateListError      = new AppError("NotInCandidateList", 403);
export const OrderAlreadyClaimedError     = new AppError("OrderAlreadyClaimed", 409);
export const OrderNotInReadyStateError    = new AppError("OrderNotInReadyState", 409);
export const NotYourTaskError             = new AppError("NotYourTask", 403);
export const AgentNotOnlineError          = new AppError("AgentNotOnline", 409);
export const OrderNotInAssignedStateError = new AppError("OrderNotInAssignedState", 409);
export const InvalidAgentTransitionError  = new AppError("InvalidAgentTransition", 400);
