import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadGatewayException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

type Account = { keyId: string; keySecret: string; webhookSecret: string };
type Link = {
  id: string; reference_id: string; short_url: string; status: string; currency: string; amount: number; amount_paid: number;
  payments?: Array<{ payment_id: string; status: string; method: string; amount: number }>;
};

function account(merchant: string): Account {
  const accounts = JSON.parse(process.env.ERA_RAZORPAY_ACCOUNTS ?? '{}') as Record<string, Account>;
  const value = Object.hasOwn(accounts, merchant) ? accounts[merchant] : undefined;
  if (!value?.keyId || !value.keySecret || !value.webhookSecret) throw new ServiceUnavailableException('UPI is not configured for this merchant');
  return value;
}

async function request<T>(merchant: string, path: string, body?: object, idempotency?: string): Promise<T> {
  const credentials = account(merchant);
  const base = process.env.NODE_ENV === 'test' ? process.env.ERA_RAZORPAY_TEST_ORIGIN : undefined;
  const headers = {
    authorization: `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString('base64')}`,
    ...(body && { 'content-type': 'application/json' }),
    ...(idempotency && { 'X-Refund-Idempotency': idempotency }),
  };
  try {
    const response = await fetch(new URL(`/v1/${path}`, base ?? 'https://api.razorpay.com'), {
      method: body ? 'POST' : 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(8000),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error('Provider request failed');
    return await response.json() as T;
  } catch {
    throw new BadGatewayException('Razorpay response unavailable. Check the same attempt again before collecting another tender.');
  }
}

export const razorpay = {
  requireAccount: (merchant: string): void => { account(merchant); },
  find: async (merchant: string, reference: string) => {
    const result = await request<{ payment_links: Link[] }>(merchant, `payment_links?reference_id=${encodeURIComponent(reference)}`);
    return result.payment_links?.find((link) => link.reference_id === reference);
  },
  create: (merchant: string, reference: string, amount: number) => request<Link>(merchant, 'payment_links', {
    reference_id: reference, amount, currency: 'INR', upi_link: true, accept_partial: false,
    description: 'ERA POS purchase', notify: { sms: false, email: false }, reminder_enable: false,
    expire_by: Math.floor(Date.now() / 1000) + 3600,
  }),
  link: (merchant: string, id: string) => request<Link>(merchant, `payment_links/${encodeURIComponent(id)}`),
  refund: (merchant: string, payment: string, id: string, amount: number) =>
    request<{ id: string; status: string; amount: number; payment_id: string }>(
      merchant, `payments/${encodeURIComponent(payment)}/refund`, { amount, receipt: id, speed: 'normal' }, id,
    ),
  refundStatus: (merchant: string, payment: string, id: string) =>
    request<{ id: string; status: string; amount: number; payment_id: string }>(
      merchant, `payments/${encodeURIComponent(payment)}/refunds/${encodeURIComponent(id)}`,
    ),
};

export function verifyWebhook(merchant: string, body: Buffer | undefined, signature?: string): void {
  if (!body || !signature || !/^[0-9a-f]{64}$/i.test(signature)) throw new UnauthorizedException();
  const expected = createHmac('sha256', account(merchant).webhookSecret).update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new UnauthorizedException();
}
