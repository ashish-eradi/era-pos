import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const deviceId = z.string().trim().regex(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i);
const code = z.string().trim().regex(/^[A-Za-z0-9_-]{43}$/);
export const deviceInput = z.object({ deviceId });
export const pairingInput = deviceInput.extend({ pairingProof: code });
export const activationInput = pairingInput.extend({ code });
export const invitationInput = z.object({ code });
export const saleInput = deviceInput.extend({ operation: z.object({ operationId: deviceId }).passthrough() });

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException('Invalid '+result.error.issues.map(issue => issue.path.join('.') || 'request body').join(', '));
  return result.data;
}
