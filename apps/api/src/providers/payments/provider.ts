/**
 * PaymentProvider abstraction (brief §12) — Stripe adapter later; StubPaymentProvider
 * for dev/test. Card data NEVER touches this server (real adapter uses Elements + webhooks).
 */
export interface PaymentIntentResult { intentId: string; clientSecret?: string }

export interface PaymentProvider {
  readonly name: string;
  authorize(amountMinor: number, currency: string, meta: { tripId: string; customerId: string }): Promise<PaymentIntentResult>;
  capture(intentId: string): Promise<{ ok: boolean; capturedAmountMinor: number }>;
  refund(intentId: string, amountMinor: number): Promise<{ ok: boolean }>;
}

export class StubPaymentProvider implements PaymentProvider {
  readonly name = 'stub';
  private amounts = new Map<string, number>();

  async authorize(amountMinor: number, _currency: string, meta: { tripId: string }) {
    const intentId = `stub_pi_${meta.tripId}`;
    this.amounts.set(intentId, amountMinor);
    return { intentId }; // no clientSecret in stub — real Stripe returns one for Elements
  }
  async capture(intentId: string) {
    const amt = this.amounts.get(intentId);
    if (amt === undefined) return { ok: false, capturedAmountMinor: 0 };
    return { ok: true, capturedAmountMinor: amt };
  }
  async refund(intentId: string, amountMinor: number) {
    const amt = this.amounts.get(intentId);
    if (amt === undefined || amountMinor > amt) return { ok: false };
    this.amounts.set(intentId, amt - amountMinor);
    return { ok: true };
  }
}

let instance: PaymentProvider = new StubPaymentProvider();
export function getPaymentProvider(): PaymentProvider { return instance; }
export function setPaymentProvider(p: PaymentProvider) { instance = p; }
