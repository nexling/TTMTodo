import { createContext, useContext, type ReactNode } from "react";
import type { AuthStatus } from "./api";

const AuthStatusContext = createContext<AuthStatus | null>(null);

export function AuthStatusProvider({
  value,
  children,
}: {
  value: AuthStatus;
  children: ReactNode;
}) {
  return <AuthStatusContext.Provider value={value}>{children}</AuthStatusContext.Provider>;
}

export function useAuthStatus(): AuthStatus | null {
  return useContext(AuthStatusContext);
}

export function useHasOrganization(): boolean {
  const status = useAuthStatus();
  return Boolean(status?.organizations?.length);
}
