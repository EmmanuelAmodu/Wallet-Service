import { z } from 'zod';

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    password: z
      .string()
      .refine((value) => Array.from(value).length >= 1 && Array.from(value).length <= 128)
      .refine((value) => !/[\uD800-\uDFFF]/u.test(value)),
  })
  .strict();
export type LoginDto = z.infer<typeof loginSchema>;
