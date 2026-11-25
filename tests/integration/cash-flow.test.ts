import { afterAll, beforeAll, describe, it } from 'vitest';
import { startTestApi } from '../smoke/test-api.mjs';
import { checkOnboarding } from '../smoke/onboarding.mjs';
import { checkMerchantScope } from '../smoke/merchant-scope.mjs';
import { checkSignup } from '../smoke/signup.mjs';
import { checkWebhookDelivery } from '../smoke/webhook.mjs';
import { checkPayments } from '../smoke/payments.mjs';

describe.sequential('Register and API integration', () => {
  let api: Awaited<ReturnType<typeof startTestApi>>;
  beforeAll(async () => { api = await startTestApi(); },60000);
  afterAll(async () => { await api?.stop(); });
  it('isolates merchant and branch data', async () => {
    await checkMerchantScope(api.port,api.databaseUrl);
  },60000);
  it('pairs a counter, downloads stock, opens a shift, synchronizes a cash receipt and closes the shift', async () => {
    await checkOnboarding(api.port,api.databaseUrl);
  },60000);
  it('settles UPI, reconciles partial refunds, approves returns and verifies stock movements', async () => {
    await checkPayments(api.port,api.databaseUrl,api.provider);
  },60000);
  it('provisions verified signups and delivers signed webhooks', async () => {
    await checkSignup(api.port,api.databaseUrl,api.provider);
    await checkWebhookDelivery();
  },60000);
});
