import { MissingPermissionsError } from '../../core/errors.js';
import type { Middleware } from '../middleware.js';

export const permissions = (): Middleware => async (invocation, next) => {
  const { userPermissions = [], botPermissions = [] } = invocation.meta;

  if (userPermissions.length > 0 && invocation.memberPermissions) {
    const missing = invocation.memberPermissions.missing([...userPermissions]);
    if (missing.length > 0) throw new MissingPermissionsError('user', missing);
  }
  if (botPermissions.length > 0 && invocation.botPermissions) {
    const missing = invocation.botPermissions.missing([...botPermissions]);
    if (missing.length > 0) throw new MissingPermissionsError('bot', missing);
  }

  await next();
};
