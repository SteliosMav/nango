import path from 'node:path';

import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { createClient } from 'redis';

import { getRedisUrl } from '@nangohq/shared';
import { flagHasAPIRateLimit, getLogger } from '@nangohq/utils';

import type { RequestLocals } from '../utils/express';
import type { NextFunction, Request, Response } from 'express';

const logger = getLogger('RateLimiter');

const rateLimiter = await (async () => {
    const opts = {
        keyPrefix: 'middleware',
        points: parseInt(process.env['DEFAULT_RATE_LIMIT_PER_MIN'] || '0') || 3500,
        duration: 60,
        blockDuration: 0
    };
    const url = getRedisUrl();
    if (url) {
        const redisClient = await createClient({ url: url, disableOfflineQueue: true }).connect();
        redisClient.on('error', (err) => {
            logger.error(`Redis (rate-limiter) error: ${err}`);
        });
        return new RateLimiterRedis({
            storeClient: redisClient,
            ...opts
        });
    }
    return new RateLimiterMemory(opts);
})();

export const rateLimiterMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (!flagHasAPIRateLimit) {
        next();
        return;
    }

    const setXRateLimitHeaders = (rateLimiterRes: RateLimiterRes) => {
        const resetEpoch = Math.floor(new Date(Date.now() + rateLimiterRes.msBeforeNext).getTime() / 1000);
        res.setHeader('X-RateLimit-Limit', rateLimiter.points);
        res.setHeader('X-RateLimit-Remaining', rateLimiterRes.remainingPoints);
        res.setHeader('X-RateLimit-Reset', resetEpoch);
    };
    const key = getKey(req, res);
    const pointsToConsume = getPointsToConsume(req, res);
    rateLimiter
        .consume(key, pointsToConsume)
        .then((rateLimiterRes) => {
            setXRateLimitHeaders(rateLimiterRes);
            next();
        })
        .catch((err: unknown) => {
            if (err instanceof RateLimiterRes) {
                res.setHeader('Retry-After', Math.floor(err.msBeforeNext / 1000));
                setXRateLimitHeaders(err);
                logger.info(`Rate limit exceeded for ${key}. Request: ${req.method} ${req.path})`);
                res.status(429).send({ error: { code: 'too_many_request' } });
                return;
            }

            logger.error('Failed to compute rate limit', { error: err });
            // If we can't get the rate limit (ex: redis is unreachable), we should not block the request
            next();
        });
};

function getKey(req: Request, res: Response<any, RequestLocals>): string {
    if ('account' in res.locals) {
        // We have one for the secret key usage (customers or syncs) and one for the rest (dashboard, public key, session token)
        // To avoid syncs bringing down dashboard and reverse
        return `account-${res.locals.authType === 'secretKey' ? 'secret' : 'global'}-${res.locals['account'].id}`;
    } else if (req.user) {
        return `user-${req.user.id}`;
    }
    return `ip-${req.ip}`;
}

const specialPaths = ['/api/v1/account'];
function getPointsToConsume(req: Request, res: Response<any, RequestLocals>): number {
    const fullPath = path.join(req.baseUrl, req.route.path);
    if (specialPaths.includes(fullPath)) {
        // limiting to 6 requests per period to avoid brute force attacks
        return Math.floor(rateLimiter.points / 6);
    } else if (!res.locals.account || (res.locals.plan && res.locals.plan.name === 'free')) {
        // TODO: maybe store this in plans
        // Free account get way less requests
        return 10;
    }

    return 1;
}
