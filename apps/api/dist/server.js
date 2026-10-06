/** API entrypoint — env validated at boot (fails fast if secrets missing). */
import { buildApp } from './app.js';
import { loadEnv } from './env.js';
import { sweepExpiredOffers } from './modules/matching/service.js';
const env = loadEnv();
const app = await buildApp();
// Offer-expiry sweeper (§9 TTL jobs) — every 5s in dev; Redis-backed scheduler in prod.
setInterval(() => { void sweepExpiredOffers().catch((e) => app.log.error(e)); }, 5_000);
try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`Testmobil API up on :${env.PORT} (maps=${process.env.MAPS_PROVIDER ?? 'local'})`);
}
catch (err) {
    app.log.error(err);
    process.exit(1);
}
