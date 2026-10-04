import { registerAs } from '@nestjs/config';
import { required } from '../../../../packages/shared/src/config.js';

export const activityRegistryConfig = registerAs('activityRegistry', () => ({
  databaseUrl:
    process.env.ACTIVITY_DATABASE_URL ??
    (process.env.NODE_ENV === 'production'
      ? required('ACTIVITY_DATABASE_URL')
      : 'postgresql://activity:activity_local_only@127.0.0.1:5435/activity'),
}));
