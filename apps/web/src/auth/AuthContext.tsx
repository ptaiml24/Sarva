import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, getToken, SARVA_SESSION_INVALID_EVENT, setToken } from "../api/http.js";

type Role = "admin" | "operator";

type AuthState = {
  token: string | null;
  role: Role | null;
  email: string | null;
};

type AuthContextValue = AuthState & {
  login: (email: string, role: Role) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTok] = useState<string | null>(() => getToken());
  const [role, setRole] = useState<Role | null>(() => {
    const r = sessionStorage.getItem("sarva_role");
    return r === "admin" || r === "operator" ? r : null;
  });
  const [email, setEmail] = useState<string | null>(() => sessionStorage.getItem("sarva_email"));

  const login = useCallback(async (e: string, r: Role) => {
    setToken(null);
    const res = await api<{ token: string; role: string }>("/api/v1/auth/login", {
      method: "POST",
      json: { email: e, role: r },
    });
    setToken(res.token);
    sessionStorage.setItem("sarva_role", res.role);
    sessionStorage.setItem("sarva_email", e);
    setTok(res.token);
    setRole(res.role as Role);
    setEmail(e);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    sessionStorage.removeItem("sarva_role");
    sessionStorage.removeItem("sarva_email");
    setTok(null);
    setRole(null);
    setEmail(null);
  }, []);

  useEffect(() => {
    const onSessionInvalid = () => {
      logout();
    };
    window.addEventListener(SARVA_SESSION_INVALID_EVENT, onSessionInvalid);
    return () => window.removeEventListener(SARVA_SESSION_INVALID_EVENT, onSessionInvalid);
  }, [logout]);

  const value = useMemo(
    () => ({ token, role, email, login, logout }),
    [token, role, email, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
