import { z } from 'zod';

export const registerUserSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    // Count Unicode code points; preserve the password's bytes without trimming or normalization.
    password: z
      .string()
      .refine((value) => {
        const length = Array.from(value).length;
        return length >= 15 && length <= 128;
      }, 'Password must contain between 15 and 128 characters')
      // UTF-8 encoders replace isolated surrogates; reject them so distinct input cannot collapse.
      .refine((value) => !/[\uD800-\uDFFF]/u.test(value), 'Password must contain valid Unicode'),
  })
  .strict();
export type RegisterUserDto = z.infer<typeof registerUserSchema>;
