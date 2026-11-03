import { useAuth, useClerk } from "@clerk/react";
import { CLERK_KEY } from "./api.js";

const notSetUp = () =>
  window.alert("Sign-in isn't set up yet: add VITE_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY, then restart.");

// Without Clerk keys the app still runs, signed out.
const NO_CLERK = {
  openSignIn: notSetUp,
  openSignUp: notSetUp,
  openUserProfile: notSetUp,
  signOut: async () => {},
};

/** Who's signed in (Clerk), plus Clerk's sign-in/out actions. */
export function useSession() {
  if (!CLERK_KEY) return { authLoaded: true, userId: null, clerk: NO_CLERK };

  // CLERK_KEY never changes while the page is open, so the hooks always run in the same order.
  /* eslint-disable react-hooks/rules-of-hooks */
  const { isLoaded, userId } = useAuth();
  const clerk = useClerk();
  /* eslint-enable react-hooks/rules-of-hooks */

  return { authLoaded: isLoaded, userId, clerk };
}
