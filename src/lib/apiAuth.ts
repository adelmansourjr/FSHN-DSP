import { auth } from './firebase';

type AuthHeaderOptions = {
  required?: boolean;
};

export async function getAuthBearerHeader(
  options: AuthHeaderOptions = {},
): Promise<Record<string, string>> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    if (options.required) {
      throw new Error('Sign in required.');
    }
    return {};
  }

  const token = await currentUser.getIdToken();
  if (!token) {
    if (options.required) {
      throw new Error('Sign in required.');
    }
    return {};
  }

  return { Authorization: `Bearer ${token}` };
}

export async function buildJsonHeaders(
  options: AuthHeaderOptions = {},
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, string>> {
  return {
    Accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
    'Content-Type': 'application/json',
    ...(await getAuthBearerHeader(options)),
    ...extraHeaders,
  };
}
