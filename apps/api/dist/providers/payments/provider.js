export class StubPaymentProvider {
    name = 'stub';
    amounts = new Map();
    async authorize(amountMinor, _currency, meta) {
        const intentId = `stub_pi_${meta.tripId}`;
        this.amounts.set(intentId, amountMinor);
        return { intentId }; // no clientSecret in stub — real Stripe returns one for Elements
    }
    async capture(intentId) {
        const amt = this.amounts.get(intentId);
        if (amt === undefined)
            return { ok: false, capturedAmountMinor: 0 };
        return { ok: true, capturedAmountMinor: amt };
    }
    async refund(intentId, amountMinor) {
        const amt = this.amounts.get(intentId);
        if (amt === undefined || amountMinor > amt)
            return { ok: false };
        this.amounts.set(intentId, amt - amountMinor);
        return { ok: true };
    }
}
let instance = new StubPaymentProvider();
export function getPaymentProvider() { return instance; }
export function setPaymentProvider(p) { instance = p; }
