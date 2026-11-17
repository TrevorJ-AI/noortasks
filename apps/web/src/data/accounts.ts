/** Accounts, members and sharing (multi-user servers). Single-user servers answer `mode: "single"`. */

export interface Me {
  userId: number;
  email: string;
  name: string;
  role: "admin" | "member";
  picture?: string | null;
  single?: boolean;
  signIn?: "oidc" | "password" | "none";
  serverName?: string;
  collaboration: { enabled: boolean; optedOut: boolean };
}

export interface AuthConfig {
  mode: "single" | "multi";
  oidc: { label: string } | null;
  password: boolean;
  setupRequired?: boolean;
  serverName?: string;
}

export interface MemberRow {
  userId: number;
  email: string;
  name: string;
  role: "admin" | "member";
  status: "active" | "disabled" | "removed";
  picture: string | null;
  createdMs: number;
  lastLoginMs: number | null;
  signIn: "oidc" | "password" | "none";
  collabOptOut: boolean;
}

export interface MembersView {
  users: MemberRow[];
  allowlist: Array<{ email: string; addedMs: number; joined: boolean; hasInvite: boolean }>;
  settings: { collaboration: boolean; maxUsers: number };
  passwordLogin: boolean;
  oidc: boolean;
  activeCount: number;
  inviteCode?: string;
}

export type Permission = "read" | "comment" | "write";
export interface ShareRow {
  id: string;
  userId: number;
  name: string;
  email: string;
  picture: string | null;
  permission: Permission | "owner";
  effectivePermission?: Permission;
  isOwner: boolean;
}
export interface Contact {
  userId: number;
  name: string;
  email: string;
  picture: string | null;
}

export const PERMISSION_LABEL: Record<Permission, string> = { write: "Can edit", comment: "Can comment", read: "Can view" };

/** Sign-in errors the server sends back as ?auth_error=<code>. */
export const AUTH_ERROR_TEXT: Record<string, string> = {
  not_invited: "This account is not invited yet. Ask the admin to add your email.",
  max_users: "This server is full. Ask the admin to make room.",
  account_disabled: "This account is turned off. Ask the admin.",
  email_not_verified: "Your provider says this email is not verified.",
  identity_mismatch: "This email is linked to a different sign-in.",
  setup_required: "No admin is set up yet. Complete first-run setup or add your email under admins in the server config.",
  setup_locked: "Initial setup is already finished. Sign in below.",
  invalid_pairing_token: "That pairing code is invalid or expired.",
  state_mismatch: "The sign-in took too long or was opened in another browser. Try again.",
  token_rejected: "The sign-in could not be verified. Try again.",
  access_denied: "Sign-in was cancelled.",
  provider_unreachable: "The sign-in provider cannot be reached right now.",
  provider_error: "The sign-in provider returned an error.",
  no_email: "Your provider did not share an email address.",
};

export const initials = (name: string): string =>
  (name || "?")
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0]!.toUpperCase())
    .join("") || "?";

/** Can this account change tasks in this list? Own lists and lists shared with edit rights. */
export const canEditProject = (p: { isOwner?: boolean; permission?: string | null } | undefined): boolean => !p || p.isOwner !== false || p.permission === "write";
export const canCommentProject = (p: { isOwner?: boolean; permission?: string | null } | undefined): boolean => canEditProject(p) || p?.permission === "comment";
export const isSharedProject = (p: { isOwner?: boolean; userCount?: number } | undefined): boolean => !!p && (p.isOwner === false || (p.userCount ?? 0) > 1);
