import { createAuthClient } from "better-auth/solid";
import { adminClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: "",
  plugins: [adminClient()],
});

export const { useSession, signIn, signUp, signOut } = authClient;
