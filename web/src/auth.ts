import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type User } from './api';

// The logged-in user, or null when there is no valid session.
export function useCurrentUser() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<User | null> => {
      try {
        return (await api<{ user: User }>('/auth/me')).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
  });
}
