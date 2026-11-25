import { startTestApi } from './test-api.mjs';
import { checkMerchantScope } from './merchant-scope.mjs';
import { checkOnboarding } from './onboarding.mjs';
import { checkSignup } from './signup.mjs';
import { checkWebhookDelivery } from './webhook.mjs';
import { checkPayments } from './payments.mjs';

const {port,databaseUrl,provider,stop} = await startTestApi();
try {
  await checkMerchantScope(port,databaseUrl);
  await checkOnboarding(port,databaseUrl);
  await checkPayments(port,databaseUrl,provider);
  await checkSignup(port,databaseUrl,provider);
  await checkWebhookDelivery();
} finally { await stop(); }
