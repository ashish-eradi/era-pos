export type HealthResponseV1 = {
  version: 1;
  status: 'ok' | 'unavailable';
};

export type CurrencyV1 = 'INR' | 'USD';

export type MoneyV1 = {
  currency: CurrencyV1;
  minorUnits: number;
};

export function isMoneyV1(value: unknown): value is MoneyV1 {
  if (typeof value !== 'object' || value === null) return false;
  const money = value as Partial<MoneyV1>;
  return (money.currency === 'INR' || money.currency === 'USD') && Number.isSafeInteger(money.minorUnits);
}

export type SyncRequestV1<Payload> = {
  version: 1;
  merchantId: string;
  branchId: string;
  registerId: string;
  operationId: string;
  occurredAt: string;
  payload: Payload;
};

export type SyncAcknowledgementV1 = {
  version: 1;
  operationId: string;
} & (
  | { status: 'committed' | 'replayed'; committedAt: string }
  | { status: 'rejected'; code: 'invalid_operation' | 'operation_conflict' | 'register_forbidden' }
  | { status: 'retry'; code: 'temporarily_unavailable' }
);
