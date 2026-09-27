import type { UserRole } from "./constants";

// The identity contract every AuthProvider yields (DESIGN §5.1). Business code
// depends ONLY on this shape — never on HOW the user authenticated — which is
// what makes auth pluggable (local today, SSO later) with zero business-code
// churn. NOTE: no password_hash / provider-internal fields here on purpose.
export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
}
