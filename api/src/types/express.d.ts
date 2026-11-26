declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth from the verified session token. Never read user ids from the request itself. */
      userId?: string;
    }
  }
}

export {};
