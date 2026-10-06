/** AppError — canonical error type mapped to the API envelope (brief §23). */
import { ErrorCode } from '@testmobil/shared';
export class AppError extends Error {
    code;
    httpStatus;
    details;
    constructor(code, message, httpStatus, details) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
        this.details = details;
        this.name = 'AppError';
    }
    static validation(msg, details) {
        return new AppError(ErrorCode.VALIDATION_FAILED, msg, 400, details);
    }
    static unauthenticated() {
        return new AppError(ErrorCode.UNAUTHENTICATED, 'Authentication required.', 401);
    }
    static forbidden(msg = 'Not permitted.') {
        return new AppError(ErrorCode.FORBIDDEN, msg, 403);
    }
    static notFound(entity = 'Resource') {
        return new AppError(ErrorCode.NOT_FOUND, `${entity} not found.`, 404);
    }
    static conflict(msg) {
        return new AppError(ErrorCode.CONFLICT, msg, 409);
    }
    static rateLimited() {
        return new AppError(ErrorCode.RATE_LIMITED, 'Too many requests. Slow down.', 429);
    }
}
